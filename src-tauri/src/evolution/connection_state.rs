//! Evolution Connection State Machine
//!
//! 연결 상태를 명시적으로 관리하는 상태 머신 패턴 구현.
//! 중첩된 if문과 플래그 대신 명확한 상태 전이를 제공합니다.

use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

/// 연결 상태
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    /// 연결되지 않음 (초기 상태)
    Disconnected,
    /// 연결 시도 중
    Connecting { started_at: Instant, attempt: u32 },
    /// 핸드셰이크 진행 중 (WebSocket 연결됨, 초기화 시퀀스 전송 중)
    Handshaking { connected_at: Instant },
    /// 테이블 구독 중
    Subscribing {
        connected_at: Instant,
        tables_count: usize,
    },
    /// 완전히 연결됨 (정상 운영 상태)
    Connected {
        connected_at: Instant,
        subscribed_tables: usize,
    },
    /// 재연결 대기 중
    Reconnecting {
        attempt: u32,
        next_retry_at: Instant,
        last_error: String,
    },
    /// 에러 발생 (복구 불가)
    Failed { error: String },
}

impl ConnectionState {
    /// 현재 연결됨 상태인지 확인
    pub fn is_connected(&self) -> bool {
        matches!(
            self,
            ConnectionState::Connected { .. }
                | ConnectionState::Subscribing { .. }
                | ConnectionState::Handshaking { .. }
        )
    }

    /// 재연결 가능 상태인지 확인
    pub fn can_reconnect(&self) -> bool {
        matches!(
            self,
            ConnectionState::Disconnected
                | ConnectionState::Reconnecting { .. }
                | ConnectionState::Failed { .. }
        )
    }

    /// 현재 상태 이름 반환
    pub fn state_name(&self) -> &'static str {
        match self {
            ConnectionState::Disconnected => "disconnected",
            ConnectionState::Connecting { .. } => "connecting",
            ConnectionState::Handshaking { .. } => "handshaking",
            ConnectionState::Subscribing { .. } => "subscribing",
            ConnectionState::Connected { .. } => "connected",
            ConnectionState::Reconnecting { .. } => "reconnecting",
            ConnectionState::Failed { .. } => "failed",
        }
    }
}

impl Default for ConnectionState {
    fn default() -> Self {
        ConnectionState::Disconnected
    }
}

/// 상태 전이 이벤트
#[derive(Debug, Clone)]
pub enum StateTransition {
    /// 연결 시작
    StartConnect,
    /// WebSocket 연결 성공
    WebSocketConnected,
    /// 핸드셰이크 완료
    HandshakeComplete,
    /// 테이블 구독 시작
    StartSubscribing { tables_count: usize },
    /// 테이블 구독 완료
    SubscriptionComplete { subscribed_count: usize },
    /// 연결 에러 발생
    Error { message: String },
    /// 킥아웃 발생
    Kickout { reason: String },
    /// 서버에서 연결 종료
    ServerDisconnect,
    /// 사용자 요청 종료
    UserDisconnect,
    /// 재연결 시도
    RetryConnect { attempt: u32 },
}

/// 연결 상태 머신
pub struct ConnectionStateMachine {
    state: ConnectionState,
    max_reconnect_attempts: u32,
    base_reconnect_delay: Duration,
    max_reconnect_delay: Duration,
}

impl ConnectionStateMachine {
    pub fn new() -> Self {
        Self {
            state: ConnectionState::Disconnected,
            max_reconnect_attempts: 5,
            base_reconnect_delay: Duration::from_secs(1),
            max_reconnect_delay: Duration::from_secs(30),
        }
    }

    /// 재연결 설정
    pub fn with_reconnect_config(
        mut self,
        max_attempts: u32,
        base_delay: Duration,
        max_delay: Duration,
    ) -> Self {
        self.max_reconnect_attempts = max_attempts;
        self.base_reconnect_delay = base_delay;
        self.max_reconnect_delay = max_delay;
        self
    }

    /// 현재 상태 반환
    pub fn state(&self) -> &ConnectionState {
        &self.state
    }

    /// 상태 전이 수행
    pub fn transition(&mut self, event: StateTransition) -> Result<&ConnectionState, StateError> {
        let old_state = self.state.state_name();
        let new_state = self.apply_transition(event.clone())?;

        if old_state != new_state.state_name() {
            info!(
                "[StateMachine] State transition: {} -> {} (event: {:?})",
                old_state,
                new_state.state_name(),
                event
            );
        }

        Ok(&self.state)
    }

