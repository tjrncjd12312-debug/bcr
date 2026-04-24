//! Local Storage
//!
//! SQLite-based local storage for user session, settings, and statistics
//! Desktop equivalent of Android SharedPreferences + Room Database

use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Pool, Row, Sqlite};
use std::path::PathBuf;
use tracing::{debug, info};

/// Local storage configuration
#[derive(Debug, Clone)]
pub struct LocalStorageConfig {
    /// Database file path
    pub db_path: PathBuf,
}

impl Default for LocalStorageConfig {
    fn default() -> Self {
        Self {
            db_path: PathBuf::from("bcr_predictor.db"),
        }
    }
}

/// User session data stored locally
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub user_id: String,
    pub username: String,
    pub auth_token: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
}

/// User settings stored locally
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSettings {
    pub server_url: String,
    pub auto_connect: bool,
    pub sound_enabled: bool,
    pub notification_enabled: bool,
    pub default_mode: String, // "single" or "multi"
    pub theme: String,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            server_url: "https://api.example.com".to_string(),
            auto_connect: true,
            sound_enabled: true,
            notification_enabled: true,
            default_mode: "single".to_string(),
            theme: "dark".to_string(),
        }
    }
}

/// Room statistics stored locally
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredRoomStats {
    pub room_id: String,
    pub room_name: String,
    pub total_predictions: i32,
    pub correct_predictions: i32,
    pub total_rounds: i32,
    pub last_played: i64,
}

/// Daily statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredDailyStats {
    pub date: String, // YYYY-MM-DD
    pub total_predictions: i32,
    pub correct_predictions: i32,
    pub rooms_played: i32,
    pub best_streak: i32,
}

/// Local storage manager
pub struct LocalStorage {
    pool: Pool<Sqlite>,
}

