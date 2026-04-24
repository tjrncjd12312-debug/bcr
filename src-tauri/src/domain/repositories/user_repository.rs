//! User Repository Interface
//!
//! Abstract interface for user data access

use crate::domain::entities::{LoginCredentials, LoginResponse, User};
use async_trait::async_trait;

/// User repository interface
#[async_trait]
pub trait UserRepository: Send + Sync {
    /// Login with credentials
    async fn login(&self, credentials: LoginCredentials) -> Result<LoginResponse, String>;

    /// Logout
    async fn logout(&self) -> Result<(), String>;

    /// Validate token
    async fn validate_token(&self, token: &str) -> Result<bool, String>;

    /// Get current user
    async fn get_current_user(&self) -> Option<User>;

    /// Restore session from local storage
    async fn restore_session(&self) -> Result<Option<User>, String>;

    /// Update user stats
    async fn update_stats(&self, user: &User) -> Result<(), String>;
}
