//! Single Room Prediction Use Case
//!
//! Handles semi-automatic prediction for a single room
//! Migrated from Android: GameLogic.java workflow

use crate::data::repositories::{PredictionRepositoryImpl, RoomRepositoryImpl};
use crate::domain::entities::{GameResult, PredictionRequest, PredictionResponse, Room};
use crate::domain::repositories::{PredictionRepository, RoomRepository}; // Import traits for method resolution
use crate::domain::services::{GameLogicService, PatternAnalyzer};
use std::sync::Arc;
use tracing::{debug, info, warn};

/// Use case for single room prediction mode
pub struct SingleRoomPredictionUseCase {
    room_repository: Arc<RoomRepositoryImpl>,
    prediction_repository: Arc<PredictionRepositoryImpl>,

    /// Minimum history required before predicting
    min_history: usize,
}

/// Prediction mode state
#[derive(Debug, Clone, PartialEq)]
pub enum PredictionMode {
    /// Analyzing initial data (first round)
    Analyzing,
    /// Ready to predict
    Ready,
    /// Waiting for result after prediction
    WaitingResult,
    /// Displaying result
    ShowingResult,
}

/// Single room prediction state
#[derive(Debug, Clone)]
pub struct SingleRoomState {
    pub mode: PredictionMode,
    pub room: Option<Room>,
    pub last_prediction: Option<PredictionResponse>,
    pub consecutive_wins: i32,
    pub consecutive_losses: i32,
    pub total_predictions: i32,
    pub correct_predictions: i32,
}

impl Default for SingleRoomState {
    fn default() -> Self {
        Self {
            mode: PredictionMode::Analyzing,
            room: None,
            last_prediction: None,
            consecutive_wins: 0,
            consecutive_losses: 0,
            total_predictions: 0,
            correct_predictions: 0,
        }
    }
}

impl SingleRoomPredictionUseCase {
    /// Create new use case
    pub fn new(
        room_repository: Arc<RoomRepositoryImpl>,
        prediction_repository: Arc<PredictionRepositoryImpl>,
    ) -> Self {
        Self {
            room_repository,
            prediction_repository,
            min_history: 10, // Minimum history before predicting
        }
    }

    /// Set minimum history requirement
    pub fn set_min_history(&mut self, min: usize) {
        self.min_history = min;
    }

    /// Select and subscribe to a room
    pub fn select_room(&self, room_id: &str) -> Result<Room, String> {
        info!("🎯 Selecting room: {}", room_id);

        // Subscribe to the room
        self.room_repository.subscribe_to_room(room_id)?;

        // Get room data
        let room = self
            .room_repository
            .get_room(room_id)
            .ok_or_else(|| format!("Room not found: {}", room_id))?;

        // Reset prediction tracking
        self.prediction_repository.reset_tracking(room_id);

        info!(
            "✅ Room selected: {} ({}) - {} results",
            room.name,
            room.id,
            room.history.len()
        );

        Ok(room)
    }

    /// Handle betting phase event
    pub async fn on_betting_phase(
        &self,
        state: &mut SingleRoomState,
        remaining_seconds: u32,
    ) -> Result<Option<PredictionResponse>, String> {
        let room = state.room.as_ref().ok_or("No room selected")?;

        debug!(
            "⏰ Betting phase: {} seconds remaining (mode: {:?})",
            remaining_seconds, state.mode
        );

        // Check if we should skip (first round / analyzing)
        if state.mode == PredictionMode::Analyzing {
            if room.history.len() >= self.min_history {
                // Enough data, transition to Ready
                state.mode = PredictionMode::Ready;
                info!("📊 Data analysis complete. Ready to predict.");
            } else {
                // Still analyzing
                info!(
                    "📊 실제 데이터 분석중입니다. ({}/{})",
                    room.history.len(),
                    self.min_history
                );
                return Ok(None);
            }
        }

        // If already waiting for result, don't predict again
        if state.mode == PredictionMode::WaitingResult {
            debug!("⏳ Already waiting for result");
            return Ok(None);
        }

        // Request prediction - convert VecDeque to Vec
        let request = PredictionRequest {
            room_id: room.id.clone(),
            room_name: room.name.clone(),
            history: room.history.iter().copied().collect(),
        };

        let response = self.prediction_repository.predict(request).await?;

        // Update state
        state.last_prediction = Some(response.clone());
        state.mode = PredictionMode::WaitingResult;

        if response.is_skip {
            info!("⏸️ SKIP: {}", response.reasoning);
        } else if let Some(ref pred) = response.prediction {
            info!(
                "🎯 Prediction: {:?} (confidence: {:.1}%)",
                pred,
                response.confidence * 100.0
            );
        }

        Ok(Some(response))
    }

