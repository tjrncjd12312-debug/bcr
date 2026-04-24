//! Multi Room Prediction Use Case
//!
//! Handles prediction for all 33 rooms simultaneously
//! New feature: Desktop multi-room prediction mode

use crate::data::repositories::{PredictionRepositoryImpl, RoomRepositoryImpl};
use crate::domain::entities::{
    GameResult, PredictionRequest, PredictionStatus, Room, RoomPrediction,
};
use crate::domain::repositories::{PredictionRepository, RoomRepository}; // Import traits for method resolution
use crate::domain::services::{GameLogicService, PatternAnalyzer};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, info, warn};

/// Use case for multi-room prediction mode
pub struct MultiRoomPredictionUseCase {
    room_repository: Arc<RoomRepositoryImpl>,
    prediction_repository: Arc<PredictionRepositoryImpl>,

    /// Minimum history required before predicting
    min_history: usize,
}

/// Multi-room prediction state
#[derive(Debug, Clone, Default)]
pub struct MultiRoomState {
    /// All room predictions
    pub predictions: HashMap<String, RoomPrediction>,

    /// Rooms sorted by score (best first)
    pub ranked_rooms: Vec<String>,

    /// Last update timestamp
    pub last_updated: i64,

    /// Total statistics
    pub stats: MultiRoomStats,
}

/// Multi-room statistics
#[derive(Debug, Clone, Default)]
pub struct MultiRoomStats {
    pub total_rooms: usize,
    pub predictable_rooms: usize,
    pub rooms_with_predictions: usize,
    pub average_confidence: f64,
    pub best_room_id: Option<String>,
    pub best_room_score: i32,
}

impl MultiRoomPredictionUseCase {
    /// Create new use case
    pub fn new(
        room_repository: Arc<RoomRepositoryImpl>,
        prediction_repository: Arc<PredictionRepositoryImpl>,
    ) -> Self {
        Self {
            room_repository,
            prediction_repository,
            min_history: 10,
        }
    }

    /// Set minimum history requirement
    pub fn set_min_history(&mut self, min: usize) {
        self.min_history = min;
    }

    /// Enable multi-room mode
    pub fn enable(&self) {
        info!("🔄 Enabling multi-room prediction mode");
        self.room_repository.set_multi_room_mode(true);
    }

    /// Disable multi-room mode
    pub fn disable(&self) {
        info!("🔄 Disabling multi-room prediction mode");
        self.room_repository.set_multi_room_mode(false);
    }

    /// Get all rooms with their current state
    pub fn get_all_rooms(&self) -> Vec<Room> {
        self.room_repository.get_all_rooms()
    }

    /// Get rooms that have enough history for prediction
    pub fn get_predictable_rooms(&self) -> Vec<Room> {
        self.room_repository.get_predictable_rooms(self.min_history)
    }

    /// Request predictions for all eligible rooms
    pub async fn predict_all(&self, state: &mut MultiRoomState) -> Result<(), String> {
        info!("🔮 Requesting predictions for all rooms...");

        let rooms = self.get_predictable_rooms();
        let total_rooms = self.room_repository.get_rooms().len();

        if rooms.is_empty() {
            warn!("⚠️ No rooms with sufficient history for prediction");
            return Ok(());
        }

        info!(
            "📊 {} rooms eligible for prediction (out of {})",
            rooms.len(),
            total_rooms
        );

        // Build prediction requests - convert VecDeque to Vec
        let requests: Vec<PredictionRequest> = rooms
            .iter()
            .map(|room| PredictionRequest {
                room_id: room.id.clone(),
                room_name: room.name.clone(),
                history: room.history.iter().copied().collect(),
            })
            .collect();

        // Batch predict
        let predictions = self.prediction_repository.predict_batch(requests).await;

        // Process results
        let mut total_confidence = 0.0;
        let mut confidence_count = 0;
        let mut rooms_with_predictions = 0;

        for prediction in predictions {
            if let Some(ref resp) = prediction.prediction {
                if !resp.is_skip && resp.prediction.is_some() {
                    total_confidence += resp.confidence;
                    confidence_count += 1;
                    rooms_with_predictions += 1;
                }
            }

            state
                .predictions
                .insert(prediction.room_id.clone(), prediction);
        }

        // Calculate room scores and rank
        let mut room_scores: Vec<(String, i32)> = rooms
            .iter()
            .map(|room| {
                (
                    room.id.clone(),
                    GameLogicService::calculate_room_score(room),
                )
            })
            .collect();

        room_scores.sort_by(|a, b| b.1.cmp(&a.1));

        state.ranked_rooms = room_scores.iter().map(|(id, _)| id.clone()).collect();

        // Update stats
        state.stats = MultiRoomStats {
            total_rooms,
            predictable_rooms: rooms.len(),
            rooms_with_predictions,
            average_confidence: if confidence_count > 0 {
                total_confidence / confidence_count as f64
            } else {
                0.0
            },
            best_room_id: room_scores.first().map(|(id, _)| id.clone()),
            best_room_score: room_scores.first().map(|(_, s)| *s).unwrap_or(0),
        };

        state.last_updated = chrono::Utc::now().timestamp();

        info!(
            "✅ Predictions complete: {} rooms predicted, avg confidence: {:.1}%",
            rooms_with_predictions,
            state.stats.average_confidence * 100.0
        );

        Ok(())
    }

