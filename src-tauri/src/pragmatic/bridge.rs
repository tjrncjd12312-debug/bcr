//! 프라그마틱 MTB(멀티테이블) **브릿지** — 브라우저가 연 게임 소켓을 CDP로 탭하고, 배팅/취소 XML을
//! 게임 iframe 컨텍스트의 훅(`__BCR_PRAG_SEND__`)으로 주입한다. 에볼루션 브릿지와 같은 골격.
//!
//! 근거: 라이브 캡처 2026-09-03 (`docs/protocol/pragmatic-mtb-game-socket-2026-09-03.md`).
//! - 소켓: `wss://gs10.<rot>.net/game?JSESSIONID=…&tableId=…&multiTable=true&mtbGroupId=…` 하나가
//!   ~30 테이블을 `channel="table-<id>"`로 실어 나른다. 수신 JSON(`{"<kind>":{…}}`), 송신 XML.
//! - 라운드: betsopen → betsclosingsoon(open+bt−6s) → betsclosed(open+bt−1s) → card… → gameresult → win.
//!   라운드 중 카운트다운 프레임은 없다(timer는 접속 스냅샷 1회) → 마감 = betsopen 수신 + betting_time − 1s.
//! - 배팅 `<command channel="table-X"><lpbet gm="mtb_desktop" gId uId ck><bet amt bc ck/></lpbet></command>`,
//!   취소 = amt="0" bc="8". ACK `{"command":{status}}` → 마감 후 `{"bet"}`/`{"bets"}` → 정산 `{"win"}`.
//! - Rust는 소켓을 직접 열지 않는다(2-클라이언트 = 킥/중복세션 원인). `BCR_PRAGMATIC_LEGACY_SOCKET=1`이면 옛 경로.
use std::collections::HashMap;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, info, warn};

use super::bet_builder::{build_bet_xml, normalize_table_id, now_ms, parse_bet_type, BetCode};
use super::normalizer::{
    parse_statistics_grid, CasinoEvent, NormalizedGameResult, NormalizedRoadResult, NormalizedRoom,
};

pub static PRAGMATIC_BRIDGE: Lazy<TokioMutex<PragmaticBridge>> =
    Lazy::new(|| TokioMutex::new(PragmaticBridge::new()));

/// CDP 루프가 async 락 없이 "이 requestId가 게임 소켓인가"를 판정하기 위한 셀.
static GAME_SOCKET_RID: Lazy<std::sync::Mutex<Option<String>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

/// 실배팅 전송에 필요한 최소 여유(ms). ACK 지연 ~200ms + 안전분.
const MIN_LEAD_MS: i64 = 800;
/// tableconfig를 못 받은 테이블의 기본 배팅창(초). 캡처상 스피드 13, 일반 18.
const DEFAULT_BETTING_TIME_SECS: u64 = 13;

