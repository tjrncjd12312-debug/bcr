use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Pragmatic raw message (already JSON) - we detect shape and map to variants
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PragmaticMessage {
    Statistics(StatisticsMessage),
    GameResult(GameResultEnvelope),
    SeatUpdate(SeatUpdateMessage),
    GlobalStats(GlobalStatsMessage),
    PingPong(PingPongMessage),
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatisticsMessage {
    pub table_id: String,
    pub grid: Vec<Vec<String>>,
    pub table_name: Option<String>,
    pub table_type: Option<String>, // e.g., "BACCARAT"
    pub table_subtype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameResultEnvelope {
    pub table_id: String,
    pub result: GameResultEntry,
    pub table_type: Option<String>,
    pub table_name: Option<String>,
    pub table_subtype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameResultEntry {
    pub winner: String,
    pub player_score: Option<i32>,
    pub banker_score: Option<i32>,
    pub player_cards: Vec<String>,
    pub banker_cards: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeatUpdateMessage {
    pub table_id: String,
    pub total_seated: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalStatsMessage {
    pub player_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingPongMessage {
    pub ping_time: i64,
    pub pong_time: i64,
}

/// Parse raw JSON string into a pragmatic message variant based on keys present
pub fn parse_message(raw: &str) -> Option<PragmaticMessage> {
    let value: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!("🎲 Pragmatic parse: JSON parse error: {}", e);
            return None;
        }
    };

    let obj = match value.as_object() {
        Some(o) => o,
        None => {
            tracing::debug!("🎲 Pragmatic parse: not a JSON object");
            return None;
        }
    };

    // Log available keys for debugging
    let keys: Vec<&String> = obj.keys().collect();
    tracing::debug!("🎲 Pragmatic parse: keys={:?}", keys);

    // 1) Statistics grid (table history)
    if let (Some(stat_value), Some(table_id)) = (
        obj.get("statistics"),
        obj.get("tableId").and_then(|v| v.as_str()),
    ) {
        tracing::debug!(
            "🎲 Pragmatic parse: found statistics for tableId={}",
            table_id
        );
        // statistics comes as a JSON string containing a 2D array
        let grid: Option<Vec<Vec<String>>> = if let Some(stat_str) = stat_value.as_str() {
            match serde_json::from_str(stat_str) {
                Ok(g) => Some(g),
                Err(e) => {
                    tracing::debug!("🎲 Pragmatic parse: statistics string parse error: {}", e);
                    None
                }
            }
        } else {
            match serde_json::from_value(stat_value.clone()) {
                Ok(g) => Some(g),
                Err(e) => {
                    tracing::debug!("🎲 Pragmatic parse: statistics value parse error: {}", e);
                    None
                }
            }
        };

        if let Some(grid) = grid {
            tracing::debug!(
                "🎲 Pragmatic parse: statistics grid parsed successfully, rows={}",
                grid.len()
            );
            return Some(PragmaticMessage::Statistics(StatisticsMessage {
                table_id: table_id.to_string(),
                grid,
                table_name: obj
                    .get("tableName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                table_type: obj
                    .get("tableType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                table_subtype: obj
                    .get("tableSubtype")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            }));
        }
    }

    // 2) Game result payload
    if let Some(game_result) = obj.get("gameResult") {
        tracing::debug!(
            "🎲 Pragmatic parse: found gameResult field, value={}",
            game_result
        );
        if let Some(table_id) = obj.get("tableId").and_then(|v| v.as_str()) {
            // Try standard GameResultRaw parsing first
            match serde_json::from_value::<Vec<GameResultRaw>>(game_result.clone()) {
                Ok(mut results) => {
                    tracing::debug!(
                        "🎲 Pragmatic parse: gameResult parsed as array, len={}",
                        results.len()
                    );
                    if let Some(first) = results.pop() {
                        return Some(PragmaticMessage::GameResult(GameResultEnvelope {
                            table_id: table_id.to_string(),
                            result: GameResultEntry {
                                winner: first.winner,
                                player_score: first.player,
                                banker_score: first.banker,
                                player_cards: first.player_cards.unwrap_or_default(),
                                banker_cards: first.banker_cards.unwrap_or_default(),
                            },
                            table_type: obj
                                .get("tableType")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            table_name: obj
                                .get("tableName")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                            table_subtype: obj
                                .get("tableSubtype")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        }));
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "🎲 Pragmatic parse: gameResult parse error: {}, trying flexible parsing",
                        e
                    );
                    // Try flexible parsing for different Pragmatic formats
                    if let Some(result) = parse_game_result_flexible(game_result, table_id, obj) {
                        return Some(result);
                    }
                }
            }
        }
    }

    // 3) Seat counts (not normalized yet, but keep variant for possible UI)
    if let (Some(total), Some(table_id)) = (
        obj.get("totalSeatedPlayers"),
        obj.get("tableId").and_then(|v| v.as_str()),
    ) {
        if let Some(total_num) = total.as_i64() {
            return Some(PragmaticMessage::SeatUpdate(SeatUpdateMessage {
                table_id: table_id.to_string(),
                total_seated: total_num as i32,
            }));
        }
    }

    // 4) Global stats (currently unused)
    if let Some(global_stats) = obj.get("globalStats") {
        if let Some(player_count) = global_stats.get("playerCount").and_then(|v| v.as_i64()) {
            return Some(PragmaticMessage::GlobalStats(GlobalStatsMessage {
                player_count,
            }));
        }
    }

    // 5) Ping/pong heartbeat
    if obj.get("pingTime").is_some() || obj.get("pongTime").is_some() {
        return Some(PragmaticMessage::PingPong(PingPongMessage {
            ping_time: obj
                .get("pingTime")
                .and_then(|v| v.as_i64())
                .unwrap_or_default(),
            pong_time: obj
                .get("pongTime")
                .and_then(|v| v.as_i64())
                .unwrap_or_default(),
        }));
    }

    None
}

// Internal helper for gameResult array parsing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameResultRaw {
    winner: String,
    player: Option<i32>,
    banker: Option<i32>,
    player_cards: Option<Vec<String>>,
    banker_cards: Option<Vec<String>>,
}

/// Flexible game result parsing for various Pragmatic message formats
fn parse_game_result_flexible(
    game_result: &Value,
    table_id: &str,
    obj: &serde_json::Map<String, Value>,
) -> Option<PragmaticMessage> {
    // Handle array format
    if let Some(arr) = game_result.as_array() {
        if let Some(first) = arr.last() {
            return parse_single_game_result(first, table_id, obj);
        }
    }

    // Handle single object format
    if game_result.is_object() {
        return parse_single_game_result(game_result, table_id, obj);
    }

    tracing::debug!("🎲 Pragmatic parse: gameResult is neither array nor object");
    None
}

fn parse_single_game_result(
    result_obj: &Value,
    table_id: &str,
    obj: &serde_json::Map<String, Value>,
) -> Option<PragmaticMessage> {
    // Extract winner - try multiple field names
    let winner = result_obj
        .get("winner")
        .and_then(|v| v.as_str())
        .or_else(|| result_obj.get("result").and_then(|v| v.as_str()))
        .or_else(|| result_obj.get("outcome").and_then(|v| v.as_str()))
        .map(|s| s.to_string())?;

    tracing::debug!("🎲 Pragmatic parse: extracted winner={}", winner);

    // Extract scores - try multiple field names
    let player_score = result_obj
        .get("player")
        .or_else(|| result_obj.get("playerScore"))
        .or_else(|| result_obj.get("playerPoints"))
        .and_then(|v| v.as_i64())
        .map(|n| n as i32);

    let banker_score = result_obj
        .get("banker")
        .or_else(|| result_obj.get("bankerScore"))
        .or_else(|| result_obj.get("bankerPoints"))
        .and_then(|v| v.as_i64())
        .map(|n| n as i32);

    // Extract cards - try multiple field names
    let player_cards = extract_cards(result_obj, &["playerCards", "player_cards", "pCards"]);
    let banker_cards = extract_cards(result_obj, &["bankerCards", "banker_cards", "bCards"]);

    Some(PragmaticMessage::GameResult(GameResultEnvelope {
        table_id: table_id.to_string(),
        result: GameResultEntry {
            winner,
            player_score,
            banker_score,
            player_cards,
            banker_cards,
        },
        table_type: obj
            .get("tableType")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        table_name: obj
            .get("tableName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        table_subtype: obj
            .get("tableSubtype")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }))
}

fn extract_cards(obj: &Value, field_names: &[&str]) -> Vec<String> {
    for field in field_names {
        if let Some(cards) = obj.get(*field) {
            if let Some(arr) = cards.as_array() {
                return arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
            }
        }
    }
    vec![]
}
