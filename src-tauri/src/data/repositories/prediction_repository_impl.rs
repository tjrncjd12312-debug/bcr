//! Prediction Repository Implementation V2
//!
//! V2 API를 사용하는 예측 저장소

use crate::data::datasources::{
    LocalStorage, PredictionApi, PredictionApiConfig, RoomSelectionRequest, RoomSelectionResponse,
    V2PredictionRequest, V2PredictionResponse,
};
use crate::domain::entities::{
    GameResult, PredictionRequest, PredictionResponse, PredictionStatus, RoomPrediction,
};
use crate::domain::repositories::PredictionRepository;
use async_trait::async_trait;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// Prediction repository implementation
pub struct PredictionRepositoryImpl {
    /// Prediction API client (using tokio Mutex for async safety)
    api: Mutex<PredictionApi>,

    /// Local storage for caching
    storage: Option<Arc<LocalStorage>>,

    /// Cached predictions (room_id -> last prediction)
    cache: RwLock<HashMap<String, PredictionResponse>>,

    /// Prediction tracking (room_id -> tracking data)
    tracking: RwLock<HashMap<String, PredictionTrackingData>>,
}

/// Internal prediction tracking data
#[derive(Debug, Clone)]
struct PredictionTrackingData {
    last_prediction_id: Option<i64>,
    last_prediction: Option<GameResult>,
    consecutive_wins: i32,
    consecutive_losses: i32,
}

impl Default for PredictionTrackingData {
    fn default() -> Self {
        Self {
            last_prediction_id: None,
            last_prediction: None,
            consecutive_wins: 0,
            consecutive_losses: 0,
        }
    }
}

impl PredictionRepositoryImpl {
    /// Create new prediction repository
    pub fn new(config: PredictionApiConfig) -> Result<Self, String> {
        let api = PredictionApi::new(config)?;

        Ok(Self {
            api: Mutex::new(api),
            storage: None,
            cache: RwLock::new(HashMap::new()),
            tracking: RwLock::new(HashMap::new()),
        })
    }

    /// Create with local storage
    pub fn with_storage(
        config: PredictionApiConfig,
        storage: Arc<LocalStorage>,
    ) -> Result<Self, String> {
        let api = PredictionApi::new(config)?;

        Ok(Self {
            api: Mutex::new(api),
            storage: Some(storage),
            cache: RwLock::new(HashMap::new()),
            tracking: RwLock::new(HashMap::new()),
        })
    }

    /// Set authentication token
    pub async fn set_auth_token(&self, token: String) {
        self.api.lock().await.set_auth_token(token);
    }

    /// Set base URL for API
    pub async fn set_base_url(&self, url: String) {
        self.api.lock().await.set_base_url(url);
    }

    /// Get last prediction for a room
    pub fn get_last_prediction(&self, room_id: &str) -> Option<PredictionResponse> {
        self.cache.read().get(room_id).cloned()
    }

    /// Get tracking data for a room
    pub fn get_tracking(&self, room_id: &str) -> Option<(i32, i32)> {
        self.tracking
            .read()
            .get(room_id)
            .map(|t| (t.consecutive_wins, t.consecutive_losses))
    }

    /// Record prediction result (for tracking)
    pub async fn record_result(&self, room_id: &str, actual: GameResult) -> Result<(), String> {
        // First, collect all information we need from the lock
        let (predicted, pred_id, is_correct) = {
            let mut tracking = self.tracking.write();
            let data = tracking.entry(room_id.to_string()).or_default();

            // Compare with last prediction
            if let Some(pred) = data.last_prediction {
                // Skip if predicted TIE or actual is TIE
                if pred == GameResult::Tie || actual == GameResult::Tie {
                    debug!("⏸️ Skipping result comparison (TIE involved)");
                    // Clear last prediction before returning
                    data.last_prediction = None;
                    data.last_prediction_id = None;
                    return Ok(());
                }

                let correct = pred == actual;

                if correct {
                    data.consecutive_wins += 1;
                    data.consecutive_losses = 0;
                    info!(
                        "✅ Prediction CORRECT for {}: {:?} (streak: {})",
                        room_id, actual, data.consecutive_wins
                    );
                } else {
                    data.consecutive_losses += 1;
                    data.consecutive_wins = 0;
                    warn!(
                        "❌ Prediction WRONG for {}: predicted {:?}, actual {:?} (losses: {})",
                        room_id, pred, actual, data.consecutive_losses
                    );
                }

                let prediction_id = data.last_prediction_id;

                // Clear last prediction
                data.last_prediction = None;
                data.last_prediction_id = None;

                (Some(pred), prediction_id, Some(correct))
            } else {
                (None, None, None)
            }
        }; // Lock released here

        // Update local storage if available (no lock held during await)
        if let (Some(ref storage), Some(_predicted), Some(is_correct)) =
            (&self.storage, predicted, is_correct)
        {
            if let Some(pred_id) = pred_id {
                let result_str = match actual {
                    GameResult::Banker => "Banker",
                    GameResult::Player => "Player",
                    GameResult::Tie => "Tie",
                };
                let _ = storage
                    .update_prediction_result(pred_id, result_str, is_correct)
                    .await;
            }

            // Update room stats
            let room_name = room_id.to_string();
            let _ = storage
                .update_room_stats(room_id, &room_name, Some(is_correct))
                .await;
            let _ = storage.update_daily_stats(Some(is_correct)).await;
        }

        Ok(())
    }

