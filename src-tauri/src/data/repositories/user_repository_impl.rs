//! User Repository Implementation
//!
//! Implements UserRepository trait using Prediction API and Local Storage

use crate::application::usecases::ServerValidationResponse;
use crate::data::datasources::{LocalStorage, PredictionApi, PredictionApiConfig, StoredSession};
use crate::domain::entities::{LoginCredentials, LoginResponse, NoticeInfo, User, UserStats};
use crate::domain::repositories::UserRepository;
use async_trait::async_trait;
use parking_lot::RwLock;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// User repository implementation
pub struct UserRepositoryImpl {
    /// Prediction API client (using tokio Mutex for async safety)
    api: Mutex<PredictionApi>,

    /// Local storage
    storage: Arc<LocalStorage>,

    /// Current user
    current_user: RwLock<Option<User>>,
}

impl UserRepositoryImpl {
    /// Create new user repository
    pub fn new(
        api_config: PredictionApiConfig,
        storage: Arc<LocalStorage>,
    ) -> Result<Self, String> {
        let api = PredictionApi::new(api_config)?;

        Ok(Self {
            api: Mutex::new(api),
            storage,
            current_user: RwLock::new(None),
        })
    }

    /// Get current user
    pub fn get_current_user(&self) -> Option<User> {
        self.current_user.read().clone()
    }

    /// Check if user is logged in
    pub fn is_logged_in(&self) -> bool {
        self.current_user.read().is_some()
    }

    /// Get auth token
    pub fn get_auth_token(&self) -> Option<String> {
        self.current_user
            .read()
            .as_ref()
            .map(|u| u.auth_token.clone())
    }

    /// Set base URL for API
    pub async fn set_base_url(&self, url: String) {
        self.api.lock().await.set_base_url(url);
    }

    /// Validate token with server and get remaining time
    /// Used for duplicate login detection
    pub async fn validate_token_with_time(
        &self,
        token: &str,
    ) -> Result<ServerValidationResponse, String> {
        debug!("🔍 Validating token with time...");
        let api = self.api.lock().await;
        let response = api.validate_token_with_time(token).await?;

        Ok(ServerValidationResponse {
            valid: response.valid,
            expired: response.expired,
            remaining_seconds: Some(response.remaining_seconds),
        })
    }
}

#[async_trait]
impl UserRepository for UserRepositoryImpl {
    async fn login(&self, credentials: LoginCredentials) -> Result<LoginResponse, String> {
        info!("🔐 Attempting login for user: {}", credentials.username);

        let result = {
            let api = self.api.lock().await;
            api.login(&credentials.username, &credentials.password)
                .await?
        };

        if !result.success {
            let msg = result.message.unwrap_or_else(|| "Login failed".to_string());
            warn!("❌ Login failed: {}", msg);
            return Err(msg);
        }

        let token = result.token.ok_or("No token received")?;
        let user_id = result
            .user_id
            .unwrap_or_else(|| credentials.username.clone());
        let username = result.username.unwrap_or(credentials.username);

        // Get session seconds (정액 시간) from server response
        let session_seconds = result.seconds;
        let now = chrono::Utc::now().timestamp();
        let session_expires_at = session_seconds.map(|s| now + s);

        info!(
            "📅 Session info: seconds={:?}, expires_at={:?}",
            session_seconds, session_expires_at
        );

        // Create user with session expiry
        let user = User {
            id: user_id.clone(),
            username: username.clone(),
            auth_token: token.clone(),
            stats: UserStats::default(),
            created_at: now,
            session_expires_at,
            session_seconds,
        };

        // Save to local storage (세션 복원은 비활성화하지만 기록은 유지)
        let session = StoredSession {
            user_id: user.id.clone(),
            username: user.username.clone(),
            auth_token: user.auth_token.clone(),
            created_at: now,
            expires_at: session_expires_at,
        };

        self.storage.save_session(&session).await?;

        // Update current user
        *self.current_user.write() = Some(user.clone());

        // Convert notice from API response
        let notice = result.notice.map(|n| NoticeInfo {
            id: n.id,
            title: n.title,
            content: n.content,
            reg_user: n.reg_user,
            reg_date: n.reg_date,
        });

        info!(
            "✅ Login successful for user: {} (session: {} seconds, notice: {})",
            username,
            session_seconds.unwrap_or(0),
            notice.is_some()
        );

        Ok(LoginResponse {
            success: true,
            user: Some(user),
            message: "Login successful".to_string(),
            remaining_seconds: session_seconds,
            notice,
        })
    }

    async fn logout(&self) -> Result<(), String> {
        info!("🚪 Logging out...");

        // Clear local session
        self.storage.clear_session().await?;

        // Clear current user
        *self.current_user.write() = None;

        info!("✅ Logged out successfully");
        Ok(())
    }

    async fn validate_token(&self, token: &str) -> Result<bool, String> {
        debug!("🔍 Validating token...");
        let api = self.api.lock().await;
        let response = api.validate_token_with_time(token).await?;
        Ok(response.valid)
    }

    async fn get_current_user(&self) -> Option<User> {
        self.current_user.read().clone()
    }

    async fn restore_session(&self) -> Result<Option<User>, String> {
        // 세션 복원 비활성화 - 항상 새로 로그인 필요
        // 정액 시간 관리를 위해 매번 새로 로그인하여 서버에서 남은 시간을 받아와야 함
        info!("🔄 Session restore disabled - new login required");

        // 기존 세션 정리
        let _ = self.storage.clear_session().await;

        Ok(None)
    }

    async fn update_stats(&self, user: &User) -> Result<(), String> {
        // Update current user stats
        let mut current = self.current_user.write();
        if let Some(ref mut u) = *current {
            u.stats = user.stats.clone();
        }

        // Save to local storage (daily stats)
        // Stats are updated per-prediction via the prediction repository
        Ok(())
    }
}