    /// Handle game result event
    pub async fn on_game_result(
        &self,
        state: &mut SingleRoomState,
        winner: GameResult,
        player_score: u8,
        banker_score: u8,
    ) -> Result<ResultComparison, String> {
        let room = state.room.as_mut().ok_or("No room selected")?;

        info!(
            "🎲 Result: {:?} (P:{} B:{})",
            winner, player_score, banker_score
        );

        // Add result to room history
        room.add_result(winner);

        // If we're in analyzing mode, just update
        if state.mode == PredictionMode::Analyzing {
            if room.history.len() >= self.min_history {
                state.mode = PredictionMode::Ready;
            }
            return Ok(ResultComparison::NotPredicted);
        }

        // Compare with prediction
        let comparison = if let Some(ref prediction) = state.last_prediction {
            if prediction.is_skip {
                // SKIP prediction - don't count
                ResultComparison::Skipped
            } else if winner == GameResult::Tie {
                // Actual TIE - push, don't count
                ResultComparison::Push
            } else if let Some(predicted) = prediction.prediction {
                if predicted == GameResult::Tie {
                    // Predicted TIE - skip
                    ResultComparison::Skipped
                } else if predicted == winner {
                    // Correct prediction
                    state.consecutive_wins += 1;
                    state.consecutive_losses = 0;
                    state.total_predictions += 1;
                    state.correct_predictions += 1;

                    info!("✅ CORRECT! Win streak: {}", state.consecutive_wins);

                    ResultComparison::Correct {
                        predicted,
                        actual: winner,
                        streak: state.consecutive_wins,
                    }
                } else {
                    // Wrong prediction
                    state.consecutive_losses += 1;
                    state.consecutive_wins = 0;
                    state.total_predictions += 1;

                    warn!("❌ WRONG! Loss streak: {}", state.consecutive_losses);

                    ResultComparison::Wrong {
                        predicted,
                        actual: winner,
                        streak: state.consecutive_losses,
                    }
                }
            } else {
                ResultComparison::NotPredicted
            }
        } else {
            ResultComparison::NotPredicted
        };

        // Record result in repository
        self.prediction_repository
            .record_result(&room.id, winner)
            .await?;

        // Update state
        state.last_prediction = None;
        state.mode = PredictionMode::Ready;
        state.room = Some(room.clone());

        Ok(comparison)
    }

    /// Get current win rate
    pub fn get_win_rate(&self, state: &SingleRoomState) -> f64 {
        if state.total_predictions == 0 {
            return 0.0;
        }
        state.correct_predictions as f64 / state.total_predictions as f64
    }

    /// Check if should change room (based on win threshold or round count)
    pub fn should_change_room(&self, state: &SingleRoomState, win_threshold: u32) -> bool {
        let room = match &state.room {
            Some(r) => r,
            None => return false,
        };

        GameLogicService::should_change_room(
            state.consecutive_wins as u32,
            win_threshold,
            room.history.len(),
        )
    }

    /// Get room analysis
    pub fn analyze_room(
        &self,
        state: &SingleRoomState,
    ) -> Option<super::multi_room_prediction::RoomAnalysis> {
        let room = state.room.as_ref()?;

        let (streak_type, streak_len) = room.current_streak();
        let history_vec: Vec<_> = room.history.iter().copied().collect();
        let volatility = PatternAnalyzer::calculate_volatility(&history_vec);
        let banker_rate = PatternAnalyzer::banker_rate(&history_vec);
        let score = GameLogicService::calculate_room_score(room);

        Some(super::multi_room_prediction::RoomAnalysis {
            room_id: room.id.clone(),
            room_name: room.name.clone(),
            round_count: room.history.len(),
            streak_type,
            streak_length: streak_len as usize,
            volatility,
            banker_rate,
            score,
        })
    }
}

/// Result comparison outcome
#[derive(Debug, Clone)]
pub enum ResultComparison {
    /// Prediction was correct
    Correct {
        predicted: GameResult,
        actual: GameResult,
        streak: i32,
    },
    /// Prediction was wrong
    Wrong {
        predicted: GameResult,
        actual: GameResult,
        streak: i32,
    },
    /// Skipped (TIE prediction or server SKIP)
    Skipped,
    /// Push (actual result was TIE)
    Push,
    /// No prediction was made
    NotPredicted,
}
