# Fresh-Shoe Tie Martingale — Design

Date: 2026-05-12
Status: Draft → User review
Owner: joej@gmeremit.com

## 1. Background

The user wants a new betting preset that:

1. Enters Evolution baccarat rooms **where the shoe has just started** (a "fresh shoe"), filtering across the user's existing room watch list.
2. Bets on **Tie** with martingale progression, using the user's already-configured base amount and martingale strategy.
3. Stops betting in that room and moves on whenever **any** of these happens:
   - Our Tie bet hits (win).
   - A Tie appears organically while we're watching (even if we did not bet that round).
   - The martingale level reaches the user-configured max (stop-loss).
4. Resumes betting in that room only after the next shoe reset event from Evolution.
5. Works in both **자동 모드 (Auto)** and **반자동 모드 (Semi-Auto)**:
   - Auto: all user-selected rooms run the strategy in parallel, each with an independent state machine.
   - Semi-Auto: serial — pick one fresh-shoe room from the list, bet there, on trigger navigate (via Chrome CDP) to another fresh-shoe room from the list.

This is Evolution-only. Pragmatic is out of scope.

The existing codebase already provides the building blocks: `MartingaleManager` (progression), `BettingDecisionService` (decision pipeline), `RoomFilterService` (composable filters), `EvolutionAdapter` (with `onShoeChange`, `isShoeReset`, `gameNumber`, `shoe_cards_out` already exposed), and Tie bet payout handling (`TIE_PAYOUT_MULTIPLIER = 8` in `ResultProcessor`).

## 2. Goals / Non-goals

### Goals
- Add a single-toggle "Fresh-Shoe Tie Martingale" preset in both Auto and Semi-Auto panels, with adjacent help text describing what it does.
- The preset, when ON, atomically activates four building blocks and atomically rolls them back when OFF.
- Building blocks are independently usable and independently testable so future presets can reuse them.
- All existing behavior (when the preset is OFF) is byte-for-byte unchanged. Regression test coverage for that.
- Safe-by-default: if Evolution payload lacks shoe data, do not bet.
- Per-room state machine in Auto mode: WATCHING → BETTING → STOPPED → WATCHING (on shoe reset).
- TDD for every new module; verification gate (build + typecheck + tests + manual UI check) before claiming completion.

### Non-goals
- Pragmatic support (Evolution only).
- New progression strategies (uses existing `martingale` / `fibonacci` / `custom` from `MartingaleManager`).
- New base-bet-as-percentage input (uses existing 설정 금액 field).
- Per-preset martingale cap (uses existing max level for now; YAGNI for separate cap).
- Multiple presets / preset framework (only this preset for now; if a second preset arrives later, refactor to a preset dropdown then).
- Cards-out / shoe-remaining-hands logic (out of scope; user picked option A in brainstorming, not C).
- Replacing the existing `fresh_room` filter (it has different semantics — "since I entered the room" vs. "since the casino shoe started" — both will coexist).

## 3. Architecture

Four new building blocks plus one thin orchestrator. Existing modules are extended via opt-in flags only.

```
┌─────────────────────────────────────────────────────────────┐
│  FreshShoeTieMartingalePreset  (NEW, thin orchestrator)      │
│  enable(mode)  → activates 4 blocks atomically, snapshots    │
│  disable(mode) → restores snapshot                           │
│  state: { enabledForAuto: bool, enabledForSemiAuto: bool,    │
│           snapshot }                                          │
└──────┬──────────┬──────────┬───────────┬────────────────────┘
       │          │          │           │
       ▼          ▼          ▼           ▼
  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐
  │ fresh_  │ │ Tie      │ │ Move-on- │ │  (existing)     │
  │ shoe    │ │ forced   │ │ Tie      │ │  Martingale     │
  │ filter  │ │ direction│ │ listener │ │  Manager        │
  │ (NEW)   │ │ (NEW)    │ │ (NEW)    │ │  (reused)       │
  └─────────┘ └──────────┘ └──────────┘ └─────────────────┘
       │          │          │           │
       ▼          ▼          ▼           ▼
  ┌─────────────────────────────────────────────────────────┐
  │ existing: RoomFilterService / BettingDecisionService /  │
  │           EvolutionAdapter / AutoModeOrchestrator /     │
  │           SemiAutoService / ResultProcessor             │
  └─────────────────────────────────────────────────────────┘
```

