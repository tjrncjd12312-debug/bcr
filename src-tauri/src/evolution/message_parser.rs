//! Evolution Message Parser
//!
//! 수신 메시지를 파싱하여 타입 안전한 이벤트로 변환합니다.
//! handle_message()의 거대한 match 블록을 분리하여 관리합니다.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, warn};

/// 테이블 정보 (availableTables에서 파싱)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub table_id: String,
    pub table_name: Option<String>,
    pub game_type: Option<String>,
    pub roadmap_type: Option<String>,
    pub raw_config: Option<Value>,
}

/// 파싱된 수신 메시지 타입
#[derive(Debug, Clone)]
pub enum IncomingMessage {
    /// 사용 가능한 테이블 목록
    AvailableTables { tables: Vec<TableInfo> },
    /// 게임 결과
    GameResult {
        table_id: Option<String>,
        data: Value,
    },
    /// 게임 상태
    GameState {
        table_id: Option<String>,
        data: Value,
    },
    /// 연결 킥아웃
    Kickout { reason: String },
    /// Pong 응답
    Pong,
    /// 에러 메시지
    Error { message: String, data: Value },
    /// 기타/알 수 없는 메시지
    Other {
        msg_type: String,
        table_id: Option<String>,
        data: Value,
    },
}

/// 메시지 파서
pub struct MessageParser;

