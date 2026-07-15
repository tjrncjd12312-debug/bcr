//! Evolution Multi-table WebSocket Client
//!
//! 단일 소켓으로 여러 테이블 이벤트를 수신/송신하기 위한 클라이언트.
//! CDP 없이 직접 WS를 붙고, 브라우저 유사 헤더를 사용해 킥을 줄인다.
//!
//! ## Architecture
//! - Clean Architecture: AppHandle 의존성 제거, 이벤트 채널 사용
//! - State Machine: 연결 상태를 명시적으로 관리
//!
//! ## URL Pattern
//! - Multiwidget: wss://{domain}/public/baccarat/player/game/multiwidget/socket
//!
//! ## TLS Fingerprint
//! Uses wreq with Chrome impersonation (BoringSSL) to bypass Akamai bot detection.

use super::connection_state::{ConnectionStateMachine, StateTransition};
use super::events::{DisconnectReason, EventSender, EvolutionEvent, TableSummary};
use super::message_parser::{IncomingMessage, MessageParser, TableInfo};
use super::protocol::ProtocolSequence;
use super::table_filter::TableFilter;
use crate::presentation::task_registry::TaskRegistry;
use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::error::Error as StdError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, error, info, warn};
use url::Url;
use wreq::ws::message::Message as WsMessage;
use wreq_util::Emulation;

/// 최대 구독 테이블 수 (제한 없음)
const MAX_SUBSCRIBE_TABLES: usize = 60;

/// 이벤트 채널 버퍼 크기 (60개 방 기준 피크 부하 대응)
const EVENT_CHANNEL_BUFFER: usize = 1024;

// ─── Human-like timing jitter (ms) ───────────────────────────────────────────
const PRE_HANDSHAKE_MIN_MS: u64 = 200;
const PRE_HANDSHAKE_MAX_MS: u64 = 800;
const INIT_GAP_MIN_MS: u64 = 80;
const INIT_GAP_MAX_MS: u64 = 180;
const SUBSCRIBE_GAP_MIN_MS: u64 = 120;
const SUBSCRIBE_GAP_MAX_MS: u64 = 280;
const HEARTBEAT_MIN_MS: u64 = 4000;
const HEARTBEAT_MAX_MS: u64 = 6000;

// WebSocket 제어프레임 Ping(opcode 0x9) keepalive 주기 (ms) — "핑퐁".
// metrics.ping(텍스트 앱 메시지)과는 별개로, 브라우저가 하듯 "진짜 WS Ping"을 주기적으로 보낸다.
// 서버의 연결 liveness 타이머가 (앱 텍스트 트래픽이 아니라) WS 제어 ping/pong을 기준으로 동작하면,
// 이게 없을 때 metrics.ping이 매초 흘러도 서버는 비활성으로 간주해 ~20분 후 세션을 킥아웃한다.
// 제어프레임이므로 메시지 파서/프론트엔드/방 상태에 절대 닿지 않는다 → 방 초기화·자동배팅 영향 0.
const WS_PING_MIN_MS: u64 = 10_000;
const WS_PING_MAX_MS: u64 = 15_000;

// 서버로부터 아무 메시지도 수신하지 못하면 좀비 연결로 판단하는 시간 (ms).
// Evolution 서버는 보통 1-2초 간격으로 테이블 이벤트를 보내므로 15초면 충분히 보수적.
const RECEIVE_TIMEOUT_MS: u64 = 15_000;

// 자동 재연결 최대 시도 횟수
const MAX_RECONNECT_ATTEMPTS: u32 = 5;
// 자동 재연결 기본 딜레이 (ms) — 지수 백오프: 2s, 4s, 8s, 16s, 30s cap
const RECONNECT_BASE_DELAY_MS: u64 = 2000;
const RECONNECT_MAX_DELAY_MS: u64 = 30_000;

// Outbound messages are acknowledged by the socket task. This prevents the
// caller from seeing success when a safety gate dropped the message locally.
const OUTBOUND_ACK_TIMEOUT_SECS: u64 = 5;

/// 위장용 기본 User-Agent. TLS/HTTP2 Emulation(`Emulation::Chrome136`, single_connection_attempt)과
/// 반드시 동일한 Chrome 버전이어야 한다 — UA가 다르면 UA-vs-JA3 불일치로 Akamai 봇 스코어링에 걸린다(ua-1).
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/// Sleep for a uniformly random duration in `[min_ms, max_ms)`.
async fn jitter_sleep(min_ms: u64, max_ms: u64) {
    use rand::Rng;
    let ms = rand::thread_rng().gen_range(min_ms..max_ms);
    tokio::time::sleep(tokio::time::Duration::from_millis(ms)).await;
}

/// Random `Instant` `min_ms..max_ms` from now — used for heartbeat scheduling.
fn jitter_deadline(min_ms: u64, max_ms: u64) -> tokio::time::Instant {
    use rand::Rng;
    let ms = rand::thread_rng().gen_range(min_ms..max_ms);
    tokio::time::Instant::now() + tokio::time::Duration::from_millis(ms)
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn diagnostics_enabled() -> bool {
    static ENABLED: Lazy<bool> = Lazy::new(|| env_flag_enabled("BCR_DIAGNOSTICS"));
    *ENABLED
}

/// Return a credential-free endpoint for logs. Query strings and fragments can
/// contain EVOSESSIONID, tokens, and browser instance identifiers.
fn websocket_endpoint_for_log(ws_url: &str) -> String {
    Url::parse(ws_url)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?;
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{}://{}{}{}", url.scheme(), host, port, url.path()))
        })
        .unwrap_or_else(|| "<invalid-websocket-url>".to_string())
}

/// Diagnostic output is metadata-only. Raw frames are never written or logged,
/// even when diagnostics are explicitly enabled.
fn diagnostic_frame_summary(text: &str) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok();
    let message_type = parsed
        .as_ref()
        .and_then(|value| value.get("type"))
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(64).collect::<String>())
        .unwrap_or_else(|| "<unknown>".to_string());
    let has_table_id = parsed
        .as_ref()
        .and_then(|value| value.get("args"))
        .and_then(|args| args.get("tableId"))
        .and_then(|value| value.as_str())
        .is_some();
    let has_error = text.contains("\"error\"") || text.contains("Author") || text.contains("eject");
    let has_bet_state = text.contains("playerBettingState") || text.contains("playerBetRequest");

    format!(
        "type={message_type} len={} table_id_present={has_table_id} error_signal={has_error} bet_signal={has_bet_state}",
        text.len()
    )
}