Design choices and *why*:

1. **Preset holds almost no state.** Just `enabledForAuto`, `enabledForSemiAuto`, and a snapshot for rollback. All real betting state lives in the existing services. Reason: SRP — the preset is an *activator*, not a state owner. Avoids dual sources of truth.
2. **Each of the 4 blocks is independently toggleable.** A power user can manually compose `fresh_shoe` filter + tie-forced direction + move-on-tie listener without the preset. OCP — adding a future "Fresh-Shoe Banker Anti-Streak" preset can reuse the same blocks.
3. **`fresh_shoe` is a separate filter, not an extension of `fresh_room`.** Different semantics (casino shoe vs. bot entry). Keeping them separate prevents subtle semantic drift in the existing filter.
4. **Auto and Semi-Auto share the 4 blocks; only the trigger handler differs.** Auto marks the room STOPPED in place; Semi-Auto navigates the single tab to another fresh-shoe room from the user's list. Reason: minimal duplication, mode-specific behavior isolated to one callback.

## 4. Components (new)

### 4.1 `fresh_shoe` filter

- Location: `src/application/services/RoomFilterService.ts` (extend `BUILT_IN_FILTERS`); evaluation lives wherever `RoomFilterService.matches()` is implemented.
- Type: `RoomFilterType` gains the literal `'fresh_shoe'`.
- Predicate (the room passes if either is true):
  - `room.isShoeReset === true`, **or**
  - `typeof room.gameNumber === 'number' && room.gameNumber <= freshShoeMaxGameNumber`
- Both fields missing → **filter returns false** (safe-by-default).
- Threshold: `freshShoeMaxGameNumber: number` is added to `FilterThresholdsService` (default `5`). Surfaced in `FilterThresholdInputs.tsx` next to the existing tie-drought / fresh-room inputs.
- Filter label / description updates live when threshold changes (existing emit mechanism in `RoomFilterService` constructor already does this).

### 4.2 Tie-forced direction in `BettingDecisionService`

- Location: `src/application/services/automode/BettingDecisionService.ts`.
- Extension: `BettingDecision` input object gains an optional `forceBetDirection?: 'auto' | 'tie_only'` (defaults to `'auto'` → unchanged behavior).
- When `'tie_only'`:
  - Final `betType` is always `'Tie'` regardless of model prediction.
  - All other gates (active filters, max martin level, bet amount calculation via `MartingaleManager`) run unchanged.
- `BetStrategy` enum is **not** touched. Tie + martingale already works today via the existing strategy field.
- Bet amount path: `MartingaleManager.calculateBetAmount(level, baseBet, strategy, customAmounts)` — reused as-is. Tie payout settlement: `ResultProcessor.calculateProfit()` already returns `betAmount * TIE_PAYOUT_MULTIPLIER` on Tie win — reused as-is.

### 4.3 `MoveOnTieListener`

- Location: `src/application/services/freshshoe/MoveOnTieListener.ts`.
- Interface:
  ```ts
  type TriggerReason = 'tie_hit' | 'organic_tie' | 'martin_cap';
  export interface IMoveOnTieListener {
    enable(scope: 'auto' | 'semiauto'): () => void;
    onTrigger(cb: (roomId: string, reason: TriggerReason) => void): () => void;
  }
  ```
- Responsibilities:
  - **Track pending bets per room**: subscribe to bet-placed events (whatever the existing wiring is — `AutoBettingService`'s `onBetSent`-style callback, or `BettingDecisionService`'s post-decision hook; pick the existing one closest to "bet was actually sent" in plan-step-1). Maintain `pendingBets: Map<roomId, { roundId, betType }>`. Clear on game result.
  - Subscribe to `casinoAdapter` `game.result` events. If result is `'T'`:
    - If `pendingBets.get(roomId)?.betType === 'Tie'` for the round just settled → `'tie_hit'`.
    - Otherwise → `'organic_tie'`.
    - Either way, call `MartingaleManager.resetLevel(roomId)` (defensive — `'organic_tie'` and `'martin_cap'` paths do not go through `ResultProcessor.recordWin`, so the level needs an explicit reset here; safe to call when already 0).
    - Emit a trigger with `(roomId, reason)`.
  - Subscribe to a `martin_cap` signal from `BettingDecisionService`. When the next bet would exceed `maxLevel`, `BettingDecisionService` blocks the bet (existing behavior) **and** emits a `'martin_cap'` event for this listener.