impl MessageParser {
    /// 텍스트 메시지를 IncomingMessage로 파싱
    pub fn parse(text: &str) -> Result<IncomingMessage, ParseError> {
        let json: Value =
            serde_json::from_str(text).map_err(|e| ParseError::InvalidJson(e.to_string()))?;

        let msg_type = json
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let args = json.get("args");
        let table_id = Self::extract_table_id(&json);

        match msg_type.as_str() {
            // Pong 응답
            "pong" => Ok(IncomingMessage::Pong),

            // 게임 결과
            "game.result" | "baccarat.result" | "baccarat.gameResult" | "baccarat.resolved" => {
                Ok(IncomingMessage::GameResult {
                    table_id,
                    data: json,
                })
            }

            // 게임 상태
            "game.state" | "baccarat.state" => Ok(IncomingMessage::GameState {
                table_id,
                data: json,
            }),

            // 킥아웃
            "connection.kickout" | "connectionAlreadyExists" => {
                let reason = args
                    .and_then(|a| a.get("reason"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                Ok(IncomingMessage::Kickout { reason })
            }

            // 에러
            "error" => {
                let message = args
                    .and_then(|a| a.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error")
                    .to_string();
                Ok(IncomingMessage::Error {
                    message,
                    data: json,
                })
            }

            // 사용 가능한 테이블 (widget.availableTables)
            "widget.availableTables" => {
                let tables = Self::parse_available_tables(&json);
                Ok(IncomingMessage::AvailableTables { tables })
            }

            // 기타 메시지
            _ => Ok(IncomingMessage::Other {
                msg_type,
                table_id,
                data: json,
            }),
        }
    }

    /// JSON에서 테이블 ID 추출 (여러 필드명 지원)
    pub fn extract_table_id(json: &Value) -> Option<String> {
        // args 내부에서 먼저 찾기
        if let Some(args) = json.get("args") {
            if let Some(id) = args
                .get("tableId")
                .or_else(|| args.get("table_id"))
                .or_else(|| args.get("table"))
                .and_then(|v| v.as_str())
            {
                return Some(id.to_string());
            }
        }

        // 최상위에서 찾기
        json.get("tableId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// availableTables 메시지에서 테이블 정보 파싱
    fn parse_available_tables(json: &Value) -> Vec<TableInfo> {
        let tables_array = json
            .get("args")
            .and_then(|a| a.get("availableTables"))
            .and_then(|t| t.as_array());

        match tables_array {
            Some(tables) => tables.iter().filter_map(Self::parse_single_table).collect(),
            None => {
                warn!("[MessageParser] availableTables array not found in message");
                vec![]
            }
        }
    }

    /// 단일 테이블 정보 파싱
    fn parse_single_table(table: &Value) -> Option<TableInfo> {
        let table_id = table.get("tableId")?.as_str()?.to_string();
        let table_name = table
            .get("tableName")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string());

        let config = table.get("config");

        // gameType 추출 (여러 경로 지원)
        let game_type = config.and_then(|c| {
            c.get("gameType")
                .or_else(|| c.get("game_type"))
                .or_else(|| c.get("game").and_then(|g| g.get("gameType")))
                .or_else(|| c.get("game").and_then(|g| g.get("game_type")))
                .or_else(|| c.get("tableCategory"))
                .or_else(|| c.get("table_category"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

        // roadmapType 추출
        let roadmap_type = config.and_then(|c| {
            c.get("roadmapType")
                .or_else(|| c.get("roadmap_type"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

        Some(TableInfo {
            table_id,
            table_name,
            game_type,
            roadmap_type,
            raw_config: config.cloned(),
        })
    }

    /// UTF-8 안전한 문자열 자르기
    pub fn truncate_str(s: &str, max_bytes: usize) -> &str {
        if s.len() <= max_bytes {
            return s;
        }
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        &s[..end]
    }

    /// 디버그용 메시지 로깅
    pub fn log_message(text: &str, msg_count: u64) {
        if text.len() < 500 {
            debug!("[MessageParser] 📨 MSG#{} Raw: {}", msg_count, text);
        } else {
            debug!(
                "[MessageParser] 📨 MSG#{} Raw (truncated): {}...",
                msg_count,
                Self::truncate_str(text, 500)
            );
        }
    }
}

/// 파싱 에러
#[derive(Debug, Clone)]
pub enum ParseError {
    InvalidJson(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::InvalidJson(e) => write!(f, "Invalid JSON: {}", e),
        }
    }
}

impl std::error::Error for ParseError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pong() {
        let msg = r#"{"type":"pong"}"#;
        let result = MessageParser::parse(msg).unwrap();
        assert!(matches!(result, IncomingMessage::Pong));
    }

    #[test]
    fn test_parse_game_result() {
        let msg = r#"{"type":"game.result","args":{"tableId":"table-123","winner":"player"}}"#;
        let result = MessageParser::parse(msg).unwrap();
        match result {
            IncomingMessage::GameResult { table_id, .. } => {
                assert_eq!(table_id, Some("table-123".to_string()));
            }
            _ => panic!("Expected GameResult"),
        }
    }

    #[test]
    fn test_parse_kickout() {
        let msg = r#"{"type":"connection.kickout","args":{"reason":"duplicate_session"}}"#;
        let result = MessageParser::parse(msg).unwrap();
        match result {
            IncomingMessage::Kickout { reason } => {
                assert_eq!(reason, "duplicate_session");
            }
            _ => panic!("Expected Kickout"),
        }
    }

    #[test]
    fn test_parse_available_tables() {
        let msg = r#"{
            "type": "widget.availableTables",
            "args": {
                "availableTables": [
                    {"tableId": "t1", "tableName": "Baccarat A", "config": {"gameType": "baccarat"}},
                    {"tableId": "t2", "tableName": "Speed Bac", "config": {"gameType": "speedBaccarat"}}
                ]
            }
        }"#;
        let result = MessageParser::parse(msg).unwrap();
        match result {
            IncomingMessage::AvailableTables { tables } => {
                assert_eq!(tables.len(), 2);
                assert_eq!(tables[0].table_id, "t1");
                assert_eq!(tables[0].table_name, Some("Baccarat A".to_string()));
                assert_eq!(tables[0].game_type, Some("baccarat".to_string()));
            }
            _ => panic!("Expected AvailableTables"),
        }
    }

    #[test]
    fn test_extract_table_id_from_args() {
        let json: Value = serde_json::from_str(r#"{"args":{"tableId":"test-table"}}"#).unwrap();
        assert_eq!(
            MessageParser::extract_table_id(&json),
            Some("test-table".to_string())
        );
    }

    #[test]
    fn test_extract_table_id_from_top_level() {
        let json: Value = serde_json::from_str(r#"{"tableId":"top-level-table"}"#).unwrap();
        assert_eq!(
            MessageParser::extract_table_id(&json),
            Some("top-level-table".to_string())
        );
    }

    #[test]
    fn test_truncate_str_utf8_safe() {
        let korean = "한글테스트입니다";
        // 한글은 3바이트씩
        let truncated = MessageParser::truncate_str(korean, 6);
        assert_eq!(truncated, "한글"); // 6바이트 = 2글자
    }

    #[test]
    fn test_parse_invalid_json() {
        let msg = "not a json";
        let result = MessageParser::parse(msg);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_unknown_type() {
        let msg = r#"{"type":"custom.event","args":{"data":123}}"#;
        let result = MessageParser::parse(msg).unwrap();
        match result {
            IncomingMessage::Other { msg_type, .. } => {
                assert_eq!(msg_type, "custom.event");
            }
            _ => panic!("Expected Other"),
        }
    }
}