    /// Reset tracking for a room
    pub fn reset_tracking(&self, room_id: &str) {
        let mut tracking = self.tracking.write();
        tracking.insert(room_id.to_string(), PredictionTrackingData::default());
    }

    // ==================== V2 API Methods ====================

    /// V2 예측 요청
    pub async fn predict_v2(
        &self,
        request: &V2PredictionRequest,
    ) -> Result<V2PredictionResponse, String> {
        let room_id = &request.room_id;

        info!(
            "🔮 V2 예측 요청: {} (히스토리: {}, 카드: {}, 베팅: {})",
            room_id,
            request.history.len(),
            request.last_game_cards.is_some(),
            request.betting_stats.is_some()
        );

        // V2 API 호출
        let response = {
            let api = self.api.lock().await;
            api.predict_v2(request).await?
        };

        // 도메인 응답으로 변환 후 캐시 및 추적
        let domain_response = response.to_domain(room_id);
        self.cache
            .write()
            .insert(room_id.clone(), domain_response.clone());

        // 로컬 스토리지 기록
        let prediction_id = if let Some(ref storage) = self.storage {
            if let Some(ref pred) = domain_response.prediction {
                let pred_str = match pred {
                    GameResult::Banker => "Banker",
                    GameResult::Player => "Player",
                    GameResult::Tie => "Tie",
                };

                match storage
                    .record_prediction(room_id, pred_str, domain_response.confidence)
                    .await
                {
                    Ok(id) => Some(id),
                    Err(e) => {
                        error!("예측 기록 실패: {}", e);
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // 추적 데이터 업데이트
        {
            let mut tracking = self.tracking.write();
            let data = tracking.entry(room_id.clone()).or_default();
            data.last_prediction = domain_response.prediction;
            data.last_prediction_id = prediction_id;
        }

        info!(
            "🎯 V2 예측 결과: {} -> {:?} (신뢰도: {:.1}%)",
            room_id,
            response.prediction,
            response.confidence.unwrap_or(0) as f64
        );

        Ok(response)
    }

    /// 방 선택 요청 (복수 방 후보 중 최적 방 반환)
    pub async fn select_best_room(
        &self,
        request: &RoomSelectionRequest,
    ) -> Result<RoomSelectionResponse, String> {
        let api = self.api.lock().await;
        api.select_best_room(request).await
    }

    /// V2 결과 보고
    pub async fn report_result_v2(
        &self,
        request: &V2PredictionRequest,
        actual_result: &str,
    ) -> Result<(), String> {
        let room_id = &request.room_id;

        info!("📊 V2 결과 보고: {} -> {}", room_id, actual_result);

        // API 호출
        let result = {
            let api = self.api.lock().await;
            api.report_result_v2(request, actual_result).await
        };

        match result {
            Ok(response) => {
                if response.success {
                    info!("✅ V2 결과 보고 완료: {}", room_id);
                } else {
                    warn!(
                        "⚠️ V2 결과 보고 실패: {:?}",
                        response.error.unwrap_or_default()
                    );
                }
            }
            Err(e) => {
                // 결과 보고 실패는 치명적이지 않으므로 경고만 출력
                warn!("⚠️ V2 결과 보고 요청 실패: {}", e);
            }
        }

        // 로컬 추적 업데이트
        let actual_game_result = match actual_result.to_lowercase().as_str() {
            "banker" | "b" | "red" => GameResult::Banker,
            "player" | "p" | "blue" => GameResult::Player,
            _ => GameResult::Tie,
        };
        self.record_result(room_id, actual_game_result).await?;

        Ok(())
    }

    /// 슈 체인지 알림
    pub async fn notify_shoe_change(&self, room_id: &str, room_name: &str) -> Result<(), String> {
        info!("🔄 슈 체인지 알림: {}", room_name);

        let result = {
            let api = self.api.lock().await;
            api.notify_shoe_change(room_id, room_name).await
        };

        match result {
            Ok(response) => {
                if response.success {
                    info!("✅ 슈 체인지 처리 완료: {:?}", response.shoe_id);
                } else {
                    warn!(
                        "⚠️ 슈 체인지 처리 실패: {:?}",
                        response.error.unwrap_or_default()
                    );
                }
                Ok(())
            }
            Err(e) => {
                warn!("⚠️ 슈 체인지 요청 실패: {}", e);
                Err(e)
            }
        }
    }
}

#[async_trait]
impl PredictionRepository for PredictionRepositoryImpl {
    async fn predict(&self, request: PredictionRequest) -> Result<PredictionResponse, String> {
        let room_id = request.room_id.clone();

        info!("🔮 Requesting prediction for room: {}", room_id);

        // Make API request
        let response = {
            let api = self.api.lock().await;
            api.predict(&request).await?
        };

        // Cache response
        self.cache.write().insert(room_id.clone(), response.clone());

        // Record to local storage if available (do this before taking lock)
        let prediction_id = if let Some(ref storage) = self.storage {
            if let Some(ref pred) = response.prediction {
                let pred_str = match pred {
                    GameResult::Banker => "Banker",
                    GameResult::Player => "Player",
                    GameResult::Tie => "Tie",
                };

                match storage
                    .record_prediction(&room_id, pred_str, response.confidence)
                    .await
                {
                    Ok(id) => Some(id),
                    Err(e) => {
                        error!("Failed to record prediction: {}", e);
                        None
                    }
                }
            } else {
                None
            }
        } else {
            None
        };

        // Update tracking (sync block, no await inside)
        {
            let mut tracking = self.tracking.write();
            let data = tracking.entry(room_id.clone()).or_default();
            data.last_prediction = response.prediction;
            data.last_prediction_id = prediction_id;
        }

        info!(
            "🎯 Prediction for {}: {:?} (confidence: {:.1}%)",
            room_id,
            response.prediction,
            response.confidence * 100.0
        );

        Ok(response)
    }

    async fn predict_batch(&self, requests: Vec<PredictionRequest>) -> Vec<RoomPrediction> {
        info!("🔮 Batch prediction for {} rooms", requests.len());

        let results = {
            let api = self.api.lock().await;
            api.predict_batch(&requests).await
        };

        let mut room_predictions = Vec::with_capacity(results.len());

        for (request, result) in requests.into_iter().zip(results) {
            let room_id = request.room_id.clone();

            let (response, status) = match result {
                Ok(resp) => {
                    // Cache response
                    self.cache.write().insert(room_id.clone(), resp.clone());

                    let status = if resp.is_skip {
                        PredictionStatus::Skip
                    } else if resp.prediction.is_some() {
                        PredictionStatus::Ready
                    } else {
                        PredictionStatus::Pending
                    };

                    (Some(resp), status)
                }
                Err(e) => {
                    error!("Failed to get prediction for {}: {}", room_id, e);
                    (None, PredictionStatus::Error(e))
                }
            };

            room_predictions.push(RoomPrediction {
                room_id,
                room_name: request.room_name,
                current_history: request.history,
                prediction: response,
                status,
                last_prediction: None,
                last_prediction_correct: None,
                consecutive_wins: 0,
                consecutive_losses: 0,
            });
        }

        room_predictions
    }

    async fn get_cached_prediction(&self, room_id: &str) -> Option<PredictionResponse> {
        self.cache.read().get(room_id).cloned()
    }

    fn clear_cache(&self) {
        self.cache.write().clear();
        info!("🗑️ Prediction cache cleared");
    }

    async fn download_file(&self, download_url: &str) -> Result<Vec<u8>, String> {
        let api = self.api.lock().await;
        api.download_file(download_url).await
    }
}