- Idempotency: dedupes by `(roomId, roundId)` so duplicate game-result events from multi-socket sources do not double-fire.
- Returns a disable function from `enable()`. Unit test verifies that after disable no further triggers fire.

### 4.4 `FreshShoeTieMartingalePreset`

- Location: `src/application/services/freshshoe/FreshShoeTieMartingalePreset.ts`.
- API:
  ```ts
  class FreshShoeTieMartingalePreset {
    enable(mode: 'auto' | 'semiauto'): void;
    disable(mode: 'auto' | 'semiauto'): void;
    isEnabled(mode: 'auto' | 'semiauto'): boolean;
    getDescription(): string;       // for the inline help text in the panel
  }
  ```
- `enable(mode)`:
  1. Snapshot current state of the 4 dimensions (was `fresh_shoe` filter on? was `forceBetDirection` set? was listener attached?).
  2. Wrap subsequent steps in try/catch with rollback to that snapshot.
  3. `RoomFilterService.setActive('fresh_shoe', true)`.
  4. Configure `BettingDecisionService`'s `forceBetDirection = 'tie_only'` for the given mode.
  5. `MoveOnTieListener.enable(mode)` and wire the trigger callback:
     - `mode === 'auto'`: mark the room as STOPPED in an in-memory `Set<roomId>` **owned by the preset itself** (keeps `AutoModeOrchestrator` unchanged; SRP). `BettingDecisionService` consults this set as one additional gate (one-line addition). On the next `onShoeChange` for that room, the preset removes it from the set.
     - `mode === 'semiauto'`: call `SemiAutoService.handlePresetTrigger(roomId, reason)`, which picks the next fresh-shoe room and calls `navigateToRoom()`.
  6. Persist `{ enabledForAuto, enabledForSemiAuto }` to localStorage.
- `disable(mode)`: reverse of enable, using the snapshot.
- Auto-restore on app boot: read localStorage and re-call `enable(mode)` for whichever modes were on.

## 5. UI changes

- **AutoModePanel**: add a single labeled toggle ("Fresh-Shoe Tie 마틴") above or near the existing strategy controls. Adjacent to the toggle, an inline help block (**always visible**, 3 lines of small dimmed text — short and important enough to not hide) describing:
  - 슈가 막 시작된 방에서만 베팅 (Evolution 슈 리셋 감지 기반).
  - Tie에 마틴 (기존 설정 금액과 마틴 한도 그대로 사용).
  - 적중 / 관망 중 Tie 출현 / 마틴 한도 도달 → 다음 fresh-shoe 방으로 이동.
- **SemiAutoPanel**: same toggle and same help block, scoped to `mode='semiauto'`.
- **FilterThresholdInputs**: new input for `freshShoeMaxGameNumber` (default 5).
- No other UI changes.

## 6. Data flow

### 6.1 Auto mode (single room — N rooms run in parallel)

```
[Toggle ON]
  → FreshShoeTieMartingalePreset.enable('auto')
      → RoomFilterService: 'fresh_shoe' filter active
      → BettingDecisionService: forceBetDirection = 'tie_only'
      → MoveOnTieListener.enable('auto')

[widget.resolved for room K]
  → RoomFilterService.matches(K)
      → fails  → ignored
      → passes → AutoModeOrchestrator.processBettingPhase(K)
          → BettingDecisionService.shouldBet({ forceBetDirection: 'tie_only', ... })
              → level >= maxMartin → block bet
                  → MoveOnTieListener emit('martin_cap', K)
                      → mark K as STOPPED
              → otherwise → place Tie bet at MartingaleManager.calculateBetAmount(level, baseBet, strategy)

[game.result for room K]
  → ResultProcessor.processResult(K, result)
      → result === 'T':
          → MartingaleManager.recordWin(K)   [level reset to 0]
          → profit = betAmount * 8 if we had an open bet
          → MoveOnTieListener emit('tie_hit' | 'organic_tie', K)
              → mark K as STOPPED
      → result !== 'T' and we bet:
          → MartingaleManager.recordLoss(K)  [level += 1]
      → result !== 'T' and we did not bet:
          → no-op

[onShoeChange for room K]   (primary trigger)
  → preset removes K from STOPPED set → K back to WATCHING

[any payload with isShoeReset === true for room K]   (E11 fallback)
  → preset removes K from STOPPED set → K back to WATCHING
```

