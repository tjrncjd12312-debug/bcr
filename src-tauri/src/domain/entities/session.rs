//! Session Entity - Represents user session state
//!
//! Clean Architecture: Domain Layer
//! Handles session validation, expiration, and duplicate login detection

use serde::{Deserialize, Serialize};

/// 세션 상태 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// 세션 유효 여부
    pub is_valid: bool,
    /// 남은 시간 (초)
    pub remaining_seconds: Option<i64>,
    /// 세션 만료 시간 (Unix timestamp)
    pub expires_at: Option<i64>,
    /// 세션 무효화 사유
    pub invalidation_reason: Option<SessionInvalidReason>,
}

impl SessionStatus {
    /// 유효한 세션 생성
    pub fn valid(remaining_seconds: i64, expires_at: i64) -> Self {
        Self {
            is_valid: true,
            remaining_seconds: Some(remaining_seconds),
            expires_at: Some(expires_at),
            invalidation_reason: None,
        }
    }

    /// 만료된 세션 생성
    pub fn expired() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: Some(0),
            expires_at: None,
            invalidation_reason: Some(SessionInvalidReason::Expired),
        }
    }

    /// 중복 로그인으로 무효화된 세션
    pub fn duplicate_login() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: None,
            expires_at: None,
            invalidation_reason: Some(SessionInvalidReason::DuplicateLogin),
        }
    }

    /// 토큰 취소로 무효화된 세션
    pub fn token_revoked() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: None,
            expires_at: None,
            invalidation_reason: Some(SessionInvalidReason::TokenRevoked),
        }
    }

    /// 오프라인 상태
    pub fn offline() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: None,
            expires_at: None,
            invalidation_reason: Some(SessionInvalidReason::Offline),
        }
    }
}

/// 세션 무효화 사유
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionInvalidReason {
    /// 정액 시간 만료
    Expired,
    /// 중복 로그인 (다른 기기에서 로그인)
    DuplicateLogin,
    /// 토큰 취소 (서버에서 강제 로그아웃)
    TokenRevoked,
    /// 오프라인 상태 (네트워크 연결 없음)
    Offline,
    /// 서버 오류
    ServerError,
}

impl std::fmt::Display for SessionInvalidReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionInvalidReason::Expired => write!(f, "세션이 만료되었습니다."),
            SessionInvalidReason::DuplicateLogin => {
                write!(f, "다른 기기에서 로그인되어 연결이 종료됩니다.")
            }
            SessionInvalidReason::TokenRevoked => write!(f, "세션이 종료되었습니다."),
            SessionInvalidReason::Offline => {
                write!(
                    f,
                    "네트워크 연결이 없습니다. 온라인 상태에서만 사용 가능합니다."
                )
            }
            SessionInvalidReason::ServerError => write!(f, "서버 오류로 연결이 종료됩니다."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_status_valid() {
        let status = SessionStatus::valid(3600, 1234567890);
        assert!(status.is_valid);
        assert_eq!(status.remaining_seconds, Some(3600));
        assert!(status.invalidation_reason.is_none());
    }

    #[test]
    fn test_session_status_expired() {
        let status = SessionStatus::expired();
        assert!(!status.is_valid);
        assert_eq!(status.remaining_seconds, Some(0));
        assert_eq!(
            status.invalidation_reason,
            Some(SessionInvalidReason::Expired)
        );
    }

    #[test]
    fn test_session_status_duplicate_login() {
        let status = SessionStatus::duplicate_login();
        assert!(!status.is_valid);
        assert_eq!(
            status.invalidation_reason,
            Some(SessionInvalidReason::DuplicateLogin)
        );
    }
}
