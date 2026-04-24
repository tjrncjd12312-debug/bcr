//! Prediction Repository Interface
//!
//! Abstract interface for prediction API access

use crate::domain::entities::{PredictionRequest, PredictionResponse, RoomPrediction};
use async_trait::async_trait;

/// Prediction repository interface
#[async_trait]
pub trait PredictionRepository: Send + Sync {
    /// Request prediction for a room
    async fn predict(&self, request: PredictionRequest) -> Result<PredictionResponse, String>;

    /// Batch prediction for multiple rooms
    async fn predict_batch(&self, requests: Vec<PredictionRequest>) -> Vec<RoomPrediction>;

    /// Get cached prediction
    async fn get_cached_prediction(&self, room_id: &str) -> Option<PredictionResponse>;

    /// Clear cache
    fn clear_cache(&self);

    /// 파일 다운로드 (V2)
    async fn download_file(&self, download_url: &str) -> Result<Vec<u8>, String>;
}
