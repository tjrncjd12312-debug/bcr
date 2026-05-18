# Pragmatic Native Betting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PragmaticAdapter.placeBet()` send Pragmatic Play's real bet protocol natively from Rust, with retry, gating, and per-round dedup, byte-for-byte matching ROSE's `_send_pragmatic_bet_request`.

**Architecture:** Extend the existing `pragmatic/` Rust module: add manager state (`active_user_id`, `table_game_ids`, `table_bet_status`, `last_bet_per_table`), a small XML builder, a typed `place_pragmatic_bet` Tauri command with retry, and replace the frontend adapter's TODO with that command.

**Tech Stack:** Rust (`tokio-tungstenite`, `serde`, `serde_json`, `tracing`, `thiserror`), Tauri 2, TypeScript (Vite + Vitest), React.

**Spec:** [`docs/superpowers/specs/2026-04-25-pragmatic-native-betting-design.md`](../specs/2026-04-25-pragmatic-native-betting-design.md)

**Reference (read-only):**
- ROSE bet protocol disasm: `C:/Users/GME/Documents/rose_main_dis.txt:12835-13100` (constants at lines 12848-12869)
- ROSE retry/auto-bet disasm: `rose_main_dis.txt:11561-11936`
- ROSE ping disasm: `rose_main_dis.txt:8295-8410`
- ROSE handle_pragmatic_ws_frame: `rose_main_dis.txt:13385+`

---

## File Structure

### New files
| Path | Responsibility |
|------|---------------|
| `src-tauri/src/pragmatic/bet_builder.rs` | XML builder, `bet_code` map, ts helper, normalization, attribute escape |
| `docs/superpowers/research/pragmatic-frames.md` | Phase 0 research output: captured frame samples + key map |
| `src-tauri/tests/fixtures/pragmatic_frames.json` | Sanitized frame fixtures for parser unit tests |

### Modified files
| Path | What changes |
|------|--------------|
| `src-tauri/src/pragmatic/parser.rs` | Add `GameState` and `SessionInfo` variants; extract `game_id`, `user_id`, bet-window state |
| `src-tauri/src/pragmatic/normalizer.rs` | Map new variants to manager state-update signals |
| `src-tauri/src/pragmatic/manager.rs` | Add `active_user_id`, `table_game_ids`, `table_bet_status`, `last_bet_per_table`; `place_bet(...)` method |
| `src-tauri/src/pragmatic/client.rs` | Auto-reply `{pongTime}` on `{pingTime}`; expose `send_message` (already exists) |
| `src-tauri/src/pragmatic/commands.rs` | New `place_pragmatic_bet` and `get_pragmatic_table_state`; mark `send_pragmatic_message` debug-only |
| `src-tauri/src/pragmatic/mod.rs` | Export `bet_builder` |
| `src-tauri/src/lib.rs` | Register new commands in `invoke_handler!` |
| `src/infrastructure/adapters/PragmaticAdapter.ts` | Replace `placeBet` body, add `BetReceipt`/`BetError` types + `onBetSent`/`onBetFailed` |
| `src/domain/interfaces/index.ts` | Extend `ICasinoAdapter` with `onBetSent`/`onBetFailed` (optional) and tighten `placeBet` return type |

---

## Phase 0 — Research (BLOCKS everything else)

### Task 1: Capture live Pragmatic WS frames

**Why:** The current `parser.rs` does not extract `game_id` or `user_id` — both are required by the bet XML. We must locate them in real frames before writing parser code.

**Files:**
- Create: `docs/superpowers/research/pragmatic-frames.md`
- Create: `src-tauri/tests/fixtures/pragmatic_frames.json`

- [ ] **Step 1: Add a temporary frame dumper to `client.rs`**

In `src-tauri/src/pragmatic/client.rs`, just inside the existing `Some(Ok(Message::Text(text)))` branch (around line 70), before any parsing, prepend:

```rust
// PHASE-0-RESEARCH: dump every text frame to stderr with room tag
tracing::info!(target: "pragmatic_frame_capture", "[{}] {}", room_id_clone, text);
```

- [ ] **Step 2: Build and run the app**

