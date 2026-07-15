//! Evolution Protocol Message Types
//!
//! 브라우저 초기화 시퀀스 및 송신 메시지 타입을 정의합니다.
//! 하드코딩된 JSON 메시지들을 타입 안전하게 관리합니다.

use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 송신 메시지 타입
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OutgoingMessage {
    /// 소켓 연결 완료 알림 (최초 연결 시)
    #[serde(rename = "log")]
    ConnectionEstablished {
        #[serde(rename = "log")]
        log: ConnectionEstablishedLog,
    },
    /// 멀티플레이 채널 구독
    Subscribe {
        #[serde(rename = "subscribe")]
        subscribe: SubscribeArgs,
    },
    /// 게임 테이블 열기
    #[serde(rename = "widget.game.open")]
    GameOpen { id: String, args: TableIdArgs },
    /// 테이블 구독
    #[serde(rename = "widget.subscribeTable")]
    SubscribeTable { id: String, args: TableIdArgs },
    /// 하트비트 핑
    #[serde(rename = "metrics.ping")]
    MetricsPing { id: String, args: MetricsPingArgs },
}

/// CONNECTION_ESTABLISHED 로그 구조
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEstablishedLog {
    #[serde(rename = "type")]
    pub log_type: String,
    pub value: ConnectionEstablishedValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEstablishedValue {
    pub reconnection_count: u32,
    pub channel: String,
    pub orientation: String,
}

/// Subscribe 인자
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeArgs {
    pub force_close_existing_connection: bool,
}

/// 테이블 ID 인자 (game.open, subscribeTable 공통)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableIdArgs {
    pub table_id: String,
}

/// metrics.ping 인자
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsPingArgs {
    pub t: u128,
}

/// 프로토콜 시퀀스 빌더
///
/// Evolution 서버와 통신 시 필요한 메시지 시퀀스를 생성합니다.
pub struct ProtocolSequence;

impl ProtocolSequence {
    /// 멀티위젯 연결 시 초기화 시퀀스 생성
    ///
    /// 브라우저가 보내는 순서와 정확히 일치해야 합니다:
    /// 1. CLIENT_SOCKET_CONNECTION_ESTABLISHED
    /// 2. subscribe (forceCloseExistingConnection: false)
    pub fn init_multiwidget() -> Vec<Value> {
        vec![
            Self::connection_established(0, "PCMac", "landscape"),
            Self::subscribe(false),
        ]
    }

    /// Lobby v2 초기화 시퀀스.
    ///
    /// Evolution이 멀티테이블 피드를 lobby v2(/public/lobby/socket/v2/)로 통합한 뒤,
    /// 브라우저는 연결 직후 `lobby.initLobby`(version 2 + features)를 보내 자신을 유효한
    /// 로비 구독자로 등록한다. 이걸 보내지 않으면 서버가 초기 스냅샷만 흘려보낸 뒤
    /// 잠시 후 연결을 끊어버려 "재연결 시도 중" 루프에 빠진다(v2 실트래픽으로 확인).
    pub fn init_lobby_v2() -> Vec<Value> {
        vec![Self::lobby_init_v2()]
    }

    /// `lobby.initLobby` 메시지 생성 — 브라우저가 보내는 실제 형식과 동일.
    /// features는 lobby v2 URL의 `features=` 쿼리 파라미터와 일치(client_version 6.2026 기준).
    pub fn lobby_init_v2() -> Value {
        serde_json::json!({
            "id": Self::generate_random_id(),
            "type": "lobby.initLobby",
            "args": {
                "version": 2,
                "features": [
                    "opensAt",
                    "multipleHero",
                    "shortThumbnails",
                    "skipInfosPublished",
                    "smc",
                    "uniRouletteHistory",
                    "bacHistoryV2",
                    "filters",
                    "tableDecorations",
                    "subscriptionModel"
                ]
            }
        })
    }

    /// lobby v2 `lobby.subscribe` — 구독한 테이블만 서버가 per-table 결과/히스토리/gameId를 push한다
    /// (initLobby features의 subscriptionModel). 브라우저 송신 캡처(2026-06-10)로 형식 확인:
    /// `{id, type:"lobby.subscribe", args:{tables:["onokyd4wn7uekbjx", ...]}}` — 평문 ID 배열.
    pub fn lobby_subscribe(table_ids: &[String]) -> Value {
        serde_json::json!({
            "id": Self::generate_random_id(),
            "type": "lobby.subscribe",
            "args": { "tables": table_ids }
        })
    }

    /// CONNECTION_ESTABLISHED 메시지 생성
    pub fn connection_established(
        reconnection_count: u32,
        channel: &str,
        orientation: &str,
    ) -> Value {
        serde_json::json!({
            "log": {
                "type": "CLIENT_SOCKET_CONNECTION_ESTABLISHED",
                "value": {
                    "reconnectionCount": reconnection_count,
                    "channel": channel,
                    "orientation": orientation
                }
            }
        })
    }

