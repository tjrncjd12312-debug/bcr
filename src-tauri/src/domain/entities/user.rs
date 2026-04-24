//! User Entity - Represents authenticated user
//!
//! Maps to Android: UserManager.java

use serde::{Deserialize, Serialize};

/// User session information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    /// User ID
    pub id: String,

    /// Username
    pub username: String,

    /// JWT token
    pub auth_token: String,

    /// User statistics
    pub stats: UserStats,

    /// Created timestamp
    pub created_at: i64,

    /// Session expiry timestamp (Unix timestamp) - 정액 시간 만료 시점
    #[serde(default)]
    pub session_expires_at: Option<i64>,

    /// Session duration in seconds (from server) - 서버에서 받은 정액 시간
    #[serde(default)]
    pub session_seconds: Option<i64>,
}

impl User {
    /// Create new user
    pub fn new(id: String, username: String, auth_token: String) -> Self {
        Self {
            id,
            username,
            auth_token,
            stats: UserStats::default(),
            created_at: chrono::Utc::now().timestamp(),
            session_expires_at: None,
            session_seconds: None,
        }
    }

    /// Create new user with session expiry (정액 시간 포함)
    pub fn with_session(
        id: String,
        username: String,
        auth_token: String,
        session_seconds: i64,
    ) -> Self {
        let now = chrono::Utc::now().timestamp();
        Self {
            id,
            username,
            auth_token,
            stats: UserStats::default(),
            created_at: now,
            session_expires_at: Some(now + session_seconds),
            session_seconds: Some(session_seconds),
        }
    }

    /// Get remaining session time in seconds
    pub fn remaining_seconds(&self) -> Option<i64> {
        self.session_expires_at.map(|expires_at| {
            let now = chrono::Utc::now().timestamp();
            (expires_at - now).max(0)
        })
    }

    /// Check if session is expired
    pub fn is_session_expired(&self) -> bool {
        match self.session_expires_at {
            Some(expires_at) => chrono::Utc::now().timestamp() >= expires_at,
            None => false, // No expiry set
        }
    }
}

/// Login credentials
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginCredentials {
    pub username: String,
    pub password: String,
}

/// Login response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    /// Success flag
    pub success: bool,

    /// User data if successful
    pub user: Option<User>,

    /// Message
    pub message: String,

    /// Session duration in seconds (정액 시간)
    #[serde(default)]
    pub remaining_seconds: Option<i64>,

    /// Notice from server (공지사항)
    #[serde(default)]
    pub notice: Option<NoticeInfo>,
}

/// Notice information from server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeInfo {
    /// Notice ID
    pub id: i64,
    /// Notice title
    pub title: String,
    /// Notice content
    pub content: String,
    /// Registration user
    #[serde(default)]
    pub reg_user: Option<String>,
    /// Registration date
    #[serde(default)]
    pub reg_date: Option<String>,
}

/// User statistics (persistent across sessions)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UserStats {
    /// Total predictions made
    pub total_predictions: u32,

    /// Correct predictions
    pub correct_predictions: u32,

    /// Total rooms played
    pub total_rooms_played: u32,

    /// Best win streak
    pub best_streak: u32,

    /// Current streak
    pub current_streak: u32,
}

impl UserStats {
    /// Calculate win rate
    pub fn win_rate(&self) -> f64 {
        if self.total_predictions == 0 {
            return 0.0;
        }
        self.correct_predictions as f64 / self.total_predictions as f64
    }

    /// Record correct prediction
    pub fn record_correct(&mut self) {
        self.total_predictions += 1;
        self.correct_predictions += 1;
        self.current_streak += 1;
        if self.current_streak > self.best_streak {
            self.best_streak = self.current_streak;
        }
    }

    /// Record incorrect prediction
    pub fn record_incorrect(&mut self) {
        self.total_predictions += 1;
        self.current_streak = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_creation() {
        let user = User::new(
            "user123".to_string(),
            "testuser".to_string(),
            "token123".to_string(),
        );

        assert_eq!(user.id, "user123");
        assert_eq!(user.username, "testuser");
        assert!(user.session_expires_at.is_none());
    }

    #[test]
    fn test_user_with_session() {
        let user = User::with_session(
            "user123".to_string(),
            "testuser".to_string(),
            "token123".to_string(),
            3600, // 1 hour
        );

        assert_eq!(user.session_seconds, Some(3600));
        assert!(user.session_expires_at.is_some());
        assert!(!user.is_session_expired());

        // Remaining seconds should be close to 3600
        let remaining = user.remaining_seconds().unwrap();
        assert!(remaining > 3590 && remaining <= 3600);
    }

    #[test]
    fn test_user_stats() {
        let mut stats = UserStats::default();

        stats.record_correct();
        stats.record_correct();
        stats.record_incorrect();

        assert_eq!(stats.total_predictions, 3);
        assert_eq!(stats.correct_predictions, 2);
        assert!((stats.win_rate() - 0.666).abs() < 0.01);
    }
}
