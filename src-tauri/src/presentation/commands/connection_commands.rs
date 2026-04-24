//! Connection Commands
//!
//! Tauri commands for Evolution Gaming connection mode control
//! Note: Actual WebSocket connection is handled by evolution/multi_client.rs

use crate::presentation::state::AppState;
use serde::Serialize;
use tauri::State;
use tracing::info;

/// Connection status (based on multi_client state, not legacy WebSocket)
#[derive(Debug, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub room_count: usize,
    pub predictable_rooms: usize,
}

/// Get connection status
/// Note: This now reflects multi_client connection, not legacy evolution_websocket
#[tauri::command]
pub fn get_connection_status(state: State<'_, AppState>) -> ConnectionStatus {
    // Room count from mapping (always available)
    let rooms = state.room_repository.get_all_rooms();

    ConnectionStatus {
        connected: false, // Legacy - actual status from multi_client events
        room_count: rooms.len(),
        predictable_rooms: rooms.iter().filter(|r| r.history.len() >= 10).count(),
    }
}

/// Enable multi-room mode
#[tauri::command]
pub fn enable_multi_room_mode(state: State<'_, AppState>) {
    info!("📲 Enable multi-room mode");
    state.room_repository.set_multi_room_mode(true);
}

/// Disable multi-room mode
#[tauri::command]
pub fn disable_multi_room_mode(state: State<'_, AppState>) {
    info!("📲 Disable multi-room mode");
    state.room_repository.set_multi_room_mode(false);
}