/// Apply the real-money round-id safety gate before a queued message reaches
/// the socket. A playerBetRequest is valid only when this connection has seen a
/// current, non-synthetic gameId for the target table.
fn prepare_outgoing_message(
    message: String,
    table_game_ids: &std::collections::HashMap<String, String>,
) -> Result<String, String> {
    if !message.contains("playerBetRequest") {
        return Ok(message);
    }

    let mut value = serde_json::from_str::<serde_json::Value>(&message)
        .map_err(|_| "Blocked playerBetRequest: malformed JSON".to_string())?;
    let args = value
        .get_mut("args")
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| "Blocked playerBetRequest: missing args".to_string())?;
    let table_id = args
        .get("tableId")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Blocked playerBetRequest: missing tableId".to_string())?;
    let tracked_game_id = table_game_ids
        .get(&table_id)
        .filter(|value| !value.is_empty() && !value.starts_with("synthetic-"))
        .cloned()
        .ok_or_else(|| {
            format!("Blocked playerBetRequest: current gameId unavailable for table {table_id}")
        })?;

    args.insert(
        "gameId".to_string(),
        serde_json::Value::String(tracked_game_id),
    );
    serde_json::to_string(&value)
        .map_err(|error| format!("Blocked playerBetRequest: serialization failed: {error}"))
}

