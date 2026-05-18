use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Pragmatic raw message (already JSON) - we detect shape and map to variants
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PragmaticMessage {
    TableConfig(Vec<TableConfigMessage>),
    Statistics(StatisticsMessage),
    GameResult(GameResultEnvelope),
    GameState(GameStateMessage),
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
pub struct TableConfigMessage {
    pub table_id: String,
    pub table_name: Option<String>,
    pub table_type: Option<String>,
    pub table_subtype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameStateMessage {
    pub table_id: String,
    pub game_id: Option<String>,
    pub betting_open: Option<bool>,
    pub remaining_seconds: Option<u32>,
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

    // 1) Table metadata. Pragmatic sends this before/alongside statistics; ROSE
    // uses it to show the real lobby names instead of "Baccarat 401".
    let table_configs = parse_table_configs(obj);
    if !table_configs.is_empty() {
        return Some(PragmaticMessage::TableConfig(table_configs));
    }

    // 2) Statistics grid (table history)
    let stat_table_id = string_from_keys(obj, &["tableId", "table", "table_id"]);
    if let (Some(stat_value), Some(table_id)) = (
        obj.get("statistics").or_else(|| obj.get("statistic")),
        stat_table_id.as_deref(),
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
    if let Some(game_result) = obj.get("gameResult").or_else(|| obj.get("gameresult")) {
        tracing::debug!(
            "🎲 Pragmatic parse: found gameResult field, value={}",
            game_result
        );
        if let Some(table_id) = string_from_keys(obj, &["tableId", "table", "table_id"]) {
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
                    if let Some(result) = parse_game_result_flexible(game_result, &table_id, obj) {
                        return Some(result);
                    }
                }
            }
        }
    }

    // 3) Game/betting state. ROSE listens for betsopen/betsclosed/game/timer
    // frames; this keeps native betting synchronized with Pragmatic's current
    // game ID and also drives semi-auto betting phase events.
    if let Some(game_state) = parse_game_state(obj) {
        return Some(PragmaticMessage::GameState(game_state));
    }

    // 4) Seat counts (not normalized yet, but keep variant for possible UI)
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

    // 5) Global stats (currently unused)
    if let Some(global_stats) = obj.get("globalStats") {
        if let Some(player_count) = global_stats.get("playerCount").and_then(|v| v.as_i64()) {
            return Some(PragmaticMessage::GlobalStats(GlobalStatsMessage {
                player_count,
            }));
        }
    }

    // 6) Ping/pong heartbeat
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

fn parse_table_configs(obj: &Map<String, Value>) -> Vec<TableConfigMessage> {
    if obj.contains_key("statistics")
        || obj.contains_key("statistic")
        || obj.contains_key("gameResult")
        || obj.contains_key("gameresult")
        || obj.contains_key("betsopen")
        || obj.contains_key("betsclosed")
        || obj.contains_key("game")
    {
        return Vec::new();
    }

    let mut configs = Vec::new();
    collect_table_configs(&Value::Object(obj.clone()), &mut configs);
    configs
}

fn collect_table_configs(value: &Value, configs: &mut Vec<TableConfigMessage>) {
    match value {
        Value::Object(obj) => {
            if let Some(config) = table_config_from_object(obj) {
                if !configs.iter().any(|item| item.table_id == config.table_id) {
                    configs.push(config);
                }
            }

            for child in obj.values() {
                collect_table_configs(child, configs);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_table_configs(child, configs);
            }
        }
        _ => {}
    }
}

fn table_config_from_object(obj: &Map<String, Value>) -> Option<TableConfigMessage> {
    let nested_table = obj.get("table").and_then(|value| value.as_object());
    let nested_config = obj
        .get("tableconfig")
        .or_else(|| obj.get("tableConfig"))
        .or_else(|| obj.get("table_config"))
        .and_then(|value| value.as_object());
    let nested = nested_config.or(nested_table);

    let table_id = string_from_maps(
        obj,
        nested,
        &[
            "tableId",
            "tableID",
            "tableid",
            "table_id",
            "gameTableId",
            "game_table_id",
            "id",
        ],
    )?;
    let table_name = string_from_maps(
        obj,
        nested,
        &["tableName", "table_name", "name", "title", "label"],
    );
    let table_type = string_from_maps(
        obj,
        nested,
        &["tableType", "table_type", "type", "gameType", "game_type"],
    );
    let table_subtype = string_from_maps(
        obj,
        nested,
        &["tableSubtype", "table_subtype", "subtype", "gameSubType"],
    );

    if table_name.is_none() && table_type.is_none() && table_subtype.is_none() {
        return None;
    }

    Some(TableConfigMessage {
        table_id,
        table_name,
        table_type,
        table_subtype,
    })
}

fn parse_game_state(obj: &Map<String, Value>) -> Option<GameStateMessage> {
    let nested_key = ["betsopen", "betsclosed", "game"]
        .iter()
        .find(|key| obj.contains_key(**key))
        .copied();

    let nested = nested_key
        .and_then(|key| obj.get(key))
        .and_then(|value| value.as_object());

    let table_id = string_from_maps(obj, nested, &["tableId", "table", "table_id"])?;
    let game_id = string_from_maps(
        obj,
        nested,
        &["gameId", "currentGameId", "gId", "id", "game"],
    );

    let betting_open = match nested_key {
        Some("betsopen") => Some(true),
        Some("betsclosed") => Some(false),
        _ => bool_from_maps(obj, nested, &["betsOpen", "bettingOpen", "betOpen"]),
    };
    let remaining_seconds = seconds_from_maps(
        obj,
        nested,
        &[
            "remainingSeconds",
            "bettingTime",
            "bettingTimer",
            "timer",
            "value",
        ],
    );

    if betting_open.is_none() && remaining_seconds.is_none() && game_id.is_none() {
        return None;
    }

    Some(GameStateMessage {
        table_id,
        game_id,
        betting_open,
        remaining_seconds,
    })
}

fn string_from_maps(
    obj: &Map<String, Value>,
    nested: Option<&Map<String, Value>>,
    keys: &[&str],
) -> Option<String> {
    nested
        .and_then(|nested_obj| string_from_keys(nested_obj, keys))
        .or_else(|| string_from_keys(obj, keys))
}

fn string_from_keys(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if let Some(text) = value.as_str() {
                if !text.trim().is_empty() {
                    return Some(text.trim().to_string());
                }
            }
            if let Some(number) = value.as_i64() {
                return Some(number.to_string());
            }
        }
    }
    None
}

