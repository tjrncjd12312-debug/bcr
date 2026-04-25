use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::{info, warn};
use url::Url;

use super::client::PragmaticClient;
use crate::presentation::task_registry::TaskRegistry;

// Global state managed by Tauri
pub struct PragmaticManagerState {
    pub manager: Arc<Mutex<PragmaticConnectionManager>>,
}

#[derive(Debug, Clone)]
pub struct PragmaticSession {
    pub base_domain: String, // e.g., "gs19.pragmaticplaylive.net"
    pub jsession_id: String,
    pub params: HashMap<String, String>, // parsed query params
}

pub struct PragmaticConnectionManager {
    // Map Room ID -> Client
    clients: HashMap<String, PragmaticClient>,
    // Active session info (captured from the first valid connection)
    active_session: Option<PragmaticSession>,
    /// Lane R2: Tracks the per-room WebSocket spawn so reconnects/teardown
    /// don't leak `JoinHandle`s. Keyed by `pragmatic:{room_id}`.
    task_registry: Arc<TaskRegistry>,
}

impl PragmaticConnectionManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
            active_session: None,
            task_registry: Arc::new(TaskRegistry::new()),
        }
    }

    /// Extract session info and table ID from a URL
    fn parse_url(&self, url_str: &str) -> Option<(String, PragmaticSession, String)> {
        // Returns (RoomID, Session, FullTableID)
        // Pragmatic URL format: wss://{server}/game?JSESSIONID={...}&tableId={...}&...

        let url = Url::parse(url_str).ok()?;
        let host = url.host_str()?.to_string();

        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        let jsession_id = pairs.get("JSESSIONID").cloned()?;
        let table_id = pairs
            .get("tableId")
            .cloned()
            .unwrap_or_else(|| "lobby".to_string());

        let session = PragmaticSession {
            base_domain: host,
            jsession_id,
            params: pairs,
        };

        Some((table_id.clone(), session, table_id))
    }

    pub async fn handle_new_connection(
        &mut self,
        app_handle: AppHandle,
        ws_url: String,
    ) -> Result<(), String> {
        info!("🔎 Analyzing new connection URL: {}", ws_url);

        // 1. Parse URL to get context
        if let Some((room_id, session, _)) = self.parse_url(&ws_url) {
            info!(
                "✅ Valid Pragmatic URL detected. Session: {}, Room: {}",
                session.jsession_id, room_id
            );

            // 2. Store Session if not exists (or update)
            self.active_session = Some(session.clone());

            // 3. Connect to this specific room/lobby
            // Note: If room_id is "lobby" (no tableId), we treat it as lobby
            self.connect_room(app_handle, room_id, ws_url).await?;
        } else {
            // If we can't parse standard params but it matched "pragmatic",
            // it might be the 'livechatinc' or some other lobby socket.
            // Just connect as "raw_lobby" to sniff traffic.
            warn!("⚠️ Could not parse standard Pragmatic params, connecting as raw_lobby");
            self.connect_room(app_handle, "raw_lobby".to_string(), ws_url)
                .await?;
        }

        Ok(())
    }

    pub async fn send_message(&self, room_id: &str, message: String) -> Result<(), String> {
        if let Some(client) = self.clients.get(room_id) {
            client.send_message(message).await
        } else {
            Err(format!("Room {} not connected", room_id))
        }
    }

    pub async fn connect_room(
        &mut self,
        app_handle: AppHandle,
        room_id: String,
        ws_url: String,
    ) -> Result<(), String> {
        info!("🔌 Connecting to room: {} ({})", room_id, ws_url);

        if self.clients.contains_key(&room_id) {
            // Allow reconnecting if strictly requested? For now, skip.
            warn!("Room {} is already connected or connecting", room_id);
            return Ok(());
        }

        // TODO(R4): the manager-wide lock is held across this `await`. R4 will
        // narrow the lock scope; R2 only adds the task-handle registry.
        let mut client = PragmaticClient::new(room_id.clone());
        let handle = client.connect(app_handle, ws_url).await?;

        // Lane R2: record the spawned task so the manager can abort it on
        // disconnect, even if the client's broadcast shutdown is missed.
        let registry_key = format!("pragmatic:{}", room_id);
        self.task_registry.insert(registry_key, handle);

        self.clients.insert(room_id, client);
        Ok(())
    }

    /// Connect to a table using stored session (tableId only)
    pub async fn connect_table_id(
        &mut self,
        app_handle: AppHandle,
        table_id: &str,
    ) -> Result<(), String> {
        let url = self
            .construct_room_url(table_id)
            .ok_or_else(|| "No active Pragmatic session to construct room URL".to_string())?;
        self.connect_room(app_handle, table_id.to_string(), url)
            .await
    }

    pub async fn disconnect_room(&mut self, room_id: &str) {
        if let Some(mut client) = self.clients.remove(room_id) {
            info!("🔌 Disconnecting room: {}", room_id);
            client.disconnect().await;
        }
        // Lane R2: abort the spawned task for this specific room. Safe to call
        // even when no handle is registered (returns false).
        let registry_key = format!("pragmatic:{}", room_id);
        self.task_registry.abort(&registry_key);
    }

    pub async fn disconnect_all(&mut self) {
        info!("🔌 Disconnecting ALL rooms");
        for (_, mut client) in self.clients.drain() {
            client.disconnect().await;
        }
        self.active_session = None;
        // Lane R2 safety net: abort every still-tracked task. The per-client
        // broadcast shutdown is the primary cancellation path; this catches
        // tasks that never observed the broadcast.
        self.task_registry.abort_all();
    }

    // Helper to construct a URL for a newly discovered room using saved session
    pub fn construct_room_url(&self, table_id: &str) -> Option<String> {
        let session = self.active_session.as_ref()?;

        // Reconstruct URL with new tableId query param
        // Base: wss://{base_domain}/game
        let mut url = Url::parse(&format!("wss://{}/game", session.base_domain)).ok()?;

        {
            let mut query = url.query_pairs_mut();
            // Copy all original params
            for (k, v) in &session.params {
                if k == "tableId" {
                    query.append_pair(k, table_id);
                } else {
                    query.append_pair(k, v);
                }
            }
            // Ensure tableId is set if it wasn't in original
            if !session.params.contains_key("tableId") {
                query.append_pair("tableId", table_id);
            }
        }

        Some(url.to_string())
    }

    /// Construct a launcher URL for Web navigation using the stored session
    /// Allows CDP navigation even before the user manually opens a Pragmatic table
    pub fn construct_launcher_url(&self, table_id: &str) -> Option<String> {
        let session = self.active_session.as_ref()?;

        let mut url = Url::parse("https://client.pragmaticplaylive.net/desktop/launcher/").ok()?;
        let mut query = url.query_pairs_mut();

        let mut has_table_id = false;
        let mut has_operator_game_id = false;
        let mut has_jsession = false;

        for (k, v) in &session.params {
            match k.as_str() {
                "tableId" => {
                    query.append_pair("tableId", table_id);
                    has_table_id = true;
                }
                "operatorGameId" => {
                    query.append_pair("operatorGameId", table_id);
                    has_operator_game_id = true;
                }
                "JSESSIONID" => {
                    query.append_pair("JSESSIONID", &session.jsession_id);
                    has_jsession = true;
                }
                _ => {
                    query.append_pair(k, v);
                }
            }
        }

        if !has_table_id {
            query.append_pair("tableId", table_id);
        }
        if !has_operator_game_id {
            query.append_pair("operatorGameId", table_id);
        }
        if !has_jsession {
            query.append_pair("JSESSIONID", &session.jsession_id);
        }

        drop(query);
        Some(url.to_string())
    }
}
