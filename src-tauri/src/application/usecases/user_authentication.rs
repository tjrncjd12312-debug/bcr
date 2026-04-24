//! User Authentication Use Case
//!
//! Handles user login, logout, and session management
//! Includes session expiry tracking and duplicate login detection

use crate::data::repositories::UserRepositoryImpl;
use crate::domain::entities::{
    LoginCredentials, LoginResponse, SessionInvalidReason, SessionStatus, User,
};
use crate::domain::repositories::UserRepository; // Import trait for method resolution
use std::sync::Arc;
use tracing::{error, info, warn};

/// Use case for user authentication
pub struct UserAuthenticationUseCase {
    user_repository: Arc<UserRepositoryImpl>,
}

impl UserAuthenticationUseCase {
    /// Create new use case
    pub fn new(user_repository: Arc<UserRepositoryImpl>) -> Self {
        Self { user_repository }
    }

    /// Login with username and password
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginResponse, String> {
        info!("🔐 Attempting login for user: {}", username);

        // Validate input
        if username.is_empty() {
            return Err("Username is required".to_string());
        }
        if password.is_empty() {
            return Err("Password is required".to_string());
        }

        let credentials = LoginCredentials {
            username: username.to_string(),
            password: password.to_string(),
        };

        let response = self.user_repository.login(credentials).await?;

        if response.success {
            info!("✅ Login successful for user: {}", username);
        } else {
            warn!("❌ Login failed for user: {}", username);
        }

        Ok(response)
    }

    /// Logout current user
    pub async fn logout(&self) -> Result<(), String> {
        info!("🚪 Logging out...");
        self.user_repository.logout().await?;
        info!("✅ Logged out successfully");
        Ok(())
    }

    /// Check if user is logged in
    pub fn is_logged_in(&self) -> bool {
        self.user_repository.is_logged_in()
    }

    /// Get current user
    pub fn get_current_user(&self) -> Option<User> {
        self.user_repository.get_current_user()
    }

    /// Get auth token
    pub fn get_auth_token(&self) -> Option<String> {
        self.user_repository.get_auth_token()
    }

    /// Restore session from local storage
    pub async fn restore_session(&self) -> Result<Option<User>, String> {
        info!("🔄 Attempting to restore session...");

        match self.user_repository.restore_session().await {
            Ok(Some(user)) => {
                info!("✅ Session restored for user: {}", user.username);
                Ok(Some(user))
            }
            Ok(None) => {
                info!("ℹ️ No previous session found");
                Ok(None)
            }
            Err(e) => {
                error!("❌ Failed to restore session: {}", e);
                Err(e)
            }
        }
    }

    /// Validate current token
    pub async fn validate_token(&self) -> Result<bool, String> {
        let token = match self.get_auth_token() {
            Some(t) => t,
            None => return Ok(false),
        };

        self.user_repository.validate_token(&token).await
    }

    /// Validate session (checks expiry and server token validity)
    /// Called periodically (every 30 seconds) from frontend
    pub async fn validate_session(&self) -> Result<SessionStatus, String> {
        // 1. Check if user is logged in
        let user = match self.get_current_user() {
            Some(u) => u,
            None => {
                return Ok(SessionStatus {
                    is_valid: false,
                    remaining_seconds: None,
                    expires_at: None,
                    invalidation_reason: Some(SessionInvalidReason::TokenRevoked),
                });
            }
        };

        // 2. Check local session expiry (정액 시간)
        if user.is_session_expired() {
            info!("⏰ Session expired for user: {}", user.username);
            return Ok(SessionStatus::expired());
        }

        // 3. Validate token with server (checks for duplicate login)
        let token = match self.get_auth_token() {
            Some(t) => t,
            None => return Ok(SessionStatus::token_revoked()),
        };

        match self.user_repository.validate_token(&token).await {
            Ok(true) => {
                // Token is valid, return remaining time
                let remaining = user.remaining_seconds().unwrap_or(0);
                let expires_at = user.session_expires_at.unwrap_or(0);
                Ok(SessionStatus::valid(remaining, expires_at))
            }
            Ok(false) => {
                // Token is invalid - likely duplicate login
                warn!(
                    "⚠️ Token invalidated for user: {} (possible duplicate login)",
                    user.username
                );
                Ok(SessionStatus::duplicate_login())
            }
            Err(e) => {
                // Network error - treat as offline
                error!("❌ Token validation failed (network error): {}", e);
                Ok(SessionStatus::offline())
            }
        }
    }

    /// Get remaining session time in seconds
    pub fn get_remaining_seconds(&self) -> Option<i64> {
        self.get_current_user()
            .and_then(|user| user.remaining_seconds())
    }

    /// Check if session is expired locally
    pub fn is_session_expired(&self) -> bool {
        self.get_current_user()
            .map(|user| user.is_session_expired())
            .unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    // Integration tests would go here
    // Requires mocking the repository
}
