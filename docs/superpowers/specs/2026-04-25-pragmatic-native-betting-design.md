# Pragmatic Native Betting — Design

Date: 2026-04-25
Status: Draft → User review
Owner: joej@gmeremit.com

## 1. Background

`PragmaticAdapter.placeBet()` currently has a `// TODO` and ships a placeholder JSON message that the Pragmatic server ignores. As a result, real-money betting on Pragmatic Play tables does not work in newbcr, even though the rest of the pipeline (room discovery, history, game results, betting timer, balance) is functional.

Reference implementation: ROSE (PyQt5 + Playwright bot, reverse-engineered from `C:\Users\GME\Documents\rose_*`). ROSE supports the full Pragmatic Play betting loop (single auto-bet, session bet, retry). Its outbound message format and bet-window gating logic are the canonical source of truth for this work.

ROSE sends bets via Playwright `page.evaluate("window.__pragSocket.send(xml)")` — i.e., it reuses the browser's already-authenticated game socket. newbcr's architecture is different: it connects to the Pragmatic WebSocket directly from Rust (`tokio-tungstenite`), reusing the `JSESSIONID` captured from the Tauri webview's first navigation. We will keep this Rust-direct architecture (Path B) and reverse-engineer the wire protocol so the Rust client can send bets natively.

## 2. Goals / Non-goals

### Goals
- `PragmaticAdapter.placeBet()` produces a server-accepted bet on Pragmatic Play tables.
- Wire format byte-for-byte matches ROSE's `_send_pragmatic_bet_request` for player / banker / tie / player_pair / banker_pair.
- Single retry policy matching ROSE: delays `[0, 200, 500, 1000, 1500, 2500] ms`.
- Bet-window gate: do not send when the round is closed.
- Per-round duplicate prevention.
- Typed errors and a bet receipt usable by UI and `SemiAutoService`.
- Unit + golden + mock-WS integration tests.

### Non-goals
- Auto-bet loop / session bet / martingale (already partially in `SemiAutoService`; separate design).
- Lobby auto-navigation (`_auto_pragmatic_flow`).
- License / integrity gate.
- Evolution betting changes.
- UI changes (betting buttons / panel).

## 3. Architecture

```
┌─────────────── Tauri webview ────────────────┐
│ User logs into Pragmatic, opens a table.     │
│ JSESSIONID + operatorGameId etc. captured    │
│ via the existing CDP WS-URL sniffing.        │
└──────────────┬───────────────────────────────┘
               │ ws_url forwarded to Rust
               ▼
┌──── Rust: PragmaticConnectionManager ────────┐
│  active_session         (existing)           │
│  active_user_id         (NEW)                │
│  table_game_ids         (NEW)                │
│  table_bet_status       (NEW)                │
│  last_bet_per_table     (NEW)                │
└──────────────┬───────────────────────────────┘
               │ spawns + tracks
     ┌─────────┴─────────┐
     ▼                   ▼
┌──────────┐       ┌──────────┐
│ client A │       │ client B │   per-table WS (existing)
│ (tableA) │       │ (tableB) │
└──────────┘       └──────────┘
```

### New modules
- `src-tauri/src/pragmatic/bet_builder.rs` — XML builder + bet-code map + ts.
- `src-tauri/src/pragmatic/ping.rs` — `pingTime` → `pongTime` responder (lives in `client.rs` if trivial).

### Modified modules
- `pragmatic/parser.rs` — add `GameState` and `SessionInfo` variants.
- `pragmatic/normalizer.rs` — map new variants to manager state-update actions.
- `pragmatic/manager.rs` — add new fields; expose `place_bet(...)`.
- `pragmatic/commands.rs` — add typed `place_pragmatic_bet`, `get_pragmatic_table_state`.
- `infrastructure/adapters/PragmaticAdapter.ts` — replace TODO body, add `onBetSent` / `onBetFailed`.

## 4. Wire protocol

### 4.1 Outbound bet (XML)

```xml
<command channel="table-{table_id}">
  <lpbet gm="mtb_desktop" gId="{game_id}" uId="{user_id}" ck="{ts_ms}">
    <bet amt="{amount}" bc="{bet_code}" ck="{ts_ms}" />
  </lpbet>
</command>
```

Sent as a single text WS frame (no wrapping JSON, no length prefix). Confirmed against `rose_main_dis.txt` line 12835 `_send_pragmatic_bet_request` constants `#10..#18`.