### 6.2 Semi-Auto mode (single tab, serial)

Same trigger detection, but instead of marking STOPPED:

```
MoveOnTieListener emit(<any reason>, currentRoom)
  → SemiAutoService.handlePresetTrigger(currentRoom, reason)
      → MartingaleManager.resetLevel(currentRoom)
      → candidates = userRoomList.filter(r => fresh_shoe filter.matches(r) && r.id !== currentRoom)
      → if candidates.length === 0:
          stay; wait for next onShoeChange in any watched room, then re-evaluate
      → else:
          navigateToRoom(candidates[0])  // existing CDP navigation
```

### 6.3 Per-room state machine (Auto mode)

```
WATCHING ──(fresh_shoe matches + betting phase)──▶ BETTING
BETTING ──(tie_hit | organic_tie | martin_cap)──▶ STOPPED
STOPPED ──(onShoeChange OR isShoeReset=true again)──▶ WATCHING
```

## 7. Error handling and edge cases

| ID  | Case                                                                                | Handling                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Evolution payload missing both `isShoeReset` and `gameNumber`                       | `fresh_shoe` filter returns false. Log once at debug level. **Safe-by-default: no bet.**                                                                                |
| E2  | User room list is empty / no fresh-shoe candidate                                   | Auto: idle, no bets placed; UI shows "fresh-shoe 방 없음". Semi-Auto: stay on current room and wait for `onShoeChange`; UI shows "대기 중 — fresh-shoe 방 등장 시 자동 이동". |
| E3  | Bet placement fails (network / balance)                                             | Handled by existing `BettingDecisionService` / `AutoBettingService`. Plan verifies that a failed bet does **not** call `MartingaleManager.recordLoss()`.                |
| E4  | Race: bet decision in flight, result `'T'` arrives before bet is sent               | Bet send is aborted by existing code. `MoveOnTieListener` classifies as `'organic_tie'`. No new handling needed.                                                        |
| E5  | Duplicate `game.result` events (multi-socket)                                       | `MoveOnTieListener` dedupes by `(roomId, roundId)`. Unit-tested.                                                                                                        |
| E6  | User changes base bet / max martin level while preset is ON                         | **Allowed.** Preset reads current values per round, not from snapshot. Snapshot only covers filter/direction/listener state.                                            |
| E7  | User toggles additional filters (e.g., tie_drought) on top of preset                | **Allowed.** Preset only forces `fresh_shoe` on; other filters AND-compose per existing `RoomFilterService` semantics.                                                  |
| E8  | App crash mid-enable                                                                | `enable()` wraps in try/catch with snapshot rollback. localStorage commit is the **last** step on success. On boot, localStorage is the source of truth for auto-resume. |
| E9  | Auto and Semi-Auto preset toggles ON simultaneously                                 | Allowed — independent flags, independent listeners. Modes are mutually exclusive in practice in the rest of the app, but the preset itself does not enforce that.       |
| E10 | Listener memory leak                                                                | `enable()` returns an unsubscribe function; `disable()` always invokes it. Unit-tested.                                                                                 |
| E11 | `onShoeChange` event missed by Evolution                                            | Dual trigger: any payload with `isShoeReset === true` also clears STOPPED. Belt-and-braces.                                                                              |

## 8. Testing strategy

All new modules are written **TDD-first** (red → green → refactor), per `superpowers:test-driven-development`. Existing test patterns (`RoomFilterService.test.ts`, `SemiAutoService.test.ts`, etc.) are mirrored.

### Unit tests

