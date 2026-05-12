//! Session Manager Service
//!
//! Clean Architecture: Domain Layer
//! Handles session state management, expiry tracking, and duplicate login detection
//!
//! Responsibilities:
//! - Track session validity locally
//! - Detect session expiry (정액 시간 만료)
//! - Provide session events for UI notification

use serde::{Deserialize, Serialize};

/// 세션 이벤트 - 프론트엔드로 전송될 이벤트
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// 세션 유효 상태 업데이트
    SessionValid {
        remaining_seconds: i64,
        expires_at: i64,
    },
    /// 세션 만료 경고 (5분 전)
    SessionExpiryWarning { remaining_seconds: i64 },
    /// 세션 만료 임박 경고 (1분 전)
    SessionExpirySoon { remaining_seconds: i64 },
    /// 세션 만료됨 - 프로그램 종료 필요
    SessionExpired { reason: String },
    /// 중복 로그인 감지 - 프로그램 종료 필요
    DuplicateLogin { reason: String },
    /// 토큰 취소됨 - 프로그램 종료 필요
    TokenRevoked { reason: String },
    /// 네트워크 오류 (일시적)
    NetworkError { message: String },
    /// 서버 오류 (일시적)
    ServerError { message: String },
}

impl SessionEvent {
    /// 강제 종료가 필요한 이벤트인지 확인
    pub fn requires_force_quit(&self) -> bool {
        matches!(
            self,
            SessionEvent::SessionExpired { .. }
                | SessionEvent::DuplicateLogin { .. }
                | SessionEvent::TokenRevoked { .. }
        )
    }

    /// 경고 이벤트인지 확인
    pub fn is_warning(&self) -> bool {
        matches!(
            self,
            SessionEvent::SessionExpiryWarning { .. } | SessionEvent::SessionExpirySoon { .. }
        )
    }

    /// 일시적 오류인지 확인 (재시도 가능)
    pub fn is_transient_error(&self) -> bool {
        matches!(
            self,
            SessionEvent::NetworkError { .. } | SessionEvent::ServerError { .. }
        )
    }
}

/// 세션 검증 결과
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionValidationResult {
    /// 세션 유효 여부
    pub is_valid: bool,
    /// 남은 시간 (초)
    pub remaining_seconds: Option<i64>,
    /// 만료 시간 (Unix timestamp)
    pub expires_at: Option<i64>,
    /// 발생한 이벤트 (있는 경우)
    pub event: Option<SessionEvent>,
    /// 강제 종료 필요 여부
    pub requires_force_quit: bool,
}

impl SessionValidationResult {
    /// 유효한 세션 (경고 없음)
    pub fn valid(remaining_seconds: i64, expires_at: i64) -> Self {
        Self {
            is_valid: true,
            remaining_seconds: Some(remaining_seconds),
            expires_at: Some(expires_at),
            event: Some(SessionEvent::SessionValid {
                remaining_seconds,
                expires_at,
            }),
            requires_force_quit: false,
        }
    }

    /// 유효한 세션 (만료 경고)
    pub fn valid_with_warning(remaining_seconds: i64, expires_at: i64) -> Self {
        let event = if remaining_seconds <= 60 {
            SessionEvent::SessionExpirySoon { remaining_seconds }
        } else {
            SessionEvent::SessionExpiryWarning { remaining_seconds }
        };

        Self {
            is_valid: true,
            remaining_seconds: Some(remaining_seconds),
            expires_at: Some(expires_at),
            event: Some(event),
            requires_force_quit: false,
        }
    }

    /// 세션 만료됨
    pub fn expired() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: Some(0),
            expires_at: None,
            event: Some(SessionEvent::SessionExpired {
                reason: "정액 시간이 만료되었습니다.".to_string(),
            }),
            requires_force_quit: true,
        }
    }

    /// 중복 로그인
    pub fn duplicate_login() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: None,
            expires_at: None,
            event: Some(SessionEvent::DuplicateLogin {
                reason: "다른 기기에서 로그인하여 현재 세션이 종료됩니다.".to_string(),
            }),
            requires_force_quit: true,
        }
    }

    /// 토큰 취소됨
    pub fn token_revoked() -> Self {
        Self {
            is_valid: false,
            remaining_seconds: None,
            expires_at: None,
            event: Some(SessionEvent::TokenRevoked {
                reason: "세션이 서버에서 종료되었습니다.".to_string(),
            }),
            requires_force_quit: true,
        }
    }

    /// 네트워크 오류
    pub fn network_error(message: &str) -> Self {
        Self {
            is_valid: true, // 네트워크 오류는 일시적이므로 세션은 유지
            remaining_seconds: None,
            expires_at: None,
            event: Some(SessionEvent::NetworkError {
                message: message.to_string(),
            }),
            requires_force_quit: false,
        }
    }

    /// 서버 오류
    pub fn server_error(message: &str) -> Self {
        Self {
            is_valid: true, // 서버 오류는 일시적이므로 세션은 유지
            remaining_seconds: None,
            expires_at: None,
            event: Some(SessionEvent::ServerError {
                message: message.to_string(),
            }),
            requires_force_quit: false,
        }
    }
}

