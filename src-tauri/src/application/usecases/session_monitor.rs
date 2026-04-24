//! Session Monitor Use Case
//!
//! Clean Architecture: Application Layer
//! Handles periodic session validation and duplicate login detection
//!
//! Features:
//! - Periodic token validation with server (every 30 seconds)
//! - Local session expiry tracking
//! - Duplicate login detection (server token mismatch)
//! - Expiry warnings (5분, 1분 전)
//! - Force quit trigger for expired/duplicate sessions

use crate::data::repositories::UserRepositoryImpl;
use crate::domain::entities::User;
use crate::domain::services::{
    SessionEvent, SessionManagerConfig, SessionState, SessionValidationResult,
};
use parking_lot::RwLock;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

/// 세션 모니터링 유스케이스
pub struct SessionMonitorUseCase {
    /// 사용자 저장소
    user_repository: Arc<UserRepositoryImpl>,
    /// 세션 상태
    session_state: RwLock<SessionState>,
    /// 설정
    config: SessionManagerConfig,
    /// 이벤트 송신자
    event_tx: RwLock<Option<mpsc::UnboundedSender<SessionEvent>>>,
}

impl SessionMonitorUseCase {
    /// 새 유스케이스 생성
    pub fn new(user_repository: Arc<UserRepositoryImpl>) -> Self {
        Self {
            user_repository,
            session_state: RwLock::new(SessionState::default()),
            config: SessionManagerConfig::default(),
            event_tx: RwLock::new(None),
        }
    }

    /// 설정과 함께 생성
    pub fn with_config(
        user_repository: Arc<UserRepositoryImpl>,
        config: SessionManagerConfig,
    ) -> Self {
        Self {
            user_repository,
            session_state: RwLock::new(SessionState::default()),
            config,
            event_tx: RwLock::new(None),
        }
    }

    /// 이벤트 채널 설정
    pub fn set_event_sender(&self, tx: mpsc::UnboundedSender<SessionEvent>) {
        *self.event_tx.write() = Some(tx);
    }

    /// 이벤트 채널 제거
    pub fn clear_event_sender(&self) {
        *self.event_tx.write() = None;
    }

    /// 세션 상태 초기화 (로그인 시 호출)
    pub fn initialize_session(&self) {
        let mut state = self.session_state.write();
        *state = SessionState::default();
        state.record_successful_validation();
        info!("📋 Session monitor initialized");
    }

    /// 세션 상태 초기화 (로그아웃 시 호출)
    pub fn clear_session(&self) {
        let mut state = self.session_state.write();
        *state = SessionState::default();
        info!("📋 Session monitor cleared");
    }

    /// 세션 검증 수행 (주기적으로 호출됨)
    ///
    /// Returns: SessionValidationResult with event if any
    pub async fn validate_session(&self) -> SessionValidationResult {
        // 1. 현재 사용자 확인
        let user = match self.user_repository.get_current_user() {
            Some(u) => u,
            None => {
                info!("ℹ️ No user logged in, skipping validation");
                return SessionValidationResult {
                    is_valid: false,
                    remaining_seconds: None,
                    expires_at: None,
                    event: None,
                    requires_force_quit: false,
                };
            }
        };

        // 2. 로컬 세션 만료 확인 (정액 시간)
        if user.is_session_expired() {
            info!("⏰ Session expired locally for user: {}", user.username);
            let result = SessionValidationResult::expired();
            self.emit_event(&result);
            return result;
        }

        // 3. 남은 시간 계산
        let remaining_seconds = user.remaining_seconds().unwrap_or(0);
        let expires_at = user.session_expires_at.unwrap_or(0);

        // 4. 서버에 토큰 검증 요청 (중복 로그인 확인)
        let token = match self.user_repository.get_auth_token() {
            Some(t) => t,
            None => {
                let result = SessionValidationResult::token_revoked();
                self.emit_event(&result);
                return result;
            }
        };

        match self.validate_token_with_server(&token, &user).await {
            Ok(server_result) => {
                // 서버 검증 성공
                self.session_state.write().record_successful_validation();

                // 서버에서 받은 남은 시간 사용 (더 정확함)
                let actual_remaining = server_result.remaining_seconds.unwrap_or(remaining_seconds);

                // 남은 시간이 0 이하면 만료
                if actual_remaining <= 0 {
                    info!(
                        "⏰ Session expired (server confirmed) for user: {}",
                        user.username
                    );
                    let result = SessionValidationResult::expired();
                    self.emit_event(&result);
                    return result;
                }

                // 경고 확인
                let warning = self
                    .session_state
                    .write()
                    .should_send_warning(actual_remaining, &self.config);

                let result = if warning.is_some() {
                    SessionValidationResult::valid_with_warning(actual_remaining, expires_at)
                } else {
                    SessionValidationResult::valid(actual_remaining, expires_at)
                };

                self.emit_event(&result);
                result
            }
            Err(validation_error) => {
                // 서버 검증 실패 처리
                self.handle_validation_error(validation_error, remaining_seconds, expires_at)
                    .await
            }
        }
    }