    /// 상태 전이 적용
    fn apply_transition(&mut self, event: StateTransition) -> Result<&ConnectionState, StateError> {
        self.state = match (&self.state, event) {
            // Disconnected -> Connecting
            (ConnectionState::Disconnected, StateTransition::StartConnect) => {
                ConnectionState::Connecting {
                    started_at: Instant::now(),
                    attempt: 1,
                }
            }

            // Connecting -> Handshaking
            (ConnectionState::Connecting { .. }, StateTransition::WebSocketConnected) => {
                ConnectionState::Handshaking {
                    connected_at: Instant::now(),
                }
            }

            // Handshaking -> Subscribing or Connected
            (ConnectionState::Handshaking { connected_at }, StateTransition::HandshakeComplete) => {
                ConnectionState::Subscribing {
                    connected_at: *connected_at,
                    tables_count: 0,
                }
            }

            // Handshaking -> Subscribing (with tables)
            (
                ConnectionState::Handshaking { connected_at },
                StateTransition::StartSubscribing { tables_count },
            ) => ConnectionState::Subscribing {
                connected_at: *connected_at,
                tables_count,
            },

            // Subscribing -> Connected
            (
                ConnectionState::Subscribing { connected_at, .. },
                StateTransition::SubscriptionComplete { subscribed_count },
            ) => ConnectionState::Connected {
                connected_at: *connected_at,
                subscribed_tables: subscribed_count,
            },

            // Any connected state -> Reconnecting (on error)
            (state, StateTransition::Error { message }) if state.is_connected() => {
                let attempt = match state {
                    ConnectionState::Reconnecting { attempt, .. } => attempt + 1,
                    _ => 1,
                };

                if attempt > self.max_reconnect_attempts {
                    ConnectionState::Failed {
                        error: format!("Max reconnect attempts exceeded: {}", message),
                    }
                } else {
                    let delay = self.calculate_backoff_delay(attempt);
                    ConnectionState::Reconnecting {
                        attempt,
                        next_retry_at: Instant::now() + delay,
                        last_error: message,
                    }
                }
            }

            // Reconnecting -> Connecting
            (
                ConnectionState::Reconnecting { attempt, .. },
                StateTransition::RetryConnect { .. },
            ) => ConnectionState::Connecting {
                started_at: Instant::now(),
                attempt: *attempt,
            },

            // Any state -> Disconnected (on user disconnect)
            (_, StateTransition::UserDisconnect) => ConnectionState::Disconnected,

            // Any state -> Reconnecting (on kickout)
            (_, StateTransition::Kickout { reason }) => {
                warn!("[StateMachine] Kickout received: {}", reason);
                ConnectionState::Reconnecting {
                    attempt: 1,
                    next_retry_at: Instant::now() + self.base_reconnect_delay,
                    last_error: format!("Kickout: {}", reason),
                }
            }

            // Any connected state -> Reconnecting (on server disconnect)
            (state, StateTransition::ServerDisconnect) if state.is_connected() => {
                ConnectionState::Reconnecting {
                    attempt: 1,
                    next_retry_at: Instant::now() + self.base_reconnect_delay,
                    last_error: "Server disconnected".to_string(),
                }
            }

            // Connecting -> Failed (on error)
            (ConnectionState::Connecting { attempt, .. }, StateTransition::Error { message }) => {
                if *attempt >= self.max_reconnect_attempts {
                    ConnectionState::Failed { error: message }
                } else {
                    let delay = self.calculate_backoff_delay(*attempt);
                    ConnectionState::Reconnecting {
                        attempt: *attempt,
                        next_retry_at: Instant::now() + delay,
                        last_error: message,
                    }
                }
            }

            // Failed -> Connecting (allow manual retry)
            (ConnectionState::Failed { .. }, StateTransition::StartConnect) => {
                ConnectionState::Connecting {
                    started_at: Instant::now(),
                    attempt: 1,
                }
            }

            // Invalid transition
            (current, event) => {
                debug!(
                    "[StateMachine] Invalid transition from {:?} with {:?}",
                    current, event
                );
                return Err(StateError::InvalidTransition {
                    from: current.state_name().to_string(),
                    event: format!("{:?}", event),
                });
            }
        };

        Ok(&self.state)
    }

    /// 지수 백오프 딜레이 계산
    fn calculate_backoff_delay(&self, attempt: u32) -> Duration {
        let delay = self.base_reconnect_delay * 2u32.pow(attempt.saturating_sub(1));
        std::cmp::min(delay, self.max_reconnect_delay)
    }

    /// 강제 상태 리셋 (테스트/디버그용)
    pub fn reset(&mut self) {
        self.state = ConnectionState::Disconnected;
    }
}

impl Default for ConnectionStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

