// use std::sync::Arc;
// use tokio::sync::Mutex;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use tracing::{error, info, warn};
use url::Url;

use super::normalizer;
use super::parser;

// PragmaticClientState moved to manager.rs (PragmaticManagerState)

pub struct PragmaticClient {
    room_id: String,
    is_connected: bool,
    shutdown_tx: Option<tokio::sync::broadcast::Sender<()>>,
    msg_tx: Option<tokio::sync::mpsc::Sender<String>>,
}

impl PragmaticClient {
    pub fn new(room_id: String) -> Self {
        Self {
            room_id,
            is_connected: false,
            shutdown_tx: None,
            msg_tx: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.is_connected
    }

    /// Connect and return the spawned task handle so the caller (the manager)
    /// can register it in its `TaskRegistry`. Lane R2 (perf-plan): without
    /// returning the handle, the JoinHandle was previously dropped at the
    /// `tokio::spawn` site, leaking the task on disconnect.
    pub async fn connect(
        &mut self,
        app_handle: AppHandle,
        ws_url: String,
    ) -> Result<JoinHandle<()>, String> {
        if self.is_connected {
            self.disconnect().await;
        }

        info!(
            "[{}] Connecting to Pragmatic WebSocket: {}",
            self.room_id, ws_url
        );

        let url = Url::parse(&ws_url).map_err(|e| e.to_string())?;
        let url_string = url.to_string();

        // Broadcast channel for shutdown signal
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::broadcast::channel(1);
        self.shutdown_tx = Some(shutdown_tx);

        // MPSC channel for sending messages to socket
        let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<String>(32);
        self.msg_tx = Some(msg_tx);

        let app_handle_clone = app_handle.clone();
        let room_id_clone = self.room_id.clone();

        let join_handle = tokio::spawn(async move {
            match connect_async(url_string).await {
                Ok((ws_stream, _)) => {
                    info!("[{}] ✅ Pragmatic WebSocket Connected", room_id_clone);
                    let (mut write, mut read) = ws_stream.split();

                    loop {
                        tokio::select! {
                            // 1. Incoming Messages
                            msg = read.next() => {
                                match msg {
                                    Some(Ok(Message::Text(text))) => {
                                        // Parse & Normalize
                                        if let Some(parsed) = parser::parse_message(&text) {
                                            if let Some(event) = normalizer::normalize_message(parsed) {
                                                let _ = app_handle_clone.emit("pragmatic_event", event);
                                            }
                                        }

                                        // Raw debug
                                        let _ = app_handle_clone.emit("pragmatic_raw_message", serde_json::json!({
                                            "roomId": room_id_clone,
                                            "message": text
                                        }));
                                    }
                                    Some(Ok(Message::Close(_))) => {
                                        warn!("Pragmatic WebSocket closed by server");
                                        break;
                                    }
                                    Some(Err(e)) => {
                                        error!("Pragmatic WebSocket error: {}", e);
                                        break;
                                    }
                                    None => break,
                                    _ => {}
                                }
                            }
                            // 2. Outgoing Messages
                            Some(msg_to_send) = msg_rx.recv() => {
                                info!("[{}] Sending message: {}", room_id_clone, msg_to_send);
                                if let Err(e) = write.send(Message::Text(msg_to_send)).await {
                                    error!("[{}] Failed to send message: {}", room_id_clone, e);
                                    break;
                                }
                            }
                            // 3. Shutdown
                            _ = shutdown_rx.recv() => {
                                info!("Pragmatic WebSocket client shutting down");
                                let _ = write.close().await;
                                break;
                            }
                        }
                    }

                    info!("Pragmatic WebSocket loop ended");
                    let _ = app_handle_clone.emit("pragmatic_disconnected", ());
                }
                Err(e) => {
                    error!("Failed to connect to Pragmatic WebSocket: {}", e);
                    let _ = app_handle_clone.emit("pragmatic_connection_error", e.to_string());
                }
            }
        });

        self.is_connected = true;
        Ok(join_handle)
    }

    pub async fn send_message(&self, message: String) -> Result<(), String> {
        if let Some(tx) = &self.msg_tx {
            tx.send(message).await.map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Not connected".to_string())
        }
    }

    pub async fn disconnect(&mut self) {
        if let Some(tx) = &self.shutdown_tx {
            let _ = tx.send(());
        }
        self.shutdown_tx = None;
        self.msg_tx = None;
        self.is_connected = false;
    }
}