/// 브릿지 모드(기본 ON). `BCR_PRAGMATIC_LEGACY_SOCKET=1`이면 Rust 직접 소켓(레거시).
pub fn bridge_mode_enabled() -> bool {
    !std::env::var("BCR_PRAGMATIC_LEGACY_SOCKET")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 🔬 자가 테스트(env `BCR_PRAG_SELFTEST=1`): 부착 후 첫 배팅창에 최소 배팅 1건 → 2초 뒤 취소.
fn selftest_enabled() -> bool {
    std::env::var("BCR_PRAG_SELFTEST")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub fn is_game_socket_request(request_id: &str) -> bool {
    GAME_SOCKET_RID
        .lock()
        .map(|g| g.as_deref() == Some(request_id))
        .unwrap_or(false)
}

/// 게임 소켓 URL 판정: `/game?…multiTable=true…`
pub fn is_game_socket_url(url: &str) -> bool {
    url.contains("/game?") && url.contains("multiTable=true")
}

#[derive(Debug, Clone, Default)]
pub struct TableState {
    pub name: Option<String>,
    pub betting_time_secs: Option<u64>,
    pub game_id: Option<String>,
    pub betting_open: bool,
    /// betsopen 수신 시각(로컬). 마감 = open_at + betting_time − 1s
    pub open_at: Option<Instant>,
    pub deadline_at_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct PendingBet {
    pub bet_type: String,
    pub amount: u64,
    pub game_id: String,
    pub sent_at_ms: i64,
    pub acked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeBetReceipt {
    pub table_id: String,
    pub bet_type: String,
    pub bet_code: u8,
    pub amount: u64,
    pub game_id: String,
    pub user_id: String,
    pub ck: i64,
    pub deadline_at_ms: i64,
    pub ms_left: i64,
}

pub struct PragmaticBridge {
    request_id: Option<String>,
    session_id: Option<String>,
    context_id: Option<i64>,
    ws_url: Option<String>,
    outbound: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    user_id: Option<String>,
    tables_order: Vec<String>,
    cfg_cursor: usize,
    tables: HashMap<String, TableState>,
    history: HashMap<String, Vec<NormalizedRoadResult>>,
    pending: HashMap<String, PendingBet>,
    selftest_done: bool,
    attached_at: Option<Instant>,
}

impl PragmaticBridge {
    pub fn new() -> Self {
        Self {
            request_id: None,
            session_id: None,
            context_id: None,
            ws_url: None,
            outbound: None,
            user_id: None,
            tables_order: Vec::new(),
            cfg_cursor: 0,
            tables: HashMap::new(),
            history: HashMap::new(),
            pending: HashMap::new(),
            selftest_done: false,
            attached_at: None,
        }
    }

    pub fn is_attached(&self) -> bool {
        self.outbound.is_some()
    }
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
    pub fn context_id(&self) -> Option<i64> {
        self.context_id
    }
    pub fn user_id(&self) -> Option<&str> {
        self.user_id.as_deref()
    }

    /// 브라우저가 게임 소켓을 열었다 — 그 소켓에 붙는다(직접 접속 없음). 옛 상태는 버린다.
    pub fn attach(
        &mut self,
        app: &AppHandle,
        request_id: &str,
        session_id: Option<&str>,
        ws_url: &str,
        outbound: tokio::sync::mpsc::UnboundedSender<String>,
    ) {
        let same_session = self.session_id.as_deref() == session_id;
        let keep_ctx = if same_session { self.context_id } else { None };
        let keep_uid = self.user_id.clone();
        *self = Self::new();
        self.request_id = Some(request_id.to_string());
        self.session_id = session_id.map(|s| s.to_string());
        self.context_id = keep_ctx;
        self.user_id = keep_uid;
        self.ws_url = Some(ws_url.to_string());
        self.outbound = Some(outbound);
        self.attached_at = Some(Instant::now());
        if let Ok(mut g) = GAME_SOCKET_RID.lock() {
            *g = Some(request_id.to_string());
        }
        info!(
            "🎲 [PRAG-BRIDGE] 게임 소켓 부착 rid={} session={:?} ctx={:?} url_len={}",
            request_id,
            session_id,
            self.context_id,
            ws_url.len()
        );
        emit(app, "pragmatic_bridge_status", serde_json::json!({ "attached": true }));
    }

    pub fn detach(&mut self, app: &AppHandle, reason: &str) {
        if self.outbound.is_none() {
            return;
        }
        warn!("🎲 [PRAG-BRIDGE] 분리: {}", reason);
        self.outbound = None;
        self.request_id = None;
        if let Ok(mut g) = GAME_SOCKET_RID.lock() {
            *g = None;
        }
        for t in self.tables.values_mut() {
            t.betting_open = false;
        }
        emit(app, "pragmatic_bridge_status", serde_json::json!({ "attached": false, "reason": reason }));
    }

    /// 블로커 콘솔 `[BCR_PRAG_WS]`가 찍힌 실행 컨텍스트 = 훅이 사는 곳.
    pub fn set_hook_context(&mut self, session_id: Option<&str>, context_id: i64) {
        if let (Some(s), Some(mine)) = (session_id, self.session_id.as_deref()) {
            if s != mine && self.request_id.is_some() {
                debug!("🎲 [PRAG-BRIDGE] 훅 컨텍스트 세션 불일치(무시): {} != {}", s, mine);
            }
        }
        if self.session_id.is_none() {
            self.session_id = session_id.map(|s| s.to_string());
        }
        self.context_id = Some(context_id);
        info!("🎲 [PRAG-BRIDGE] 송신 훅 컨텍스트 기록: session={:?} contextId={}", session_id, context_id);
    }

    pub fn set_user_id(&mut self, user_id: &str) {
        let uid = user_id.trim();
        if uid.is_empty() {
            return;
        }
        if self.user_id.as_deref() != Some(uid) {
            info!("🎲 [PRAG-BRIDGE] 사용자 id 확보: {}", uid);
            self.user_id = Some(uid.to_string());
        }
    }

    fn table_mut(&mut self, table: &str) -> &mut TableState {
        self.tables.entry(table.to_string()).or_default()
    }

    fn betting_time(&self, table: &str) -> u64 {
        self.tables
            .get(table)
            .and_then(|t| t.betting_time_secs)
            .unwrap_or(DEFAULT_BETTING_TIME_SECS)
    }

    fn table_name(&self, table: &str) -> String {
        self.tables
            .get(table)
            .and_then(|t| t.name.clone())
            .unwrap_or_else(|| format!("Baccarat {}", table))
    }

    /// 수수료 자동부착 테이블(2026-09-03 라이브 확정): Amazing Baccarat은 본배팅의 20%를 필수 보너스
    /// 배팅(betcode 1000)으로 서버가 붙인다 — 1,000원 Player를 보내면 `bets`에 {1000,bc0}+{200,bc1000}
    /// 두 건이 확정되고 정산 nwb=-1200(앱 회계 -1000과 200 어긋남). Mega Baccarat도 같은 멀티플라이어
    /// 계열이라 같이 제외한다(추정, 미관측). 에볼루션 라이트닝 20% 수수료와 동일 구조.
    fn is_fee_table(&self, table: &str) -> bool {
        let n = self.table_name(table).to_ascii_uppercase();
        n.contains("AMAZING") || n.contains("MEGA")
    }

    /// 게임 소켓 수신 프레임 한 건. `{"<kind>":{…}}` 형태만 다룬다.
    pub fn ingest(&mut self, app: &AppHandle, text: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        let Some(obj) = v.as_object() else { return };
        let Some((kind, body)) = obj.iter().next() else { return };
        let kind = kind.as_str();
        let s = |k: &str| body.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
        let table = s("table").or_else(|| s("tableId")).or_else(|| {
            s("channel").map(|c| c.trim_start_matches("table-").to_string())
        });

        match kind {
            "tablesorder" => {
                let list: Vec<String> = body
                    .as_array()
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                info!("🎲 [PRAG-BRIDGE] tablesorder {}개", list.len());
                for t in &list {
                    self.table_mut(t);
                }
                self.tables_order = list;
                self.cfg_cursor = 0;
            }
            "tableconfig" => {
                // 캡처상 tableconfig는 tablesorder 순서대로 도착한다(테이블 id 키 없음).
                let name = s("table_name");
                let bt = s("betting_time").and_then(|x| x.parse::<u64>().ok());
                let explicit = s("table").or_else(|| s("tableId"));
                let target = explicit.or_else(|| self.tables_order.get(self.cfg_cursor).cloned());
                if let Some(t) = target {
                    let st = self.table_mut(&t);
                    if name.is_some() {
                        st.name = name.clone();
                    }
                    if bt.is_some() {
                        st.betting_time_secs = bt;
                    }
                    debug!("🎲 [PRAG-BRIDGE] tableconfig {} → {:?} bt={:?}", t, name, bt);
                }
                self.cfg_cursor += 1;
                if self.cfg_cursor == self.tables_order.len() && !self.tables_order.is_empty() {
                    self.emit_rooms(app);
                }
            }
            "subscribe" => {
                if let Some(t) = table {
                    self.table_mut(&t);
                }
            }
            "statistic" => {
                // value = JSON 문자열 {"bigRoad":[[...6행]], "beadPlate":[...]} — bigRoad를 기존 디코더로.
                if let (Some(t), Some(val)) = (table.clone(), s("value")) {
                    if let Ok(sv) = serde_json::from_str::<serde_json::Value>(&val) {
                        if let Some(grid) = sv.get("bigRoad").and_then(|g| g.as_array()) {
                            let cols: Vec<Vec<String>> = grid
                                .iter()
                                .filter_map(|c| c.as_array())
                                .map(|c| c.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                                .collect();
                            let results = parse_statistics_grid(&cols);
                            if !results.is_empty() {
                                self.history.insert(t.clone(), results);
                                self.emit_room(app, &t);
                            }
                        }
                    }
                }
            }
            "game" => {
                if let (Some(t), Some(id)) = (table, s("id")) {
                    self.table_mut(&t).game_id = Some(id);
                }
            }
            "timer" => {
                // 접속 스냅샷: value = 남은 초(마감 후 음수). 이 순간 기준으로 마감 시각을 세운다.
                if let (Some(t), Some(val)) = (table, s("value")) {
                    let secs: i64 = val.parse().unwrap_or(0);
                    if let Some(id) = s("id") {
                        self.table_mut(&t).game_id = Some(id);
                    }
                    if secs > 0 {
                        let deadline = now_ms() + secs * 1000;
                        let bt = self.betting_time(&t);
                        let st = self.table_mut(&t);
                        st.betting_open = true;
                        st.deadline_at_ms = Some(deadline);
                        st.open_at = Some(Instant::now() - Duration::from_secs(bt.saturating_sub(1).saturating_sub(secs as u64)));
                        let gid = st.game_id.clone();
                        self.emit_betting_phase(app, &t, secs as u32, deadline, bt, gid);
                    } else {
                        self.table_mut(&t).betting_open = false;
                    }
                }
            }
            "betsopen" => {
                if let Some(t) = table {
                    let bt = self.betting_time(&t);
                    let window_secs = bt.saturating_sub(1).max(1);
                    let deadline = now_ms() + (window_secs as i64) * 1000;
                    let st = self.table_mut(&t);
                    st.betting_open = true;
                    st.open_at = Some(Instant::now());
                    st.deadline_at_ms = Some(deadline);
                    if let Some(g) = s("game") {
                        st.game_id = Some(g);
                    }
                    let gid = st.game_id.clone();
                    self.emit_betting_phase(app, &t, window_secs as u32, deadline, bt, gid);
                    self.maybe_selftest(&t);
                }
            }
            "betsclosingsoon" => {
                debug!("🎲 [PRAG-BRIDGE] closingsoon {:?}", table);
            }
            "betsclosed" => {
                if let Some(t) = table {
                    let st = self.table_mut(&t);
                    st.betting_open = false;
                    st.deadline_at_ms = None;
                    emit(app, "pragmatic_event", serde_json::json!({
                        "type": "betting_phase",
                        "data": { "room_id": t, "remaining_seconds": 0, "game_id": st.game_id, "closed": true }
                    }));
                }
            }
            "gameresult" => {
                if let Some(t) = table {
                    let result = s("result").unwrap_or_default().to_ascii_lowercase();
                    let winner = if result.starts_with('b') { "B" } else if result.starts_with('p') { "P" } else if result.starts_with('t') { "T" } else { "" };
                    if winner.is_empty() {
                        return;
                    }
                    let pp = s("player_pair").map(|x| x == "true").unwrap_or(false);
                    let bp = s("banker_pair").map(|x| x == "true").unwrap_or(false);
                    let score = s("score").and_then(|x| x.parse::<i32>().ok());
                    let entry = NormalizedRoadResult { winner: winner.to_string(), is_player_pair: pp, is_banker_pair: bp };
                    self.history.entry(t.clone()).or_default().push(entry);
                    let st = self.table_mut(&t);
                    st.betting_open = false;
                    let name = self.table_name(&t);
                    let ev = CasinoEvent::GameResult(NormalizedGameResult {
                        room_id: t.clone(),
                        winner: winner.to_string(),
                        table_type: Some("baccarat".to_string()),
                        table_subtype: None,
                        table_name: Some(name),
                        player_score: if winner == "P" { score } else { None },
                        banker_score: if winner == "B" { score } else { None },
                        is_player_pair: pp,
                        is_banker_pair: bp,
                    });
                    emit_event(app, &ev);
                }
            }
            "command" => {
                let status = s("status").unwrap_or_default();
                if let Some(t) = table.clone() {
                    if let Some(p) = self.pending.get_mut(&t) {
                        p.acked = status == "success";
                    }
                }
                info!("🎲 [PRAG-BRIDGE] command ack table={:?} status={}", table, status);
                emit(app, "pragmatic_bet_event", serde_json::json!({
                    "type": "command_ack", "table": table, "status": status
                }));
            }
            "bet" => {
                info!("🎲 [PRAG-BRIDGE] bet confirmed table={:?} amount={:?} betcode={:?}", table, s("amount"), s("betcode"));
                emit(app, "pragmatic_bet_event", serde_json::json!({
                    "type": "bet_confirmed", "table": table, "amount": s("amount"), "betcode": s("betcode"),
                    "game_id": table.as_ref().and_then(|t| self.tables.get(t)).and_then(|x| x.game_id.clone())
                }));
            }
            "bets" => {
                let list: Vec<serde_json::Value> = body
                    .get("bet")
                    .and_then(|b| b.as_array())
                    .cloned()
                    .unwrap_or_default();
                let non_empty: Vec<&serde_json::Value> = list.iter().filter(|b| b.as_object().map(|o| !o.is_empty()).unwrap_or(false)).collect();
                info!("🎲 [PRAG-BRIDGE] bets table={:?} count={}", table, non_empty.len());
                // 앱은 테이블당 한 라운드에 한 건만 건다 → 2건 이상 확정이면 서버가 자동 부착한 것(수수료 의심).
                if non_empty.len() > 1 {
                    if let Some(t) = table.as_deref() {
                        warn!("🎲 [PRAG-BRIDGE] ⚠️ 서버 자동부착 추가 배팅 감지 table={} name={} bets={} — 수수료 테이블 의심, 제외 목록 검토 필요",
                            t, self.table_name(t), serde_json::Value::Array(non_empty.iter().map(|v| (*v).clone()).collect()));
                    }
                }
                emit(app, "pragmatic_bet_event", serde_json::json!({
                    "type": if non_empty.is_empty() { "bets_cleared" } else { "bets_confirmed" },
                    "table": table, "bets": non_empty,
                }));
            }
            "win" => {
                let win: f64 = s("win").and_then(|x| x.parse().ok()).unwrap_or(0.0);
                let nwb: f64 = s("nwb").and_then(|x| x.parse().ok()).unwrap_or(0.0);
                info!("🎲 [PRAG-BRIDGE] settled table={:?} game={:?} win={} nwb={}", table, s("gameId"), win, nwb);
                if let Some(t) = table.clone() {
                    self.pending.remove(&t);
                }
                emit(app, "pragmatic_bet_event", serde_json::json!({
                    "type": "settled", "table": table, "game_id": s("gameId"), "win": win, "nwb": nwb
                }));
            }
            _ => {}
        }
    }

    fn emit_betting_phase(&self, app: &AppHandle, table: &str, remaining: u32, deadline_at_ms: i64, bt: u64, game_id: Option<String>) {
        if self.is_fee_table(table) {
            debug!("🎲 [PRAG-BRIDGE] 수수료 테이블 {} 배팅창 미공지(자동배팅 제외)", self.table_name(table));
            return;
        }
        emit(app, "pragmatic_event", serde_json::json!({
            "type": "betting_phase",
            "data": {
                "room_id": table,
                "remaining_seconds": remaining,
                "deadline_at_ms": deadline_at_ms,
                "window_ms": bt.saturating_sub(1) * 1000,
                "game_id": game_id,
            }
        }));
    }

    fn room_of(&self, table: &str) -> NormalizedRoom {
        NormalizedRoom {
            id: table.to_string(),
            name: self.table_name(table),
            history: self.history.get(table).cloned().unwrap_or_default(),
            status: "open".to_string(),
            table_type: Some("baccarat".to_string()),
            table_subtype: None,
        }
    }

    fn emit_room(&self, app: &AppHandle, table: &str) {
        emit_event(app, &CasinoEvent::RoomUpdate(vec![self.room_of(table)]));
    }

    fn emit_rooms(&self, app: &AppHandle) {
        let rooms: Vec<NormalizedRoom> = self.tables_order.iter().map(|t| self.room_of(t)).collect();
        if !rooms.is_empty() {
            info!("🎲 [PRAG-BRIDGE] rooms {}개 방출", rooms.len());
            emit_event(app, &CasinoEvent::RoomUpdate(rooms));
        }
    }

    fn ms_left(&self, table: &str) -> Option<i64> {
        self.tables.get(table).and_then(|t| t.deadline_at_ms).map(|d| d - now_ms())
    }

    /// 배팅 전송(브릿지). 마감 여유·gameId·사용자 id·훅 컨텍스트가 전부 있어야 나간다(fail-closed).
    pub fn place_bet(&mut self, table_id: &str, bet_type: &str, amount: u64) -> Result<BridgeBetReceipt, String> {
        let table = normalize_table_id(table_id);
        if self.is_fee_table(&table) {
            return Err(format!("{}은(는) 20% 수수료 보너스 배팅이 자동 부착되는 테이블 — 자동배팅 제외", self.table_name(&table)));
        }
        let outbound = self.outbound.as_ref().ok_or("프라그마틱 게임 소켓에 붙어 있지 않아요")?.clone();
        if self.context_id.is_none() {
            return Err("게임 화면의 송신 훅 컨텍스트를 아직 못 잡았어요".to_string());
        }
        if amount == 0 {
            return Err("배팅 금액이 0이에요".to_string());
        }
        let bet_code = parse_bet_type(bet_type).map_err(|_| format!("지원하지 않는 배팅 종류: {}", bet_type))?;
        let user_id = self.user_id.clone().ok_or("사용자 id를 아직 못 잡았어요 (로비 좌석 프레임/수동 배팅 필요)")?;
        let st = self.tables.get(&table).ok_or_else(|| format!("모르는 테이블 {}", table))?;
        if !st.betting_open {
            return Err(format!("{} 배팅창이 닫혀 있어요", table));
        }
        let game_id = st.game_id.clone().ok_or_else(|| format!("{} 현재 라운드 gameId 없음", table))?;
        let deadline = st.deadline_at_ms.ok_or_else(|| format!("{} 마감 시각 없음", table))?;
        let ms_left = deadline - now_ms();
        if ms_left < MIN_LEAD_MS {
            return Err(format!("{} 마감까지 {}ms 남아 전송 안 함(최소 {}ms)", table, ms_left, MIN_LEAD_MS));
        }
        let ck = now_ms();
        let xml = build_bet_xml(&table, bet_code, amount, &game_id, &user_id, ck);
        outbound.send(xml).map_err(|_| "브릿지 송신 채널 닫힘".to_string())?;
        self.pending.insert(table.clone(), PendingBet { bet_type: bet_type.to_string(), amount, game_id: game_id.clone(), sent_at_ms: ck, acked: false });
        info!("🎲 [PRAG-BRIDGE] 📤 bet table={} {} {} game={} msLeft={}", table, bet_type, amount, game_id, ms_left);
        Ok(BridgeBetReceipt { table_id: table, bet_type: bet_type.to_string(), bet_code: bet_code.as_u8(), amount, game_id, user_id, ck, deadline_at_ms: deadline, ms_left })
    }

    /// 취소(전체) — 같은 lpbet 형식에 amt=0, bc=8 (라이브 캡처 확인).
    pub fn cancel_bet(&mut self, table_id: &str) -> Result<String, String> {
        let table = normalize_table_id(table_id);
        let outbound = self.outbound.as_ref().ok_or("프라그마틱 게임 소켓에 붙어 있지 않아요")?.clone();
        if self.context_id.is_none() {
            return Err("게임 화면의 송신 훅 컨텍스트를 아직 못 잡았어요".to_string());
        }
        let user_id = self.user_id.clone().ok_or("사용자 id 없음")?;
        let st = self.tables.get(&table).ok_or_else(|| format!("모르는 테이블 {}", table))?;
        if !st.betting_open {
            return Err(format!("{} 배팅창이 닫혀 취소할 수 없어요", table));
        }
        let game_id = st.game_id.clone().ok_or_else(|| format!("{} gameId 없음", table))?;
        let ck = now_ms();
        let xml = build_bet_xml(&table, BetCode::cancel(), 0, &game_id, &user_id, ck);
        outbound.send(xml.clone()).map_err(|_| "브릿지 송신 채널 닫힘".to_string())?;
        self.pending.remove(&table);
        info!("🎲 [PRAG-BRIDGE] 📤 cancel table={} game={}", table, game_id);
        Ok(xml)
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let tables: Vec<serde_json::Value> = self.tables_order.iter().map(|t| {
            let st = self.tables.get(t).cloned().unwrap_or_default();
            serde_json::json!({ "id": t, "name": st.name, "betting_time": st.betting_time_secs, "game_id": st.game_id, "open": st.betting_open, "ms_left": self.ms_left(t) })
        }).collect();
        serde_json::json!({ "attached": self.is_attached(), "session": self.session_id, "context": self.context_id, "user_id": self.user_id, "tables": tables })
    }

    /// 🔬 자가 테스트: 첫 배팅창(여유 ≥ 8초)에 1000원 Player → 2초 뒤 취소. 결과는 로그로.
    fn maybe_selftest(&mut self, table: &str) {
        if !selftest_enabled() || self.selftest_done || self.user_id.is_none() || self.context_id.is_none() {
            return;
        }
        if self.ms_left(table).unwrap_or(0) < 8000 {
            return;
        }
        self.selftest_done = true;
        let t = table.to_string();
        info!("🔬 [PRAG-SELFTEST] 테이블 {}에서 1000원 Player 배팅 → 2초 뒤 취소", t);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let r = PRAGMATIC_BRIDGE.lock().await.place_bet(&t, "player", 1000);
            info!("🔬 [PRAG-SELFTEST] place → {:?}", r.as_ref().map(|x| x.ms_left));
            if r.is_err() {
                warn!("🔬 [PRAG-SELFTEST] place 실패: {:?}", r.err());
                return;
            }
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let c = PRAGMATIC_BRIDGE.lock().await.cancel_bet(&t);
            info!("🔬 [PRAG-SELFTEST] cancel → {:?}", c.map(|_| "sent"));
        });
    }
}

fn emit(app: &AppHandle, name: &str, payload: serde_json::Value) {
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.emit(name, payload) {
            debug!("🎲 [PRAG-BRIDGE] emit {} 실패: {}", name, e);
        }
    }
}

fn emit_event(app: &AppHandle, ev: &CasinoEvent) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("pragmatic_event", ev);
    }
}