| Field      | Source                                               | Notes                                       |
|------------|------------------------------------------------------|---------------------------------------------|
| `table_id` | caller arg                                           | trim via `_normalize_table_id()`            |
| `amount`   | caller arg, `u64`                                    | reject `0`                                  |
| `bet_code` | map below                                            |                                             |
| `ts_ms`    | `SystemTime::now()` epoch ms (`i64`)                 | used in both `<bet ck=…>` and `<lpbet ck=…>`|
| `game_id`  | `manager.table_game_ids[table_id]`                   | NoGameId → retry                            |
| `user_id`  | `manager.active_user_id`                             | NoUserId → fail (no retry)                  |
| `gm`       | constant `"mtb_desktop"`                             |                                             |

```
bet_code_map = { player: 0, banker: 1, tie: 2, player_pair: 3, banker_pair: 4 }
```

Input normalization (ROSE-faithful):
1. trim → lower
2. direct key match
3. fallback: replace space with underscore (`"player pair"` → `"player_pair"`)

XML escaping: `table_id` and `user_id` must pass through XML attribute escape (`&`, `<`, `>`, `"`). All other fields are numeric.

### 4.2 Inbound (JSON, existing) — gaps to fill

Current `parser.rs` recognises: `Statistics`, `GameResult`, `SeatUpdate`, `GlobalStats`, `PingPong`. None of these expose `gameId` or `userId`.

Phase 0 (research) must locate, by capturing live frames in the webview:
- the frame carrying `gameId` / `currentGameId` (per table)
- the frame or session-establishment artifact carrying `userId` / `playerId` / `operatorPlayerId`
- the bet-window open/close signal that newbcr already receives (currently inferred via `BettingPhaseEvent`)

Hypotheses:
- **A** — `gameId` is already inside the existing `gameResult` envelope and the parser drops it. Verify first.
- **B** — separate frame (e.g. `gameState`, `newGame`, `round`).
- **C** — only on a different MTB command socket. Worst case: requires CDP iframe socket hookup.

`user_id` candidates (in order):
1. `session.params` already-captured query keys (`userId`, `playerId`, `operatorPlayerId`, `pn`).
2. WS auth-response JSON.
3. `seatUpdate` / `playerInfo` frame.
4. Last resort: `Runtime.evaluate` `window.user`/`window.config` in the webview.

### 4.3 Ping / heartbeat

- `tokio-tungstenite` answers WebSocket-level pings automatically.
- Pragmatic application-level heartbeat looks like inbound `{pingTime: ...}` expecting `{pongTime: ...}`. `parser.rs` already recognises both. Add: client auto-replies `{"pongTime": <ms>}` on receipt.
- ROSE's `'2'` payload (socket.io-flavored) is presumed unnecessary on the direct `/game` socket — confirm in Phase 0; if needed, send on connect.

## 5. Rust API

`commands.rs`:

```rust
#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
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

#[command]
pub async fn place_pragmatic_bet(
    state: State<'_, PragmaticManagerState>,
    table_id: String,
    bet_type: String,
    amount: u64,
) -> Result<BetReceipt, BetError>;

#[command]
pub async fn get_pragmatic_table_state(
    state: State<'_, PragmaticManagerState>,
    table_id: String,
) -> Result<TableSnapshot, String>;
```

### Retry loop

```
const RETRY_DELAYS_MS: [u64; 6] = [0, 200, 500, 1000, 1500, 2500];

for (attempt, delay) in RETRY_DELAYS_MS.iter().enumerate() {
    sleep(Duration::from_millis(*delay)).await;

    if bet_status != Open  -> Err(BetWindowClosed)            // no further retry
    let game_id = table_game_ids.get(&table_id)
        .ok_or(BetError::NoGameId{...})?;                     // retried by loop
    let user_id = active_user_id
        .ok_or(BetError::NoUserId)?;                          // not retried (loop short-circuits)
    if last_bet_per_table[&table_id].game_id == game_id
                                  -> Err(DuplicateForRound)   // no retry

    let xml = build_bet_xml(...);
    match client.send_message(xml.clone()).await {
        Ok(()) => {
            last_bet_per_table.insert(table_id, (game_id, ck));
            return Ok(BetReceipt { attempt: attempt + 1, xml, ... });
        }
        Err(e) => { last_error = e; continue; }
    }
}
return Err(AllRetriesExhausted { last_error });
```

`NoUserId` and `BetWindowClosed` and `DuplicateForRound` short-circuit (loop returns on the first occurrence). `NoGameId` and `SendFailed` get re-attempted within the schedule.

## 6. Frontend integration

`PragmaticAdapter.ts`:

```ts
async placeBet(roomId: string, betType: string, amount: number): Promise<BetReceipt> {
    if (!this.connected) throw new Error('Not connected')
    try {
        const receipt = await invoke<BetReceipt>('place_pragmatic_bet', {
            tableId: roomId,
            betType: this.normalizeBetType(betType),
            amount,
        })
        this.emitBetSent(receipt)
        return receipt
    } catch (err) {
        this.emitBetFailed(roomId, err as BetError)
        throw err
    }
}
```

