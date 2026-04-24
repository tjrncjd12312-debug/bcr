//! Data Sources - External data access implementations
//!
//! Clean Architecture: Data Layer
//! - HTTP API clients (Prediction Server V2)
//! - Local storage (SQLite)
//! - Evolution data collection (betting, cards, shoe state)
//! Note: WebSocket connection is handled by evolution/multi_client.rs

mod evolution_data;
mod local_storage;
mod prediction_api;

pub use evolution_data::{EvolutionDataManager, RoomGameData};
pub use local_storage::{
    LocalStorage, LocalStorageConfig, StoredDailyStats, StoredRoomStats, StoredSession,
    StoredSettings,
};
pub use prediction_api::{
    // V2 API 구조체
    BettingStats,
    CardInfo,
    GameRound,
    // 기본 구조체
    LoginApiResponse,
    PredictionApi,
    PredictionApiConfig,
    RoomSelectionRequest,
    RoomSelectionResponse,
    ShoeStats,
    StreakTracking,
    TokenValidationResponse,
    V2PredictionRequest,
    V2PredictionResponse,
    // 버전 체크
    VersionCheckResponse,
};
