//! Evolution Domain Events
//!
//! 네트워크 계층에서 발생하는 이벤트를 정의합니다.
//! Clean Architecture: 도메인 이벤트는 UI/인프라 계층에 의존하지 않습니다.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Evolution WebSocket에서 발생하는 도메인 이벤트
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EvolutionEvent {
    /// WebSocket 연결 성공
    Connected { url: String, is_multiwidget: bool },

    /// WebSocket 연결 해제
    Disconnected {
        url: String,
        reason: DisconnectReason,
    },

    /// 연결 에러 발생
    Error {
        url: String,
        error: String,
        error_detail: Option<String>,
    },

    /// 사용 가능한 테이블 목록 수신
    TablesAvailable { tables: Vec<TableSummary> },

    /// 테이블 구독 완료
    RoomsReady {
        room_count: usize,
        total_available: usize,
    },

    /// 게임 결과 수신
    GameResult { table_id: String, data: Value },

    /// 게임 상태 업데이트
    GameState { table_id: String, data: Value },

    /// 킥아웃 발생
    Kickout { reason: String },

    /// 기타 테이블 이벤트
    TableEvent {
        table_id: Option<String>,
        event_type: String,
        data: Value,
    },

    /// 자동 재연결 시도 중
    ReconnectAttempt {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        reason: String,
    },

    /// 원시 메시지 (디버깅/로깅용)
    RawMessage { event_type: String, payload: Value },
}

/// 연결 해제 사유
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DisconnectReason {
    /// 정상 종료
    Normal,
    /// 사용자 요청에 의한 종료
    UserRequested,
    /// 서버에서 연결 종료
    ServerClosed,
    /// 킥아웃 (중복 세션 등)
    Kickout(String),
    /// 네트워크 에러
    NetworkError(String),
    /// 재연결 시도 중
    Reconnecting,
    /// 서버로부터 수신 타임아웃 (좀비 연결 감지)
    ReceiveTimeout,
    /// 멀티위젯 암복호 키 불일치 (복호 실패 또는 서버의 1007/1003 거부).
    ///
    /// **절대 재연결하지 않는다.** 키가 틀린 채로 재접속하면 규격 위반 프레임을 반복 전송하게 되고,
    /// Evolution이 이를 어뷰징으로 보고 세션을 무효화(`notAuthorised`)한 뒤 계정이 차단된다
    /// (2026-08-31 라이브에서 13초 내 3회 재연결 → 밴 확인). 크립토 시크릿 재추출이 유일한 복구다.
    CryptoMismatch(String),
}

impl DisconnectReason {
    pub fn as_str(&self) -> String {
        match self {
            DisconnectReason::Normal => "normal".to_string(),
            DisconnectReason::UserRequested => "user_requested".to_string(),
            DisconnectReason::ServerClosed => "server_closed".to_string(),
            DisconnectReason::Kickout(reason) => format!("kickout:{}", reason),
            DisconnectReason::NetworkError(err) => format!("network_error:{}", err),
            DisconnectReason::Reconnecting => "reconnecting".to_string(),
            DisconnectReason::ReceiveTimeout => "receive_timeout".to_string(),
            DisconnectReason::CryptoMismatch(detail) => format!("crypto_mismatch:{}", detail),
        }
    }

    /// 자동 재연결을 시도해야 하는 사유인지 확인
    pub fn should_auto_reconnect(&self) -> bool {
        matches!(
            self,
            DisconnectReason::ServerClosed
                | DisconnectReason::NetworkError(_)
                | DisconnectReason::ReceiveTimeout
        )
    }
}

/// 테이블 요약 정보 (이벤트용 경량 구조체)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSummary {
    pub table_id: String,
    pub table_name: Option<String>,
    pub game_type: Option<String>,
}

impl From<&super::message_parser::TableInfo> for TableSummary {
    fn from(info: &super::message_parser::TableInfo) -> Self {
        Self {
            table_id: info.table_id.clone(),
            table_name: info.table_name.clone(),
            game_type: info.game_type.clone(),
        }
    }
}

/// 이벤트 송신자 타입 별칭
pub type EventSender = tokio::sync::mpsc::Sender<EvolutionEvent>;
/// 이벤트 수신자 타입 별칭
pub type EventReceiver = tokio::sync::mpsc::Receiver<EvolutionEvent>;

/// 이벤트 채널 생성
pub fn create_event_channel(buffer_size: usize) -> (EventSender, EventReceiver) {
    tokio::sync::mpsc::channel(buffer_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_disconnect_reason_as_str() {
        assert_eq!(DisconnectReason::Normal.as_str(), "normal");
        assert_eq!(DisconnectReason::UserRequested.as_str(), "user_requested");
        assert_eq!(
            DisconnectReason::Kickout("duplicate".to_string()).as_str(),
            "kickout:duplicate"
        );
        assert_eq!(
            DisconnectReason::CryptoMismatch("flag 207".to_string()).as_str(),
            "crypto_mismatch:flag 207"
        );
    }

    /// 키가 틀린 채 재연결하면 규격 위반 프레임을 반복 전송해 계정이 밴된다
    /// (2026-08-31 라이브: 13초 내 3회 재연결 → notAuthorised → 차단).
    /// 이 회귀 방어가 깨지면 밴이 재발하므로 반드시 유지한다.
    #[test]
    fn crypto_mismatch_never_auto_reconnects() {
        assert!(
            !DisconnectReason::CryptoMismatch("frame decrypt failed".to_string())
                .should_auto_reconnect()
        );
        // 킥아웃도 재연결 금지. 반대로 일시적 네트워크 오류는 재연결 대상이어야 한다.
        assert!(!DisconnectReason::Kickout("notAuthorised".to_string()).should_auto_reconnect());
        assert!(DisconnectReason::NetworkError("timeout".to_string()).should_auto_reconnect());
        assert!(DisconnectReason::ServerClosed.should_auto_reconnect());
    }

    #[test]
    fn test_event_serialization() {
        let event = EvolutionEvent::Connected {
            url: "wss://example.com".to_string(),
            is_multiwidget: true,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("connected"));
        assert!(json.contains("wss://example.com"));
    }

    #[test]
    fn test_table_summary_from_table_info() {
        use super::super::message_parser::TableInfo;

        let info = TableInfo {
            table_id: "t1".to_string(),
            table_name: Some("Baccarat A".to_string()),
            game_type: Some("baccarat".to_string()),
            roadmap_type: None,
            raw_config: None,
        };

        let summary: TableSummary = (&info).into();
        assert_eq!(summary.table_id, "t1");
        assert_eq!(summary.table_name, Some("Baccarat A".to_string()));
    }
}