    /// 서버에 토큰 검증 요청
    async fn validate_token_with_server(
        &self,
        token: &str,
        _user: &User,
    ) -> Result<ServerValidationResponse, ValidationError> {
        // UserRepositoryImpl의 API를 통해 검증
        match self.user_repository.validate_token_with_time(token).await {
            Ok(response) => {
                if response.valid {
                    Ok(response)
                } else if response.expired {
                    // 서버에서 만료됨 확인
                    Err(ValidationError::SessionExpired)
                } else {
                    // 토큰 불일치 = 중복 로그인
                    Err(ValidationError::DuplicateLogin)
                }
            }
            Err(e) => {
                // 네트워크/서버 오류
                if e.contains("timeout") || e.contains("connection") {
                    Err(ValidationError::NetworkError(e))
                } else {
                    Err(ValidationError::ServerError(e))
                }
            }
        }
    }

    /// 검증 오류 처리
    async fn handle_validation_error(
        &self,
        error: ValidationError,
        _remaining_seconds: i64,
        _expires_at: i64,
    ) -> SessionValidationResult {
        match error {
            ValidationError::DuplicateLogin => {
                warn!("⚠️ Duplicate login detected!");
                let result = SessionValidationResult::duplicate_login();
                self.emit_event(&result);
                result
            }
            ValidationError::SessionExpired => {
                info!("⏰ Session expired (server confirmed)");
                let result = SessionValidationResult::expired();
                self.emit_event(&result);
                result
            }
            ValidationError::NetworkError(msg) => {
                // 네트워크 오류 기록
                let mut state = self.session_state.write();
                state.record_network_error();

                let offline_duration = state.offline_duration().unwrap_or(0);
                let consecutive_errors = state.consecutive_network_errors;

                warn!(
                    "⚠️ Network error (attempt {}, offline {}s): {}",
                    consecutive_errors, offline_duration, msg
                );

                // 오프라인 허용 시간 초과 시 강제 종료
                if offline_duration > self.config.offline_grace_period_secs {
                    error!(
                        "❌ Offline too long ({}s), forcing logout",
                        offline_duration
                    );
                    let result = SessionValidationResult {
                        is_valid: false,
                        remaining_seconds: None,
                        expires_at: None,
                        event: Some(SessionEvent::NetworkError {
                            message: format!(
                                "네트워크 연결이 {}초 이상 끊어져 프로그램을 종료합니다.",
                                self.config.offline_grace_period_secs
                            ),
                        }),
                        requires_force_quit: true,
                    };
                    self.emit_event(&result);
                    return result;
                }

                // 일시적 오류 - 세션 유지
                let result = SessionValidationResult::network_error(&msg);
                self.emit_event(&result);
                result
            }
            ValidationError::ServerError(msg) => {
                warn!("⚠️ Server error: {}", msg);
                // 서버 오류는 일시적으로 처리
                SessionValidationResult::server_error(&msg)
            }
        }
    }

    /// 이벤트 전송
    fn emit_event(&self, result: &SessionValidationResult) {
        if let Some(ref event) = result.event {
            if let Some(ref tx) = *self.event_tx.read() {
                if let Err(e) = tx.send(event.clone()) {
                    error!("Failed to send session event: {}", e);
                }
            }
        }
    }

    /// 현재 남은 시간 조회 (로컬 계산)
    pub fn get_remaining_seconds(&self) -> Option<i64> {
        self.user_repository
            .get_current_user()
            .and_then(|user| user.remaining_seconds())
    }

    /// 세션 만료 여부 확인 (로컬)
    pub fn is_session_expired(&self) -> bool {
        self.user_repository
            .get_current_user()
            .map(|user| user.is_session_expired())
            .unwrap_or(true)
    }

    /// 검증 주기 조회
    pub fn validation_interval_secs(&self) -> u64 {
        self.config.validation_interval_secs
    }
}

/// 서버 검증 응답
#[derive(Debug)]
pub struct ServerValidationResponse {
    pub valid: bool,
    pub expired: bool,
    pub remaining_seconds: Option<i64>,
}

/// 검증 오류 타입
#[derive(Debug)]
enum ValidationError {
    DuplicateLogin,
    SessionExpired,
    NetworkError(String),
    ServerError(String),
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    // 테스트는 mock repository로 구현 필요
}