    /// Get prediction for a specific room
    pub fn get_room_prediction<'a>(
        &self,
        state: &'a MultiRoomState,
        room_id: &str,
    ) -> Option<&'a RoomPrediction> {
        state.predictions.get(room_id)
    }

    /// Get top N rooms by score
    pub fn get_top_rooms<'a>(
        &self,
        state: &'a MultiRoomState,
        n: usize,
    ) -> Vec<&'a RoomPrediction> {
        state
            .ranked_rooms
            .iter()
            .take(n)
            .filter_map(|id| state.predictions.get(id))
            .collect()
    }

    /// Get rooms filtered by prediction (Banker, Player, Skip)
    pub fn get_rooms_by_prediction<'a>(
        &self,
        state: &'a MultiRoomState,
        filter: Option<GameResult>,
    ) -> Vec<&'a RoomPrediction> {
        state
            .predictions
            .values()
            .filter(|p| {
                if let Some(ref resp) = p.prediction {
                    match filter {
                        Some(f) => resp.prediction == Some(f),
                        None => resp.is_skip || resp.prediction.is_none(),
                    }
                } else {
                    filter.is_none()
                }
            })
            .collect()
    }

    /// Process game result for a room
    pub async fn on_game_result(
        &self,
        state: &mut MultiRoomState,
        room_id: &str,
        winner: GameResult,
    ) -> Result<RoomResultUpdate, String> {
        debug!("🎲 Multi-room result: {} = {:?}", room_id, winner);

        // Get current prediction
        let prediction = state.predictions.get(room_id);

        let result = if let Some(pred) = prediction {
            if let Some(ref resp) = pred.prediction {
                if resp.is_skip || resp.prediction == Some(GameResult::Tie) {
                    RoomResultUpdate::Skipped
                } else if winner == GameResult::Tie {
                    RoomResultUpdate::Push
                } else if resp.prediction == Some(winner) {
                    RoomResultUpdate::Correct
                } else {
                    RoomResultUpdate::Wrong
                }
            } else {
                RoomResultUpdate::NoPrediction
            }
        } else {
            RoomResultUpdate::NoPrediction
        };

        // Record result
        self.prediction_repository
            .record_result(room_id, winner)
            .await?;

        // Clear old prediction
        if let Some(pred) = state.predictions.get_mut(room_id) {
            pred.prediction = None;
            pred.status = PredictionStatus::Pending;
        }

        Ok(result)
    }

    /// Get room analysis for all rooms
    pub fn get_all_room_analyses(&self) -> Vec<RoomAnalysis> {
        self.room_repository
            .get_all_rooms()
            .iter()
            .filter(|r| r.history.len() >= self.min_history)
            .map(|room| {
                let (streak_type, streak_len) = room.current_streak();
                let history_vec: Vec<_> = room.history.iter().copied().collect();
                let volatility = PatternAnalyzer::calculate_volatility(&history_vec);
                let banker_rate = PatternAnalyzer::banker_rate(&history_vec);
                let score = GameLogicService::calculate_room_score(room);

                RoomAnalysis {
                    room_id: room.id.clone(),
                    room_name: room.name.clone(),
                    round_count: room.history.len(),
                    streak_type,
                    streak_length: streak_len as usize,
                    volatility,
                    banker_rate,
                    score,
                }
            })
            .collect()
    }

    /// Get summary for UI display
    pub fn get_summary(&self, state: &MultiRoomState) -> MultiRoomSummary {
        let banker_predictions = state
            .predictions
            .values()
            .filter(|p| {
                p.prediction
                    .as_ref()
                    .map(|r| r.prediction == Some(GameResult::Banker))
                    .unwrap_or(false)
            })
            .count();

        let player_predictions = state
            .predictions
            .values()
            .filter(|p| {
                p.prediction
                    .as_ref()
                    .map(|r| r.prediction == Some(GameResult::Player))
                    .unwrap_or(false)
            })
            .count();

        let skip_count = state
            .predictions
            .values()
            .filter(|p| p.prediction.as_ref().map(|r| r.is_skip).unwrap_or(false))
            .count();

        MultiRoomSummary {
            total_rooms: state.stats.total_rooms,
            predictable_rooms: state.stats.predictable_rooms,
            banker_predictions,
            player_predictions,
            skip_count,
            average_confidence: state.stats.average_confidence,
            best_room: state.stats.best_room_id.clone(),
            last_updated: state.last_updated,
        }
    }
}

/// Room result update outcome
#[derive(Debug, Clone)]
pub enum RoomResultUpdate {
    Correct,
    Wrong,
    Skipped,
    Push,
    NoPrediction,
}

/// Room analysis result
#[derive(Debug, Clone)]
pub struct RoomAnalysis {
    pub room_id: String,
    pub room_name: String,
    pub round_count: usize,
    pub streak_type: GameResult,
    pub streak_length: usize,
    pub volatility: f64,
    pub banker_rate: f64,
    pub score: i32,
}

/// Multi-room summary for UI
#[derive(Debug, Clone)]
pub struct MultiRoomSummary {
    pub total_rooms: usize,
    pub predictable_rooms: usize,
    pub banker_predictions: usize,
    pub player_predictions: usize,
    pub skip_count: usize,
    pub average_confidence: f64,
    pub best_room: Option<String>,
    pub last_updated: i64,
}
