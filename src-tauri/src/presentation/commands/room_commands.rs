//! Room Commands
//!
//! Tauri commands for room management
//!
//! ⚠️ 주의: 프론트엔드 SSOT 전략 적용
//! 이 API들은 Rust 내부 상태를 반환하며, 프론트엔드 상태와 동기화되지 않습니다.
//! 멀티룸 예측 시에는 request_prediction_with_history를 사용하세요.
//! 이 API들은 주로 초기 방 목록 조회 등에만 사용됩니다.

use crate::domain::entities::GameResult;
use crate::presentation::state::AppState;
use serde::Serialize;
use tauri::State;
use tracing::{info, warn};

/// Room info for frontend
#[derive(Debug, Serialize)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub history_count: usize,
    pub streak_type: String,
    pub streak_length: usize,
    pub is_predictable: bool,
}

/// Room detail for frontend
#[derive(Debug, Serialize)]
pub struct RoomDetail {
    pub id: String,
    pub name: String,
    pub history: Vec<String>, // "Banker", "Player", "Tie"
    pub phase: String,
    pub stats: RoomStats,
}

/// Room statistics
#[derive(Debug, Serialize)]
pub struct RoomStats {
    pub total_rounds: usize,
    pub banker_count: usize,
    pub player_count: usize,
    pub tie_count: usize,
    pub banker_rate: f64,
    pub volatility: f64,
    pub score: i32,
}

/// Convert Room to RoomInfo
fn room_to_info(room: &crate::domain::entities::Room) -> RoomInfo {
    let (streak_result, streak_len) = room.current_streak();
    let streak_type = match streak_result {
        GameResult::Banker => "Banker",
        GameResult::Player => "Player",
        GameResult::Tie => "Tie",
    };

    RoomInfo {
        id: room.id.clone(),
        name: room.name.clone(),
        history_count: room.history.len(),
        streak_type: streak_type.to_string(),
        streak_length: streak_len as usize,
        is_predictable: room.history.len() >= 10,
    }
}

/// Get all available rooms
/// ⚠️ Note: Returns Rust internal state which may not be synced with frontend.
/// For multi-room prediction, use request_prediction_with_history instead.
#[tauri::command]
pub fn get_all_rooms(state: State<'_, AppState>) -> Vec<RoomInfo> {
    // 프론트엔드 SSOT 전략: Rust 내부 상태는 초기 목록용으로만 사용
    warn!("⚠️ get_all_rooms called - Rust state may be stale, use frontend state for predictions");

    state
        .room_repository
        .get_all_rooms()
        .iter()
        .map(room_to_info)
        .collect()
}

/// Get room detail by ID
#[tauri::command]
pub fn get_room_detail(room_id: String, state: State<'_, AppState>) -> Option<RoomDetail> {
    let room = state.room_repository.get_room(&room_id)?;

    let history: Vec<String> = room
        .history
        .iter()
        .map(|r| match r {
            GameResult::Banker => "Banker".to_string(),
            GameResult::Player => "Player".to_string(),
            GameResult::Tie => "Tie".to_string(),
        })
        .collect();

    let phase = match room.phase {
        crate::domain::entities::GamePhase::Idle => "Idle".to_string(),
        crate::domain::entities::GamePhase::Betting { remaining_seconds } => {
            format!("Betting ({}s)", remaining_seconds)
        }
        crate::domain::entities::GamePhase::Dealing => "Dealing".to_string(),
        crate::domain::entities::GamePhase::Result { winner } => {
            format!(
                "Result ({:?})",
                match winner {
                    GameResult::Banker => "Banker",
                    GameResult::Player => "Player",
                    GameResult::Tie => "Tie",
                }
            )
        }
    };

    let banker_count = room
        .history
        .iter()
        .filter(|r| **r == GameResult::Banker)
        .count();
    let player_count = room
        .history
        .iter()
        .filter(|r| **r == GameResult::Player)
        .count();
    let tie_count = room
        .history
        .iter()
        .filter(|r| **r == GameResult::Tie)
        .count();
    let total = banker_count + player_count;
    let banker_rate = if total > 0 {
        banker_count as f64 / total as f64
    } else {
        0.5
    };

    let history_vec: Vec<_> = room.history.iter().copied().collect();
    let volatility = crate::domain::services::PatternAnalyzer::calculate_volatility(&history_vec);
    let score = crate::domain::services::GameLogicService::calculate_room_score(&room);

    Some(RoomDetail {
        id: room.id,
        name: room.name,
        history,
        phase,
        stats: RoomStats {
            total_rounds: room.history.len(),
            banker_count,
            player_count,
            tie_count,
            banker_rate,
            volatility,
            score,
        },
    })
}

/// Subscribe to a room (single-room mode)
#[tauri::command]
pub fn subscribe_to_room(room_id: String, state: State<'_, AppState>) -> Result<(), String> {
    info!("📲 Subscribe to room: {}", room_id);
    state.room_repository.set_active_room(Some(room_id));
    Ok(())
}

/// Unsubscribe from current room
#[tauri::command]
pub fn unsubscribe_from_room(room_id: String, state: State<'_, AppState>) -> Result<(), String> {
    info!("📲 Unsubscribe from room: {}", room_id);
    state.room_repository.set_active_room(None);
    Ok(())
}

/// Get rooms sorted by score (best first)
#[tauri::command]
pub fn get_ranked_rooms(state: State<'_, AppState>) -> Vec<RoomInfo> {
    let mut rooms = state.room_repository.get_all_rooms();

    // Sort by score (higher is better)
    rooms.sort_by(|a, b| {
        let score_a = crate::domain::services::GameLogicService::calculate_room_score(a);
        let score_b = crate::domain::services::GameLogicService::calculate_room_score(b);
        score_b.cmp(&score_a)
    });

    rooms.iter().map(room_to_info).collect()
}

/// Get predictable rooms only
#[tauri::command]
pub fn get_predictable_rooms(state: State<'_, AppState>) -> Vec<RoomInfo> {
    let mut rooms = state.room_repository.get_all_rooms();

    // Sort by score (higher is better)
    rooms.sort_by(|a, b| {
        let score_a = crate::domain::services::GameLogicService::calculate_room_score(a);
        let score_b = crate::domain::services::GameLogicService::calculate_room_score(b);
        score_b.cmp(&score_a)
    });

    rooms
        .iter()
        .filter(|r| r.history.len() >= 10)
        .map(room_to_info)
        .collect()
}
