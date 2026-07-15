//! Evolution Tauri Commands
//!
//! Exposes Evolution WebSocket functionality to the frontend.
//! Uses event bridge pattern for clean separation of concerns.

use super::event_bridge::spawn_event_bridge;
use super::multi_client::{MultiSocketOptions, GLOBAL_MULTI_CLIENT};
use super::protocol::ProtocolSequence;
use serde::Serialize;
use tauri::AppHandle;
use tracing::info;

/// Response for multi-socket status
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiSocketStatus {
    pub is_connected: bool,
    pub state: String,
}

/// Connect to multi-table Evolution WebSocket (single socket)
///
/// Creates an event channel and spawns the event bridge for Tauri integration.
/// The WebSocket client itself is decoupled from Tauri (Clean Architecture).
#[tauri::command]
pub async fn connect_evolution_multi_socket(
    app: AppHandle,
    ws_url: String,
    origin: Option<String>,
    cookie: Option<String>,
    user_agent: Option<String>,
    referer: Option<String>,
    mwg_params: Option<String>,
) -> Result<(), String> {
    info!("📡 connect_evolution_multi_socket called");
    info!(
        "📡 WebSocket URL received: present={}, length={}",
        !ws_url.is_empty(),
        ws_url.len()
    );
    if let Some(ref mwg) = mwg_params {
        info!("📡 mwg_params received: present=true, length={}", mwg.len());
    }

    let mut client = GLOBAL_MULTI_CLIENT.lock().await;

    // 이벤트 채널 생성 및 브릿지 시작
    let event_rx = client.create_event_channel();
    spawn_event_bridge(app, event_rx);

    let options = MultiSocketOptions {
        origin,
        cookie,
        user_agent,
        referer,
        mwg_params,
    };

    client.connect(ws_url, options).await
}

/// Disconnect multi-table Evolution WebSocket
#[tauri::command]
pub async fn disconnect_evolution_multi_socket() -> Result<(), String> {
    let mut client = GLOBAL_MULTI_CLIENT.lock().await;
    client.disconnect().await;
    Ok(())
}

/// Send message over multi-table Evolution WebSocket
#[tauri::command]
pub async fn send_evolution_multi_message(message: String) -> Result<(), String> {
    let client = GLOBAL_MULTI_CLIENT.lock().await;
    client.send_message(message).await
}

/// Get multi-table connection status
#[tauri::command]
pub async fn get_evolution_multi_status() -> Result<MultiSocketStatus, String> {
    let client = GLOBAL_MULTI_CLIENT.lock().await;
    Ok(MultiSocketStatus {
        is_connected: client.is_connected(),
        state: client.connection_state().to_string(),
    })
}

/// Resubscribe to a specific table (after room entry)
///
/// Uses ProtocolSequence for message generation (refactored).
#[tauri::command]
pub async fn resubscribe_evolution_table(table_id: String) -> Result<(), String> {
    info!("🔄 Resubscribing to table: {}", table_id);

    let client = GLOBAL_MULTI_CLIENT.lock().await;
    if !client.is_connected() {
        return Err("Not connected to Evolution multi-socket".to_string());
    }

    // Use ProtocolSequence for message generation
    let open_msg = ProtocolSequence::game_open(&table_id);
    client.send_message(open_msg.to_string()).await?;

    // Small delay between messages
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let subscribe_msg = ProtocolSequence::subscribe_table(&table_id);
    client.send_message(subscribe_msg.to_string()).await?;

    info!("✅ Resubscribed to table: {}", table_id);
    Ok(())
}
