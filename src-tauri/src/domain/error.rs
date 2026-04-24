//! Domain Error Types
//!
//! Defines all error types used across the domain layer.
//! Using thiserror for ergonomic error handling.

use thiserror::Error;

/// Main domain error type
#[derive(Error, Debug)]
pub enum DomainError {
    // Authentication Errors
    #[error("Authentication failed: {0}")]
    AuthenticationFailed(String),

    #[error("Invalid credentials")]
    InvalidCredentials,

    #[error("Session expired")]
    SessionExpired,

    #[error("User not found: {0}")]
    UserNotFound(String),

    // Connection Errors
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("WebSocket error: {0}")]
    WebSocketError(String),

    #[error("Not connected")]
    NotConnected,

    #[error("Connection timeout")]
    ConnectionTimeout,

    // Prediction Errors
    #[error("Prediction failed: {0}")]
    PredictionFailed(String),

    #[error("Room not found: {0}")]
    RoomNotFound(String),

    #[error("Invalid room ID: {0}")]
    InvalidRoomId(String),

    #[error("Insufficient history for prediction (need at least {required}, got {actual})")]
    InsufficientHistory { required: usize, actual: usize },

    #[error("Prediction service unavailable")]
    PredictionServiceUnavailable,

    // API Errors
    #[error("API error: {status} - {message}")]
    ApiError { status: u16, message: String },

    #[error("Network error: {0}")]
    NetworkError(String),

    #[error("Request timeout")]
    RequestTimeout,

    // Data Errors
    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("Deserialization error: {0}")]
    DeserializationError(String),

    #[error("Storage error: {0}")]
    StorageError(String),

    #[error("Cache miss for key: {0}")]
    CacheMiss(String),

    // Validation Errors
    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("Invalid input: {field} - {reason}")]
    InvalidInput { field: String, reason: String },

    // Generic Errors
    #[error("Internal error: {0}")]
    InternalError(String),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

/// Result type alias using DomainError
pub type DomainResult<T> = Result<T, DomainError>;

// Implement From traits for common error conversions

impl From<reqwest::Error> for DomainError {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            DomainError::RequestTimeout
        } else if err.is_connect() {
            DomainError::ConnectionFailed(err.to_string())
        } else {
            DomainError::NetworkError(err.to_string())
        }
    }
}

impl From<serde_json::Error> for DomainError {
    fn from(err: serde_json::Error) -> Self {
        if err.is_data() {
            DomainError::DeserializationError(err.to_string())
        } else {
            DomainError::SerializationError(err.to_string())
        }
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for DomainError {
    fn from(err: tokio_tungstenite::tungstenite::Error) -> Self {
        DomainError::WebSocketError(err.to_string())
    }
}

impl From<std::io::Error> for DomainError {
    fn from(err: std::io::Error) -> Self {
        DomainError::StorageError(err.to_string())
    }
}

// Convert DomainError to String for Tauri commands
impl From<DomainError> for String {
    fn from(err: DomainError) -> Self {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = DomainError::AuthenticationFailed("Invalid token".to_string());
        assert_eq!(err.to_string(), "Authentication failed: Invalid token");

        let err = DomainError::InsufficientHistory {
            required: 5,
            actual: 2,
        };
        assert_eq!(
            err.to_string(),
            "Insufficient history for prediction (need at least 5, got 2)"
        );
    }

    #[test]
    fn test_error_conversion_to_string() {
        let err = DomainError::NotConnected;
        let s: String = err.into();
        assert_eq!(s, "Not connected");
    }
}