| Target                                    | Cases                                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh_shoe` filter                       | `isShoeReset=true` → pass / `gameNumber<=N` → pass / both undefined → fail / `gameNumber>N` and `isShoeReset=false` → fail                                                                                                                       |
| `BettingDecisionService` tie-forced       | model says 'B'/'P'/'T'/'none' → bet is always 'Tie' when `forceBetDirection='tie_only'` / behavior unchanged when `'auto'` (regression) / max-martin gate still blocks                                                                          |
| `MoveOnTieListener`                       | result='T' with open bet → `'tie_hit'` / result='T' without open bet → `'organic_tie'` / result='B/P' → no emit / `martin_cap` signal → emit / duplicate `(roomId,roundId)` → single emit / disable() prevents further emits                     |
| `FreshShoeTieMartingalePreset`            | enable activates all 4 blocks / disable restores snapshot / failure mid-enable → full rollback / localStorage persists across boot / auto-restore on construction                                                                              |
| `MartingaleManager`                       | Existing `recordWin` resets level — add explicit Tie regression test                                                                                                                                                                            |
| `FilterThresholdsService`                 | new `freshShoeMaxGameNumber` get / set / persist / onChange emits                                                                                                                                                                              |

### Integration tests

- Auto mode full flow with mocked `EvolutionAdapter`: fresh shoe detected → Tie bet placed → result `'T'` → STOPPED → `onShoeChange` → WATCHING re-entry.
- Semi-Auto mode full flow with mocked CDP: trigger emitted → next fresh-shoe room selected → `navigateToRoom` called with correct URL.
- `martin_cap` path: N consecutive non-Tie results → level hits max → bet blocked + emit + room marked STOPPED (Auto) or navigation (Semi-Auto).
- Race case E4: bet decision pending while result `'T'` arrives → bet aborted, `'organic_tie'` emitted.

### Regression tests

- All existing tests in `AutoModeService.test.ts`, `SemiAutoService.test.ts`, `RoomFilterService.test.ts`, `MultiRoomPredictionService.test.ts` pass unchanged.
- With the preset OFF, behavior is byte-for-byte identical: same bets, same filter outcomes, same room navigation. Add an explicit "preset OFF == old behavior" smoke test for both modes.

### Plan-step-0 data validation (must precede coding)

Before writing any production code, capture real Evolution payloads (one shoe transition + several normal rounds) and confirm:

1. `isShoeReset` actually becomes `true` at shoe reset and for how many subsequent rounds it remains `true`.
2. `gameNumber` starts at `1` for the first hand of a new shoe (or, if it does not, what the correct first-hand sentinel is).
3. The relationship between `isShoeReset` and `gameNumber` (e.g., is `isShoeReset === (gameNumber <= MIN_HISTORY_FOR_PREDICTION)` already, in which case one of the predicates is redundant?).

If observed semantics differ from this design's assumptions, update the `fresh_shoe` predicate accordingly in plan-step-1.

### Manual verification gate

Per `superpowers:verification-before-completion`, "complete" is only claimed after **all** of the following return green and the user has approved the manual UI walkthrough:

- [ ] `npm run build` succeeds.
- [ ] `npm run typecheck` returns 0 errors.
- [ ] `npm test` passes (new tests + all existing tests).
- [ ] In Tauri dev: toggling the preset ON/OFF in Auto panel actually activates / deactivates `fresh_shoe` filter, `forceBetDirection`, and listener subscription (verified via console logs and DI inspection).
- [ ] In Tauri dev with a real Evolution session: a shoe reset is detected → `fresh_shoe` filter matches → a small-amount Tie bet is placed → result settles correctly → on Tie hit OR organic Tie, room is marked STOPPED (Auto) or tab navigates (Semi-Auto).
- [ ] Toggle OFF: confirm zero residual side effects (filter back to user-configured state, no listener still firing).

## 9. Clean-code principles applied (explicit)

- **SRP**: `fresh_shoe` filter detects only; tie-forced direction decides direction only; `MoveOnTieListener` detects triggers only; preset orchestrates only. No mixing.
- **OCP**: `BetStrategy` enum is untouched. `BUILT_IN_FILTERS` is extended additively. `BettingDecisionService` gets one new optional field.
- **YAGNI**: No preset framework, no per-preset martingale cap, no cards-out logic, no percentage base bet. One preset, four small blocks, single toggle each.
- **Tell, don't ask**: Preset issues commands (`enable`, `disable`); blocks own their state. `MoveOnTieListener` emits typed reasons; consumers decide what to do.
- **Names over comments**: `enableFreshShoeTieMartingale`, `freshShoeMaxGameNumber`, `MoveOnTieListener`, `forceBetDirection`. Korean inline comments only where they explain *why* (architectural intent), not *what*.
- **Atomic with rollback**: `enable()` is transactional; partial failure leaves the system in its pre-call state.

## 10. Out-of-scope / future work

- Percentage-based base bet input (separate spec if ever needed).
- Per-preset martingale cap, separate from the global one.
- Cards-out / shoe-remaining-hands heuristic (option C in brainstorming, deferred).
- Preset dropdown UX (only triggers when a second preset appears).
- Pragmatic support (Evolution-only by user decision).