impl LocalStorage {
    /// Initialize local storage
    pub async fn new(config: LocalStorageConfig) -> Result<Self, String> {
        // Ensure parent directory exists
        if let Some(parent) = config.db_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create database directory: {}", e))?;
                info!("📁 Created database directory: {}", parent.display());
            }
        }

        let db_url = format!("sqlite:{}?mode=rwc", config.db_path.display());

        info!(
            "📂 Initializing local storage: {}",
            config.db_path.display()
        );

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&db_url)
            .await
            .map_err(|e| format!("Failed to connect to database: {}", e))?;

        let storage = Self { pool };
        storage.initialize_schema().await?;

        Ok(storage)
    }

    /// Initialize database schema
    async fn initialize_schema(&self) -> Result<(), String> {
        let schema = r#"
            -- User session table
            CREATE TABLE IF NOT EXISTS user_session (
                id INTEGER PRIMARY KEY,
                user_id TEXT NOT NULL,
                username TEXT NOT NULL,
                auth_token TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER
            );

            -- User settings table
            CREATE TABLE IF NOT EXISTS user_settings (
                id INTEGER PRIMARY KEY,
                key TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            );

            -- Room statistics table
            CREATE TABLE IF NOT EXISTS room_stats (
                room_id TEXT PRIMARY KEY,
                room_name TEXT NOT NULL,
                total_predictions INTEGER DEFAULT 0,
                correct_predictions INTEGER DEFAULT 0,
                total_rounds INTEGER DEFAULT 0,
                last_played INTEGER
            );

            -- Daily statistics table
            CREATE TABLE IF NOT EXISTS daily_stats (
                date TEXT PRIMARY KEY,
                total_predictions INTEGER DEFAULT 0,
                correct_predictions INTEGER DEFAULT 0,
                rooms_played INTEGER DEFAULT 0,
                best_streak INTEGER DEFAULT 0
            );

            -- Prediction history table
            CREATE TABLE IF NOT EXISTS prediction_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                prediction TEXT NOT NULL,
                actual_result TEXT,
                is_correct INTEGER,
                confidence REAL,
                created_at INTEGER NOT NULL
            );

            -- Create indexes
            CREATE INDEX IF NOT EXISTS idx_prediction_history_room ON prediction_history(room_id);
            CREATE INDEX IF NOT EXISTS idx_prediction_history_date ON prediction_history(created_at);
        "#;

        sqlx::query(schema)
            .execute(&self.pool)
            .await
            .map_err(|e| format!("Failed to initialize schema: {}", e))?;

        debug!("✅ Database schema initialized");
        Ok(())
    }

    // ==================== Session Management ====================

    /// Save user session
    pub async fn save_session(&self, session: &StoredSession) -> Result<(), String> {
        // Clear existing sessions first
        sqlx::query("DELETE FROM user_session")
            .execute(&self.pool)
            .await
            .map_err(|e| format!("Failed to clear sessions: {}", e))?;

        sqlx::query(
            r#"
            INSERT INTO user_session (user_id, username, auth_token, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&session.user_id)
        .bind(&session.username)
        .bind(&session.auth_token)
        .bind(session.created_at)
        .bind(session.expires_at)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to save session: {}", e))?;

        info!("💾 Session saved for user: {}", session.username);
        Ok(())
    }

    /// Get current session
    pub async fn get_session(&self) -> Result<Option<StoredSession>, String> {
        let row = sqlx::query(
            "SELECT user_id, username, auth_token, created_at, expires_at FROM user_session LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("Failed to get session: {}", e))?;

        Ok(row.map(|r| StoredSession {
            user_id: r.get("user_id"),
            username: r.get("username"),
            auth_token: r.get("auth_token"),
            created_at: r.get("created_at"),
            expires_at: r.get("expires_at"),
        }))
    }

    /// Clear session (logout)
    pub async fn clear_session(&self) -> Result<(), String> {
        sqlx::query("DELETE FROM user_session")
            .execute(&self.pool)
            .await
            .map_err(|e| format!("Failed to clear session: {}", e))?;

        info!("🚪 Session cleared");
        Ok(())
    }

    // ==================== Settings Management ====================

    /// Save setting
    pub async fn save_setting(&self, key: &str, value: &str) -> Result<(), String> {
        sqlx::query(
            r#"
            INSERT OR REPLACE INTO user_settings (key, value)
            VALUES (?, ?)
            "#,
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to save setting: {}", e))?;

        Ok(())
    }

    /// Get setting
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let row = sqlx::query("SELECT value FROM user_settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| format!("Failed to get setting: {}", e))?;

        Ok(row.map(|r| r.get("value")))
    }

    /// Save all settings
    pub async fn save_settings(&self, settings: &StoredSettings) -> Result<(), String> {
        let json = serde_json::to_string(settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;

        self.save_setting("app_settings", &json).await
    }

    /// Get all settings
    pub async fn get_settings(&self) -> Result<StoredSettings, String> {
        match self.get_setting("app_settings").await? {
            Some(json) => serde_json::from_str(&json)
                .map_err(|e| format!("Failed to deserialize settings: {}", e)),
            None => Ok(StoredSettings::default()),
        }
    }

    // ==================== Statistics Management ====================

    /// Update room statistics
    pub async fn update_room_stats(
        &self,
        room_id: &str,
        room_name: &str,
        is_correct: Option<bool>,
    ) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp();

        // Upsert room stats
        sqlx::query(
            r#"
            INSERT INTO room_stats (room_id, room_name, total_predictions, correct_predictions, total_rounds, last_played)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(room_id) DO UPDATE SET
                total_predictions = total_predictions + CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END,
                correct_predictions = correct_predictions + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
                total_rounds = total_rounds + 1,
                last_played = ?
            "#,
        )
        .bind(room_id)
        .bind(room_name)
        .bind(if is_correct.is_some() { 1 } else { 0 })
        .bind(if is_correct == Some(true) { 1 } else { 0 })
        .bind(now)
        .bind(is_correct.map(|b| if b { 1 } else { 0 }))
        .bind(if is_correct == Some(true) { 1 } else { 0 })
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to update room stats: {}", e))?;

        Ok(())
    }

    /// Get room statistics
    pub async fn get_room_stats(&self, room_id: &str) -> Result<Option<StoredRoomStats>, String> {
        let row = sqlx::query(
            "SELECT room_id, room_name, total_predictions, correct_predictions, total_rounds, last_played FROM room_stats WHERE room_id = ?",
        )
        .bind(room_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("Failed to get room stats: {}", e))?;

        Ok(row.map(|r| StoredRoomStats {
            room_id: r.get("room_id"),
            room_name: r.get("room_name"),
            total_predictions: r.get("total_predictions"),
            correct_predictions: r.get("correct_predictions"),
            total_rounds: r.get("total_rounds"),
            last_played: r.get("last_played"),
        }))
    }

    /// Get all room statistics
    pub async fn get_all_room_stats(&self) -> Result<Vec<StoredRoomStats>, String> {
        let rows = sqlx::query(
            "SELECT room_id, room_name, total_predictions, correct_predictions, total_rounds, last_played FROM room_stats ORDER BY last_played DESC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("Failed to get all room stats: {}", e))?;

        Ok(rows
            .into_iter()
            .map(|r| StoredRoomStats {
                room_id: r.get("room_id"),
                room_name: r.get("room_name"),
                total_predictions: r.get("total_predictions"),
                correct_predictions: r.get("correct_predictions"),
                total_rounds: r.get("total_rounds"),
                last_played: r.get("last_played"),
            })
            .collect())
    }

    /// Update daily statistics
    pub async fn update_daily_stats(&self, is_correct: Option<bool>) -> Result<(), String> {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

        sqlx::query(
            r#"
            INSERT INTO daily_stats (date, total_predictions, correct_predictions, rooms_played)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(date) DO UPDATE SET
                total_predictions = total_predictions + CASE WHEN ? IS NOT NULL THEN 1 ELSE 0 END,
                correct_predictions = correct_predictions + CASE WHEN ? = 1 THEN 1 ELSE 0 END
            "#,
        )
        .bind(&today)
        .bind(if is_correct.is_some() { 1 } else { 0 })
        .bind(if is_correct == Some(true) { 1 } else { 0 })
        .bind(is_correct.map(|b| if b { 1 } else { 0 }))
        .bind(if is_correct == Some(true) { 1 } else { 0 })
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to update daily stats: {}", e))?;

        Ok(())
    }

    /// Get today's statistics
    pub async fn get_today_stats(&self) -> Result<Option<StoredDailyStats>, String> {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

        let row = sqlx::query(
            "SELECT date, total_predictions, correct_predictions, rooms_played, best_streak FROM daily_stats WHERE date = ?",
        )
        .bind(&today)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("Failed to get today stats: {}", e))?;

        Ok(row.map(|r| StoredDailyStats {
            date: r.get("date"),
            total_predictions: r.get("total_predictions"),
            correct_predictions: r.get("correct_predictions"),
            rooms_played: r.get("rooms_played"),
            best_streak: r.get("best_streak"),
        }))
    }

    // ==================== Prediction History ====================

    /// Record prediction
    pub async fn record_prediction(
        &self,
        room_id: &str,
        prediction: &str,
        confidence: f64,
    ) -> Result<i64, String> {
        let now = chrono::Utc::now().timestamp();

        let result = sqlx::query(
            r#"
            INSERT INTO prediction_history (room_id, prediction, confidence, created_at)
            VALUES (?, ?, ?, ?)
            "#,
        )
        .bind(room_id)
        .bind(prediction)
        .bind(confidence)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to record prediction: {}", e))?;

        Ok(result.last_insert_rowid())
    }

    /// Update prediction result
    pub async fn update_prediction_result(
        &self,
        prediction_id: i64,
        actual_result: &str,
        is_correct: bool,
    ) -> Result<(), String> {
        sqlx::query(
            r#"
            UPDATE prediction_history
            SET actual_result = ?, is_correct = ?
            WHERE id = ?
            "#,
        )
        .bind(actual_result)
        .bind(if is_correct { 1 } else { 0 })
        .bind(prediction_id)
        .execute(&self.pool)
        .await
        .map_err(|e| format!("Failed to update prediction result: {}", e))?;

        Ok(())
    }

    /// Get recent predictions for a room
    pub async fn get_recent_predictions(
        &self,
        room_id: &str,
        limit: i32,
    ) -> Result<Vec<(String, Option<String>, Option<bool>)>, String> {
        let rows = sqlx::query(
            r#"
            SELECT prediction, actual_result, is_correct
            FROM prediction_history
            WHERE room_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            "#,
        )
        .bind(room_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("Failed to get recent predictions: {}", e))?;

        Ok(rows
            .into_iter()
            .map(|r| {
                let is_correct: Option<i32> = r.get("is_correct");
                (
                    r.get("prediction"),
                    r.get("actual_result"),
                    is_correct.map(|i| i == 1),
                )
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_session_management() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        let storage = LocalStorage::new(LocalStorageConfig { db_path })
            .await
            .unwrap();

        // Save session
        let session = StoredSession {
            user_id: "user123".to_string(),
            username: "testuser".to_string(),
            auth_token: "token123".to_string(),
            created_at: 1234567890,
            expires_at: Some(1234567890 + 3600),
        };

        storage.save_session(&session).await.unwrap();

        // Get session
        let loaded = storage.get_session().await.unwrap().unwrap();
        assert_eq!(loaded.user_id, "user123");
        assert_eq!(loaded.username, "testuser");

        // Clear session
        storage.clear_session().await.unwrap();
        let cleared = storage.get_session().await.unwrap();
        assert!(cleared.is_none());
    }
}