/// lobby.categories 프레임에서 'baccarat' 카테고리의 테이블 ID(평문 문자열)를 추출한다.
/// lobby v2: args.categories[].id == "baccarat" 의 tables = ["onokyd4wn7uekbjx", ...] (평문 ID 배열).
/// 이 ID들로 lobby.subscribe를 보내면 서버가 해당 테이블의 결과/히스토리/gameId를 push한다.
fn extract_baccarat_table_ids(data: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(cats) = data
        .get("args")
        .and_then(|a| a.get("categories"))
        .and_then(|c| c.as_array())
    {
        for cat in cats {
            let id = cat.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.contains("baccarat") {
                if let Some(tables) = cat.get("tables").and_then(|t| t.as_array()) {
                    for t in tables {
                        if let Some(s) = t.as_str() {
                            if !s.is_empty() {
                                ids.push(s.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    ids
}

/// 멀티테이블 이벤트(정규화) - 하위 호환성 유지
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvolutionMultiEvent {
    pub table_id: Option<String>,
    pub event_type: String,
    pub data: serde_json::Value,
}

/// 연결 옵션(헤더 커스터마이즈)
#[derive(Debug, Clone, Default)]
pub struct MultiSocketOptions {
    pub origin: Option<String>,
    pub cookie: Option<String>,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    /// mwg hash fragment params
    pub mwg_params: Option<String>,
}

struct OutboundMessage {
    payload: String,
    response_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
    expires_at: tokio::time::Instant,
}

/// `handle_incoming_message`가 메시지 루프에 돌려주는 후속 동작 신호.
enum HandleOutcome {
    /// availableTables 수신 → 이 테이블들을 구독해야 함
    Subscribe(Vec<TableInfo>),
    /// 서버 킥아웃 수신 → 루프를 즉시 종료해야 함(만료 세션 재연결 금지)
    Kickout(String),
    /// lobby.categories 수신 → 바카라 테이블들을 lobby.subscribe로 구독해야 함(lobby v2 subscriptionModel)
    LobbySubscribe(Vec<String>),
}

/// 멀티테이블 WS 클라이언트 (단일 소켓)
pub struct EvolutionMultiSocket {
    state_machine: ConnectionStateMachine,
    shutdown_tx: Option<tokio::sync::broadcast::Sender<()>>,
    msg_tx: Option<tokio::sync::mpsc::Sender<OutboundMessage>>,
    event_tx: Option<EventSender>,
    /// Internal registry of background tasks spawned by `connect()`.
    ///
    /// Lane R2 (perf-plan): without this, repeated `connect()` calls without an
    /// intervening `disconnect()` (or a `disconnect()` that races a
    /// shutdown-deaf task) would leak `JoinHandle`s. The registry is a safety
    /// net layered on top of the existing `shutdown_tx` broadcast channel.
    task_registry: Arc<TaskRegistry>,
    /// Live-connection flag, shared with the spawned connection task.
    ///
    /// The `state_machine` only ever reaches `Connecting` because the spawned
    /// task has no `&self` handle to advance it, so `is_connected()` cannot rely
    /// on it. This atomic is flipped true once the socket is up (after the
    /// `Connected` event) and false when the attempt ends / on `disconnect()`,
    /// giving `is_connected()` / `get_multiwidget_status()` / `resubscribe` a
    /// truthful answer (state-3).
    connected: Arc<AtomicBool>,
}

/// 글로벌 싱글턴 멀티위젯 클라이언트
pub static GLOBAL_MULTI_CLIENT: Lazy<TokioMutex<EvolutionMultiSocket>> =
    Lazy::new(|| TokioMutex::new(EvolutionMultiSocket::new()));

impl EvolutionMultiSocket {
    pub fn new() -> Self {
        Self {
            state_machine: ConnectionStateMachine::new(),
            shutdown_tx: None,
            msg_tx: None,
            event_tx: None,
            task_registry: Arc::new(TaskRegistry::new()),
            connected: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_connected(&self) -> bool {
        // 실제 라이브 소켓 여부는 공유 atomic으로 판단(state_machine은 Connecting에 갇힘 — state-3).
        self.connected.load(Ordering::SeqCst) || self.state_machine.state().is_connected()
    }

    /// 현재 연결 상태 반환
    pub fn connection_state(&self) -> &str {
        self.state_machine.state().state_name()
    }

    /// 이벤트 송신자 설정
    pub fn set_event_sender(&mut self, event_tx: EventSender) {
        self.event_tx = Some(event_tx);
    }

    /// 이벤트 채널 생성 및 반환
    pub fn create_event_channel(&mut self) -> super::events::EventReceiver {
        let (tx, rx) = super::events::create_event_channel(EVENT_CHANNEL_BUFFER);
        self.event_tx = Some(tx);
        rx
    }

    /// 멀티위젯 WS에 접속 (Clean Architecture: AppHandle 없음)
    pub async fn connect(
        &mut self,
        ws_url: String,
        mut options: MultiSocketOptions,
    ) -> Result<(), String> {
        // 이미 연결 중이면 먼저 종료
        if self.is_connected() {
            info!("[Evolution-Multi] 🔄 Disconnecting existing connection first...");
            self.disconnect().await;
        }

        // Lane R2 idempotency safety net: even if `is_connected()` returned
        // false (e.g. the state machine moved to Disconnected after a network
        // error) the registry might still hold a not-yet-cleaned task. Make
        // sure no stale spawn leaks into a fresh connect cycle.
        if self.task_registry.len() > 0 {
            warn!(
                "[Evolution-Multi] ⚠️ Stale tasks detected on connect ({} pending), aborting first",
                self.task_registry.len()
            );
            self.task_registry.abort_all();
        }

        // 상태 전이: Disconnected -> Connecting
        if let Err(e) = self.state_machine.transition(StateTransition::StartConnect) {
            warn!("[Evolution-Multi] State transition error: {}", e);
        }

        let parsed = Url::parse(&ws_url).map_err(|e| format!("Invalid WS URL: {}", e))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "Missing host in WS URL".to_string())?
            .to_string();

        // lobby v2(/public/lobby/socket/v2/)는 multiwidget이 통합된 멀티테이블 피드이므로
        // 동일하게 init 시퀀스(connection_established + subscribe)를 보내야 서버가 데이터를 push한다.
        // 이를 빼먹으면 소켓은 붙지만 아무 메시지도 못 받아 ReceiveTimeout으로 끊긴다(v2-1).
        let is_multiwidget = ws_url.contains("/multiwidget/")
            || ws_url.contains("/lobby/socket/v2")
            || ws_url.contains("/lobby/socket/V2");
        info!(
            "[Evolution-Multi] 🎰 Is multiwidget/lobby-v2 socket: {}",
            is_multiwidget
        );

        // 인스턴스 ID 재생성
        let ws_url = Self::regenerate_instance_id(&ws_url, &parsed, is_multiwidget);
        let parsed = Url::parse(&ws_url)
            .map_err(|e| format!("Invalid WS URL after instance change: {}", e))?;

        // 기본 옵션 설정
        Self::setup_default_options(&mut options, &host, &parsed);

        let origin = options.origin.clone().unwrap_or_default();
        let cookie = options.cookie.clone().unwrap_or_default();
        // Caller may override (e.g. for per-session UA pinning) but the default
        // MUST match the TLS Emulation (Chrome136) to keep UA and TLS in lockstep.
        let user_agent = options
            .user_agent
            .clone()
            .unwrap_or_else(|| CHROME_UA.to_string());
        let referer = options
            .referer
            .clone()
            .unwrap_or_else(|| format!("https://{}/frontend/evo/r2/", host));

        Self::log_connection_info(&ws_url, &host, &origin, &referer, &cookie);

        let (shutdown_tx, shutdown_rx) = tokio::sync::broadcast::channel(1);
        self.shutdown_tx = Some(shutdown_tx);

        let (msg_tx, msg_rx) = tokio::sync::mpsc::channel::<OutboundMessage>(64);
        self.msg_tx = Some(msg_tx);

        // 이벤트 송신자 복제 (없으면 더미 채널 생성)
        let event_tx = self.event_tx.clone().unwrap_or_else(|| {
            let (tx, _) = tokio::sync::mpsc::channel(1);
            tx
        });

        let ws_url_clone = ws_url.clone();
        let is_multiwidget_clone = is_multiwidget;
        let referer_without_hash = referer.split('#').next().unwrap_or(&referer).to_string();

        // 새 연결 사이클 시작 — atomic을 초기화하고 spawned task와 공유한다(state-3).
        self.connected.store(false, Ordering::SeqCst);
        let connected = self.connected.clone();

        let connection_handle = tokio::spawn(async move {
            Self::connection_task(
                ws_url_clone,
                is_multiwidget_clone,
                origin,
                user_agent,
                cookie,
                referer_without_hash,
                event_tx,
                msg_rx,
                shutdown_rx,
                connected,
            )
            .await;
        });

        // Register the connection task so `disconnect()` can abort it as a
        // safety net if the broadcast shutdown is missed (e.g. a task stuck on
        // a syscall that never reaches the next `.await`).
        self.task_registry
            .insert("evolution_multi:connection_task", connection_handle);

        info!("[Evolution-Multi] 🎯 Connection initiated (async)");
        Ok(())
    }

    /// 연결 태스크 (백그라운드 실행, 자동 재연결 루프 포함)
    async fn connection_task(
        ws_url: String,
        is_multiwidget: bool,
        origin: String,
        user_agent: String,
        cookie: String,
        referer: String,
        event_tx: EventSender,
        mut msg_rx: tokio::sync::mpsc::Receiver<OutboundMessage>,
        mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
        connected: Arc<AtomicBool>,
    ) {
        let mut attempt: u32 = 0;

        loop {
            attempt += 1;
            info!(
                "[Evolution-Multi] 🚀 Connection attempt #{} to {}",
                attempt,
                websocket_endpoint_for_log(&ws_url)
            );

            // Human-like dwell before opening the socket
            jitter_sleep(PRE_HANDSHAKE_MIN_MS, PRE_HANDSHAKE_MAX_MS).await;

            let disconnect_reason = Self::single_connection_attempt(
                &ws_url,
                is_multiwidget,
                &origin,
                &user_agent,
                &cookie,
                &referer,
                &event_tx,
                &mut msg_rx,
                &mut shutdown_rx,
                &connected,
            )
            .await;

            // 이번 시도가 끝났다(끊김/재연결 대기 진입) — 라이브 플래그 해제(state-3).
            connected.store(false, Ordering::SeqCst);

            match &disconnect_reason {
                // 사용자 요청 또는 킥아웃 → 재연결 안 함
                DisconnectReason::UserRequested => {
                    info!("[Evolution-Multi] 🛑 User requested disconnect, exiting loop");
                    let _ = event_tx
                        .send(EvolutionEvent::Disconnected {
                            url: ws_url.clone(),
                            reason: disconnect_reason,
                        })
                        .await;
                    return;
                }
                DisconnectReason::Kickout(reason) => {
                    warn!(
                        "[Evolution-Multi] ⚠️ Kicked out ({}), not auto-reconnecting",
                        reason
                    );
                    let _ = event_tx
                        .send(EvolutionEvent::Disconnected {
                            url: ws_url.clone(),
                            reason: disconnect_reason,
                        })
                        .await;
                    return;
                }
                reason if reason.should_auto_reconnect() => {
                    if attempt >= MAX_RECONNECT_ATTEMPTS {
                        error!(
                            "[Evolution-Multi] ❌ Max reconnect attempts ({}) reached, giving up",
                            MAX_RECONNECT_ATTEMPTS
                        );
                        let _ = event_tx
                            .send(EvolutionEvent::Disconnected {
                                url: ws_url.clone(),
                                reason: DisconnectReason::NetworkError(format!(
                                    "Max reconnect attempts exceeded (last: {})",
                                    reason.as_str()
                                )),
                            })
                            .await;
                        return;
                    }

                    // 지수 백오프 딜레이 계산
                    let delay_ms = std::cmp::min(
                        RECONNECT_BASE_DELAY_MS * 2u64.pow(attempt.saturating_sub(1)),
                        RECONNECT_MAX_DELAY_MS,
                    );

                    warn!(
                        "[Evolution-Multi] 🔄 Auto-reconnect in {}ms (attempt {}/{}, reason: {})",
                        delay_ms,
                        attempt,
                        MAX_RECONNECT_ATTEMPTS,
                        reason.as_str()
                    );

                    // 프론트엔드에 재연결 시도 알림
                    let _ = event_tx
                        .send(EvolutionEvent::ReconnectAttempt {
                            attempt,
                            max_attempts: MAX_RECONNECT_ATTEMPTS,
                            delay_ms,
                            reason: reason.as_str(),
                        })
                        .await;

                    // 백오프 대기 중에도 셧다운 신호 체크
                    tokio::select! {
                        _ = tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)) => {
                            // 대기 완료, 재연결 시도
                        }
                        _ = shutdown_rx.recv() => {
                            info!("[Evolution-Multi] 🛑 Shutdown during reconnect wait");
                            let _ = event_tx
                                .send(EvolutionEvent::Disconnected {
                                    url: ws_url.clone(),
                                    reason: DisconnectReason::UserRequested,
                                })
                                .await;
                            return;
                        }
                    }
                }
                // Normal 등 기타 — 재연결 안 함
                _ => {
                    let _ = event_tx
                        .send(EvolutionEvent::Disconnected {
                            url: ws_url.clone(),
                            reason: disconnect_reason,
                        })
                        .await;
                    return;
                }
            }
        }
    }

    /// 단일 연결 시도 — 연결 → 메시지 루프 → 종료 사유 반환
    async fn single_connection_attempt(
        ws_url: &str,
        is_multiwidget: bool,
        origin: &str,
        user_agent: &str,
        cookie: &str,
        referer: &str,
        event_tx: &EventSender,
        msg_rx: &mut tokio::sync::mpsc::Receiver<OutboundMessage>,
        shutdown_rx: &mut tokio::sync::broadcast::Receiver<()>,
        connected: &AtomicBool,
    ) -> DisconnectReason {
        let client = match wreq::Client::builder()
            .emulation(Emulation::Chrome136)
            .cert_verification(false)
            .connect_timeout(tokio::time::Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                error!("[Evolution-Multi] ❌ Failed to build client: {}", e);
                let _ = event_tx
                    .send(EvolutionEvent::Error {
                        url: ws_url.to_string(),
                        error: format!("Failed to build client: {}", e),
                        error_detail: None,
                    })
                    .await;
                return DisconnectReason::NetworkError(e.to_string());
            }
        };

        let mut ws_request = client
            .websocket(ws_url)
            .header("Origin", origin)
            .header("User-Agent", user_agent)
            .header("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("Referer", referer);

        if !cookie.is_empty() {
            ws_request = ws_request.header("Cookie", cookie);
        }

        match ws_request.send().await {
            Ok(upgrade_response) => {
                info!(
                    "[Evolution-Multi] ✅ Upgrade response: {}",
                    upgrade_response.status()
                );

                let status = upgrade_response.status();
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    let reason = format!(
                        "upgrade_forbidden_{}:duplicate_or_invalid_evosessionid",
                        status.as_u16()
                    );
                    error!(
                        "[Evolution-Multi] Upgrade rejected with {} - fatal session conflict, no reconnect",
                        status
                    );
                    return DisconnectReason::Kickout(reason);
                }

                match upgrade_response.into_websocket().await {
                    Ok(websocket) => {
                        info!("[Evolution-Multi] ✅ WebSocket connected!");

                        let (mut write, mut read) = websocket.split();

                        // 초기화 시퀀스 전송 (lobby v2는 lobby.initLobby, 구버전은 multiwidget init)
                        if is_multiwidget {
                            let is_lobby_v2 = ws_url.contains("/lobby/socket/v2")
                                || ws_url.contains("/lobby/socket/V2");
                            if let Err(e) = Self::send_init_sequence(&mut write, is_lobby_v2).await
                            {
                                error!("[Evolution-Multi] ❌ Init failed: {}", e);
                                let _ = event_tx
                                    .send(EvolutionEvent::Error {
                                        url: ws_url.to_string(),
                                        error: e.clone(),
                                        error_detail: None,
                                    })
                                    .await;
                                return DisconnectReason::NetworkError(e);
                            }
                        }

                        // Connected 이벤트 발송
                        let _ = event_tx
                            .send(EvolutionEvent::Connected {
                                url: ws_url.to_string(),
                                is_multiwidget,
                            })
                            .await;

                        // 라이브 연결 플래그 ON — is_connected()/상태조회/resubscribe가 진실을 반환(state-3)
                        connected.store(true, Ordering::SeqCst);

                        // 메시지 루프
                        Self::run_message_loop(event_tx, &mut write, &mut read, msg_rx, shutdown_rx)
                            .await
                    }
                    Err(e) => {
                        error!("[Evolution-Multi] ❌ Upgrade failed: {}", e);
                        let _ = event_tx
                            .send(EvolutionEvent::Error {
                                url: ws_url.to_string(),
                                error: format!("WebSocket upgrade failed: {}", e),
                                error_detail: None,
                            })
                            .await;
                        DisconnectReason::NetworkError(e.to_string())
                    }
                }
            }
            Err(e) => {
                error!("[Evolution-Multi] ❌ HTTP request failed: {}", e);
                error!("[Evolution-Multi] ❌ Error chain: {:?}", e);
                if let Some(source) = e.source() {
                    error!("[Evolution-Multi] ❌ Caused by: {}", source);
                }
                let _ = event_tx
                    .send(EvolutionEvent::Error {
                        url: ws_url.to_string(),
                        error: e.to_string(),
                        error_detail: Some(format!("{:?}", e)),
                    })
                    .await;
                DisconnectReason::NetworkError(e.to_string())
            }
        }
    }

    /// 인스턴스 ID 재생성
    fn regenerate_instance_id(ws_url: &str, parsed: &Url, is_multiwidget: bool) -> String {
        if !is_multiwidget || !ws_url.contains("instance=") {
            return ws_url.to_string();
        }

        let new_instance_prefix = ProtocolSequence::generate_instance_prefix();
        let session_prefix = parsed
            .query_pairs()
            .find(|(k, _)| k.as_ref().eq_ignore_ascii_case("EVOSESSIONID"))
            .map(|(_, v)| v.chars().take(16).collect::<String>())
            .unwrap_or_else(|| new_instance_prefix.clone());

        let new_instance = format!("{}-{}-", new_instance_prefix, session_prefix);

        let mut new_url = ws_url.to_string();
        if let Some(start) = new_url.find("instance=") {
            let end = new_url[start..]
                .find('&')
                .map(|i| start + i)
                .unwrap_or(new_url.len());
            new_url = format!(
                "{}instance={}{}",
                &ws_url[..start],
                new_instance,
                &ws_url[end..]
            );
        }

        info!("[Evolution-Multi] 🔄 Regenerated browser instance ID");
        new_url
    }

    /// 기본 옵션 설정
    fn setup_default_options(options: &mut MultiSocketOptions, host: &str, parsed: &Url) {
        // 빈 문자열 옵션은 None으로 정규화한다. 프론트엔드/수동 경로가 ""(빈 문자열)을 넘기면
        // Some("")가 되어 아래 기본값(unwrap_or_else)을 건너뛰고 빈 User-Agent/Origin이 그대로
        // 전송된다 — Chrome TLS 지문과 모순되어 즉시 봇으로 플래그됨(ua-2).
        for opt in [
            &mut options.user_agent,
            &mut options.origin,
            &mut options.cookie,
            &mut options.referer,
        ] {
            if opt.as_deref().map(str::trim).map_or(false, str::is_empty) {
                *opt = None;
            }
        }

        if options.origin.is_none() {
            options.origin = Some(format!("https://{}", host));
        }

        if options.referer.is_none() {
            let base_referer = format!("https://{}/frontend/evo/r2/", host);
            options.referer = Some(match &options.mwg_params {
                Some(mwg) if !mwg.is_empty() => format!("{}#{}", base_referer, mwg),
                _ => base_referer,
            });
        }

        if options.cookie.is_none() {
            if let Some(session) = parsed.query_pairs().find_map(|(k, v)| {
                k.as_ref()
                    .eq_ignore_ascii_case("EVOSESSIONID")
                    .then(|| v.to_string())
            }) {
                options.cookie = Some(format!("EVOSESSIONID={}", session));
            }
        }
    }

    /// 연결 정보 로깅
    fn log_connection_info(ws_url: &str, host: &str, origin: &str, referer: &str, cookie: &str) {
        info!("[Evolution-Multi] 🔌 Connecting with Chrome TLS fingerprint...");
        info!(
            "[Evolution-Multi] 📍 Endpoint: {}",
            websocket_endpoint_for_log(ws_url)
        );
        info!("[Evolution-Multi] 📋 Host: {}", host);
        info!(
            "[Evolution-Multi] 📋 Credentials: origin_present={} referer_present={} cookie_present={}",
            !origin.is_empty(),
            !referer.is_empty(),
            !cookie.is_empty()
        );
    }

    /// 초기화 시퀀스 전송
    async fn send_init_sequence<W>(write: &mut W, is_lobby_v2: bool) -> Result<(), String>
    where
        W: SinkExt<WsMessage> + Unpin,
        W::Error: std::fmt::Display,
    {
        // lobby v2는 브라우저와 동일하게 `lobby.initLobby`를 보내야 서버가 구독자로 인정하고
        // 연결을 유지한다. 구버전 multiwidget init을 보내면 v2 서버가 잠시 후 끊는다.
        let sequence = if is_lobby_v2 {
            info!("[Evolution-Multi] 📤 Sending lobby v2 init sequence (lobby.initLobby)...");
            ProtocolSequence::init_lobby_v2()
        } else {
            info!("[Evolution-Multi] 📤 Sending init sequence...");
            ProtocolSequence::init_multiwidget()
        };

        for (i, msg) in sequence.iter().enumerate() {
            if let Err(e) = write.send(WsMessage::Text(msg.to_string().into())).await {
                return Err(format!("Init message {} failed: {}", i + 1, e));
            }
            jitter_sleep(INIT_GAP_MIN_MS, INIT_GAP_MAX_MS).await;
        }

        info!("[Evolution-Multi] ✅ Init sequence completed");
        Ok(())
    }

    /// 메시지 루프 실행 - DisconnectReason 반환
    async fn run_message_loop<W, R>(
        event_tx: &EventSender,
        write: &mut W,
        read: &mut R,
        msg_rx: &mut tokio::sync::mpsc::Receiver<OutboundMessage>,
        shutdown_rx: &mut tokio::sync::broadcast::Receiver<()>,
    ) -> DisconnectReason
    where
        W: SinkExt<WsMessage> + Unpin,
        W::Error: std::fmt::Display,
        R: StreamExt<Item = Result<WsMessage, wreq::Error>> + Unpin,
    {
        // 하트비트 타이밍 랜덤화 - 봇 탐지 패턴 분석 방지
        let mut next_heartbeat = jitter_deadline(HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS);

        // WS 제어프레임 Ping(핑퐁) — metrics.ping과 독립 스케줄. 세션 liveness 유지용.
        let mut next_ws_ping = jitter_deadline(WS_PING_MIN_MS, WS_PING_MAX_MS);

        // 수신 타임아웃: 마지막으로 서버에서 데이터를 받은 시각 추적
        let mut last_received = tokio::time::Instant::now();
        let receive_timeout = tokio::time::Duration::from_millis(RECEIVE_TIMEOUT_MS);

        info!("[Evolution-Multi] 🔄 Entering message loop...");

        let mut tables_subscribed = false;
        // lobby v2: lobby.categories를 받아 lobby.subscribe를 보냈는지(1회만 전송).
        let mut lobby_subscribed = false;
        let mut msg_count: u64 = 0;
        // 🔧 [BET-FIX] 테이블별 실시간 gameId (tableId → 현재 라운드 gameId). 배팅 전송 시
        // 프론트가 넣은 synthetic-… gameId를 이 실제 gameId로 치환하는 데 쓴다(실배팅 등록 수정).
        let mut table_game_ids: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        loop {
            let timeout_deadline = last_received + receive_timeout;

            tokio::select! {
                msg = read.next() => {
                    msg_count += 1;
                    last_received = tokio::time::Instant::now();

                    match msg {
                        Some(Ok(WsMessage::Text(text))) => {
                            debug!("[Evolution-Multi] 📨 MSG#{} len={}", msg_count, text.len());

                            // Opt-in diagnostics expose metadata only. Raw frames can contain
                            // session cookies, tokens, balances, and bet payloads.
                            if diagnostics_enabled()
                                && (text.contains("categor") || text.contains("lobbydata")
                                    || text.contains("availableTables") || text.contains("historyUpdated")
                                    || text.contains("histories"))
                            {
                                info!(
                                    "[Evolution-Multi] [LOBBY-DIAG] {}",
                                    diagnostic_frame_summary(&text)
                                );
                            }

                            // 🔧 [BET-FIX] 실시간 gameId 추적: 게임 프레임(newGame/gameState/playerBettingState 등)은
                            // args에 tableId+gameId를 담는다. 이 실제 gameId를 테이블별로 저장해 두었다가, 배팅 전송 시
                            // 프론트가 넣은 synthetic-… gameId를 치환한다(auto 모드에서 프론트가 실시간 gameId를 못 받는
                            // 구조적 gap 보완 — webview CDP forward가 predict 전용이라). 값싼 substring 가드로 게임 프레임만 파싱.
                            if text.contains("\"gameId\"") && text.contains("\"tableId\"") {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(args) = v.get("args") {
                                        // 멀티테이블 모드의 실시간 gameId는 두 경로로 도착한다(라이브 덤프 확인):
                                        //  - baccarat.gameState / newGame: top-level args.gameId
                                        //  - baccarat.tableState:          args.currentGame.gameId (중첩)
                                        // 둘 다 추적해야 BET-FIX가 최신 gameId를 확보한다(예전엔 top-level만 봐서
                                        // tableState만 받는 테이블은 추적값이 비어 synthetic/stale 전송됨 = 실배팅 무효 원인).
                                        let tid = args.get("tableId").and_then(|x| x.as_str());
                                        let gid = args.get("gameId").and_then(|x| x.as_str())
                                            .or_else(|| {
                                                args.get("currentGame")
                                                    .and_then(|c| c.get("gameId"))
                                                    .and_then(|x| x.as_str())
                                            });
                                        if let (Some(tid), Some(gid)) = (tid, gid) {
                                            if !gid.is_empty() && !gid.starts_with("synthetic-") {
                                                table_game_ids.insert(tid.to_string(), gid.to_string());
                                            }
                                        }
                                    }
                                }
                            }

                            if diagnostics_enabled()
                                && (text.contains("Bet") || text.contains("Chip") || text.contains("Author")
                                    || text.contains("\"error\"") || text.contains("eject") || text.contains("ccept"))
                            {
                                info!(
                                    "[Evolution-Multi] [BET-DIAG] IN {}",
                                    diagnostic_frame_summary(&text)
                                );
                            }

                            // ✅ [BET-CONFIRM] 실배팅이 Evolution에 '실제로 등록'됐는지 확인(라이브 검증용).
                            // playerBettingState에 실제 베팅이 잡히면(HasBet:true / acceptedBets·currentChips 비어있지 않음 /
                            // totalAmount>0) 등록 성공이다. playerBetRequest OUT 후 이 줄이 한 번도 안 뜨면
                            // = Evolution이 베팅을 무시(미등록)한 것 = 실제로는 배팅이 안 된 것.
                            if text.contains("playerBettingState")
                                && (
                                    text.contains("\"HasBet\":true")
                                    || text.contains("\"acceptedBets\":{\"")
                                    || text.contains("\"currentChips\":{\"")
                                    || (text.contains("\"totalAmount\":") && !text.contains("\"totalAmount\":0"))
                                )
                            {
                                info!("[Evolution-Multi] ✅ [BET-CONFIRM] 베팅 등록 확인");
                                if diagnostics_enabled() {
                                    info!(
                                        "[Evolution-Multi] [BET-DIAG] CONFIRM {}",
                                        diagnostic_frame_summary(&text)
                                    );
                                }
                            }

                            match Self::handle_incoming_message(event_tx, &text).await {
                                // 서버 킥아웃(세션 만료/중복세션 등). 같은 만료 EVOSESSIONID로 재연결하면
                                // 100% 다시 킥당하므로 루프를 즉시 종료한다 → connection_task의 Kickout 분기로
                                // 라우팅되어 재연결 없이 Disconnected만 방출(방 상태 보존, 헛재연결 폭주 방지).
                                Some(HandleOutcome::Kickout(reason)) => {
                                    warn!(
                                        "[Evolution-Multi] ⚠️ Kickout in message loop ({}) — stopping, no reconnect",
                                        reason
                                    );
                                    return DisconnectReason::Kickout(reason);
                                }
                                Some(HandleOutcome::Subscribe(tables)) => {
                                    if !tables_subscribed {
                                        match Self::subscribe_to_tables(write, &tables).await {
                                            Ok(count) => {
                                                tables_subscribed = true;
                                                let _ = event_tx.send(EvolutionEvent::RoomsReady {
                                                    room_count: count,
                                                    total_available: tables.len(),
                                                }).await;
                                            }
                                            Err(e) => warn!("[Evolution-Multi] Subscribe failed: {}", e),
                                        }
                                    }
                                }
                                Some(HandleOutcome::LobbySubscribe(table_ids)) => {
                                    // lobby v2: 받은 바카라 테이블들을 한 번만 구독한다(subscriptionModel).
                                    if !lobby_subscribed {
                                        lobby_subscribed = true;
                                        let sub = ProtocolSequence::lobby_subscribe(&table_ids);
                                        match write.send(WsMessage::Text(sub.to_string().into())).await {
                                            Ok(_) => {
                                                info!("[Evolution-Multi] 📋 lobby.subscribe 전송 — {} 바카라 테이블 구독(결과/gameId push 요청)", table_ids.len());
                                                let _ = event_tx.send(EvolutionEvent::RoomsReady {
                                                    room_count: table_ids.len(),
                                                    total_available: table_ids.len(),
                                                }).await;
                                            }
                                            Err(e) => warn!("[Evolution-Multi] lobby.subscribe 실패: {}", e),
                                        }
                                    }
                                }
                                None => {}
                            }
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            let _ = write.send(WsMessage::Pong(data)).await;
                        }
                        Some(Ok(WsMessage::Pong(_))) => {
                            // 서버 pong 수신 — last_received 이미 갱신됨
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            // 종료 코드/사유를 명확히 로깅 — ~20분 만료의 실제 원인(코드/사유) 진단용.
                            match &frame {
                                Some(cf) => warn!(
                                    "[Evolution-Multi] Server closed: code={:?} reason={:?} (after {} msgs)",
                                    cf.code, cf.reason, msg_count
                                ),
                                None => warn!(
                                    "[Evolution-Multi] Server closed (no close frame, after {} msgs)",
                                    msg_count
                                ),
                            }
                            return DisconnectReason::ServerClosed;
                        }
                        Some(Err(e)) => {
                            error!("[Evolution-Multi] ❌ Error: {}", e);
                            return DisconnectReason::NetworkError(e.to_string());
                        }
                        None => {
                            info!("[Evolution-Multi] 📭 Stream ended");
                            return DisconnectReason::ServerClosed;
                        }
                        _ => {}
                    }
                }
                Some(outgoing) = msg_rx.recv() => {
                    let OutboundMessage { payload, response_tx, expires_at } = outgoing;

                    if response_tx.is_closed() {
                        continue;
                    }
                    if tokio::time::Instant::now() >= expires_at {
                        let _ = response_tx.send(Err(
                            "Outbound message expired before socket send".to_string()
                        ));
                        continue;
                    }

                    let to_send = match prepare_outgoing_message(payload, &table_game_ids) {
                        Ok(message) => message,
                        Err(error) => {
                            warn!("[Evolution-Multi] 🛡️ {}", error);
                            let _ = response_tx.send(Err(error));
                            continue;
                        }
                    };

                    if diagnostics_enabled()
                        && (to_send.contains("Bet") || to_send.contains("bet")
                            || to_send.contains("Chip") || to_send.contains("chips"))
                    {
                        info!(
                            "[Evolution-Multi] [BET-DIAG] OUT {}",
                            diagnostic_frame_summary(&to_send)
                        );
                    }

                    // Do not send a message after its caller has timed out or cancelled.
                    if response_tx.is_closed() || tokio::time::Instant::now() >= expires_at {
                        let _ = response_tx.send(Err(
                            "Outbound message expired before socket send".to_string()
                        ));
                        continue;
                    }

                    match tokio::time::timeout_at(
                        expires_at,
                        write.send(WsMessage::Text(to_send.into())),
                    )
                    .await
                    {
                        Ok(Ok(())) => {
                            let _ = response_tx.send(Ok(()));
                        }
                        Ok(Err(error)) => {
                            let error_message = format!("Socket send failed: {error}");
                            let _ = response_tx.send(Err(error_message.clone()));
                            error!("[Evolution-Multi] ❌ {}", error_message);
                            return DisconnectReason::NetworkError(error.to_string());
                        }
                        Err(_) => {
                            let error_message = "Socket send deadline exceeded".to_string();
                            let _ = response_tx.send(Err(error_message.clone()));
                            warn!("[Evolution-Multi] ⏰ {}", error_message);
                            return DisconnectReason::NetworkError(error_message);
                        }
                    }
                }
                _ = tokio::time::sleep_until(next_heartbeat) => {
                    let ping = ProtocolSequence::metrics_ping();
                    if let Err(e) = write.send(WsMessage::Text(ping.to_string().into())).await {
                        warn!("[Evolution-Multi] Heartbeat failed: {}", e);
                        return DisconnectReason::NetworkError(e.to_string());
                    }
                    // lobby v2 앱-레벨 keepalive PING(eventType:PING) — 서버의 세션 활성 신호.
                    // 이게 없으면 metrics.ping/게임데이터가 흘러도 서버가 ~10분 뒤 inactivity로
                    // 세션을 만료(server_closed→재연결 시 KICKOUT:inactivity)한다(라이브 확인 2026-05-31).
                    let lobby_ping = ProtocolSequence::lobby_ping();
                    if let Err(e) = write.send(WsMessage::Text(lobby_ping.to_string().into())).await {
                        warn!("[Evolution-Multi] Lobby ping failed: {}", e);
                        return DisconnectReason::NetworkError(e.to_string());
                    }
                    next_heartbeat = jitter_deadline(HEARTBEAT_MIN_MS, HEARTBEAT_MAX_MS);
                }
                _ = tokio::time::sleep_until(next_ws_ping) => {
                    // 진짜 WS 제어프레임 Ping(핑퐁). 서버는 표준에 따라 Pong을 돌려주고(위 Pong 처리에서
                    // last_received 갱신), 텍스트가 아니므로 파서/프론트엔드/방 상태에 닿지 않는다.
                    // 빈 페이로드는 RFC 6455 허용. 송신 실패는 소켓이 죽었다는 의미 → 재연결로 라우팅.
                    if let Err(e) = write.send(WsMessage::Ping(Default::default())).await {
                        warn!("[Evolution-Multi] WS ping(control frame) failed: {}", e);
                        return DisconnectReason::NetworkError(e.to_string());
                    }
                    // INFO 레벨 — 이게 10~15초마다 계속 찍히면 소켓 생존 중. 끊기면 이 줄이 멈춘다.
                    info!(
                        "[Evolution-Multi] 🏓 WS keepalive ping (msgs={}, {}s since last recv)",
                        msg_count,
                        last_received.elapsed().as_secs()
                    );
                    next_ws_ping = jitter_deadline(WS_PING_MIN_MS, WS_PING_MAX_MS);
                }
                _ = tokio::time::sleep_until(timeout_deadline) => {
                    let elapsed = last_received.elapsed().as_secs();
                    warn!(
                        "[Evolution-Multi] ⏰ Receive timeout: no data for {}s (threshold: {}ms)",
                        elapsed, RECEIVE_TIMEOUT_MS
                    );
                    return DisconnectReason::ReceiveTimeout;
                }
                _ = shutdown_rx.recv() => {
                    info!("[Evolution-Multi] 🛑 Shutdown signal");
                    let _ = write.close().await;
                    return DisconnectReason::UserRequested;
                }
            }
        }
    }

    /// 수신 메시지 처리 - 테이블 목록 반환 시 Some
    #[tracing::instrument(skip_all, level = "debug", fields(msg_len = text.len()))]
    async fn handle_incoming_message(event_tx: &EventSender, text: &str) -> Option<HandleOutcome> {
        let parsed = match MessageParser::parse(text) {
            Ok(msg) => msg,
            Err(e) => {
                warn!("[Evolution-Multi] Parse error: {}", e);
                return None;
            }
        };

        // lobby.categories(Other로 분류)를 받으면 바카라 ID를 추출해 루프에 구독을 신호한다.
        // 그 외 메시지는 None. (Kickout/AvailableTables는 아래 arm에서 early-return하므로 무관)
        let mut pending: Option<HandleOutcome> = None;

        match &parsed {
            IncomingMessage::Pong => {
                debug!("[Evolution-Multi] 💓 Pong");
            }
            IncomingMessage::GameResult { table_id, data } => {
                let _ = event_tx
                    .send(EvolutionEvent::GameResult {
                        table_id: table_id.clone().unwrap_or_default(),
                        data: data.clone(),
                    })
                    .await;
            }
            IncomingMessage::GameState { table_id, data } => {
                let _ = event_tx
                    .send(EvolutionEvent::GameState {
                        table_id: table_id.clone().unwrap_or_default(),
                        data: data.clone(),
                    })
                    .await;
            }
            IncomingMessage::Kickout { reason } => {
                warn!("[Evolution-Multi] ⚠️ KICKOUT: {}", reason);
                // 루프에 즉시 종료를 신호한다(만료/중복 세션 재연결 폭주 방지).
                // Disconnected 이벤트는 connection_task의 Kickout 분기에서 단일 방출한다.
                return Some(HandleOutcome::Kickout(reason.clone()));
            }
            IncomingMessage::Error { message, data } => {
                error!("[Evolution-Multi] ❌ Error: {}", message);
                let _ = event_tx
                    .send(EvolutionEvent::Error {
                        url: String::new(),
                        error: message.clone(),
                        error_detail: Some(data.to_string()),
                    })
                    .await;
            }
            IncomingMessage::AvailableTables { tables } => {
                info!("[Evolution-Multi] 📋 {} tables available", tables.len());

                let summaries: Vec<TableSummary> = tables.iter().map(|t| t.into()).collect();
                let _ = event_tx
                    .send(EvolutionEvent::TablesAvailable { tables: summaries })
                    .await;

                return Some(HandleOutcome::Subscribe(tables.clone()));
            }
            IncomingMessage::Other {
                msg_type,
                table_id,
                data,
            } => {
                if !msg_type.is_empty() {
                    let _ = event_tx
                        .send(EvolutionEvent::TableEvent {
                            table_id: table_id.clone(),
                            event_type: msg_type.clone(),
                            data: data.clone(),
                        })
                        .await;
                }
                // 🔧 [LOBBY-V2 SUBSCRIBE] lobby.categories(전체 방 목록)를 받으면 바카라 ID를 뽑아
                // lobby.subscribe를 보내도록 신호한다. lobby v2는 subscriptionModel이라 구독한 테이블만
                // per-table 결과/히스토리/gameId를 push한다(브라우저 캡처 확인). 구독해야 로드맵·예측·
                // 자동배팅 데이터가 흐른다. (RawMessage 포워딩은 match 아래에서 계속 진행됨)
                if msg_type.as_str() == "lobby.categories" {
                    let ids = extract_baccarat_table_ids(data);
                    if !ids.is_empty() {
                        info!(
                            "[Evolution-Multi] 📑 lobby.categories 수신 — 바카라 {}개 구독 예약",
                            ids.len()
                        );
                        pending = Some(HandleOutcome::LobbySubscribe(ids));
                    }
                }
            }
        }

        // Raw 이벤트 발송
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(text) {
            let msg_type = json
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let _ = event_tx
                .send(EvolutionEvent::RawMessage {
                    event_type: msg_type,
                    payload: json,
                })
                .await;
        }

        pending
    }

    /// 테이블 구독 - 구독 성공 개수 반환
    async fn subscribe_to_tables<W>(write: &mut W, tables: &[TableInfo]) -> Result<usize, String>
    where
        W: SinkExt<WsMessage> + Unpin,
        W::Error: std::fmt::Display,
    {
        let baccarat_ids = TableFilter::filter_baccarat_tables(tables);
        let mut targets = TableFilter::take_tables(baccarat_ids, MAX_SUBSCRIBE_TABLES);

        // Real users open rooms in an unpredictable order — deterministic
        // alphabetical / lobby-feed order is itself a bot signal when 60
        // tables are subscribed in a tight window.
        use rand::seq::SliceRandom;
        targets.shuffle(&mut rand::thread_rng());

        info!(
            "[Evolution-Multi] 🎰 Subscribing to {} tables",
            targets.len()
        );

        let mut sent_count = 0;
        for table_id in &targets {
            // game.open
            let open_msg = ProtocolSequence::game_open(table_id);
            if write
                .send(WsMessage::Text(open_msg.to_string().into()))
                .await
                .is_err()
            {
                continue;
            }

            // subscribeTable
            let sub_msg = ProtocolSequence::subscribe_table(table_id);
            if write
                .send(WsMessage::Text(sub_msg.to_string().into()))
                .await
                .is_ok()
            {
                sent_count += 1;
            }

            jitter_sleep(SUBSCRIBE_GAP_MIN_MS, SUBSCRIBE_GAP_MAX_MS).await;
        }

        info!(
            "[Evolution-Multi] ✅ Subscribed to {}/{}",
            sent_count,
            targets.len()
        );
        Ok(sent_count)
    }

    /// 메시지 송신
    pub async fn send_message(&self, message: String) -> Result<(), String> {
        if !self.is_connected() {
            return Err("Not connected".to_string());
        }

        let tx = self
            .msg_tx
            .as_ref()
            .ok_or_else(|| "Not connected".to_string())?;
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        let timeout = tokio::time::Duration::from_secs(OUTBOUND_ACK_TIMEOUT_SECS);
        let deadline = tokio::time::Instant::now() + timeout;
        tokio::time::timeout_at(
            deadline,
            tx.send(OutboundMessage {
                payload: message,
                response_tx,
                expires_at: deadline,
            }),
        )
        .await
        .map_err(|_| "Timed out waiting to enqueue socket message".to_string())?
        .map_err(|_| "Connection task stopped before message enqueue".to_string())?;

        tokio::time::timeout_at(deadline, response_rx)
            .await
            .map_err(|_| "Timed out waiting for socket send acknowledgement".to_string())?
            .map_err(|_| "Connection task stopped before socket send".to_string())?
    }

    /// 종료
    pub async fn disconnect(&mut self) {
        info!("[Evolution-Multi] 🔌 Disconnecting...");

        if let Some(tx) = &self.shutdown_tx {
            let _ = tx.send(());
        }

        self.shutdown_tx = None;
        self.msg_tx = None;
        self.connected.store(false, Ordering::SeqCst);
        self.state_machine.reset();

        // Lane R2 safety net: abort any tasks still tracked by the registry.
        // The broadcast shutdown above is the primary cancellation path; the
        // abort_all here catches stragglers (stuck syscalls, dropped futures
        // that never observe the broadcast).
        self.task_registry.abort_all();

        info!("[Evolution-Multi] ✅ Disconnected");
    }
}

impl Default for EvolutionMultiSocket {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri 상태용 래퍼
pub struct EvolutionMultiSocketState {
    pub client: std::sync::Arc<tokio::sync::Mutex<EvolutionMultiSocket>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn bet_message(game_id: &str) -> String {
        serde_json::json!({
            "type": "baccarat.playerBetRequest",
            "args": {
                "tableId": "table-1",
                "gameId": game_id,
                "chips": { "Banker": 1000 }
            }
        })
        .to_string()
    }

    #[test]
    fn player_bet_uses_connection_tracked_game_id() {
        let tracked = HashMap::from([("table-1".to_string(), "current-round".to_string())]);

        let prepared = prepare_outgoing_message(bet_message("stale-round"), &tracked).unwrap();
        let value: serde_json::Value = serde_json::from_str(&prepared).unwrap();

        assert_eq!(value["args"]["gameId"], "current-round");
    }

    #[test]
    fn player_bet_without_tracked_game_id_is_fail_closed_even_if_id_looks_real() {
        let error = prepare_outgoing_message(bet_message("looks-real-but-stale"), &HashMap::new())
            .unwrap_err();

        assert!(error.contains("current gameId unavailable"));
    }

    #[test]
    fn player_bet_without_tracked_game_id_rejects_synthetic_id() {
        let error = prepare_outgoing_message(bet_message("synthetic-table-1-123"), &HashMap::new())
            .unwrap_err();

        assert!(error.contains("current gameId unavailable"));
    }

    #[test]
    fn malformed_player_bet_is_fail_closed() {
        let error =
            prepare_outgoing_message("playerBetRequest:not-json".to_string(), &HashMap::new())
                .unwrap_err();

        assert_eq!(error, "Blocked playerBetRequest: malformed JSON");
    }

    #[test]
    fn non_bet_message_is_unchanged() {
        let message = r#"{"type":"lobby.ping","args":{}}"#.to_string();

        assert_eq!(
            prepare_outgoing_message(message.clone(), &HashMap::new()).unwrap(),
            message
        );
    }

    #[test]
    fn diagnostic_summary_does_not_include_sensitive_values() {
        let frame = serde_json::json!({
            "type": "baccarat.playerBettingState",
            "args": {
                "tableId": "secret-table-id",
                "EVOSESSIONID": "secret-session-value",
                "token": "secret-token-value",
                "error": "secret-error-detail"
            }
        })
        .to_string();

        let summary = diagnostic_frame_summary(&frame);

        assert!(summary.contains("baccarat.playerBettingState"));
        assert!(!summary.contains("secret-table-id"));
        assert!(!summary.contains("secret-session-value"));
        assert!(!summary.contains("secret-token-value"));
        assert!(!summary.contains("secret-error-detail"));
    }

    #[test]
    fn websocket_log_endpoint_strips_query_and_fragment() {
        let endpoint = websocket_endpoint_for_log(
            "wss://example.test/public/lobby/socket/v2?EVOSESSIONID=secret#token",
        );

        assert_eq!(endpoint, "wss://example.test/public/lobby/socket/v2");
        assert!(!endpoint.contains("secret"));
        assert!(!endpoint.contains("token"));
    }

    #[tokio::test]
    async fn send_message_returns_socket_task_rejection_to_caller() {
        let mut client = EvolutionMultiSocket::new();
        client.connected.store(true, Ordering::SeqCst);
        let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel(1);
        client.msg_tx = Some(msg_tx);

        let reject = async move {
            let queued: OutboundMessage = msg_rx.recv().await.unwrap();
            queued
                .response_tx
                .send(Err("safety gate rejected message".to_string()))
                .unwrap();
        };
        let send = client.send_message("payload".to_string());
        let (_, result) = tokio::join!(reject, send);

        assert_eq!(result.unwrap_err(), "safety gate rejected message");
    }
}