fn bool_from_maps(
    obj: &Map<String, Value>,
    nested: Option<&Map<String, Value>>,
    keys: &[&str],
) -> Option<bool> {
    nested
        .and_then(|nested_obj| bool_from_keys(nested_obj, keys))
        .or_else(|| bool_from_keys(obj, keys))
}

fn bool_from_keys(obj: &Map<String, Value>, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(value) = obj.get(*key) {
            if let Some(flag) = value.as_bool() {
                return Some(flag);
            }
            if let Some(text) = value.as_str() {
                match text.trim().to_ascii_lowercase().as_str() {
                    "true" | "open" | "1" => return Some(true),
                    "false" | "closed" | "0" => return Some(false),
                    _ => {}
                }
            }
        }
    }
    None
}

fn seconds_from_maps(
    obj: &Map<String, Value>,
    nested: Option<&Map<String, Value>>,
    keys: &[&str],
) -> Option<u32> {
    nested
        .and_then(|nested_obj| seconds_from_keys(nested_obj, keys))
        .or_else(|| seconds_from_keys(obj, keys))
}

fn seconds_from_keys(obj: &Map<String, Value>, keys: &[&str]) -> Option<u32> {
    for key in keys {
        if let Some(value) = obj.get(*key) {
            let raw = value
                .as_u64()
                .or_else(|| value.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()));

            if let Some(raw) = raw {
                let seconds = if raw > 1000 { raw / 1000 } else { raw };
                return Some(seconds.min(u32::MAX as u64) as u32);
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rose_betsopen_state() {
        let msg = parse_message(
            r#"{"betsopen":{"table":"413","gameId":"GAME-7","value":15000}}"#,
        )
        .expect("message should parse");

        match msg {
            PragmaticMessage::GameState(state) => {
                assert_eq!(state.table_id, "413");
                assert_eq!(state.game_id.as_deref(), Some("GAME-7"));
                assert_eq!(state.betting_open, Some(true));
                assert_eq!(state.remaining_seconds, Some(15));
            }
            other => panic!("unexpected message: {:?}", other),
        }
    }

    #[test]
    fn parses_lowercase_statistic_alias() {
        let msg = parse_message(
            r#"{"tableId":"413","statistic":"[[\"BN\",\"PP\"]]","tableType":"BACCARAT"}"#,
        )
        .expect("message should parse");

        match msg {
            PragmaticMessage::Statistics(stats) => {
                assert_eq!(stats.table_id, "413");
                assert_eq!(stats.grid.len(), 1);
            }
            other => panic!("unexpected message: {:?}", other),
        }
    }
}