/// 세션 매니저 설정
#[derive(Debug, Clone)]
pub struct SessionManagerConfig {
    /// 세션 검증 주기 (초) - 기본 30초
    pub validation_interval_secs: u64,
    /// 만료 경고 시간 (초) - 기본 5분 (300초)
    pub expiry_warning_secs: i64,
    /// 만료 임박 경고 시간 (초) - 기본 1분 (60초)
    pub expiry_soon_secs: i64,
    /// 네트워크 오류 재시도 횟수
    pub network_retry_count: u32,
    /// 네트워크 오류 시 강제 종료까지 허용 시간 (초) - 기본 5분
    pub offline_grace_period_secs: i64,
}

impl Default for SessionManagerConfig {
    fn default() -> Self {
        Self {
            validation_interval_secs: 60,
            expiry_warning_secs: 300, // 5분
            expiry_soon_secs: 60,     // 1분
            network_retry_count: 3,
            offline_grace_period_secs: 300, // 5분
        }
    }
}

/// 세션 상태 - 내부 추적용
#[derive(Debug, Clone, Default)]
pub struct SessionState {
    /// 마지막 성공적인 검증 시간 (Unix timestamp)
    pub last_validated_at: Option<i64>,
    /// 연속 네트워크 오류 횟수
    pub consecutive_network_errors: u32,
    /// 오프라인 시작 시간 (Unix timestamp)
    pub offline_since: Option<i64>,
    /// 마지막으로 전송된 경고 타입
    pub last_warning_type: Option<WarningType>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WarningType {
    FiveMinutes,
    OneMinute,
}

impl SessionState {
    /// 성공적인 검증 기록
    pub fn record_successful_validation(&mut self) {
        let now = chrono::Utc::now().timestamp();
        self.last_validated_at = Some(now);
        self.consecutive_network_errors = 0;
        self.offline_since = None;
    }

    /// 네트워크 오류 기록
    pub fn record_network_error(&mut self) {
        let now = chrono::Utc::now().timestamp();
        self.consecutive_network_errors += 1;
        if self.offline_since.is_none() {
            self.offline_since = Some(now);
        }
    }

    /// 오프라인 경과 시간 (초)
    pub fn offline_duration(&self) -> Option<i64> {
        self.offline_since
            .map(|since| chrono::Utc::now().timestamp() - since)
    }

    /// 경고 타입 업데이트 (중복 경고 방지용)
    pub fn should_send_warning(
        &mut self,
        remaining_seconds: i64,
        config: &SessionManagerConfig,
    ) -> Option<WarningType> {
        let warning_type = if remaining_seconds <= config.expiry_soon_secs {
            Some(WarningType::OneMinute)
        } else if remaining_seconds <= config.expiry_warning_secs {
            Some(WarningType::FiveMinutes)
        } else {
            None
        };

        // 이미 같은 경고를 보냈으면 None 반환
        if warning_type == self.last_warning_type {
            return None;
        }

        // 새 경고 타입 저장
        if warning_type.is_some() {
            self.last_warning_type = warning_type.clone();
        }

        warning_type
    }

    /// 경고 상태 초기화 (새 세션 시작 시)
    pub fn reset_warnings(&mut self) {
        self.last_warning_type = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_event_requires_force_quit() {
        assert!(SessionEvent::SessionExpired {
            reason: "test".to_string()
        }
        .requires_force_quit());

        assert!(SessionEvent::DuplicateLogin {
            reason: "test".to_string()
        }
        .requires_force_quit());

        assert!(!SessionEvent::SessionValid {
            remaining_seconds: 100,
            expires_at: 0
        }
        .requires_force_quit());

        assert!(!SessionEvent::NetworkError {
            message: "test".to_string()
        }
        .requires_force_quit());
    }

    #[test]
    fn test_session_validation_result() {
        let valid = SessionValidationResult::valid(3600, 1234567890);
        assert!(valid.is_valid);
        assert!(!valid.requires_force_quit);

        let expired = SessionValidationResult::expired();
        assert!(!expired.is_valid);
        assert!(expired.requires_force_quit);

        let duplicate = SessionValidationResult::duplicate_login();
        assert!(!duplicate.is_valid);
        assert!(duplicate.requires_force_quit);
    }

    #[test]
    fn test_session_state_warning() {
        let config = SessionManagerConfig::default();
        let mut state = SessionState::default();

        // 처음 5분 경고
        let warning = state.should_send_warning(200, &config);
        assert_eq!(warning, Some(WarningType::FiveMinutes));

        // 같은 경고는 다시 보내지 않음
        let warning = state.should_send_warning(180, &config);
        assert_eq!(warning, None);

        // 1분 경고로 업그레이드
        let warning = state.should_send_warning(50, &config);
        assert_eq!(warning, Some(WarningType::OneMinute));
    }
}
