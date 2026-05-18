use super::parser::{
    GameResultEntry, GameStateMessage, PragmaticMessage, StatisticsMessage, TableConfigMessage,
};
use serde::{Deserialize, Serialize};

// Unified Event structure for Frontend (Evolution compatible)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum CasinoEvent {
    #[serde(rename = "room_update")]
    RoomUpdate(Vec<NormalizedRoom>),

    #[serde(rename = "game_result")]
    GameResult(NormalizedGameResult),

    #[serde(rename = "betting_phase")]
    BettingPhase(NormalizedBettingPhase),

    #[serde(rename = "balance_update")]
    BalanceUpdate(NormalizedBalanceUpdate),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedRoom {
    pub id: String,
    pub name: String,
    pub history: Vec<NormalizedRoadResult>,
    pub status: String,
    #[serde(default)]
    pub table_type: Option<String>,
    #[serde(default)]
    pub table_subtype: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedRoadResult {
    pub winner: String, // "B", "P", "T"
    #[serde(default)]
    pub is_player_pair: bool,
    #[serde(default)]
    pub is_banker_pair: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedGameResult {
    pub room_id: String,
    pub winner: String, // "B", "P", "T"
    #[serde(default)]
    pub table_type: Option<String>,
    #[serde(default)]
    pub table_subtype: Option<String>,
    #[serde(default)]
    pub table_name: Option<String>,
    #[serde(default)]
    pub player_score: Option<i32>,
    #[serde(default)]
    pub banker_score: Option<i32>,
    #[serde(default)]
    pub is_player_pair: bool,
    #[serde(default)]
    pub is_banker_pair: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedBettingPhase {
    pub room_id: String,
    pub remaining_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedBalanceUpdate {
    pub balance: f64,
    pub currency: String,
}

pub fn normalize_message(msg: PragmaticMessage) -> Option<CasinoEvent> {
    match msg {
        PragmaticMessage::TableConfig(data) => normalize_table_configs(data).map(CasinoEvent::RoomUpdate),
        PragmaticMessage::Statistics(data) => {
            tracing::debug!(
                "🎲 Normalizer: processing Statistics for tableId={}",
                data.table_id
            );
            normalize_statistics(data).map(CasinoEvent::RoomUpdate)
        }
        PragmaticMessage::GameResult(data) => {
            tracing::debug!(
                "🎲 Normalizer: processing GameResult for tableId={}, winner={}",
                data.table_id,
                data.result.winner
            );
            normalize_game_result(
                &data.table_id,
                data.result,
                data.table_type,
                data.table_subtype,
                data.table_name,
            )
        }
        PragmaticMessage::GameState(data) => normalize_game_state(data),
        PragmaticMessage::SeatUpdate(data) => {
            tracing::debug!(
                "🎲 Normalizer: ignoring SeatUpdate for tableId={}",
                data.table_id
            );
            None
        }
        PragmaticMessage::GlobalStats(data) => {
            tracing::debug!(
                "🎲 Normalizer: ignoring GlobalStats player_count={}",
                data.player_count
            );
            None
        }
        PragmaticMessage::PingPong(_) => {
            tracing::debug!("🎲 Normalizer: ignoring PingPong");
            None
        }
        PragmaticMessage::Unknown => {
            tracing::debug!("🎲 Normalizer: ignoring Unknown message");
            None
        }
    }
}

fn normalize_table_configs(data: Vec<TableConfigMessage>) -> Option<Vec<NormalizedRoom>> {
    let rooms: Vec<NormalizedRoom> = data
        .into_iter()
        .filter(|config| {
            is_baccarat(
                config.table_type.as_deref(),
                config.table_subtype.as_deref(),
                config.table_name.as_deref(),
            )
        })
        .map(|config| {
            let name = infer_room_name(&config.table_id, config.table_name.clone());
            NormalizedRoom {
                id: config.table_id,
                name,
                history: Vec::new(),
                status: "active".to_string(),
                table_type: config.table_type,
                table_subtype: config.table_subtype,
            }
        })
        .collect();

    (!rooms.is_empty()).then_some(rooms)
}

fn normalize_game_state(data: GameStateMessage) -> Option<CasinoEvent> {
    let remaining_seconds = data.remaining_seconds.unwrap_or_else(|| {
        if data.betting_open == Some(true) {
            15
        } else {
            0
        }
    });

    if data.betting_open.is_some() || data.remaining_seconds.is_some() {
        return Some(CasinoEvent::BettingPhase(NormalizedBettingPhase {
            room_id: data.table_id,
            remaining_seconds,
        }));
    }

    None
}

fn normalize_statistics(data: StatisticsMessage) -> Option<Vec<NormalizedRoom>> {
    let is_valid = is_baccarat(
        data.table_type.as_deref(),
        data.table_subtype.as_deref(),
        data.table_name.as_deref(),
    );
    if !is_valid {
        tracing::debug!(
            "🎲 Normalizer: Statistics filtered (not baccarat): type={:?}, subtype={:?}, name={:?}",
            data.table_type,
            data.table_subtype,
            data.table_name
        );
        return None;
    }

    let history = parse_statistics_grid(&data.grid);
    let name = infer_room_name(&data.table_id, data.table_name.clone());

    tracing::debug!(
        "🎲 Normalizer: Statistics normalized - id={}, name={}, history_len={}",
        data.table_id,
        name,
        history.len()
    );

    Some(vec![NormalizedRoom {
        id: data.table_id.clone(),
        name,
        history,
        status: "active".to_string(),
        table_type: data.table_type.clone(),
        table_subtype: data.table_subtype.clone(),
    }])
}

fn normalize_game_result(
    room_id: &str,
    result: GameResultEntry,
    table_type: Option<String>,
    table_subtype: Option<String>,
    table_name: Option<String>,
) -> Option<CasinoEvent> {
    let is_valid = is_baccarat(
        table_type.as_deref(),
        table_subtype.as_deref(),
        table_name.as_deref(),
    );
    if !is_valid {
        tracing::debug!(
            "🎲 Normalizer: GameResult filtered (not baccarat): type={:?}, subtype={:?}, name={:?}",
            table_type,
            table_subtype,
            table_name
        );
        return None;
    }

    let normalized_winner = normalize_winner(&result.winner);
    tracing::debug!(
        "🎲 Normalizer: GameResult normalized - room={}, winner={} (raw={})",
        room_id,
        normalized_winner,
        result.winner
    );

    Some(CasinoEvent::GameResult(NormalizedGameResult {
        room_id: room_id.to_string(),
        winner: normalized_winner,
        table_type,
        table_subtype,
        table_name,
        player_score: result.player_score,
        banker_score: result.banker_score,
        is_player_pair: has_pair(&result.player_cards),
        is_banker_pair: has_pair(&result.banker_cards),
    }))
}

fn parse_statistics_grid(grid: &[Vec<String>]) -> Vec<NormalizedRoadResult> {
    let mut results: Vec<NormalizedRoadResult> = Vec::new();

    // Pragmatic statistics grid: outer = columns, inner = rows (6)
    for column in grid {
        for cell in column {
            let trimmed = cell.trim();
            if trimmed.is_empty() || trimmed == "---" {
                continue;
            }
            let parsed = parse_bead_cell(trimmed);
            results.extend(parsed);
        }
    }

    // Reverse so the latest result is first (UI expects newest-first)
    results.into_iter().rev().collect()
}

fn parse_bead_cell(code: &str) -> Vec<NormalizedRoadResult> {
    if code.len() < 2 {
        return vec![];
    }

    let mut chars = code.chars();
    let winner_char = chars.next().unwrap_or('T');
    let pair_char = chars.next().unwrap_or('N');
    let tie_count: usize = chars.as_str().parse::<usize>().unwrap_or(0);

    let winner = match winner_char {
        'B' | 'b' => "B".to_string(),
        'P' | 'p' => "P".to_string(),
        'T' | 't' => "T".to_string(),
        _ => "T".to_string(),
    };

    let is_player_pair = matches!(pair_char, 'P' | 'p' | 'E' | 'e');
    let is_banker_pair = matches!(pair_char, 'B' | 'b' | 'E' | 'e');

    let mut entries = Vec::new();
    entries.push(NormalizedRoadResult {
        winner: winner.clone(),
        is_player_pair,
        is_banker_pair,
    });

    // Ties in the bead cell are encoded as trailing digits; append as separate results
    for _ in 0..tie_count {
        entries.push(NormalizedRoadResult {
            winner: "T".to_string(),
            is_player_pair: false,
            is_banker_pair: false,
        });
    }

    entries
}

fn normalize_winner(winner: &str) -> String {
    let lower = winner.to_lowercase();
    if lower.contains("banker") {
        "B".to_string()
    } else if lower.contains("player") {
        "P".to_string()
    } else if lower.contains("tie") {
        "T".to_string()
    } else {
        "T".to_string()
    }
}

fn is_baccarat(
    table_type: Option<&str>,
    table_subtype: Option<&str>,
    table_name: Option<&str>,
) -> bool {
    tracing::debug!(
        "🎲 is_baccarat check: type={:?}, subtype={:?}, name={:?}",
        table_type,
        table_subtype,
        table_name
    );

    // If explicit type/subtype is provided and says "Baccarat", allow.
    if let Some(tt) = table_type {
        let upper = tt.to_uppercase();
        if upper.contains("BACCARAT") || upper.contains("BAC") {
            tracing::debug!("🎲 is_baccarat: true (tableType contains BAC/BACCARAT)");
            return true;
        }
        // If type provided but not baccarat, treat as non-baccarat.
        tracing::debug!(
            "🎲 is_baccarat: false (tableType={} doesn't contain BACCARAT)",
            tt
        );
        return false;
    }
    if let Some(st) = table_subtype {
        let upper = st.to_uppercase();
        if upper.contains("BACCARAT") || upper.contains("BAC") {
            tracing::debug!("🎲 is_baccarat: true (tableSubtype contains BAC/BACCARAT)");
            return true;
        }
        // subtype provided but not baccarat → drop.
        tracing::debug!(
            "🎲 is_baccarat: false (tableSubtype={} doesn't contain BACCARAT)",
            st
        );
        return false;
    }
    // Check tableName for "baccarat" (English) or "바카라" (Korean)
    if let Some(name) = table_name {
        let lower = name.to_lowercase();
        if lower.contains("baccarat") || lower.contains("bac") || name.contains("바카라") {
            tracing::debug!("🎲 is_baccarat: true (tableName contains bac/바카라)");
            return true;
        }
    }
    // No type info → allow by default (to avoid dropping valid baccarat tables lacking metadata)
    tracing::debug!("🎲 is_baccarat: true (no type info, allowing by default)");
    true
}

fn infer_room_name(table_id: &str, table_name: Option<String>) -> String {
    if let Some(name) = table_name {
        if !name.trim().is_empty() {
            return name;
        }
    }

    let digits: String = table_id.chars().filter(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        return format!("Baccarat {}", digits);
    }

    table_id.to_string()
}

fn has_pair(cards: &[String]) -> bool {
    if cards.len() < 2 {
        return false;
    }

    let rank_a = cards.get(0).and_then(|c| c.chars().next());
    let rank_b = cards.get(1).and_then(|c| c.chars().next());

    match (rank_a, rank_b) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}
