use super::manager::{PragmaticBetReceipt, PragmaticManagerState};
use tauri::{command, AppHandle, State};

// Connect to a specific room (or lobby connection if room_id="lobby")
#[command]
pub async fn connect_pragmatic_room(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    room_id: String,
    ws_url: String,
) -> Result<(), String> {
    let manager_arc = state.manager.clone();
    let mut manager = state.manager.lock().await;
    manager
        .connect_room(app, room_id, ws_url, manager_arc)
        .await
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
    let manager_arc = state.manager.clone();
    let mut manager = state.manager.lock().await;
    manager.connect_table_id(app, &table_id, manager_arc).await
}

// Legacy command wrapper for compatibility (treats as "lobby" connection)
#[command]
pub async fn connect_pragmatic(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    ws_url: String,
) -> Result<(), String> {
    let manager_arc = state.manager.clone();
    let mut manager = state.manager.lock().await;
    // Use the smart connection handler that parses URL and session
    manager
        .handle_new_connection(app, ws_url, manager_arc)
        .await
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

#[command]
pub async fn set_pragmatic_user_id(
    state: State<'_, PragmaticManagerState>,
    user_id: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.set_user_id(user_id);
    Ok(())
}

#[command]
pub async fn place_pragmatic_bet(
    state: State<'_, PragmaticManagerState>,
    table_id: String,
    bet_type: String,
    amount: u64,
) -> Result<PragmaticBetReceipt, String> {
    let mut manager = state.manager.lock().await;
    manager.place_bet(&table_id, &bet_type, amount).await
}