/// 상태 전이 에러
#[derive(Debug, Clone)]
pub enum StateError {
    InvalidTransition { from: String, event: String },
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateError::InvalidTransition { from, event } => {
                write!(f, "Invalid transition from {} with event {}", from, event)
            }
        }
    }
}

impl std::error::Error for StateError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let sm = ConnectionStateMachine::new();
        assert_eq!(sm.state().state_name(), "disconnected");
    }

    #[test]
    fn test_normal_connection_flow() {
        let mut sm = ConnectionStateMachine::new();

        // Disconnected -> Connecting
        sm.transition(StateTransition::StartConnect).unwrap();
        assert_eq!(sm.state().state_name(), "connecting");

        // Connecting -> Handshaking
        sm.transition(StateTransition::WebSocketConnected).unwrap();
        assert_eq!(sm.state().state_name(), "handshaking");

        // Handshaking -> Subscribing
        sm.transition(StateTransition::StartSubscribing { tables_count: 10 })
            .unwrap();
        assert_eq!(sm.state().state_name(), "subscribing");

        // Subscribing -> Connected
        sm.transition(StateTransition::SubscriptionComplete {
            subscribed_count: 10,
        })
        .unwrap();
        assert_eq!(sm.state().state_name(), "connected");
    }

    #[test]
    fn test_user_disconnect() {
        let mut sm = ConnectionStateMachine::new();
        sm.transition(StateTransition::StartConnect).unwrap();
        sm.transition(StateTransition::WebSocketConnected).unwrap();

        // User disconnect from any state
        sm.transition(StateTransition::UserDisconnect).unwrap();
        assert_eq!(sm.state().state_name(), "disconnected");
    }

    #[test]
    fn test_error_triggers_reconnect() {
        let mut sm = ConnectionStateMachine::new();
        sm.transition(StateTransition::StartConnect).unwrap();
        sm.transition(StateTransition::WebSocketConnected).unwrap();
        sm.transition(StateTransition::HandshakeComplete).unwrap();
        sm.transition(StateTransition::SubscriptionComplete {
            subscribed_count: 5,
        })
        .unwrap();

        // Error should trigger reconnect
        sm.transition(StateTransition::Error {
            message: "Connection lost".to_string(),
        })
        .unwrap();
        assert_eq!(sm.state().state_name(), "reconnecting");
    }

    #[test]
    fn test_max_reconnect_attempts() {
        // Test that after max_reconnect_attempts, state goes to Failed
        // With max_attempts = 1, the first error from Connecting should fail immediately
        // if attempt >= max_attempts

        let mut sm = ConnectionStateMachine::new().with_reconnect_config(
            1, // Only 1 attempt allowed
            Duration::from_millis(100),
            Duration::from_secs(1),
        );

        // First connection attempt (attempt = 1)
        sm.transition(StateTransition::StartConnect).unwrap();
        assert_eq!(sm.state().state_name(), "connecting");

        // Error when attempt (1) >= max_attempts (1) -> should fail
        sm.transition(StateTransition::Error {
            message: "error".to_string(),
        })
        .unwrap();
        assert_eq!(sm.state().state_name(), "failed");
    }

    #[test]
    fn test_kickout_triggers_reconnect() {
        let mut sm = ConnectionStateMachine::new();
        sm.transition(StateTransition::StartConnect).unwrap();
        sm.transition(StateTransition::WebSocketConnected).unwrap();

        sm.transition(StateTransition::Kickout {
            reason: "duplicate_session".to_string(),
        })
        .unwrap();
        assert_eq!(sm.state().state_name(), "reconnecting");
    }

    #[test]
    fn test_is_connected() {
        let state = ConnectionState::Connected {
            connected_at: Instant::now(),
            subscribed_tables: 5,
        };
        assert!(state.is_connected());

        let state = ConnectionState::Disconnected;
        assert!(!state.is_connected());
    }

    #[test]
    fn test_backoff_delay() {
        let sm = ConnectionStateMachine::new().with_reconnect_config(
            5,
            Duration::from_secs(1),
            Duration::from_secs(30),
        );

        assert_eq!(sm.calculate_backoff_delay(1), Duration::from_secs(1));
        assert_eq!(sm.calculate_backoff_delay(2), Duration::from_secs(2));
        assert_eq!(sm.calculate_backoff_delay(3), Duration::from_secs(4));
        assert_eq!(sm.calculate_backoff_delay(4), Duration::from_secs(8));
        assert_eq!(sm.calculate_backoff_delay(5), Duration::from_secs(16));
        assert_eq!(sm.calculate_backoff_delay(6), Duration::from_secs(30)); // capped
    }
}
