//! Application State
//!
//! Tauri managed state for the application
//! Note: WebSocket connection is handled by evolution/multi_client.rs

use crate::application::usecases::{
    MultiRoomPredictionUseCase, SessionMonitorUseCase, SingleRoomPredictionUseCase,
    UserAuthenticationUseCase,
};
use crate::data::datasources::{
    EvolutionDataManager, LocalStorage, LocalStorageConfig, PredictionApiConfig,
};
use crate::data::repositories::{PredictionRepositoryImpl, RoomRepositoryImpl, UserRepositoryImpl};
use crate::presentation::event_aggregator::EventAggregator;
use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tracing::info;

/// Application state managed by Tauri
///
/// Note: 프론트엔드 SSOT 전략 적용
/// - 실제 WebSocket 연결은 evolution/multi_client.rs에서 처리
/// - room_repository는 정적 룸 매핑 정보만 제공
/// - 예측 요청 시 프론트엔드에서 전달하는 히스토리 사용 (request_prediction_with_history)
pub struct AppState {
    /// Room repository (정적 룸 매핑, 모드 설정)
    pub room_repository: Arc<RoomRepositoryImpl>,

    /// Prediction repository
    pub prediction_repository: Arc<PredictionRepositoryImpl>,

    /// User repository
    pub user_repository: Arc<UserRepositoryImpl>,

    /// Use cases
    pub single_room_prediction: Arc<SingleRoomPredictionUseCase>,
    pub multi_room_prediction: Arc<MultiRoomPredictionUseCase>,
    pub user_authentication: Arc<UserAuthenticationUseCase>,
    pub session_monitor: Arc<SessionMonitorUseCase>,

    /// Local storage
    pub local_storage: Arc<LocalStorage>,

    /// Current site URL
    site_url: RwLock<Option<String>>,

    /// Evolution 데이터 매니저 (V2 API용)
    pub evolution_data: Arc<EvolutionDataManager>,

    /// Event aggregator for batched Tauri event emission (Lane R1).
    ///
    /// `None` until `install_event_aggregator()` is called from Tauri
    /// `setup()`, because the aggregator needs an `AppHandle` which is not
    /// available during `AppState::new()`.
    pub event_aggregator: Option<Arc<EventAggregator>>,
}

impl AppState {
    /// Create new application state
    pub async fn new(data_dir: PathBuf) -> Result<Self, String> {
        info!("🚀 Initializing application state...");

        // Initialize local storage
        let storage_config = LocalStorageConfig {
            db_path: data_dir.join("bcr_predictor.db"),
        };
        let local_storage = Arc::new(LocalStorage::new(storage_config).await?);

        // Initialize repositories
        // Note: WebSocket connection handled by evolution/multi_client.rs
        let room_repository = Arc::new(RoomRepositoryImpl::new());

        let api_config = PredictionApiConfig::default();
        let prediction_repository = Arc::new(PredictionRepositoryImpl::with_storage(
            api_config.clone(),
            local_storage.clone(),
        )?);

        let user_repository = Arc::new(UserRepositoryImpl::new(api_config, local_storage.clone())?);

        // Initialize use cases
        let single_room_prediction = Arc::new(SingleRoomPredictionUseCase::new(
            room_repository.clone(),
            prediction_repository.clone(),
        ));
        let multi_room_prediction = Arc::new(MultiRoomPredictionUseCase::new(
            room_repository.clone(),
            prediction_repository.clone(),
        ));
        let user_authentication = Arc::new(UserAuthenticationUseCase::new(user_repository.clone()));
        let session_monitor = Arc::new(SessionMonitorUseCase::new(user_repository.clone()));

        // Evolution 데이터 매니저 초기화
        let evolution_data = Arc::new(EvolutionDataManager::new());

        info!("✅ Application state initialized");

        Ok(Self {
            room_repository,
            prediction_repository,
            user_repository,
            single_room_prediction,
            multi_room_prediction,
            user_authentication,
            session_monitor,
            local_storage,
            site_url: RwLock::new(None),
            evolution_data,
            event_aggregator: None,
        })
    }

    /// Install the event aggregator once a Tauri `AppHandle` is available
    /// (from `setup()`). No-op if already installed. Lane R1 infrastructure.
    pub fn install_event_aggregator(&mut self, handle: AppHandle) {
        if self.event_aggregator.is_none() {
            self.event_aggregator = Some(Arc::new(EventAggregator::new(handle)));
            info!("📦 Event aggregator installed (Lane R1)");
        }
    }

    /// Update API server URL
    pub fn set_server_url(&self, url: &str) {
        // This would require recreating the API client
        // For now, we'll store it in settings
        info!("📡 Server URL set to: {}", url);
    }

    /// Set auth token for API calls (async because prediction_repository is async)
    pub async fn set_auth_token(&self, token: &str) {
        self.prediction_repository
            .set_auth_token(token.to_string())
            .await;
        info!("🔐 Auth token updated");
    }

    /// Set API base URL (site URL from login)
    pub async fn set_api_base_url(&self, url: &str) {
        self.prediction_repository
            .set_base_url(url.to_string())
            .await;
        self.user_repository.set_base_url(url.to_string()).await;
        info!("📡 API base URL set to: {}", url);
    }

    /// Set site URL
    pub async fn set_site_url(&self, url: &str) {
        *self.site_url.write() = Some(url.to_string());
        info!("🌐 Site URL stored: {}", url);
    }

    /// Get site URL
    pub async fn get_site_url(&self) -> Option<String> {
        self.site_url.read().clone()
    }
}
