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
//! Uses rquest with Chrome impersonation (BoringSSL) to bypass Akamai bot detection.

use super::connection_state::{ConnectionStateMachine, StateTransition};
use super::events::{DisconnectReason, EvolutionEvent, EventSender, TableSummary};
use super::message_parser::{IncomingMessage, MessageParser, TableInfo};
use super::protocol::ProtocolSequence;
use super::table_filter::TableFilter;
use futures_util::{SinkExt, StreamExt};
use once_cell::sync::Lazy;
use rquest::Message as RquestMessage;
use rquest_util::Emulation;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, error, info, warn};
use url::Url;

/// 최대 구독 테이블 수 (제한 없음)
const MAX_SUBSCRIBE_TABLES: usize = 60;

/// 이벤트 채널 버퍼 크기 (60개 방 기준 피크 부하 대응)
const EVENT_CHANNEL_BUFFER: usize = 1024;

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

/// 멀티테이블 WS 클라이언트 (단일 소켓)
pub struct EvolutionMultiSocket {
    state_machine: ConnectionStateMachine,
    shutdown_tx: Option<tokio::sync::broadcast::Sender<()>>,
    msg_tx: Option<tokio::sync::mpsc::Sender<String>>,
    event_tx: Option<EventSender>,
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
        }
    }

    pub fn is_connected(&self) -> bool {
        self.state_machine.state().is_connected()
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
    pub fn create_event_channel(
        &mut self,
    ) -> super::events::EventReceiver {
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

        // 상태 전이: Disconnected -> Connecting
        if let Err(e) = self.state_machine.transition(StateTransition::StartConnect) {
            warn!("[Evolution-Multi] State transition error: {}", e);
        }

        let parsed = Url::parse(&ws_url).map_err(|e| format!("Invalid WS URL: {}", e))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "Missing host in WS URL".to_string())?
            .to_string();

        let is_multiwidget = ws_url.contains("/multiwidget/");
        info!(
            "[Evolution-Multi] 🎰 Is multiwidget socket: {}",
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
        let user_agent = options.user_agent.clone().unwrap_or_else(|| {
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".to_string()
        });
        let referer = options
            .referer
            .clone()
            .unwrap_or_else(|| format!("https://{}/frontend/evo/r2/", host));

        Self::log_connection_info(&ws_url, &host, &origin, &referer, &cookie);

        let (shutdown_tx, shutdown_rx) = tokio::sync::broadcast::channel(1);
        self.shutdown_tx = Some(shutdown_tx);

        let (msg_tx, msg_rx) = tokio::sync::mpsc::channel::<String>(64);
        self.msg_tx = Some(msg_tx);

        // 이벤트 송신자 복제 (없으면 더미 채널 생성)
        let event_tx = self.event_tx.clone().unwrap_or_else(|| {
            let (tx, _) = tokio::sync::mpsc::channel(1);
            tx
        });

        let ws_url_clone = ws_url.clone();
        let is_multiwidget_clone = is_multiwidget;
        let referer_without_hash = referer.split('#').next().unwrap_or(&referer).to_string();

        tokio::spawn(async move {
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
            )
            .await;
        });

        info!("[Evolution-Multi] 🎯 Connection initiated (async)");
        Ok(())
    }

    /// 연결 태스크 (백그라운드 실행)
    async fn connection_task(
        ws_url: String,
        is_multiwidget: bool,
        origin: String,
        user_agent: String,
        cookie: String,
        referer: String,
        event_tx: EventSender,
        mut msg_rx: tokio::sync::mpsc::Receiver<String>,
        mut shutdown_rx: tokio::sync::broadcast::Receiver<()>,
    ) {
        info!("[Evolution-Multi] 🚀 Attempting WebSocket connection...");

        // TLS 클라이언트 빌드 - Chrome 131 최신 지문 사용
        let client = match rquest::Client::builder()
            .emulation(Emulation::Chrome131)
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                error!("[Evolution-Multi] ❌ Failed to build client: {}", e);
                let _ = event_tx
                    .send(EvolutionEvent::Error {
                        url: ws_url,
                        error: format!("Failed to build client: {}", e),
                        error_detail: None,
                    })
                    .await;
                return;
            }
        };

        // WebSocket 요청 빌드 - Chrome 131 브라우저 모방
        // 주의: Sec-WebSocket-* 헤더는 rquest가 자동 처리하므로 추가하면 안됨
        let ws_request = client
            .websocket(&ws_url)
            .header("Origin", &origin)
            .header("User-Agent", &user_agent)
            .header("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("Referer", &referer);

        let ws_request = if !cookie.is_empty() {
            ws_request.header("Cookie", &cookie)
        } else {
            ws_request
        };

        match ws_request.send().await {
            Ok(upgrade_response) => {
                info!(
                    "[Evolution-Multi] ✅ Upgrade response: {}",
                    upgrade_response.status()
                );

                match upgrade_response.into_websocket().await {
                    Ok(websocket) => {
                        info!("[Evolution-Multi] ✅ WebSocket connected!");

                        let (mut write, mut read) = websocket.split();

                        // 초기화 시퀀스 전송
                        if is_multiwidget {
                            if let Err(e) = Self::send_init_sequence(&mut write).await {
                                error!("[Evolution-Multi] ❌ Init failed: {}", e);
                                let _ = event_tx
                                    .send(EvolutionEvent::Error {
                                        url: ws_url,
                                        error: e,
                                        error_detail: None,
                                    })
                                    .await;
                                return;
                            }
                        }

                        // Connected 이벤트 발송
                        let _ = event_tx
                            .send(EvolutionEvent::Connected {
                                url: ws_url.clone(),
                                is_multiwidget,
                            })
                            .await;

                        // 메시지 루프
                        let disconnect_reason = Self::run_message_loop(
                            &event_tx,
                            &mut write,
                            &mut read,
                            &mut msg_rx,
                            &mut shutdown_rx,
                        )
                        .await;

                        // Disconnected 이벤트 발송
                        let _ = event_tx
                            .send(EvolutionEvent::Disconnected {
                                url: ws_url,
                                reason: disconnect_reason,
                            })
                            .await;
                    }
                    Err(e) => {
                        error!("[Evolution-Multi] ❌ Upgrade failed: {}", e);
                        let _ = event_tx
                            .send(EvolutionEvent::Error {
                                url: ws_url,
                                error: format!("WebSocket upgrade failed: {}", e),
                                error_detail: None,
                            })
                            .await;
                    }
                }
            }
            Err(e) => {
                error!("[Evolution-Multi] ❌ HTTP request failed: {}", e);
                let _ = event_tx
                    .send(EvolutionEvent::Error {
                        url: ws_url,
                        error: e.to_string(),
                        error_detail: Some(format!("{:?}", e)),
                    })
                    .await;
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

        info!("[Evolution-Multi] 🔄 New instance ID: {}", new_instance);
        new_url
    }

    /// 기본 옵션 설정
    fn setup_default_options(options: &mut MultiSocketOptions, host: &str, parsed: &Url) {
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
        info!("[Evolution-Multi] 📍 URL: {}", &ws_url[..ws_url.len().min(150)]);
        info!("[Evolution-Multi] 📋 Host: {}", host);
        info!("[Evolution-Multi] 📋 Origin: {}", origin);
        info!("[Evolution-Multi] 📋 Referer: {}", &referer[..referer.len().min(100)]);
        info!("[Evolution-Multi] 📋 Cookie: {}...", &cookie[..cookie.len().min(50)]);
    }

    /// 초기화 시퀀스 전송
    async fn send_init_sequence<W>(write: &mut W) -> Result<(), String>
    where
        W: SinkExt<RquestMessage> + Unpin,
        W::Error: std::fmt::Display,
    {
        info!("[Evolution-Multi] 📤 Sending init sequence...");

        for (i, msg) in ProtocolSequence::init_multiwidget().iter().enumerate() {
            if let Err(e) = write
                .send(RquestMessage::Text(msg.to_string().into()))
                .await
            {
                return Err(format!("Init message {} failed: {}", i + 1, e));
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }

        info!("[Evolution-Multi] ✅ Init sequence completed");
        Ok(())
    }

    /// 메시지 루프 실행 - DisconnectReason 반환
    async fn run_message_loop<W, R>(
        event_tx: &EventSender,
        write: &mut W,
        read: &mut R,
        msg_rx: &mut tokio::sync::mpsc::Receiver<String>,
        shutdown_rx: &mut tokio::sync::broadcast::Receiver<()>,
    ) -> DisconnectReason
    where
        W: SinkExt<RquestMessage> + Unpin,
        W::Error: std::fmt::Display,
        R: StreamExt<Item = Result<RquestMessage, rquest::Error>> + Unpin,
    {
        // 하트비트 타이밍 랜덤화 (4-6초) - 봇 탐지 패턴 분석 방지
        use rand::Rng;
        let mut next_heartbeat = tokio::time::Instant::now() + tokio::time::Duration::from_millis(
            rand::thread_rng().gen_range(4000..6000)
        );

        info!("[Evolution-Multi] 🔄 Entering message loop...");

        let mut tables_subscribed = false;
        let mut msg_count: u64 = 0;

        loop {
            tokio::select! {
                msg = read.next() => {
                    msg_count += 1;

                    match msg {
                        Some(Ok(RquestMessage::Text(text))) => {
                            debug!("[Evolution-Multi] 📨 MSG#{} len={}", msg_count, text.len());

                            if let Some(tables) = Self::handle_incoming_message(event_tx, &text).await {
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
                        }
                        Some(Ok(RquestMessage::Ping(data))) => {
                            let _ = write.send(RquestMessage::Pong(data)).await;
                        }
                        Some(Ok(RquestMessage::Close(frame))) => {
                            if let Some(cf) = frame {
                                warn!("[Evolution-Multi] Server closed: {:?}", cf.reason);
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
                    if let Err(e) = write.send(RquestMessage::Text(outgoing.into())).await {
                        error!("[Evolution-Multi] ❌ Send failed: {}", e);
                        return DisconnectReason::NetworkError(e.to_string());
                    }
                }
                _ = tokio::time::sleep_until(next_heartbeat) => {
                    let ping = ProtocolSequence::metrics_ping();
                    if let Err(e) = write.send(RquestMessage::Text(ping.to_string().into())).await {
                        warn!("[Evolution-Multi] Heartbeat failed: {}", e);
                        return DisconnectReason::NetworkError(e.to_string());
                    }
                    // 다음 하트비트 시간 랜덤 설정 (4-6초)
                    next_heartbeat = tokio::time::Instant::now() + tokio::time::Duration::from_millis(
                        rand::thread_rng().gen_range(4000..6000)
                    );
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
    async fn handle_incoming_message(
        event_tx: &EventSender,
        text: &str,
    ) -> Option<Vec<TableInfo>> {
        let parsed = match MessageParser::parse(text) {
            Ok(msg) => msg,
            Err(e) => {
                warn!("[Evolution-Multi] Parse error: {}", e);
                return None;
            }
        };

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
                let _ = event_tx
                    .send(EvolutionEvent::Kickout {
                        reason: reason.clone(),
                    })
                    .await;
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

                return Some(tables.clone());
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

        None
    }

    /// 테이블 구독 - 구독 성공 개수 반환
    async fn subscribe_to_tables<W>(write: &mut W, tables: &[TableInfo]) -> Result<usize, String>
    where
        W: SinkExt<RquestMessage> + Unpin,
        W::Error: std::fmt::Display,
    {
        let baccarat_ids = TableFilter::filter_baccarat_tables(tables);
        let targets = TableFilter::take_tables(baccarat_ids, MAX_SUBSCRIBE_TABLES);

        info!("[Evolution-Multi] 🎰 Subscribing to {} tables", targets.len());

        let mut sent_count = 0;
        for table_id in &targets {
            // game.open
            let open_msg = ProtocolSequence::game_open(table_id);
            if write
                .send(RquestMessage::Text(open_msg.to_string().into()))
                .await
                .is_err()
            {
                continue;
            }

            // subscribeTable
            let sub_msg = ProtocolSequence::subscribe_table(table_id);
            if write
                .send(RquestMessage::Text(sub_msg.to_string().into()))
                .await
                .is_ok()
            {
                sent_count += 1;
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }

        info!("[Evolution-Multi] ✅ Subscribed to {}/{}", sent_count, targets.len());
        Ok(sent_count)
    }

    /// 메시지 송신
    pub async fn send_message(&self, message: String) -> Result<(), String> {
        if let Some(tx) = &self.msg_tx {
            tx.send(message).await.map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Not connected".to_string())
        }
    }

    /// 종료
    pub async fn disconnect(&mut self) {
        info!("[Evolution-Multi] 🔌 Disconnecting...");

        if let Some(tx) = &self.shutdown_tx {
            let _ = tx.send(());
        }

        self.shutdown_tx = None;
        self.msg_tx = None;
        self.state_machine.reset();

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