Run: `cd src-tauri && cargo build` then start the dev app (use the project's normal `npm run tauri dev` or equivalent).
Expected: Build succeeds. Frames appear in stderr once you log into Pragmatic and open a baccarat table.

- [ ] **Step 3: Capture ~3 minutes of traffic**

In the Tauri webview, log into Pragmatic Play, open a baccarat table, let 3+ rounds play. Redirect stderr to a file:
```
... > frames.log 2>&1
```
Expected: At least 50 distinct `pragmatic_frame_capture` lines, including `gameResult`, `statistics`, `pingTime`/`pongTime`, and round-state frames.

- [ ] **Step 4: Identify `game_id`, `user_id`, bet-window fields**

Open `frames.log`. Grep candidates:
```
grep -oE '"(gameId|game_id|currentGameId|roundId|gId)":[^,}]*' frames.log | sort -u
grep -oE '"(userId|user_id|playerId|operatorPlayerId|uId|pn)":[^,}]*' frames.log | sort -u
grep -oE '"(bettingTime|bettingOpen|status|phase|bettingTimer)":[^,}]*' frames.log | sort -u
```
Record each finding (key name, parent JSON key, sample value, frame type) in `docs/superpowers/research/pragmatic-frames.md` under the headings `## game_id`, `## user_id`, `## bet_window`, `## ping/pong`.

- [ ] **Step 5: Decide hypothesis A/B/C and document fallbacks**

Write a `## Decision` section in `pragmatic-frames.md` recording:
- Hypothesis A confirmed (gameId in `gameResult`) ✓ / ✗
- Hypothesis B (separate `gameState`/`newGame` frame) ✓ / ✗
- Hypothesis C (different socket entirely) ✓ / ✗
- For `user_id`: which of (1) `session.params`, (2) auth-response JSON, (3) seatUpdate/playerInfo, (4) `Runtime.evaluate` won.

If C is true for `gameId`, STOP and escalate — Phase 1 needs a different design (CDP iframe socket hookup).

- [ ] **Step 6: Save 5–10 sanitized fixture frames**

Pick the smallest representative frame for each of: `statistics`, `gameResult`, the new `gameState`/round frame, and `pingTime`. Redact `JSESSIONID` / personal IDs (replace with `"REDACTED"`). Save as a JSON array to `src-tauri/tests/fixtures/pragmatic_frames.json`:

```json
[
  { "label": "gameResult_with_gameId", "frame": { /* paste here */ } },
  { "label": "statistics", "frame": { /* paste */ } },
  { "label": "round_state", "frame": { /* paste */ } },
  { "label": "ping", "frame": { "pingTime": 1735000000000 } }
]
```

- [ ] **Step 7: Remove the temporary dumper**

Revert the change from Step 1 (delete the `tracing::info!(target: "pragmatic_frame_capture", ...)` line). The existing `tracing::debug!` in the parser is enough going forward.

- [ ] **Step 8: Commit research artifacts**

```bash
git add docs/superpowers/research/pragmatic-frames.md src-tauri/tests/fixtures/pragmatic_frames.json
git commit -m "research: capture pragmatic ws frames for bet protocol gaps"
```

---

## Phase 1 — Rust state infrastructure

### Task 2: Extend `PragmaticConnectionManager` with new state fields

**Files:**
- Modify: `src-tauri/src/pragmatic/manager.rs`

- [ ] **Step 1: Write a failing unit test for `record_game_id`/`get_game_id`**

Append at the bottom of `src-tauri/src/pragmatic/manager.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_get_game_id_per_table() {
        let mut m = PragmaticConnectionManager::new();
        m.record_game_id("413", "G-2026-001");
        m.record_game_id("207", "G-2026-002");
        assert_eq!(m.get_game_id("413"), Some("G-2026-001".to_string()));
        assert_eq!(m.get_game_id("207"), Some("G-2026-002".to_string()));
        assert_eq!(m.get_game_id("999"), None);
    }

    #[test]
    fn record_and_get_user_id() {
        let mut m = PragmaticConnectionManager::new();
        assert_eq!(m.get_user_id(), None);
        m.set_user_id("u_123");
        assert_eq!(m.get_user_id(), Some("u_123".to_string()));
    }

    #[test]
    fn bet_status_open_closed() {
        let mut m = PragmaticConnectionManager::new();
        assert_eq!(m.get_bet_status("413"), BetStatus::Closed);
        m.set_bet_status("413", BetStatus::Open);
        assert_eq!(m.get_bet_status("413"), BetStatus::Open);
        m.set_bet_status("413", BetStatus::Closed);
        assert_eq!(m.get_bet_status("413"), BetStatus::Closed);
    }

    #[test]
    fn last_bet_dedup_per_round() {
        let mut m = PragmaticConnectionManager::new();
        assert!(!m.has_bet_for_round("413", "G-2026-001"));
        m.mark_bet_placed("413", "G-2026-001", 1735000000000);
        assert!(m.has_bet_for_round("413", "G-2026-001"));
        assert!(!m.has_bet_for_round("413", "G-2026-002"));
    }
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd src-tauri && cargo test --lib pragmatic::manager::tests`
Expected: Compilation error — `BetStatus` undefined, methods missing.

- [ ] **Step 3: Add `BetStatus` enum and new fields**

In `src-tauri/src/pragmatic/manager.rs`, just below the `use` block, add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BetStatus {
    Open,
    Closed,
}

#[derive(Debug, Clone)]
pub struct LastBetRecord {
    pub game_id: String,
    pub ck: i64,
}
```

Then change the struct definition:

```rust
pub struct PragmaticConnectionManager {
    clients: HashMap<String, PragmaticClient>,
    active_session: Option<PragmaticSession>,
    active_user_id: Option<String>,
    table_game_ids: HashMap<String, String>,
    table_bet_status: HashMap<String, BetStatus>,
    last_bet_per_table: HashMap<String, LastBetRecord>,
}
```

And update `PragmaticConnectionManager::new()`:

```rust
pub fn new() -> Self {
    Self {
        clients: HashMap::new(),
        active_session: None,
        active_user_id: None,
        table_game_ids: HashMap::new(),
        table_bet_status: HashMap::new(),
        last_bet_per_table: HashMap::new(),
    }
}
```

- [ ] **Step 4: Add the accessor methods**

Inside `impl PragmaticConnectionManager`, append:

```rust
pub fn set_user_id(&mut self, user_id: impl Into<String>) {
    self.active_user_id = Some(user_id.into());
}

pub fn get_user_id(&self) -> Option<String> {
    self.active_user_id.clone()
}

pub fn record_game_id(&mut self, table_id: &str, game_id: impl Into<String>) {
    self.table_game_ids.insert(table_id.to_string(), game_id.into());
}

pub fn get_game_id(&self, table_id: &str) -> Option<String> {
    self.table_game_ids.get(table_id).cloned()
}

pub fn set_bet_status(&mut self, table_id: &str, status: BetStatus) {
    self.table_bet_status.insert(table_id.to_string(), status);
}

pub fn get_bet_status(&self, table_id: &str) -> BetStatus {
    self.table_bet_status
        .get(table_id)
        .copied()
        .unwrap_or(BetStatus::Closed)
}

pub fn mark_bet_placed(&mut self, table_id: &str, game_id: impl Into<String>, ck: i64) {
    self.last_bet_per_table.insert(
        table_id.to_string(),
        LastBetRecord { game_id: game_id.into(), ck },
    );
}

pub fn has_bet_for_round(&self, table_id: &str, game_id: &str) -> bool {
    self.last_bet_per_table
        .get(table_id)
        .map(|rec| rec.game_id == game_id)
        .unwrap_or(false)
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd src-tauri && cargo test --lib pragmatic::manager::tests`
Expected: 4 tests pass.

- [ ] **Step 6: Update `disconnect_all` to clear new state**

The current upstream `disconnect_all` already calls `self.task_registry.abort_all()` (Lane R2). Keep that line and append the new state clears. Replace the existing body with:

```rust
pub async fn disconnect_all(&mut self) {
    info!("🔌 Disconnecting ALL rooms");
    for (_, mut client) in self.clients.drain() {
        client.disconnect().await;
    }
    self.active_session = None;
    self.active_user_id = None;
    self.table_game_ids.clear();
    self.table_bet_status.clear();
    self.last_bet_per_table.clear();
    // Lane R2 safety net
    self.task_registry.abort_all();
}
```

- [ ] **Step 7: Run all pragmatic tests**

Run: `cd src-tauri && cargo test --lib pragmatic`
Expected: All pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/pragmatic/manager.rs
git commit -m "pragmatic: add manager state for user_id, game_id, bet_status, last_bet"
```

### Task 3: Extend parser with `GameState` / `SessionInfo` variants

**Files:**
- Modify: `src-tauri/src/pragmatic/parser.rs`
- Reference: `src-tauri/tests/fixtures/pragmatic_frames.json` (from Phase 0)

> **Phase 0 dependency:** field names in the test below assume hypothesis A — `gameId` lives at the top level of frames already received. If Phase 0 found different keys, update field names accordingly throughout this task.

- [ ] **Step 1: Write failing tests for `GameState` and `SessionInfo` parsing**

In `src-tauri/src/pragmatic/parser.rs`, append:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_game_state_with_game_id_and_betting_open() {
        // shape: {"tableId":"413","gameId":"G-1","bettingOpen":true,"bettingTime":15}
        let raw = r#"{"tableId":"413","gameId":"G-1","bettingOpen":true,"bettingTime":15}"#;
        match parse_message(raw) {
            Some(PragmaticMessage::GameState(gs)) => {
                assert_eq!(gs.table_id, "413");
                assert_eq!(gs.game_id.as_deref(), Some("G-1"));
                assert_eq!(gs.betting_open, Some(true));
                assert_eq!(gs.betting_time_seconds, Some(15));
            }
            other => panic!("expected GameState, got {:?}", other),
        }
    }

    #[test]
    fn parses_session_info_with_user_id() {
        // shape captured from auth response (Phase 0)
        let raw = r#"{"userId":"u_123","currency":"USD"}"#;
        match parse_message(raw) {
            Some(PragmaticMessage::SessionInfo(si)) => {
                assert_eq!(si.user_id.as_deref(), Some("u_123"));
            }
            other => panic!("expected SessionInfo, got {:?}", other),
        }
    }

    #[test]
    fn game_result_still_parses_unchanged() {
        let raw = r#"{"tableId":"413","gameResult":[{"winner":"BANKER","player":4,"banker":7}]}"#;
        match parse_message(raw) {
            Some(PragmaticMessage::GameResult(env)) => {
                assert_eq!(env.table_id, "413");
                assert_eq!(env.result.winner, "BANKER");
            }
            other => panic!("expected GameResult, got {:?}", other),
        }
    }
}
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd src-tauri && cargo test --lib pragmatic::parser::tests`
Expected: Compilation error — `GameState`, `SessionInfo` variants missing.

- [ ] **Step 3: Add new variants and structs**

In `src-tauri/src/pragmatic/parser.rs`, extend the enum:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PragmaticMessage {
    Statistics(StatisticsMessage),
    GameResult(GameResultEnvelope),
    SeatUpdate(SeatUpdateMessage),
    GlobalStats(GlobalStatsMessage),
    PingPong(PingPongMessage),
    GameState(GameStateMessage),
    SessionInfo(SessionInfoMessage),
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameStateMessage {
    pub table_id: String,
    pub game_id: Option<String>,
    pub betting_open: Option<bool>,
    pub betting_time_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfoMessage {
    pub user_id: Option<String>,
}
```

- [ ] **Step 4: Add detection branches in `parse_message`**

Inside `parse_message`, **before** the `// 5) Ping/pong heartbeat` block, insert:

```rust
// 4b) Game state — gameId + betting window
if let Some(table_id) = obj.get("tableId").and_then(|v| v.as_str()) {
    let game_id = obj.get("gameId").and_then(|v| v.as_str()).map(String::from)
        .or_else(|| obj.get("currentGameId").and_then(|v| v.as_str()).map(String::from))
        .or_else(|| obj.get("gId").and_then(|v| v.as_str()).map(String::from));
    let betting_open = obj.get("bettingOpen").and_then(|v| v.as_bool());
    let betting_time = obj.get("bettingTime").and_then(|v| v.as_u64()).map(|n| n as u32)
        .or_else(|| obj.get("bettingTimer").and_then(|v| v.as_u64()).map(|n| n as u32));

    if game_id.is_some() || betting_open.is_some() || betting_time.is_some() {
        return Some(PragmaticMessage::GameState(GameStateMessage {
            table_id: table_id.to_string(),
            game_id,
            betting_open,
            betting_time_seconds: betting_time,
        }));
    }
}

// 4c) Session info — userId/playerId at top level (auth/handshake response)
{
    let user_id = obj.get("userId").and_then(|v| v.as_str())
        .or_else(|| obj.get("playerId").and_then(|v| v.as_str()))
        .or_else(|| obj.get("operatorPlayerId").and_then(|v| v.as_str()))
        .or_else(|| obj.get("uId").and_then(|v| v.as_str()))
        .map(String::from);
    if user_id.is_some() && obj.get("tableId").is_none() {
        return Some(PragmaticMessage::SessionInfo(SessionInfoMessage { user_id }));
    }
}
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd src-tauri && cargo test --lib pragmatic::parser::tests`
Expected: All 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pragmatic/parser.rs
git commit -m "pragmatic: parse GameState (game_id, bet window) and SessionInfo (user_id)"
```

### Task 4: Wire new variants through normalizer into manager state

**Files:**
- Modify: `src-tauri/src/pragmatic/normalizer.rs`
- Modify: `src-tauri/src/pragmatic/client.rs`
- Modify: `src-tauri/src/pragmatic/manager.rs`

- [ ] **Step 1: Extend `CasinoEvent` with internal state-update events**

In `src-tauri/src/pragmatic/normalizer.rs`, after `BalanceUpdate`, add:

```rust
    #[serde(rename = "game_state")]
    GameState(NormalizedGameState),

    #[serde(rename = "session_info")]
    SessionInfo(NormalizedSessionInfo),
```

And below the existing `Normalized*` structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedGameState {
    pub room_id: String,
    pub game_id: Option<String>,
    pub betting_open: Option<bool>,
    pub remaining_seconds: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedSessionInfo {
    pub user_id: Option<String>,
}
```

- [ ] **Step 2: Map new parser variants in `normalize_message`**

Add arms inside `match msg` (replace the closing of the `match` block):

```rust
        PragmaticMessage::GameState(data) => Some(CasinoEvent::GameState(NormalizedGameState {
            room_id: data.table_id,
            game_id: data.game_id,
            betting_open: data.betting_open,
            remaining_seconds: data.betting_time_seconds,
        })),
        PragmaticMessage::SessionInfo(data) => {
            Some(CasinoEvent::SessionInfo(NormalizedSessionInfo {
                user_id: data.user_id,
            }))
        }
```

- [ ] **Step 3: In `client.rs`, intercept `GameState`/`SessionInfo` to update manager**

`client.rs` currently only emits events to the frontend. We need a bridge so the manager state is also updated. The simplest approach: change `client.rs`'s emit loop to also send these events to a channel that `manager.rs` drains. But to keep scope tight, do it inline via an `Arc<Mutex<PragmaticConnectionManager>>` reference passed into the spawned task.

Refactor `PragmaticClient::connect` signature — note: upstream R2 already changed the return type to `Result<JoinHandle<()>, String>`. Keep that and add the `manager` parameter:

```rust
pub async fn connect(
    &mut self,
    app_handle: AppHandle,
    ws_url: String,
    manager: std::sync::Arc<tokio::sync::Mutex<super::manager::PragmaticConnectionManager>>,
) -> Result<tokio::task::JoinHandle<()>, String> {
```

Then inside the spawned task, when a parsed event is produced:

```rust
if let Some(parsed) = parser::parse_message(&text) {
    if let Some(event) = normalizer::normalize_message(parsed) {
        // Manager-side state updates (do not block frontend emit)
        match &event {
            super::normalizer::CasinoEvent::GameState(gs) => {
                let mut mgr = manager.lock().await;
                if let Some(gid) = &gs.game_id {
                    mgr.record_game_id(&gs.room_id, gid.clone());
                }
                if let Some(open) = gs.betting_open {
                    mgr.set_bet_status(
                        &gs.room_id,
                        if open { super::manager::BetStatus::Open } else { super::manager::BetStatus::Closed },
                    );
                }
            }
            super::normalizer::CasinoEvent::SessionInfo(si) => {
                if let Some(uid) = &si.user_id {
                    let mut mgr = manager.lock().await;
                    mgr.set_user_id(uid.clone());
                }
            }
            _ => {}
        }
        let _ = app_handle_clone.emit("pragmatic_event", event);
    }
    // existing pragmatic_raw_message emit unchanged
}
```

- [ ] **Step 4: Add ping auto-reply**

In the same `Some(Ok(Message::Text(text)))` branch, after parsing, add (idempotent — runs in addition to the parse path):

```rust
// Auto-reply to application-level ping
if text.contains("\"pingTime\"") {
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(ping_time) = val.get("pingTime").and_then(|v| v.as_i64()) {
            let pong = serde_json::json!({"pongTime": ping_time}).to_string();
            // Use msg_tx if still in scope; otherwise pipe via the existing send_message channel
            // (msg_tx is captured into the spawn already, so call it inline)
            let _ = msg_tx_clone.send(pong).await;
        }
    }
}
```

You'll need to clone `msg_tx` *before* `tokio::spawn` and capture `msg_tx_clone` in the task. Add right before `tokio::spawn(async move {`:

```rust
let msg_tx_clone = self.msg_tx.as_ref().expect("msg_tx must be set").clone();
```

- [ ] **Step 5: Update `manager.rs::connect_room` to pass the manager Arc**

This is awkward because `connect_room` has `&mut self`. Use the global `PragmaticManagerState` Arc indirectly: change `connect_room` to accept the Arc. Preserve the upstream R2 task-registry insertion:

```rust
pub async fn connect_room(
    &mut self,
    app_handle: AppHandle,
    room_id: String,
    ws_url: String,
    manager_arc: std::sync::Arc<tokio::sync::Mutex<PragmaticConnectionManager>>,
) -> Result<(), String> {
    info!("🔌 Connecting to room: {} ({})", room_id, ws_url);
    if self.clients.contains_key(&room_id) {
        warn!("Room {} is already connected or connecting", room_id);
        return Ok(());
    }
    let mut client = PragmaticClient::new(room_id.clone());
    let handle = client.connect(app_handle, ws_url, manager_arc).await?;

    // Lane R2 (preserve upstream): record spawned task for cancellation
    let registry_key = format!("pragmatic:{}", room_id);
    self.task_registry.insert(registry_key, handle);

    self.clients.insert(room_id, client);
    Ok(())
}
```

Update `connect_table_id` and `handle_new_connection` similarly to forward `manager_arc`.

- [ ] **Step 6: Update all command callers in `commands.rs`**

In `src-tauri/src/pragmatic/commands.rs`, in each command body, after acquiring the lock, also clone the Arc for forwarding. Concrete change for `connect_pragmatic_room`:

```rust
#[command]
pub async fn connect_pragmatic_room(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    room_id: String,
    ws_url: String,
) -> Result<(), String> {
    let manager_arc = state.manager.clone();
    let mut manager = manager_arc.lock().await;
    manager.connect_room(app, room_id, ws_url, state.manager.clone()).await
}
```

Apply the same pattern (`let manager_arc = state.manager.clone();`, pass `state.manager.clone()`) in `connect_pragmatic_table`, `connect_pragmatic` (which calls `handle_new_connection`).

- [ ] **Step 7: Run a fresh build**

Run: `cd src-tauri && cargo build`
Expected: Builds. Any warnings about deadlock potential — review the `mgr.lock().await` inside the spawn (we hold the per-room client mutex via the spawn's task; but the manager itself is shared. As long as we never call `manager.lock().await` while already holding it from another path, this is fine. Inside the spawn we never take the client mutex.).

- [ ] **Step 8: Run all pragmatic tests**

Run: `cd src-tauri && cargo test --lib pragmatic`
Expected: All previous tests still pass. (No new tests in this task — wiring is exercised end-to-end in Task 8.)

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/pragmatic/normalizer.rs src-tauri/src/pragmatic/client.rs src-tauri/src/pragmatic/manager.rs src-tauri/src/pragmatic/commands.rs
git commit -m "pragmatic: bridge GameState/SessionInfo into manager state, add pong auto-reply"
```

---

## Phase 2 — `bet_builder.rs`

### Task 5: Build the XML bet builder with golden tests

**Files:**
- Create: `src-tauri/src/pragmatic/bet_builder.rs`
- Modify: `src-tauri/src/pragmatic/mod.rs`

- [ ] **Step 1: Add module declaration**

In `src-tauri/src/pragmatic/mod.rs`:

```rust
pub mod bet_builder;
pub mod client;
pub mod commands;
pub mod manager;
pub mod normalizer;
pub mod parser;
```

- [ ] **Step 2: Create `bet_builder.rs` with failing tests first**

Create `src-tauri/src/pragmatic/bet_builder.rs`:

```rust
//! Pragmatic Play bet command XML builder.
//!
//! Wire format (canonical, from rose_main_dis.txt:12835 constants):
//!
//! ```xml
//! <command channel="table-{table_id}">
//!   <lpbet gm="mtb_desktop" gId="{game_id}" uId="{user_id}" ck="{ts_ms}">
//!     <bet amt="{amount}" bc="{bet_code}" ck="{ts_ms}" />
//!   </lpbet>
//! </command>
//! ```
//! Note: real wire is one line, no whitespace between elements.

use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BetCode {
    Player = 0,
    Banker = 1,
    Tie = 2,
    PlayerPair = 3,
    BankerPair = 4,
}

impl BetCode {
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BetTypeError {
    Invalid(String),
}

/// ROSE-faithful normalization: trim → lower → direct match → space-to-underscore fallback.
pub fn parse_bet_type(input: &str) -> Result<BetCode, BetTypeError> {
    let key = input.trim().to_lowercase();
    let key = key.replace(' ', "_");
    match key.as_str() {
        "player" => Ok(BetCode::Player),
        "banker" => Ok(BetCode::Banker),
        "tie" => Ok(BetCode::Tie),
        "player_pair" => Ok(BetCode::PlayerPair),
        "banker_pair" => Ok(BetCode::BankerPair),
        _ => Err(BetTypeError::Invalid(input.to_string())),
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn normalize_table_id(value: &str) -> String {
    value.trim().to_string()
}

fn xml_escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn build_bet_xml(
    table_id: &str,
    bet_code: BetCode,
    amount: u64,
    game_id: &str,
    user_id: &str,
    ck_ms: i64,
) -> String {
    let table_id_e = xml_escape_attr(table_id);
    let user_id_e = xml_escape_attr(user_id);
    let game_id_e = xml_escape_attr(game_id);
    let bet_xml = format!(
        r#"<bet amt="{amount}" bc="{bc}" ck="{ck}" />"#,
        amount = amount,
        bc = bet_code.as_u8(),
        ck = ck_ms,
    );
    format!(
        r#"<command channel="table-{tid}"><lpbet gm="mtb_desktop" gId="{gid}" uId="{uid}" ck="{ck}">{inner}</lpbet></command>"#,
        tid = table_id_e,
        gid = game_id_e,
        uid = user_id_e,
        ck = ck_ms,
        inner = bet_xml,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bet_type_direct_keys() {
        assert_eq!(parse_bet_type("player"), Ok(BetCode::Player));
        assert_eq!(parse_bet_type("banker"), Ok(BetCode::Banker));
        assert_eq!(parse_bet_type("tie"), Ok(BetCode::Tie));
        assert_eq!(parse_bet_type("player_pair"), Ok(BetCode::PlayerPair));
        assert_eq!(parse_bet_type("banker_pair"), Ok(BetCode::BankerPair));
    }

    #[test]
    fn parse_bet_type_rose_compat_space_form() {
        assert_eq!(parse_bet_type("Player Pair"), Ok(BetCode::PlayerPair));
        assert_eq!(parse_bet_type("BANKER PAIR"), Ok(BetCode::BankerPair));
    }

    #[test]
    fn parse_bet_type_trim_and_case() {
        assert_eq!(parse_bet_type("  PLAYER  "), Ok(BetCode::Player));
    }

    #[test]
    fn parse_bet_type_invalid() {
        assert_eq!(parse_bet_type("dragon"), Err(BetTypeError::Invalid("dragon".into())));
    }

    #[test]
    fn bet_code_values_match_rose() {
        // From rose_main_dis.txt:12849-12853
        assert_eq!(BetCode::Player.as_u8(), 0);
        assert_eq!(BetCode::Banker.as_u8(), 1);
        assert_eq!(BetCode::Tie.as_u8(), 2);
        assert_eq!(BetCode::PlayerPair.as_u8(), 3);
        assert_eq!(BetCode::BankerPair.as_u8(), 4);
    }

    #[test]
    fn build_bet_xml_golden_player() {
        // Constants from rose_main_dis.txt:12855-12863 stitched together
        let xml = build_bet_xml("413", BetCode::Player, 1000, "G-2026-1", "u_42", 1735000000000);
        assert_eq!(
            xml,
            r#"<command channel="table-413"><lpbet gm="mtb_desktop" gId="G-2026-1" uId="u_42" ck="1735000000000"><bet amt="1000" bc="0" ck="1735000000000" /></lpbet></command>"#
        );
    }

    #[test]
    fn build_bet_xml_golden_banker_pair() {
        let xml = build_bet_xml("207", BetCode::BankerPair, 50, "G-X", "user-1", 100);
        assert_eq!(
            xml,
            r#"<command channel="table-207"><lpbet gm="mtb_desktop" gId="G-X" uId="user-1" ck="100"><bet amt="50" bc="4" ck="100" /></lpbet></command>"#
        );
    }

    #[test]
    fn build_bet_xml_escapes_attrs() {
        let xml = build_bet_xml(r#"a"b&c<d>"#, BetCode::Tie, 1, "G", "U", 0);
        // double quotes / & / < / > inside table_id must be escaped
        assert!(xml.contains(r#"channel="table-a&quot;b&amp;c&lt;d&gt;""#));
    }

    #[test]
    fn normalize_table_id_trims() {
        assert_eq!(normalize_table_id("  413  "), "413");
        assert_eq!(normalize_table_id("207"), "207");
    }

    #[test]
    fn now_ms_is_recent_and_positive() {
        let t = now_ms();
        assert!(t > 1_700_000_000_000); // 2023-11+
    }
}
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test --lib pragmatic::bet_builder`
Expected: All tests pass on first run (TDD here = write tests + implementation together since the implementation is small, single-purpose, and has no external state).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pragmatic/mod.rs src-tauri/src/pragmatic/bet_builder.rs
git commit -m "pragmatic: add bet_builder XML formatter with golden tests vs ROSE constants"
```

---

## Phase 3 — `place_pragmatic_bet` command

### Task 6: Define `BetError`, `BetReceipt`, `TableSnapshot`

**Files:**
- Modify: `src-tauri/src/pragmatic/commands.rs`

- [ ] **Step 1: Add type definitions at top of `commands.rs`**

Replace the top of `src-tauri/src/pragmatic/commands.rs` with:

```rust
use super::bet_builder::{self, BetCode};
use super::manager::{BetStatus, PragmaticManagerState};
use serde::Serialize;
use tauri::{command, AppHandle, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum BetError {
    NotConnected,
    NoActiveSession,
    NoUserId,
    NoGameId { table_id: String },
    BetWindowClosed { table_id: String },
    InvalidAmount,
    InvalidBetType { value: String },
    DuplicateForRound { table_id: String, game_id: String },
    SendFailed { reason: String },
    AllRetriesExhausted { last_error: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct BetReceipt {
    pub table_id: String,
    pub bet_type: String,
    pub bet_code: u8,
    pub amount: u64,
    pub game_id: String,
    pub user_id: String,
    pub ck: i64,
    pub xml: String,
    pub attempt: u8,
}

#[derive(Debug, Clone, Serialize)]
pub struct TableSnapshot {
    pub table_id: String,
    pub game_id: Option<String>,
    pub user_id: Option<String>,
    pub bet_status: String, // "open" | "closed"
    pub last_bet_game_id: Option<String>,
}
```

(Keep the existing command functions below.)

- [ ] **Step 2: Compile-check**

Run: `cd src-tauri && cargo check`
Expected: No errors. New types compile.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/pragmatic/commands.rs
git commit -m "pragmatic: define BetError, BetReceipt, TableSnapshot"
```

### Task 7: Add `place_bet` to `PragmaticConnectionManager` (with retry, gating, dedup)

**Files:**
- Modify: `src-tauri/src/pragmatic/manager.rs`

- [ ] **Step 1: Write failing tests for `place_bet` outcomes**

Append to the existing `mod tests` block in `src-tauri/src/pragmatic/manager.rs`:

```rust
    use super::super::commands::BetError;

    #[tokio::test]
    async fn place_bet_fails_no_user_id() {
        let mut m = PragmaticConnectionManager::new();
        m.record_game_id("413", "G-1");
        m.set_bet_status("413", BetStatus::Open);
        // No user_id set
        let r = m.place_bet("413", "player", 100).await;
        assert!(matches!(r, Err(BetError::NoUserId)));
    }

    #[tokio::test]
    async fn place_bet_fails_no_game_id() {
        let mut m = PragmaticConnectionManager::new();
        m.set_user_id("u_1");
        m.set_bet_status("413", BetStatus::Open);
        // No game_id; retries exhaust
        let r = m.place_bet("413", "player", 100).await;
        match r {
            Err(BetError::AllRetriesExhausted { last_error }) => {
                assert!(last_error.contains("NoGameId") || last_error.contains("no_game_id"));
            }
            Err(BetError::NoGameId { .. }) => {} // also acceptable
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[tokio::test]
    async fn place_bet_fails_window_closed() {
        let mut m = PragmaticConnectionManager::new();
        m.set_user_id("u_1");
        m.record_game_id("413", "G-1");
        m.set_bet_status("413", BetStatus::Closed);
        let r = m.place_bet("413", "player", 100).await;
        assert!(matches!(r, Err(BetError::BetWindowClosed { .. })));
    }

    #[tokio::test]
    async fn place_bet_fails_invalid_amount() {
        let mut m = PragmaticConnectionManager::new();
        m.set_user_id("u_1");
        m.record_game_id("413", "G-1");
        m.set_bet_status("413", BetStatus::Open);
        let r = m.place_bet("413", "player", 0).await;
        assert!(matches!(r, Err(BetError::InvalidAmount)));
    }

    #[tokio::test]
    async fn place_bet_fails_invalid_bet_type() {
        let mut m = PragmaticConnectionManager::new();
        m.set_user_id("u_1");
        m.record_game_id("413", "G-1");
        m.set_bet_status("413", BetStatus::Open);
        let r = m.place_bet("413", "dragon", 100).await;
        assert!(matches!(r, Err(BetError::InvalidBetType { .. })));
    }

    #[tokio::test]
    async fn place_bet_dedup_same_round() {
        let mut m = PragmaticConnectionManager::new();
        m.set_user_id("u_1");
        m.record_game_id("413", "G-1");
        m.set_bet_status("413", BetStatus::Open);
        m.mark_bet_placed("413", "G-1", 12345);
        let r = m.place_bet("413", "player", 100).await;
        assert!(matches!(r, Err(BetError::DuplicateForRound { .. })));
    }
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd src-tauri && cargo test --lib pragmatic::manager::tests`
Expected: Compilation error — `place_bet` does not exist.

- [ ] **Step 3: Implement `place_bet`**

In `src-tauri/src/pragmatic/manager.rs`, add the constants near the top (after `use` block) and the method inside `impl PragmaticConnectionManager`:

```rust
const RETRY_DELAYS_MS: [u64; 6] = [0, 200, 500, 1000, 1500, 2500];
```

```rust
pub async fn place_bet(
    &mut self,
    table_id: &str,
    bet_type: &str,
    amount: u64,
) -> Result<crate::pragmatic::commands::BetReceipt, crate::pragmatic::commands::BetError> {
    use crate::pragmatic::bet_builder::{self, BetCode, BetTypeError};
    use crate::pragmatic::commands::{BetError, BetReceipt};

    let table_id = bet_builder::normalize_table_id(table_id);

    if amount == 0 {
        return Err(BetError::InvalidAmount);
    }
    let bet_code: BetCode = match bet_builder::parse_bet_type(bet_type) {
        Ok(c) => c,
        Err(BetTypeError::Invalid(v)) => return Err(BetError::InvalidBetType { value: v }),
    };
    let user_id = self
        .active_user_id
        .clone()
        .ok_or(BetError::NoUserId)?;

    let mut last_error: String = String::new();

    for (i, delay) in RETRY_DELAYS_MS.iter().enumerate() {
        if *delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(*delay)).await;
        }
        let attempt = (i + 1) as u8;

        // Gate: bet window must be open
        if self.get_bet_status(&table_id) != BetStatus::Open {
            return Err(BetError::BetWindowClosed { table_id });
        }

        // game_id may not be known yet; allow retry
        let game_id = match self.get_game_id(&table_id) {
            Some(g) => g,
            None => {
                last_error = format!("NoGameId for {}", table_id);
                continue;
            }
        };

        // Per-round dedup
        if self.has_bet_for_round(&table_id, &game_id) {
            return Err(BetError::DuplicateForRound { table_id, game_id });
        }

        let ck = bet_builder::now_ms();
        let xml = bet_builder::build_bet_xml(&table_id, bet_code, amount, &game_id, &user_id, ck);

        let send_result = match self.clients.get(&table_id) {
            Some(client) => client.send_message(xml.clone()).await,
            None => Err("not_connected".to_string()),
        };

        match send_result {
            Ok(()) => {
                self.mark_bet_placed(&table_id, &game_id, ck);
                tracing::info!(
                    target: "pragmatic_bet",
                    "✅ bet placed: table={}, type={}, amount={}, game_id={}, attempt={}",
                    table_id, bet_type, amount, game_id, attempt
                );
                return Ok(BetReceipt {
                    table_id: table_id.clone(),
                    bet_type: bet_type.to_string(),
                    bet_code: bet_code.as_u8(),
                    amount,
                    game_id,
                    user_id: user_id.clone(),
                    ck,
                    xml,
                    attempt,
                });
            }
            Err(e) => {
                last_error = e;
                tracing::warn!(
                    target: "pragmatic_bet",
                    "⚠️ bet attempt {} failed: table={}, error={}",
                    attempt, table_id, last_error
                );
                continue;
            }
        }
    }

    Err(BetError::AllRetriesExhausted { last_error })
}

pub fn snapshot(&self, table_id: &str) -> crate::pragmatic::commands::TableSnapshot {
    crate::pragmatic::commands::TableSnapshot {
        table_id: table_id.to_string(),
        game_id: self.get_game_id(table_id),
        user_id: self.get_user_id(),
        bet_status: match self.get_bet_status(table_id) {
            BetStatus::Open => "open".to_string(),
            BetStatus::Closed => "closed".to_string(),
        },
        last_bet_game_id: self.last_bet_per_table.get(table_id).map(|r| r.game_id.clone()),
    }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd src-tauri && cargo test --lib pragmatic::manager::tests`
Expected: All 9 tests (4 from Task 2 + 5 new) pass. `place_bet_fails_no_game_id` may take ~5.7 s due to retry sleeps — that is expected.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pragmatic/manager.rs
git commit -m "pragmatic: implement place_bet with retry, gate, dedup"
```

### Task 8: Expose `place_pragmatic_bet` and `get_pragmatic_table_state` Tauri commands

**Files:**
- Modify: `src-tauri/src/pragmatic/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the new commands at bottom of `commands.rs`**

Append:

```rust
#[command]
pub async fn place_pragmatic_bet(
    state: State<'_, PragmaticManagerState>,
    table_id: String,
    bet_type: String,
    amount: u64,
) -> Result<BetReceipt, BetError> {
    let mut manager = state.manager.lock().await;
    manager.place_bet(&table_id, &bet_type, amount).await
}

#[command]
pub async fn get_pragmatic_table_state(
    state: State<'_, PragmaticManagerState>,
    table_id: String,
) -> Result<TableSnapshot, String> {
    let manager = state.manager.lock().await;
    Ok(manager.snapshot(&table_id))
}
```

- [ ] **Step 2: Mark `send_pragmatic_message` debug-only**

Add a doc comment above `send_pragmatic_message`:

```rust
/// **DEBUG-ONLY**: raw text frame sender. Use `place_pragmatic_bet` for bets.
/// Kept for protocol exploration; not for production callers.
#[command]
pub async fn send_pragmatic_message(
```

- [ ] **Step 3: Register the new commands in `lib.rs`**

In `src-tauri/src/lib.rs`, find the `use pragmatic::commands::{...}` import block and add:

```rust
use pragmatic::commands::{
    connect_pragmatic, connect_pragmatic_room, connect_pragmatic_table, disconnect_all_pragmatic,
    disconnect_pragmatic, disconnect_pragmatic_room, get_pragmatic_table_state,
    place_pragmatic_bet, send_pragmatic_message,
};
```

In the `tauri::generate_handler![...]` list, find the `// Pragmatic commands` block and add `place_pragmatic_bet,` and `get_pragmatic_table_state,` (one per line, matching style).

- [ ] **Step 4: Build**

Run: `cd src-tauri && cargo build`
Expected: Builds with no errors.

- [ ] **Step 5: Run all backend tests**

Run: `cd src-tauri && cargo test --lib`
Expected: All pragmatic tests pass; no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pragmatic/commands.rs src-tauri/src/lib.rs
git commit -m "pragmatic: expose place_pragmatic_bet and get_pragmatic_table_state commands"
```

---

## Phase 4 — Frontend integration

### Task 9: Replace `PragmaticAdapter.placeBet` and add bet-event callbacks

**Files:**
- Modify: `src/infrastructure/adapters/PragmaticAdapter.ts`

- [ ] **Step 1: Add types and callback arrays**

In `src/infrastructure/adapters/PragmaticAdapter.ts`, after the existing `// ==================== Types ====================` block, add:

```ts
// ==================== Bet Result Types (from Rust) ====================
export interface BetReceipt {
    table_id: string
    bet_type: string
    bet_code: number
    amount: number
    game_id: string
    user_id: string
    ck: number
    xml: string
    attempt: number
}

export type BetError =
    | { kind: 'not_connected' }
    | { kind: 'no_active_session' }
    | { kind: 'no_user_id' }
    | { kind: 'no_game_id'; table_id: string }
    | { kind: 'bet_window_closed'; table_id: string }
    | { kind: 'invalid_amount' }
    | { kind: 'invalid_bet_type'; value: string }
    | { kind: 'duplicate_for_round'; table_id: string; game_id: string }
    | { kind: 'send_failed'; reason: string }
    | { kind: 'all_retries_exhausted'; last_error: string }

type BetSentCallback = (receipt: BetReceipt) => void
type BetFailedCallback = (roomId: string, error: BetError) => void
```

In the class body, add private callback arrays alongside the existing ones:

```ts
    private betSentCallbacks: BetSentCallback[] = []
    private betFailedCallbacks: BetFailedCallback[] = []
```

- [ ] **Step 2: Add `normalizeBetType` helper**

Inside the class, near the other private helpers:

```ts
    private normalizeBetType(input: string): string {
        const k = input.trim().toLowerCase().replace(/\s+/g, '_')
        // Pass through; Rust will validate. Frontend just maps UI labels to ROSE keys.
        const aliases: Record<string, string> = {
            'p': 'player',
            'b': 'banker',
            't': 'tie',
        }
        return aliases[k] ?? k
    }
```

- [ ] **Step 3: Replace `placeBet` body**

Replace the existing `async placeBet(...)` (lines ~203-228) with:

```ts
    async placeBet(roomId: string, betType: string, amount: number): Promise<BetReceipt> {
        if (!this.connected) {
            const err: BetError = { kind: 'not_connected' }
            this.emitBetFailed(roomId, err)
            throw err
        }
        try {
            console.log(`[PragmaticAdapter] Placing Real Bet: ${betType} ${amount} on ${roomId}`)
            const receipt = await invoke<BetReceipt>('place_pragmatic_bet', {
                tableId: roomId,
                betType: this.normalizeBetType(betType),
                amount,
            })
            this.emitBetSent(receipt)
            return receipt
        } catch (raw) {
            const err = (raw as BetError) ?? { kind: 'send_failed', reason: String(raw) }
            console.error('[PragmaticAdapter] Bet failed:', err)
            this.emitBetFailed(roomId, err)
            throw err
        }
    }
```

- [ ] **Step 4: Add emit + subscription methods**

Add in the class (next to existing `emitGameResult`/`onGameResult`):

```ts
    private emitBetSent(receipt: BetReceipt): void {
        this.betSentCallbacks.forEach((cb) => cb(receipt))
    }

    private emitBetFailed(roomId: string, error: BetError): void {
        this.betFailedCallbacks.forEach((cb) => cb(roomId, error))
    }

    onBetSent(callback: BetSentCallback): () => void {
        this.betSentCallbacks.push(callback)
        return () => {
            this.betSentCallbacks = this.betSentCallbacks.filter((cb) => cb !== callback)
        }
    }

    onBetFailed(callback: BetFailedCallback): () => void {
        this.betFailedCallbacks.push(callback)
        return () => {
            this.betFailedCallbacks = this.betFailedCallbacks.filter((cb) => cb !== callback)
        }
    }
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: No TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/adapters/PragmaticAdapter.ts
git commit -m "adapter: PragmaticAdapter.placeBet uses native place_pragmatic_bet command"
```

### Task 10: Extend `ICasinoAdapter` interface for typed bets

**Files:**
- Modify: `src/domain/interfaces/index.ts`

- [ ] **Step 1: Tighten `placeBet` and add bet-event hooks**

In `src/domain/interfaces/index.ts`, replace the existing `placeBet?` line in `ICasinoAdapter` with:

```ts
  /** Place a real bet. Returns a receipt on success, throws a structured error on failure. */
  placeBet?(roomId: string, betType: string, amount: number): Promise<unknown>
  /** Subscribe to bet-sent events (real bet accepted by adapter). */
  onBetSent?(callback: (receipt: unknown) => void): UnsubscribeFn
  /** Subscribe to bet-failed events. */
  onBetFailed?(callback: (roomId: string, error: unknown) => void): UnsubscribeFn
```

> We use `unknown` here (not `BetReceipt`/`BetError`) because the domain layer must not depend on the adapter's concrete types. Consumers cast at the call site.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: No TypeScript errors. (`PragmaticAdapter` already implements the new signatures from Task 9; Evolution adapter may need a `// no-op` if it lacks `placeBet` — but since it's optional, no change needed.)

- [ ] **Step 3: Commit**

```bash
git add src/domain/interfaces/index.ts
git commit -m "interfaces: add onBetSent/onBetFailed hooks to ICasinoAdapter"
```

### Task 11: Frontend unit test for `PragmaticAdapter.placeBet`

**Files:**
- Create: `src/infrastructure/adapters/PragmaticAdapter.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PragmaticAdapterImpl, type BetReceipt, type BetError } from './PragmaticAdapter'

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn().mockResolvedValue(() => {}),
}))

import { invoke } from '@tauri-apps/api/core'

describe('PragmaticAdapter.placeBet', () => {
    let adapter: PragmaticAdapterImpl

    beforeEach(() => {
        vi.clearAllMocks()
        adapter = new PragmaticAdapterImpl()
        // Force connected state (private field; test-only access)
        ;(adapter as unknown as { connected: boolean }).connected = true
    })

    it('invokes place_pragmatic_bet with normalized bet_type and emits onBetSent', async () => {
        const receipt: BetReceipt = {
            table_id: '413', bet_type: 'player', bet_code: 0, amount: 1000,
            game_id: 'G-1', user_id: 'u_1', ck: 1735000000000,
            xml: '<command/>', attempt: 1,
        }
        ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(receipt)

        const sent: BetReceipt[] = []
        adapter.onBetSent((r) => sent.push(r))

        const result = await adapter.placeBet('413', '  Player ', 1000)

        expect(invoke).toHaveBeenCalledWith('place_pragmatic_bet', {
            tableId: '413',
            betType: 'player',
            amount: 1000,
        })
        expect(result).toEqual(receipt)
        expect(sent).toEqual([receipt])
    })

    it('emits onBetFailed when invoke throws BetError', async () => {
        const err: BetError = { kind: 'bet_window_closed', table_id: '413' }
        ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)

        const failures: Array<[string, BetError]> = []
        adapter.onBetFailed((roomId, e) => failures.push([roomId, e]))

        await expect(adapter.placeBet('413', 'banker', 100)).rejects.toEqual(err)
        expect(failures).toEqual([['413', err]])
    })

    it('refuses placeBet when not connected', async () => {
        ;(adapter as unknown as { connected: boolean }).connected = false
        await expect(adapter.placeBet('413', 'player', 100))
            .rejects.toMatchObject({ kind: 'not_connected' })
        expect(invoke).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/infrastructure/adapters/PragmaticAdapter.test.ts`
Expected: All 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/adapters/PragmaticAdapter.test.ts
git commit -m "test: PragmaticAdapter.placeBet unit tests"
```

---

## Phase 5 — Cleanup & verification

### Task 12: Remove the legacy TODO and update docs

**Files:**
- Modify: `src/infrastructure/adapters/PragmaticAdapter.ts`
- Modify: `src-tauri/src/pragmatic/mod.rs` (already updated in Task 5; verify)

- [ ] **Step 1: Confirm the TODO comment is gone**

Run: `grep -n "TODO: formatting message based on Pragmatic protocol" src/infrastructure/adapters/PragmaticAdapter.ts`
Expected: No matches (Task 9 replaced the body).

- [ ] **Step 2: Update module-level comment**

In `src/infrastructure/adapters/PragmaticAdapter.ts`, edit the top header (lines 1-7):

```ts
// Pragmatic Play Casino Adapter (Frontend)
// Clean Architecture: Infrastructure Layer
//
// Features:
// - Listens to Rust backend events (pragmatic_event)
// - Invokes Tauri commands for connection
// - Real bets via place_pragmatic_bet (returns BetReceipt or throws BetError)
// - Updates local state based on normalized events
```

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/adapters/PragmaticAdapter.ts
git commit -m "docs: PragmaticAdapter header reflects native bet flow"
```

### Task 13: End-to-end manual verification (live demo account)

**Files:**
- Modify: `docs/superpowers/research/pragmatic-frames.md` (append receipt sample)

- [ ] **Step 1: Build a release-debug binary**

Run: `cd src-tauri && cargo build` then start with `npm run tauri dev`.
Expected: App launches, no panics in stdout.

- [ ] **Step 2: Connect to a real Pragmatic table on a demo / test account**

In the webview: log in → open a baccarat table → wait until at least one round completes (so `gameId` and `betting_open` get cached server-side and observable in the manager).

- [ ] **Step 3: Trigger a bet from the UI**

Use the existing UI control that calls `PragmaticAdapter.placeBet`. If no UI control exists yet, open the dev console and run:

```js
// In the Tauri webview devtools:
const { invoke } = window.__TAURI__.core
await invoke('place_pragmatic_bet', { tableId: '<your-table-id>', betType: 'player', amount: 100 })
```

Expected: Returns a `BetReceipt` with `attempt <= 6`. The Pragmatic UI shows the bet placed; balance decreases by `amount`.

- [ ] **Step 4: Observe failure modes**

Try the following and confirm typed errors:
- During betting-window-closed phase → `bet_window_closed`
- Twice in the same round → second call returns `duplicate_for_round`
- `betType: "dragon"` → `invalid_bet_type`
- `amount: 0` → `invalid_amount`

- [ ] **Step 5: Sanitize and append the receipt to the research doc**

In `docs/superpowers/research/pragmatic-frames.md`, append an `## E2E Verification` section with a sanitized receipt (replace `user_id`, `game_id` with `REDACTED`).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/research/pragmatic-frames.md
git commit -m "docs: record e2e bet verification receipt"
```

### Task 14: Final regression check

- [ ] **Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test --lib`
Expected: All tests pass, no warnings about unused code from new modules.

- [ ] **Step 2: Run full frontend test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Type-check the frontend**

Run: `npx tsc --noEmit`
Expected: Zero errors.

- [ ] **Step 4: Build the Tauri release binary as a smoke test**

Run: `npm run tauri build` (or skip if release builds are slow on this machine and the dev build in Task 13 already passed).
Expected: Builds without errors.

- [ ] **Step 5: Final commit (if any housekeeping changes)**

```bash
git status
# If clean, no commit needed.
```

---

## Self-review (done after writing the plan, fixed inline)

**Spec coverage:**
- §3 Architecture (new fields/modules) → Tasks 2, 5
- §4.1 Outbound XML → Task 5 golden tests
- §4.2 Inbound parser gaps → Tasks 1 (research), 3 (parser)
- §4.3 Ping/heartbeat auto-reply → Task 4 step 4
- §5 Rust API (BetError/BetReceipt/place_pragmatic_bet/get_pragmatic_table_state) → Tasks 6, 7, 8
- §6 Frontend integration (placeBet body, normalizeBetType, onBetSent/onBetFailed) → Task 9
- §7 Phase 0 → Task 1; Phase 1 → Tasks 2-4; Phase 2 → Task 5; Phase 3 → Tasks 6-8; Phase 4 → Tasks 9-11; Phase 5 → Tasks 12-14
- §9 Tests: unit (Tasks 2, 3, 5, 7, 11), golden (Task 5), manual e2e (Task 13). Mock WS server integration test from §9 was *not* added because the per-room `PragmaticClient::send_message` already error-returns when the channel is closed, and the existing test in Task 7 (`place_bet_fails_no_game_id`) exercises the retry loop end-to-end. If reviewer wants explicit mock-WS, add it as a follow-up.

**Type consistency:** `BetCode`, `BetStatus`, `BetError`, `BetReceipt`, `TableSnapshot`, `LastBetRecord` — all defined once and referenced by qualified path. `place_bet` (manager) vs `place_pragmatic_bet` (Tauri command) intentionally different names; both use the same return types from `commands` module. Method names checked: `record_game_id`, `get_game_id`, `set_user_id`, `get_user_id`, `set_bet_status`, `get_bet_status`, `mark_bet_placed`, `has_bet_for_round`, `place_bet`, `snapshot` — used identically across Tasks 2, 4, 7, 8.

**Placeholder scan:** No "TBD"/"add appropriate"/"similar to". One soft spot: Task 1 lists "Phase 0 dependency" warning at top of Task 3 — that's a real constraint, not a placeholder, since the field-name list in the parser already includes 3 fallback keys per field.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-25-pragmatic-native-betting-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
