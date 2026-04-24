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
        }
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
