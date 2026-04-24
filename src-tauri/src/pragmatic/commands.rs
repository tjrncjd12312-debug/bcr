use super::manager::PragmaticManagerState;
use tauri::{command, AppHandle, State};

// Connect to a specific room (or lobby connection if room_id="lobby")
#[command]
pub async fn connect_pragmatic_room(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    room_id: String,
    ws_url: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.connect_room(app, room_id, ws_url).await
}

// Disconnect a specific room
#[command]
pub async fn disconnect_pragmatic_room(
    state: State<'_, PragmaticManagerState>,
    room_id: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.disconnect_room(&room_id).await;
    Ok(())
}

// Disconnect all pragmatic connections
#[command]
pub async fn disconnect_all_pragmatic(
    state: State<'_, PragmaticManagerState>,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.disconnect_all().await;
    Ok(())
}

/// Connect by tableId using stored session (constructs WS URL dynamically)
#[command]
pub async fn connect_pragmatic_table(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    table_id: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.connect_table_id(app, &table_id).await
}

// Legacy command wrapper for compatibility (treats as "lobby" connection)
#[command]
pub async fn connect_pragmatic(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    ws_url: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    // Use the smart connection handler that parses URL and session
    manager.handle_new_connection(app, ws_url).await
}

#[command]
pub async fn disconnect_pragmatic(state: State<'_, PragmaticManagerState>) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.disconnect_all().await;
    Ok(())
}
#[command]
pub async fn send_pragmatic_message(
    state: State<'_, PragmaticManagerState>,
    room_id: String,
    message: String,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.send_message(&room_id, message).await
}