    /// Subscribe 메시지 생성
    pub fn subscribe(force_close_existing: bool) -> Value {
        serde_json::json!({
            "subscribe": {
                "forceCloseExistingConnection": force_close_existing
            }
        })
    }

    /// widget.game.open 메시지 생성
    pub fn game_open(table_id: &str) -> Value {
        serde_json::json!({
            "id": Self::generate_random_id(),
            "type": "widget.game.open",
            "args": {
                "tableId": table_id
            }
        })
    }

    /// widget.subscribeTable 메시지 생성
    pub fn subscribe_table(table_id: &str) -> Value {
        serde_json::json!({
            "id": Self::generate_random_id(),
            "type": "widget.subscribeTable",
            "args": {
                "tableId": table_id
            }
        })
    }

    /// metrics.ping 메시지 생성
    pub fn metrics_ping() -> Value {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        serde_json::json!({
            "id": Self::generate_random_id(),
            "type": "metrics.ping",
            "args": {
                "t": timestamp
            }
        })
    }

    /// lobby v2 앱-레벨 keepalive PING.
    /// 브라우저가 lobby 소켓으로 1.5~2초마다 보내는 `{"eventType":"PING","requestId":N,"requestTimestamp":ms}`.
    /// 서버는 이걸 "세션 활성" 신호로 쓴다. metrics.ping/게임데이터가 계속 흘러도 이 PING이 없으면
    /// 서버가 ~10분 뒤 세션을 inactivity로 만료(server_closed→재연결 시 KICKOUT:inactivity)한다.
    /// 따라서 Rust도 주기적으로 보내야 세션이 유지된다(inactivity 킥 방지).
    pub fn lobby_ping() -> Value {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        // 브라우저 requestId는 16자리 내외의 큰 정수 — 동일 형태로 랜덤 생성.
        let request_id: u64 =
            rand::thread_rng().gen_range(1_000_000_000_000_000u64..9_999_999_999_999_999u64);
        serde_json::json!({
            "eventType": "PING",
            "requestId": request_id,
            "requestTimestamp": timestamp
        })
    }

    /// 랜덤 ID 생성 (브라우저 패턴과 동일)
    pub fn generate_random_id() -> String {
        (0..10)
            .map(|_| {
                let idx = rand::thread_rng().gen_range(0..36usize);
                if idx < 10 {
                    (b'0' + idx as u8) as char
                } else {
                    (b'a' + (idx - 10) as u8) as char
                }
            })
            .collect()
    }

    /// 인스턴스 ID 프리픽스 생성 (6자리 랜덤)
    pub fn generate_instance_prefix() -> String {
        (0..6)
            .map(|_| {
                let idx = rand::thread_rng().gen_range(0..36usize);
                if idx < 10 {
                    (b'0' + idx as u8) as char
                } else {
                    (b'a' + (idx - 10) as u8) as char
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_connection_established_format() {
        let msg = ProtocolSequence::connection_established(0, "PCMac", "landscape");
        let log = msg.get("log").expect("should have log field");
        assert_eq!(
            log.get("type").and_then(|v| v.as_str()),
            Some("CLIENT_SOCKET_CONNECTION_ESTABLISHED")
        );
        let value = log.get("value").expect("should have value");
        assert_eq!(
            value.get("reconnectionCount").and_then(|v| v.as_u64()),
            Some(0)
        );
        assert_eq!(value.get("channel").and_then(|v| v.as_str()), Some("PCMac"));
    }

    #[test]
    fn test_subscribe_format() {
        let msg = ProtocolSequence::subscribe(false);
        let subscribe = msg.get("subscribe").expect("should have subscribe field");
        assert_eq!(
            subscribe
                .get("forceCloseExistingConnection")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn test_game_open_format() {
        let msg = ProtocolSequence::game_open("test-table-123");
        assert_eq!(
            msg.get("type").and_then(|v| v.as_str()),
            Some("widget.game.open")
        );
        let args = msg.get("args").expect("should have args");
        assert_eq!(
            args.get("tableId").and_then(|v| v.as_str()),
            Some("test-table-123")
        );
        assert!(msg.get("id").and_then(|v| v.as_str()).is_some());
    }

    #[test]
    fn test_metrics_ping_format() {
        let msg = ProtocolSequence::metrics_ping();
        assert_eq!(
            msg.get("type").and_then(|v| v.as_str()),
            Some("metrics.ping")
        );
        let args = msg.get("args").expect("should have args");
        assert!(args.get("t").and_then(|v| v.as_u64()).is_some());
    }

    #[test]
    fn test_random_id_length() {
        let id = ProtocolSequence::generate_random_id();
        assert_eq!(id.len(), 10);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_init_multiwidget_sequence() {
        let sequence = ProtocolSequence::init_multiwidget();
        assert_eq!(sequence.len(), 2);

        // First message should be connection established
        assert!(sequence[0].get("log").is_some());

        // Second message should be subscribe
        assert!(sequence[1].get("subscribe").is_some());
    }
}
