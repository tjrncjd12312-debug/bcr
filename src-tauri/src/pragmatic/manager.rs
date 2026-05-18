use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;
use tracing::{info, warn};
use url::Url;

use super::bet_builder::{build_bet_xml, normalize_table_id, now_ms, parse_bet_type};
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
    active_user_id: Option<String>,
    table_game_ids: HashMap<String, String>,
    table_betting_open: HashMap<String, bool>,
    last_bets: HashMap<String, LastPragmaticBet>,
    /// Lane R2: Tracks the per-room WebSocket spawn so reconnects/teardown
    /// don't leak `JoinHandle`s. Keyed by `pragmatic:{room_id}`.
    task_registry: Arc<TaskRegistry>,
}

#[derive(Debug, Clone)]
pub struct LastPragmaticBet {
    pub bet_type: String,
    pub amount: u64,
    pub game_id: String,
    pub sent_at_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PragmaticBetReceipt {
    pub table_id: String,
    pub bet_type: String,
    pub amount: u64,
    pub game_id: String,
    pub sent_at_ms: i64,
    pub attempts: usize,
}

impl PragmaticConnectionManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
            active_session: None,
            active_user_id: None,
            table_game_ids: HashMap::new(),
            table_betting_open: HashMap::new(),
            last_bets: HashMap::new(),
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
        manager_arc: Arc<Mutex<PragmaticConnectionManager>>,
    ) -> Result<(), String> {
        info!("🔎 Analyzing new connection URL: {}", ws_url);

        // 1. Parse URL to get context
        if let Some((room_id, session, _)) = self.parse_url(&ws_url) {
            info!(
                "✅ Valid Pragmatic URL detected. Session: {}, Room: {}",
                session.jsession_id, room_id
            );

            // 2. Store Session if not exists (or update)
            if let Some(user_id) = extract_user_id(&session.params) {
                self.active_user_id = Some(user_id);
            }
            self.active_session = Some(session.clone());

            // 3. Connect to this specific room/lobby
            // Note: If room_id is "lobby" (no tableId), we treat it as lobby
            self.connect_room(app_handle, room_id, ws_url, manager_arc)
                .await?;
        } else {
            // If we can't parse standard params but it matched "pragmatic",
            // it might be the 'livechatinc' or some other lobby socket.
            // Just connect as "raw_lobby" to sniff traffic.
            warn!("⚠️ Could not parse standard Pragmatic params, connecting as raw_lobby");
            self.connect_room(app_handle, "raw_lobby".to_string(), ws_url, manager_arc)
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

    pub fn set_user_id(&mut self, user_id: String) {
        let trimmed = user_id.trim();
        if !trimmed.is_empty() {
            self.active_user_id = Some(trimmed.to_string());
        }
    }

    pub fn record_game_state(
        &mut self,
        table_id: &str,
        game_id: Option<String>,
        betting_open: Option<bool>,
    ) {
        let table_id = normalize_table_id(table_id);
        if let Some(game_id) = game_id.filter(|value| !value.trim().is_empty()) {
            self.table_game_ids.insert(table_id.clone(), game_id);
        }
        if let Some(open) = betting_open {
            self.table_betting_open.insert(table_id, open);
        }
    }

    pub async fn place_bet(
        &mut self,
        table_id: &str,
        bet_type: &str,
        amount: u64,
    ) -> Result<PragmaticBetReceipt, String> {
        if amount == 0 {
            return Err("Bet amount must be greater than zero".to_string());
        }

        let normalized_table_id = normalize_table_id(table_id);
        if self.table_betting_open.get(&normalized_table_id) == Some(&false) {
            return Err(format!(
                "Pragmatic table {} is not open for betting",
                normalized_table_id
            ));
        }

        let bet_code = parse_bet_type(bet_type)
            .map_err(|_| format!("Unsupported Pragmatic bet type: {}", bet_type))?;
        let game_id = self
            .table_game_ids
            .get(&normalized_table_id)
            .cloned()
            .ok_or_else(|| format!("No active gameId for Pragmatic table {}", normalized_table_id))?;
        let user_id = self
            .active_user_id
            .clone()
            .or_else(|| {
                self.active_session
                    .as_ref()
                    .and_then(|session| extract_user_id(&session.params))
            })
            .ok_or_else(|| "No Pragmatic user id captured from session".to_string())?;
        let client_key = self
            .resolve_client_key(&normalized_table_id)
            .ok_or_else(|| format!("Room {} not connected", normalized_table_id))?;
        let sent_at_ms = now_ms();
        let xml = build_bet_xml(
            &normalized_table_id,
            bet_code,
            amount,
            &game_id,
            &user_id,
            sent_at_ms,
        );
        let retry_delays_ms = [0_u64, 200, 500, 1000, 1500, 2500];
        let mut last_error = None;

        for (index, delay_ms) in retry_delays_ms.iter().enumerate() {
            if *delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
            }

            let send_result = match self.clients.get(&client_key) {
                Some(client) => client.send_message(xml.clone()).await,
                None => Err(format!("Room {} not connected", normalized_table_id)),
            };

            match send_result {
                Ok(()) => {
                    self.last_bets.insert(
                        normalized_table_id.clone(),
                        LastPragmaticBet {
                            bet_type: bet_type.to_string(),
                            amount,
                            game_id: game_id.clone(),
                            sent_at_ms,
                        },
                    );
                    return Ok(PragmaticBetReceipt {
                        table_id: normalized_table_id,
                        bet_type: bet_type.to_string(),
                        amount,
                        game_id,
                        sent_at_ms,
                        attempts: index + 1,
                    });
                }
                Err(error) => last_error = Some(error),
            }
        }

        Err(last_error.unwrap_or_else(|| "Pragmatic bet send failed".to_string()))
    }

    fn resolve_client_key(&self, table_id: &str) -> Option<String> {
        if self.clients.contains_key(table_id) {
            return Some(table_id.to_string());
        }

        let prefixed = format!("table-{}", table_id);
        if self.clients.contains_key(&prefixed) {
            return Some(prefixed);
        }

        None
    }

    pub async fn connect_room(
        &mut self,
        app_handle: AppHandle,
        room_id: String,
        ws_url: String,
        manager_arc: Arc<Mutex<PragmaticConnectionManager>>,
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
        let handle = client.connect(app_handle, ws_url, manager_arc).await?;

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
        manager_arc: Arc<Mutex<PragmaticConnectionManager>>,
    ) -> Result<(), String> {
        let url = self
            .construct_room_url(table_id)
            .ok_or_else(|| "No active Pragmatic session to construct room URL".to_string())?;
        self.connect_room(app_handle, table_id.to_string(), url, manager_arc)
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

fn extract_user_id(params: &HashMap<String, String>) -> Option<String> {
    [
        "uId",
        "uid",
        "userId",
        "user_id",
        "playerId",
        "accountId",
        "memberId",
        "login",
    ]
    .iter()
    .find_map(|key| params.get(*key))
    .map(|value| value.trim())
    .filter(|value| !value.is_empty())
    .map(ToString::to_string)
}