New callbacks (parallel to existing `onGameResult` etc.):
- `onBetSent(receipt: BetReceipt) => void`
- `onBetFailed(roomId: string, error: BetError) => void`

Subscribed by `SemiAutoService` (so its martingale ladder advances on actual server-accepted bets, not optimistic UI) and the bet-log UI.

## 7. Implementation phases

```
Phase 0 — Research (mandatory, blocks everything else)
  0.1 In webview, log into Pragmatic and open a baccarat table.
  0.2 Dump every pragmatic_raw_message to a file for ~3 minutes (multiple rounds).
  0.3 Identify gameId / userId / bet-window frames.
  0.4 Confirm ping/pong pattern.
  0.5 Cross-check with rose_main_dis.txt _handle_pragmatic_ws_frame (line 13385).
  Output: docs/superpowers/research/pragmatic-frames.md (sanitized capture + key map).

Phase 1 — Rust state infrastructure
  1.1 PragmaticConnectionManager: add active_user_id, table_game_ids,
      table_bet_status, last_bet_per_table.
  1.2 parser.rs: GameState + SessionInfo variants (driven by Phase 0).
  1.3 normalizer.rs: map new variants to manager updates.
  1.4 client.rs: pingTime → pongTime auto-reply.
  Tests: unit on parser fixtures.

Phase 2 — bet_builder.rs
  2.1 build_bet_xml(table_id, bet_type, amount, game_id, user_id, ck) -> String
  2.2 bet_code map; XML attribute escape.
  Tests: golden — string equality with constants from rose_main_dis.txt.

Phase 3 — place_pragmatic_bet command
  3.1 BetError, BetReceipt.
  3.2 Retry loop with the schedule above.
  3.3 Audit log via `tracing` target "pragmatic_bet".
  Tests: integration with local tokio-tungstenite mock server; assert
        outbound text frame == expected XML.

Phase 4 — Frontend
  4.1 PragmaticAdapter.placeBet replaced.
  4.2 onBetSent / onBetFailed wired through to SemiAutoService.
  4.3 normalizeBetType helper.
  Manual e2e: one demo-account real bet succeeds end-to-end.

Phase 5 — Cleanup
  5.1 send_pragmatic_message marked debug-only in commands.rs.
  5.2 Remove TODO comment.
  5.3 Update AGENTS.md / module-level docs.
```

## 8. Risks

| # | Risk                                                          | P  | Impact   | Mitigation                                                                                                  |
|---|---------------------------------------------------------------|----|----------|-------------------------------------------------------------------------------------------------------------|
| R1 | `gameId` not present on the socket newbcr connects to (hyp C) | M  | Critical | Verify in Phase 0 first. Fallback: hook the iframe socket via CDP and pipe `gameId` events back to manager. |
| R2 | `userId` not exposed in any frame                             | M  | Critical | Walk the candidate list in §4.2; last resort: `Runtime.evaluate` `window.user`/`window.config`.             |
| R3 | XML accepted but silently rejected (no balance change)        | L  | High     | Capture server ACK / reject frames in Phase 0; add `ack_frame` field to `BetReceipt`.                       |
| R4 | Race at end of betting window                                 | H  | Medium   | `BetWindowClosed` short-circuits; retries don't help in last ~2 s.                                          |
| R5 | Multi-table simultaneous bets / `gameId` lag                  | M  | Medium   | Atomic `HashMap` reads OK; per-table mutex only around `last_bet_per_table` write.                          |
| R6 | No auto-reconnect → stale session blocks bets                 | M  | High     | Add reconnect using `active_session` in Phase 1.4 (small extension).                                        |
| R7 | Bot detection / rate limiting                                 | L  | High     | Match ROSE delays exactly; add ±10% jitter as opt-in.                                                       |

## 9. Test strategy

- **Unit**: `bet_builder` (5 bet types × 3 input variants), bet_code map, `_normalize_table_id`, parser fixtures from Phase 0 capture, retry loop with mock client (success on attempt 1/3/6, total failure).
- **Golden**: byte-equality of generated XML against constants extracted from `rose_main_dis.txt:12835+` — frozen as a regression oracle.
- **Integration**: local `tokio-tungstenite::accept_async` mock Pragmatic server; assert outbound frame text equals expected XML; assert `BetWindowClosed` and `NoGameId` paths.
- **Manual e2e**: one demo bet in a real Pragmatic table, sanitized receipt attached to `pragmatic-frames.md`.

## 10. Rollback

- All new code is additive (new modules, new fields, new command). Existing `send_pragmatic_message` stays.
- Frontend change is one method body; revert via single git revert.
- No DB / config / settings migrations.
