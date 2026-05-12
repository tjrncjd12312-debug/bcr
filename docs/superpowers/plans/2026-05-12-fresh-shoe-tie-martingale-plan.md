# Fresh-Shoe Tie Martingale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-toggle "Fresh-Shoe Tie Martingale" preset to both Auto and Semi-Auto panels that enters Evolution rooms with a freshly started shoe, bets Tie with martingale, and moves on whenever a Tie appears (our bet hits, organic tie, or martin cap is reached).

**Architecture:** Four independently-toggleable building blocks (new `fresh_shoe` filter, new `forceBetDirection: 'tie_only'` setting, new `MoveOnTieListener`, new `FreshShoeTieMartingalePreset` thin orchestrator) plus a single new gate inside `BettingDecisionService.shouldBet`. Existing services (`MartingaleManager`, `RoomFilterService`, `ResultProcessor`, `AutoModeOrchestrator`, `SemiAutoService`, `EvolutionAdapter`) get minimal additive changes; default behavior is unchanged when the preset is OFF.

**Tech Stack:** TypeScript, Vitest (`npm test`, single-run `npm run test:run`), React, Vite, Tauri 2. Build/typecheck via `npm run build` (= `tsc && vite build`).

**Spec:** [`docs/superpowers/specs/2026-05-12-fresh-shoe-tie-martingale-design.md`](../specs/2026-05-12-fresh-shoe-tie-martingale-design.md)

---

## File Structure

### New files
| Path | Responsibility |
|------|---------------|
| `src/application/services/freshshoe/MoveOnTieListener.ts` | Subscribes to multi-socket `game.result` (and a `martin_cap` signal), classifies Tie events as `'tie_hit'` / `'organic_tie'` / `'martin_cap'`, emits per-roomId triggers. Scope-filters to all rooms (Auto) or current room only (Semi-Auto). Dedupes by `(roomId, roundId)`. |
| `src/application/services/freshshoe/FreshShoeTieMartingalePreset.ts` | Thin orchestrator. `enable(mode)` / `disable(mode)` atomically activate/restore four blocks. Owns `stoppedRooms: Set<string>` and exposes `isRoomStopped(roomId)`. Persists `{enabledForAuto, enabledForSemiAuto}` to localStorage. Auto-restores on construction. |
| `src/application/services/freshshoe/index.ts` | Barrel export. |
| `src/application/services/freshshoe/MoveOnTieListener.test.ts` | Unit tests. |
| `src/application/services/freshshoe/FreshShoeTieMartingalePreset.test.ts` | Unit tests. |
| `src/application/services/freshshoe/__integration__/freshShoeAutoFlow.test.ts` | Auto-mode integration test. |
| `src/application/services/freshshoe/__integration__/freshShoeSemiAutoFlow.test.ts` | Semi-Auto-mode integration test. |
| `docs/superpowers/research/2026-05-12-evolution-shoe-fields.md` | Phase 0 verification notes (which Evolution field actually marks a fresh shoe). |

### Modified files
| Path | What changes |
|------|--------------|
| `src/domain/entities/index.ts` | Add `'fresh_shoe'` to `RoomFilterType` union. Add `FRESH_SHOE_MAX_GAME_NUMBER = 5` constant. |
| `src/application/services/FilterThresholdsService.ts` | Add `freshShoeMaxGameNumber: number` to `FilterThresholds`. Update `DEFAULTS`, `load()`, `set()` to handle the new field. |
| `src/application/services/RoomFilterService.ts` | Add `'fresh_shoe'` entry to `BUILT_IN_FILTERS`. Refresh its label when threshold changes. Add `case 'fresh_shoe'` to `matchesFilter()`. |
| `src/application/services/RoomFilterService.test.ts` | Add tests for `fresh_shoe`. |
| `src/application/services/automode/types.ts` | Add `forceBetDirection?: 'auto' \| 'tie_only'` to `AutoModeSettings`. Update `DEFAULT_SETTINGS`. |
| `src/application/services/automode/BettingDecisionService.ts` | (1) Honor `settings.forceBetDirection === 'tie_only'` by overriding `betType` to `'Tie'`. (2) Accept an optional `stoppedRoomsChecker?: (roomId: string) => boolean` via constructor; add a gate after rest-check that returns `{ shouldBet: false, skipReason: 'Fresh-shoe 종료' }` when the checker returns true. (3) When `currentLevel >= settings.maxMartin`, call a new optional `onMartinCap?: (roomId: string) => void` callback so the listener can emit `'martin_cap'`. |
| `src/application/services/automode/BettingDecisionService.test.ts` (existing or new) | Add tests for tie-forced direction, stopped-rooms gate, and martin-cap callback. |
| `src/application/services/SemiAutoService.ts` | Add `handlePresetTrigger(roomId: string, reason: TriggerReason): Promise<void>` method. Extend `BetLogEvent.betType` to include `'Tie'`. Expose `getCurrentRoomId(): string \| null` for the listener scope filter. |
| `src/application/services/SemiAutoService.test.ts` | Add tests for `handlePresetTrigger` (no candidates / has candidates / re-evaluates on event). |
| `src/application/di/setupContainer.ts` | Register `MoveOnTieListener` and `FreshShoeTieMartingalePreset` in the DI container. |
| `src/presentation/components/AutoModePanel/components/FilterThresholdInputs.tsx` | Add a third input row for `freshShoeMaxGameNumber` (same shape as existing two). |
| `src/presentation/components/AutoModePanel/AutoModeSettingsDialog.tsx` | Add a labeled toggle "Fresh-Shoe Tie 마틴" + 3-line help block. On change, call `preset.enable('auto')` / `preset.disable('auto')`. |
| `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx` | Same toggle and help block, scoped to `'semiauto'`. |

---

## Phase 0 — Evolution Field Verification (BLOCKS Phase 1 step "fresh_shoe filter implementation")

### Task 1: Verify how `isShoeReset` / shoe-start data reaches `RoomPredictionState`

**Why:** The spec assumes the `fresh_shoe` filter can read `predictionState.isShoeReset` (and optionally a hand-number) for the current room. `RoomPredictionState.isShoeReset` is documented on `src/domain/entities/index.ts:391` ("히스토리 5개 미만"). We must confirm (a) this flag actually flips to `true` shortly after `EvolutionAdapter.emitShoeChange()` fires, and (b) what real-time field, if any, exposes the casino-shoe hand index (so we can choose whether the filter's second predicate is `gameNumber` or just `room.history.length`).

**Files:**
- Create: `docs/superpowers/research/2026-05-12-evolution-shoe-fields.md`

- [ ] **Step 1: Add a temporary log to `EvolutionAdapter.processShoeHistory` and `emitShoeChange`**

In `src/infrastructure/adapters/EvolutionAdapter.ts`, locate `processShoeHistory` (~line 760) and `emitShoeChange` (~line 1479). Prepend a single `console.log` in each:

```ts
// PHASE-0 FRESH-SHOE VERIFY: remove after research
console.log('[FRESH-SHOE-VERIFY] processShoeHistory', { tableId, historyLen: historyData.length, hasArgsGameNumber: typeof (args as any)?.gameNumber, sampleArgsKeys: Object.keys(args ?? {}).slice(0, 20) })
```

```ts
// PHASE-0 FRESH-SHOE VERIFY: remove after research
console.log('[FRESH-SHOE-VERIFY] emitShoeChange', { roomId, koreanName })
```

- [ ] **Step 2: Add a temporary log inside `MultiRoomPredictionService` where `isShoeReset` is set**

Run `grep -rn "isShoeReset" src/application/services/` to find the assignment. Prepend a `console.log('[FRESH-SHOE-VERIFY] isShoeReset set', { roomId, value })` next to it.

- [ ] **Step 3: Run the Tauri dev app and capture logs**

Run: `npm run tauri:dev`
Open Evolution, log in, watch any baccarat table for 10–15 minutes spanning at least one shoe reset. Save the DevTools console as `docs/superpowers/research/2026-05-12-shoe-logs.txt` (manual copy/paste is fine).

- [ ] **Step 4: Document findings**

In `docs/superpowers/research/2026-05-12-evolution-shoe-fields.md`, record:

```markdown
# Evolution Shoe Field Verification — 2026-05-12

## isShoeReset
- Set to `true` by: <which method, when>
- Set to `false` by: <which method, when>
- Observed: stays `true` for ~N events after a shoe reset (paste 3–5 log lines).

## gameNumber (if any)
- Field name observed in `args`: <yes / no / which key>
- Source frame: <which msgType>
- Resets to 1 (or some sentinel) on shoe reset: <yes / no / not present>

## Decision for `fresh_shoe` filter second predicate
- [ ] Use real `gameNumber` field from args (if confirmed present and meaningful)
- [ ] Fall back to `room.history.length <= freshShoeMaxGameNumber`
- Reason: <one sentence>
```

- [ ] **Step 5: Revert the temporary logs**

Remove the three `[FRESH-SHOE-VERIFY]` `console.log` statements from `EvolutionAdapter.ts` and `MultiRoomPredictionService` (whichever file Step 2 touched). Run `npm run build` and confirm 0 errors.

- [ ] **Step 6: Commit research**

```bash
git add docs/superpowers/research/2026-05-12-evolution-shoe-fields.md
git commit -m "research: verify evolution shoe-reset field semantics for fresh-shoe filter"
```

---

## Phase 1 — Foundation Extensions (additive, no behavior change yet)

### Task 2: Add `freshShoeMaxGameNumber` threshold

**Files:**
- Modify: `src/domain/entities/index.ts` (around line 278)
- Modify: `src/application/services/FilterThresholdsService.ts`
- Test: existing `FilterThresholdsService` smoke (or add a new test file if none exists)

- [ ] **Step 1: Add constant to `domain/entities/index.ts`**

Right after the `FRESH_ROOM_GAMES = 5` constant (~line 278), add:

```ts
/** 카지노 슈가 막 시작된 직후 N게임 (fresh_shoe 필터용) */
export const FRESH_SHOE_MAX_GAME_NUMBER = 5
```

- [ ] **Step 2: Write a failing test for the new threshold field**

Create `src/application/services/FilterThresholdsService.test.ts` if it does not exist (check first; if there is already a test file, append to it):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import FilterThresholdsService from './FilterThresholdsService'
import { FRESH_SHOE_MAX_GAME_NUMBER } from '../../domain/entities'

describe('FilterThresholdsService', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem('bcr-filter-thresholds')
    }
  })

  it('defaults freshShoeMaxGameNumber to FRESH_SHOE_MAX_GAME_NUMBER', () => {
    const v = FilterThresholdsService.get()
    expect(v.freshShoeMaxGameNumber).toBe(FRESH_SHOE_MAX_GAME_NUMBER)
  })

  it('sets and persists freshShoeMaxGameNumber', () => {
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 8 })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(8)
    const raw = window.localStorage.getItem('bcr-filter-thresholds') ?? ''
    expect(raw).toContain('"freshShoeMaxGameNumber":8')
  })

  it('clamps freshShoeMaxGameNumber to [1, 200]', () => {
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 0 })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(1)
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 9999 })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(200)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:run -- FilterThresholdsService`
Expected: All three new cases fail — `freshShoeMaxGameNumber` is `undefined` and `set` ignores it.

- [ ] **Step 4: Implement the threshold field**

In `src/application/services/FilterThresholdsService.ts`:

Replace the `FilterThresholds` interface and `DEFAULTS`:

```ts
import { TIE_DROUGHT_THRESHOLD, FRESH_ROOM_GAMES, FRESH_SHOE_MAX_GAME_NUMBER } from '../../domain/entities'

const STORAGE_KEY = 'bcr-filter-thresholds'

export interface FilterThresholds {
  tieDroughtThreshold: number
  freshRoomGames: number
  freshShoeMaxGameNumber: number
}

const DEFAULTS: FilterThresholds = {
  tieDroughtThreshold: TIE_DROUGHT_THRESHOLD,
  freshRoomGames: FRESH_ROOM_GAMES,
  freshShoeMaxGameNumber: FRESH_SHOE_MAX_GAME_NUMBER,
}
```

Inside `load()`, extend the `this.values` assignment:

```ts
this.values = {
  tieDroughtThreshold: this.coerce(parsed.tieDroughtThreshold, DEFAULTS.tieDroughtThreshold, 1, 200),
  freshRoomGames: this.coerce(parsed.freshRoomGames, DEFAULTS.freshRoomGames, 1, 200),
  freshShoeMaxGameNumber: this.coerce(parsed.freshShoeMaxGameNumber, DEFAULTS.freshShoeMaxGameNumber, 1, 200),
}
```

Inside `set(partial)`, extend the new-values object:

```ts
this.values = {
  tieDroughtThreshold: partial.tieDroughtThreshold !== undefined
    ? this.coerce(partial.tieDroughtThreshold, this.values.tieDroughtThreshold, 1, 200)
    : this.values.tieDroughtThreshold,
  freshRoomGames: partial.freshRoomGames !== undefined
    ? this.coerce(partial.freshRoomGames, this.values.freshRoomGames, 1, 200)
    : this.values.freshRoomGames,
  freshShoeMaxGameNumber: partial.freshShoeMaxGameNumber !== undefined
    ? this.coerce(partial.freshShoeMaxGameNumber, this.values.freshShoeMaxGameNumber, 1, 200)
    : this.values.freshShoeMaxGameNumber,
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `npm run test:run -- FilterThresholdsService`
Expected: All three new cases pass. No other tests should regress.

- [ ] **Step 6: Commit**

```bash
git add src/domain/entities/index.ts src/application/services/FilterThresholdsService.ts src/application/services/FilterThresholdsService.test.ts
git commit -m "feat(filter): add freshShoeMaxGameNumber threshold with persistence"
```

---

### Task 3: Register `'fresh_shoe'` filter type and built-in entry

**Files:**
- Modify: `src/domain/entities/index.ts` (around line 261)
- Modify: `src/application/services/RoomFilterService.ts`

- [ ] **Step 1: Add `'fresh_shoe'` to `RoomFilterType` union**

In `src/domain/entities/index.ts`, update the union (around line 261):

```ts
export type RoomFilterType =
  | 'losing_streak'
  | 'alternating'
  | 'long_streak'
  | 'winning_streak'
  | 'short_streak'
  | 'after_tie'
  | 'banker_dominant'
  | 'player_dominant'
  | 'tie_drought'
  | 'no_tie_room'
  | 'fresh_room'
  | 'fresh_shoe'      // NEW: 카지노 슈가 막 시작된 방
  | CustomPatternType
```

- [ ] **Step 2: Add the `'fresh_shoe'` entry to `BUILT_IN_FILTERS`**

In `src/application/services/RoomFilterService.ts`, in the `BUILT_IN_FILTERS` array (around line 20), append after the `'fresh_room'` entry:

```ts
{
  type: 'fresh_shoe',
  enabled: false,
  label: 'Fresh Shoe',
  description: '카지노 슈가 막 시작된 방 (isShoeReset 또는 history ≤ N)',
},
```

- [ ] **Step 3: Update label-refresh in `getAvailableFilters()` to use the threshold for `'fresh_shoe'`**

In `RoomFilterService.ts`, locate the `getAvailableFilters` method (~line 111). It already destructures `tieDroughtThreshold` and `freshRoomGames`. Extend:

```ts
const { tieDroughtThreshold, freshRoomGames, freshShoeMaxGameNumber } = FilterThresholdsService.get()

const builtin = BUILT_IN_FILTERS.map(filter => {
  let label = filter.label
  let description = filter.description
  if (filter.type === 'tie_drought') {
    label = `타이 가뭄 (${tieDroughtThreshold})`
    description = `최근 ${tieDroughtThreshold}게임 동안 Tie 미발생`
  } else if (filter.type === 'fresh_room') {
    label = `신규 방 (≤${freshRoomGames})`
    description = `방 진입 후 ${freshRoomGames}게임 이내`
  } else if (filter.type === 'fresh_shoe') {
    label = `Fresh Shoe (≤${freshShoeMaxGameNumber})`
    description = `카지노 슈가 막 시작된 방 — isShoeReset=true 또는 history ≤ ${freshShoeMaxGameNumber}`
  }
  return {
    ...filter,
    label,
    description,
    enabled: this.activeFilters.has(filter.type),
  }
})
```

- [ ] **Step 4: Run typecheck**

Run: `npm run build`
Expected: 0 TypeScript errors. (No runtime tests yet for this change — the matcher is added in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add src/domain/entities/index.ts src/application/services/RoomFilterService.ts
git commit -m "feat(filter): register fresh_shoe filter type and built-in entry"
```

---

### Task 4: Implement `matchesFilter` for `'fresh_shoe'`

**Files:**
- Modify: `src/application/services/RoomFilterService.ts` (the `matchesFilter` method)
- Modify: `src/application/services/RoomFilterService.test.ts`

**Note:** The exact predicate's second branch is decided by Phase 0 — Task 1 Step 4. The plan below assumes the fallback `room.history.length <= freshShoeMaxGameNumber` is acceptable; if Phase 0 surfaced a real `gameNumber` field on the room or prediction state, replace the `historyLengthOk` line with the real-field check.

- [ ] **Step 1: Write failing tests in `RoomFilterService.test.ts`**

Append a new `describe` block after the existing ones:

```ts
import FilterThresholdsService from './FilterThresholdsService'
import type { RoomPredictionState } from '../../domain/entities'

function createPredictionState(roomId: string, isShoeReset?: boolean): RoomPredictionState {
  return {
    roomId,
    roomName: `Room ${roomId}`,
    lastPrediction: null,
    stats: {
      total: 0, correct: 0, winRate: 0,
      consecutiveWins: 0, consecutiveLosses: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
    },
    pattern: null,
    isFiltered: false,
    predictionCount: 0,
    history: [],
    isShoeReset,
  }
}

describe('fresh_shoe filter', () => {
  beforeEach(() => {
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 5 })
  })

  it('matches when predictionState.isShoeReset === true regardless of history length', () => {
    const room = createRoom('r1', createHistory('BBPBPBBPPBBPBP')) // 14 results > 5
    const state = createPredictionState('r1', true)
    expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(true)
  })

  it('matches when history.length <= freshShoeMaxGameNumber and isShoeReset is falsy', () => {
    const room = createRoom('r2', createHistory('BPB')) // 3 results
    const state = createPredictionState('r2', false)
    expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(true)
  })

  it('does NOT match when history is long and isShoeReset is false', () => {
    const room = createRoom('r3', createHistory('BPBPBPBP')) // 8 > 5
    const state = createPredictionState('r3', false)
    expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
  })

  it('does NOT match when both isShoeReset is undefined and history is long', () => {
    const room = createRoom('r4', createHistory('BPBPBPBP'))
    const state = createPredictionState('r4', undefined)
    expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
  })

  it('does NOT match when predictionState is null and history is long', () => {
    const room = createRoom('r5', createHistory('BPBPBPBP'))
    expect(RoomFilterService.matchesFilter(room, null, 'fresh_shoe')).toBe(false)
  })

  it('matches when predictionState is null but history is short (≤ N)', () => {
    const room = createRoom('r6', createHistory('BP'))
    expect(RoomFilterService.matchesFilter(room, null, 'fresh_shoe')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm run test:run -- RoomFilterService`
Expected: All six new cases fail because there is no `case 'fresh_shoe'` branch yet.

- [ ] **Step 3: Implement the matcher**

In `RoomFilterService.ts`, inside `matchesFilter()`'s switch statement, add this case after `case 'fresh_room'` (~line 340):

```ts
case 'fresh_shoe': {
  const { freshShoeMaxGameNumber } = FilterThresholdsService.get()
  if (predictionState?.isShoeReset === true) return true
  const historyLen = winners.length
  return historyLen > 0 && historyLen <= freshShoeMaxGameNumber
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm run test:run -- RoomFilterService`
Expected: All six new cases pass. All existing cases still pass.

- [ ] **Step 5: Commit**

```bash
git add src/application/services/RoomFilterService.ts src/application/services/RoomFilterService.test.ts
git commit -m "feat(filter): implement fresh_shoe matcher (isShoeReset OR short history)"
```

---

### Task 5: Add `forceBetDirection` to `AutoModeSettings`

**Files:**
- Modify: `src/application/services/automode/types.ts`

- [ ] **Step 1: Extend `AutoModeSettings` and `DEFAULT_SETTINGS`**

In `src/application/services/automode/types.ts`, add a new field. Right under `bettingMode: BettingMode` (~line 53):

```ts
  // 강제 베팅 방향: 'tie_only'일 때 prediction 무시하고 Tie 강제 (Fresh-Shoe 프리셋이 사용)
  forceBetDirection?: 'auto' | 'tie_only'
```

In `DEFAULT_SETTINGS` (~line 67), add:

```ts
  forceBetDirection: 'auto',
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: 0 errors. (Optional field, default supplied; no consumers need updating until Task 6.)

- [ ] **Step 3: Commit**

```bash
git add src/application/services/automode/types.ts
git commit -m "feat(automode): add forceBetDirection setting (default 'auto')"
```

---

### Task 6: Honor `forceBetDirection` in `BettingDecisionService`

**Files:**
- Modify: `src/application/services/automode/BettingDecisionService.ts`
- Test: `src/application/services/automode/BettingDecisionService.test.ts` (create if missing)

- [ ] **Step 1: Write a failing test**

Create (or append to) `src/application/services/automode/BettingDecisionService.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { BettingDecisionService } from './BettingDecisionService'
import { MartingaleManager } from './MartingaleManager'
import { RestPeriodManager } from './RestPeriodManager'
import { DEFAULT_SETTINGS, createRoomContext, type AutoModeSettings } from './types'
import type { Prediction } from '../../../domain/entities'

function settings(override: Partial<AutoModeSettings> = {}): AutoModeSettings {
  return { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false, ...override }
}

function prediction(p: 'B' | 'P' | 'T' | null, isSkip = false): Prediction {
  return {
    roomId: 'r1',
    prediction: p,
    confidence: 0.9,
    isSkip,
    timestamp: Date.now(),
  } as Prediction
}

describe('BettingDecisionService.forceBetDirection', () => {
  let svc: BettingDecisionService

  beforeEach(() => {
    svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
  })

  it("returns betType='Tie' when forceBetDirection='tie_only' and prediction is 'B'", () => {
    const d = svc.shouldBet('r1', prediction('B'), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
    expect(d.betType).toBe('Tie')
  })

  it("returns betType='Tie' when forceBetDirection='tie_only' and prediction is 'P'", () => {
    const d = svc.shouldBet('r1', prediction('P'), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.betType).toBe('Tie')
  })

  it("returns betType='Tie' when forceBetDirection='tie_only' and prediction is 'T'", () => {
    const d = svc.shouldBet('r1', prediction('T'), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.betType).toBe('Tie')
  })

  it("uses prediction-derived betType when forceBetDirection='auto' (default)", () => {
    const d = svc.shouldBet('r1', prediction('B'), settings({ forceBetDirection: 'auto' }), createRoomContext('r1', 'Room'))
    expect(d.betType).toBe('Banker')
  })

  it("does not bet when prediction.isSkip is true even with forceBetDirection='tie_only'", () => {
    const d = svc.shouldBet('r1', prediction('B', true), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(false)
    expect(d.skipReason).toBe('패스 예측')
  })

  it("respects max martin gate with forceBetDirection='tie_only'", () => {
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 5
    const d = svc.shouldBet('r1', prediction('B'), settings({ forceBetDirection: 'tie_only', maxMartin: 5 }), ctx)
    expect(d.shouldBet).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm run test:run -- BettingDecisionService`
Expected: At least the three "Tie forced" cases fail because `betType` is currently derived purely from `prediction.prediction`.

- [ ] **Step 3: Implement the override in `BettingDecisionService.shouldBet`**

In `src/application/services/automode/BettingDecisionService.ts`, locate step 8 (the `betType` derivation around line 109). Replace:

```ts
    // 8. 배팅 타입 결정
    const betType: BetType =
      prediction.prediction === 'B' ? 'Banker' :
      prediction.prediction === 'P' ? 'Player' : 'Tie'
```

with:

```ts
    // 8. 배팅 타입 결정
    // 'tie_only' 모드: prediction 무시하고 Tie 강제 (Fresh-Shoe 프리셋)
    const betType: BetType =
      settings.forceBetDirection === 'tie_only'
        ? 'Tie'
        : prediction.prediction === 'B' ? 'Banker' :
          prediction.prediction === 'P' ? 'Player' : 'Tie'
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm run test:run -- BettingDecisionService`
Expected: All six new cases pass. Any existing tests unchanged.

- [ ] **Step 5: Run full test suite for regression check**

Run: `npm run test:run`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/automode/BettingDecisionService.ts src/application/services/automode/BettingDecisionService.test.ts
git commit -m "feat(automode): honor forceBetDirection='tie_only' in BettingDecisionService"
```

---

## Phase 2 — New Modules (TDD)

### Task 7: Create `MoveOnTieListener`

**Files:**
- Create: `src/application/services/freshshoe/MoveOnTieListener.ts`
- Create: `src/application/services/freshshoe/MoveOnTieListener.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/application/services/freshshoe/MoveOnTieListener.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MoveOnTieListener, type TriggerReason } from './MoveOnTieListener'

// Minimal fake casino adapter
function createFakeAdapter() {
  const resultCallbacks: Array<(e: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) => void> = []
  return {
    onGameResult(cb: (e: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) => void): () => void {
      resultCallbacks.push(cb)
      return () => {
        const i = resultCallbacks.indexOf(cb)
        if (i >= 0) resultCallbacks.splice(i, 1)
      }
    },
    fireResult(e: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) {
      resultCallbacks.slice().forEach(cb => cb(e))
    },
  }
}

describe('MoveOnTieListener', () => {
  let adapter: ReturnType<typeof createFakeAdapter>
  let listener: MoveOnTieListener
  let emitted: Array<{ roomId: string; reason: TriggerReason }>

  beforeEach(() => {
    adapter = createFakeAdapter()
    listener = new MoveOnTieListener({
      casinoAdapter: adapter,
      getCurrentFocusedRoomId: () => null,
      onMartinReset: vi.fn(),
    })
    emitted = []
    listener.onTrigger((roomId, reason) => emitted.push({ roomId, reason }))
  })

  describe("scope === 'auto'", () => {
    it("emits 'organic_tie' when result is T and no pending bet existed for room", () => {
      const disable = listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(emitted).toEqual([{ roomId: 'r1', reason: 'organic_tie' }])
      disable()
    })

    it("emits 'tie_hit' when result is T and listener was told a Tie bet was placed for that round", () => {
      listener.enable('auto')
      listener.notePendingBet('r1', { roundId: '1', betType: 'Tie' })
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(emitted).toEqual([{ roomId: 'r1', reason: 'tie_hit' }])
    })

    it("does NOT emit for non-Tie results", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'B' })
      adapter.fireResult({ roomId: 'r1', winner: 'P' })
      expect(emitted).toEqual([])
    })

    it("dedupes duplicate game-result events by (roomId, roundId)", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })
      expect(emitted).toHaveLength(1)
    })

    it("emits separately for different rounds in same room", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-2' })
      expect(emitted).toHaveLength(2)
    })

    it("does not emit after disable()", () => {
      const disable = listener.enable('auto')
      disable()
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(emitted).toEqual([])
    })

    it("emits 'martin_cap' via signalMartinCap", () => {
      listener.enable('auto')
      listener.signalMartinCap('r1')
      expect(emitted).toEqual([{ roomId: 'r1', reason: 'martin_cap' }])
    })

    it("calls onMartinReset on any T result (defensive level reset)", () => {
      const onMartinReset = vi.fn()
      const l = new MoveOnTieListener({ casinoAdapter: adapter, getCurrentFocusedRoomId: () => null, onMartinReset })
      l.onTrigger(() => {})
      l.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(onMartinReset).toHaveBeenCalledWith('r1')
    })
  })

  describe("scope === 'semiauto'", () => {
    it("only processes events for the currently focused room", () => {
      let focusedRoomId: string | null = 'r-focus'
      const l = new MoveOnTieListener({
        casinoAdapter: adapter,
        getCurrentFocusedRoomId: () => focusedRoomId,
        onMartinReset: vi.fn(),
      })
      const got: Array<{ roomId: string; reason: TriggerReason }> = []
      l.onTrigger((roomId, reason) => got.push({ roomId, reason }))
      l.enable('semiauto')

      adapter.fireResult({ roomId: 'r-other', winner: 'T', roundId: 'a' })
      expect(got).toEqual([])

      adapter.fireResult({ roomId: 'r-focus', winner: 'T', roundId: 'b' })
      expect(got).toEqual([{ roomId: 'r-focus', reason: 'organic_tie' }])

      // After focus changes, only the new focused room fires
      focusedRoomId = 'r-new-focus'
      adapter.fireResult({ roomId: 'r-focus', winner: 'T', roundId: 'c' })
      adapter.fireResult({ roomId: 'r-new-focus', winner: 'T', roundId: 'd' })
      expect(got).toEqual([
        { roomId: 'r-focus', reason: 'organic_tie' },
        { roomId: 'r-new-focus', reason: 'organic_tie' },
      ])
    })

    it("scope filter applies to signalMartinCap too", () => {
      let focusedRoomId: string | null = 'r1'
      const l = new MoveOnTieListener({
        casinoAdapter: adapter,
        getCurrentFocusedRoomId: () => focusedRoomId,
        onMartinReset: vi.fn(),
      })
      const got: Array<{ roomId: string; reason: TriggerReason }> = []
      l.onTrigger((roomId, reason) => got.push({ roomId, reason }))
      l.enable('semiauto')

      l.signalMartinCap('r-other')
      expect(got).toEqual([])

      l.signalMartinCap('r1')
      expect(got).toEqual([{ roomId: 'r1', reason: 'martin_cap' }])
    })
  })
})
```

- [ ] **Step 2: Run tests — should fail (file does not exist)**

Run: `npm run test:run -- MoveOnTieListener`
Expected: All cases fail with "Cannot find module './MoveOnTieListener'".

- [ ] **Step 3: Implement `MoveOnTieListener`**

Create `src/application/services/freshshoe/MoveOnTieListener.ts`:

```ts
// MoveOnTieListener — Fresh-Shoe Tie Martingale 프리셋의 "이동" 트리거 감지 서브시스템
// Clean Architecture: Application Layer
// 단일 책임: game-result 이벤트와 martin-cap 신호를 받아 적절한 TriggerReason으로 emit

import type { BetType } from '../../../domain/entities'

export type TriggerReason = 'tie_hit' | 'organic_tie' | 'martin_cap'
export type Scope = 'auto' | 'semiauto'

// 외부 의존성: casino adapter는 onGameResult(cb) → () => void 만 노출하면 됨
export interface IGameResultSource {
  onGameResult(cb: (event: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) => void): () => void
}

export interface MoveOnTieListenerDeps {
  casinoAdapter: IGameResultSource
  // semiauto 모드에서 현재 CDP 탭이 가리키는 방의 id를 돌려준다 (null이면 미집중)
  getCurrentFocusedRoomId: () => string | null
  // 결과가 'T'이거나 martin_cap일 때 마틴 레벨을 0으로 리셋하는 부수효과
  onMartinReset: (roomId: string) => void
}

type TriggerCallback = (roomId: string, reason: TriggerReason) => void

export class MoveOnTieListener {
  private callbacks: TriggerCallback[] = []
  private pendingBets: Map<string, { roundId: string; betType: BetType }> = new Map()
  private firedKeys: Set<string> = new Set()      // (roomId, roundId, reason) dedup keys
  private scope: Scope | null = null
  private unsubscribeAdapter: (() => void) | null = null

  constructor(private readonly deps: MoveOnTieListenerDeps) {}

  enable(scope: Scope): () => void {
    if (this.scope) {
      // 이미 활성: idempotent하게 처리하고 같은 disable handle 반환
      // (다른 scope이면 먼저 disable하는 것이 사용자의 책임)
    }
    this.scope = scope

    this.unsubscribeAdapter = this.deps.casinoAdapter.onGameResult((event) => {
      this.handleResult(event)
    })

    return () => this.disable()
  }

  disable(): void {
    this.unsubscribeAdapter?.()
    this.unsubscribeAdapter = null
    this.scope = null
    this.pendingBets.clear()
    this.firedKeys.clear()
  }

  onTrigger(cb: TriggerCallback): () => void {
    this.callbacks.push(cb)
    return () => {
      const i = this.callbacks.indexOf(cb)
      if (i >= 0) this.callbacks.splice(i, 1)
    }
  }

  // BettingDecisionService 또는 베팅 발사 경로가 호출: 어떤 베팅이 어떤 라운드에 들어갔는지 기록
  notePendingBet(roomId: string, info: { roundId: string; betType: BetType }): void {
    this.pendingBets.set(roomId, info)
  }

  // BettingDecisionService가 martin cap 도달을 알릴 때 호출
  signalMartinCap(roomId: string): void {
    if (!this.passesScope(roomId)) return
    this.deps.onMartinReset(roomId)
    this.emit(roomId, 'martin_cap', `cap:${roomId}:${Date.now()}`)
  }

  // === 내부 ===

  private handleResult(event: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }): void {
    if (!this.passesScope(event.roomId)) return
    if (event.winner !== 'T') {
      // T가 아니면 트리거 없음. pending은 유지 (다른 라운드에서 사용될 수 있음)
      return
    }

    const pending = this.pendingBets.get(event.roomId)
    const reason: TriggerReason =
      pending?.betType === 'Tie' && (event.roundId === undefined || event.roundId === pending.roundId)
        ? 'tie_hit'
        : 'organic_tie'

    this.deps.onMartinReset(event.roomId)
    const dedupKey = `${event.roomId}:${event.roundId ?? 'noround'}:${reason}`
    this.emit(event.roomId, reason, dedupKey)

    // 발사된 베팅 항목 정리
    this.pendingBets.delete(event.roomId)
  }

  private passesScope(roomId: string): boolean {
    if (this.scope === null) return false
    if (this.scope === 'auto') return true
    // semiauto: 현재 CDP focus된 방만
    return this.deps.getCurrentFocusedRoomId() === roomId
  }

  private emit(roomId: string, reason: TriggerReason, dedupKey: string): void {
    if (this.firedKeys.has(dedupKey)) return
    this.firedKeys.add(dedupKey)
    // 메모리 안정성: 너무 커지면 오래된 것 정리 (1000개 넘으면 가장 오래된 100개 제거)
    if (this.firedKeys.size > 1000) {
      const arr = Array.from(this.firedKeys)
      for (let i = 0; i < 100; i++) this.firedKeys.delete(arr[i])
    }
    this.callbacks.slice().forEach(cb => cb(roomId, reason))
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm run test:run -- MoveOnTieListener`
Expected: All cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/application/services/freshshoe/MoveOnTieListener.ts src/application/services/freshshoe/MoveOnTieListener.test.ts
git commit -m "feat(freshshoe): add MoveOnTieListener with scope filter and dedup"
```

---

### Task 8: Add martin-cap callback and stopped-rooms gate to `BettingDecisionService`

**Files:**
- Modify: `src/application/services/automode/BettingDecisionService.ts`
- Modify: `src/application/services/automode/BettingDecisionService.test.ts`

- [ ] **Step 1: Write failing tests for the two new behaviors**

Append to `BettingDecisionService.test.ts`:

```ts
describe('BettingDecisionService gates', () => {
  it('emits martin_cap callback when level reaches maxMartin', () => {
    const martin = new MartingaleManager(5)
    const onMartinCap = vi.fn()
    const svc = new BettingDecisionService(martin, new RestPeriodManager(), { onMartinCap })
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 5
    const d = svc.shouldBet('r1', prediction('B'), settings({ maxMartin: 5 }), ctx)
    expect(d.shouldBet).toBe(false)
    expect(onMartinCap).toHaveBeenCalledWith('r1')
  })

  it('does NOT emit martin_cap callback when level is below cap', () => {
    const onMartinCap = vi.fn()
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager(), { onMartinCap })
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 3
    svc.shouldBet('r1', prediction('B'), settings({ maxMartin: 5 }), ctx)
    expect(onMartinCap).not.toHaveBeenCalled()
  })

  it('blocks bet when stoppedRoomsChecker returns true', () => {
    const stoppedRoomsChecker = vi.fn((roomId: string) => roomId === 'r-stopped')
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager(), { stoppedRoomsChecker })
    const d = svc.shouldBet('r-stopped', prediction('B'), settings(), createRoomContext('r-stopped', 'Room'))
    expect(d.shouldBet).toBe(false)
    expect(d.skipReason).toBe('Fresh-shoe 종료')
  })

  it('allows bet when stoppedRoomsChecker returns false', () => {
    const stoppedRoomsChecker = vi.fn(() => false)
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager(), { stoppedRoomsChecker })
    const d = svc.shouldBet('r1', prediction('B'), settings(), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
  })

  it('does not require gates option (backwards compatible)', () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const d = svc.shouldBet('r1', prediction('B'), settings(), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm run test:run -- BettingDecisionService`
Expected: New cases fail because the constructor does not accept the gates option.

- [ ] **Step 3: Implement the gates option**

In `BettingDecisionService.ts`:

Replace the constructor and add fields:

```ts
export interface BettingDecisionGates {
  // Fresh-Shoe 프리셋이 STOPPED 마킹한 방을 차단하는 게이트 (true 반환 시 차단)
  stoppedRoomsChecker?: (roomId: string) => boolean
  // 마틴 한도 도달 시 호출 (MoveOnTieListener.signalMartinCap에 연결)
  onMartinCap?: (roomId: string) => void
}

export class BettingDecisionService implements IBettingDecisionService {
  private martingaleManager: IMartingaleManager
  private gates: BettingDecisionGates

  constructor(
    martingaleManager: IMartingaleManager,
    _restPeriodManager: IRestPeriodManager,
    gates: BettingDecisionGates = {}
  ) {
    this.martingaleManager = martingaleManager
    this.gates = gates
  }
```

Inside `shouldBet`, just after step 3 (휴식 중인지 확인), insert:

```ts
    // 3.5. Fresh-Shoe 프리셋의 STOPPED 게이트
    if (this.gates.stoppedRoomsChecker?.(roomId)) {
      return { shouldBet: false, skipReason: 'Fresh-shoe 종료' }
    }
```

Inside the existing step 6 (마틴 레벨 확인) block, before the `return { shouldBet: false, skipReason: ... }`, fire the callback:

```ts
    // 6. 마틴 레벨 확인
    const currentLevel = ctx.martingale.level
    if (currentLevel >= settings.maxMartin) {
      this.gates.onMartinCap?.(roomId)
      return { shouldBet: false, skipReason: `최대 마틴 도달 (${currentLevel}M)` }
    }
```

Update the factory `createBettingDecisionService` to accept the optional gates parameter:

```ts
export function createBettingDecisionService(
  martingaleManager: IMartingaleManager,
  restPeriodManager: IRestPeriodManager,
  gates: BettingDecisionGates = {}
): BettingDecisionService {
  return new BettingDecisionService(martingaleManager, restPeriodManager, gates)
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm run test:run -- BettingDecisionService`
Expected: All pass, including older tests.

- [ ] **Step 5: Commit**

```bash
git add src/application/services/automode/BettingDecisionService.ts src/application/services/automode/BettingDecisionService.test.ts
git commit -m "feat(automode): add stoppedRoomsChecker gate and onMartinCap callback to BettingDecisionService"
```

---

### Task 9: Create `FreshShoeTieMartingalePreset`

**Files:**
- Create: `src/application/services/freshshoe/FreshShoeTieMartingalePreset.ts`
- Create: `src/application/services/freshshoe/FreshShoeTieMartingalePreset.test.ts`
- Create: `src/application/services/freshshoe/index.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/application/services/freshshoe/FreshShoeTieMartingalePreset.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FreshShoeTieMartingalePreset } from './FreshShoeTieMartingalePreset'

function createFakeRoomFilterService() {
  const active = new Set<string>()
  return {
    toggleFilter: vi.fn((t: string) => { active.has(t) ? active.delete(t) : active.add(t) }),
    getActiveFilters: () => Array.from(active),
    has(t: string) { return active.has(t) },
  }
}

function createFakeSettings() {
  const settings: any = { forceBetDirection: 'auto' }
  return {
    get: () => ({ ...settings }),
    update: (patch: any) => { Object.assign(settings, patch) },
  }
}

function createFakeListener() {
  let scope: 'auto' | 'semiauto' | null = null
  const triggerCallbacks: any[] = []
  return {
    enable: vi.fn((s: 'auto' | 'semiauto') => {
      scope = s
      return () => { scope = null }
    }),
    onTrigger: vi.fn((cb: any) => { triggerCallbacks.push(cb); return () => {} }),
    getScope: () => scope,
    fireTrigger: (roomId: string, reason: string) => triggerCallbacks.forEach(cb => cb(roomId, reason)),
    notePendingBet: vi.fn(),
    signalMartinCap: vi.fn(),
  }
}

function createFakeAdapter() {
  const shoeChangeCbs: any[] = []
  return {
    onShoeChange(cb: any) { shoeChangeCbs.push(cb); return () => {} },
    fireShoeChange(roomId: string) { shoeChangeCbs.forEach(cb => cb(roomId, `room-${roomId}`)) },
  }
}

function createPreset(overrides: any = {}) {
  return new FreshShoeTieMartingalePreset({
    filterService: overrides.filterService ?? createFakeRoomFilterService(),
    settingsBridge: overrides.settingsBridge ?? { auto: createFakeSettings(), semiauto: createFakeSettings() },
    listener: overrides.listener ?? createFakeListener(),
    casinoAdapter: overrides.casinoAdapter ?? createFakeAdapter(),
    storage: overrides.storage ?? createFakeStorage(),
    semiAutoTriggerHandler: overrides.semiAutoTriggerHandler ?? vi.fn().mockResolvedValue(undefined),
    onMartinReset: overrides.onMartinReset ?? vi.fn(),
  })
}

function createFakeStorage() {
  let data: string | null = null
  return {
    get: () => data,
    set: (v: string) => { data = v },
    remove: () => { data = null },
  }
}

describe('FreshShoeTieMartingalePreset', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('enable("auto") activates fresh_shoe filter, sets forceBetDirection, enables listener', () => {
    const filterService = createFakeRoomFilterService()
    const settingsBridge = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener = createFakeListener()
    const p = createPreset({ filterService, settingsBridge, listener })

    p.enable('auto')

    expect(filterService.has('fresh_shoe')).toBe(true)
    expect(settingsBridge.auto.get().forceBetDirection).toBe('tie_only')
    expect(listener.enable).toHaveBeenCalledWith('auto')
    expect(p.isEnabled('auto')).toBe(true)
    expect(p.isEnabled('semiauto')).toBe(false)
  })

  it('disable("auto") restores filter / setting / listener state', () => {
    const filterService = createFakeRoomFilterService()
    const settingsBridge = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener = createFakeListener()
    const p = createPreset({ filterService, settingsBridge, listener })

    p.enable('auto')
    p.disable('auto')

    expect(filterService.has('fresh_shoe')).toBe(false)
    expect(settingsBridge.auto.get().forceBetDirection).toBe('auto')
    expect(listener.getScope()).toBeNull()
    expect(p.isEnabled('auto')).toBe(false)
  })

  it('persists enabled state to storage and auto-restores on construction', () => {
    const storage = createFakeStorage()
    const p1 = createPreset({ storage })
    p1.enable('auto')
    p1.enable('semiauto')

    // New instance reads storage on construction
    const filterService2 = createFakeRoomFilterService()
    const settingsBridge2 = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener2 = createFakeListener()
    const p2 = createPreset({ storage, filterService: filterService2, settingsBridge: settingsBridge2, listener: listener2 })

    expect(p2.isEnabled('auto')).toBe(true)
    expect(p2.isEnabled('semiauto')).toBe(true)
    expect(filterService2.has('fresh_shoe')).toBe(true)
  })

  it('isRoomStopped tracks rooms by mode', () => {
    const p = createPreset()
    p.enable('auto')
    expect(p.isRoomStopped('r1')).toBe(false)
    p['markRoomStopped']('r1')
    expect(p.isRoomStopped('r1')).toBe(true)
  })

  it('clears STOPPED set on onShoeChange', () => {
    const adapter = createFakeAdapter()
    const p = createPreset({ casinoAdapter: adapter })
    p.enable('auto')
    p['markRoomStopped']('r1')
    expect(p.isRoomStopped('r1')).toBe(true)
    adapter.fireShoeChange('r1')
    expect(p.isRoomStopped('r1')).toBe(false)
  })

  it('listener trigger in auto mode marks room as stopped', () => {
    const listener = createFakeListener()
    const p = createPreset({ listener })
    p.enable('auto')
    listener.fireTrigger('r1', 'tie_hit')
    expect(p.isRoomStopped('r1')).toBe(true)
  })

  it('listener trigger in semiauto mode invokes semiAutoTriggerHandler', () => {
    const listener = createFakeListener()
    const semiAutoTriggerHandler = vi.fn().mockResolvedValue(undefined)
    const p = createPreset({ listener, semiAutoTriggerHandler })
    p.enable('semiauto')
    listener.fireTrigger('r1', 'organic_tie')
    expect(semiAutoTriggerHandler).toHaveBeenCalledWith('r1', 'organic_tie')
    // In semiauto mode, the STOPPED set is NOT used (handler decides navigation)
    expect(p.isRoomStopped('r1')).toBe(false)
  })

  it('disable rolls back even if listener.enable throws after filter is set', () => {
    const filterService = createFakeRoomFilterService()
    const settingsBridge = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener = {
      ...createFakeListener(),
      enable: vi.fn(() => { throw new Error('listener boom') }),
    } as any
    const p = createPreset({ filterService, settingsBridge, listener })

    expect(() => p.enable('auto')).toThrow('listener boom')
    // Rollback: filter and setting must be back to pre-call state
    expect(filterService.has('fresh_shoe')).toBe(false)
    expect(settingsBridge.auto.get().forceBetDirection).toBe('auto')
    expect(p.isEnabled('auto')).toBe(false)
  })

  it("getDescription returns a non-empty Korean help string", () => {
    const p = createPreset()
    const s = p.getDescription()
    expect(s.length).toBeGreaterThan(20)
    expect(s).toMatch(/fresh|슈|Tie|마틴/i)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm run test:run -- FreshShoeTieMartingalePreset`
Expected: All cases fail because the file does not exist yet.

- [ ] **Step 3: Implement `FreshShoeTieMartingalePreset.ts`**

Create `src/application/services/freshshoe/FreshShoeTieMartingalePreset.ts`:

```ts
// FreshShoeTieMartingalePreset — 단일 토글로 4개 부품(필터/방향/리스너/STOPPED 게이트)을 atomic하게 활성/비활성
// Clean Architecture: Application Layer
// 단일 책임: orchestration. 자체 베팅 상태는 보유하지 않음.

import type { TriggerReason, MoveOnTieListener } from './MoveOnTieListener'

export type Mode = 'auto' | 'semiauto'

// 최소한의 인터페이스만 의존 (테스트 용이성)
export interface IFilterService {
  toggleFilter(type: 'fresh_shoe'): void
  getActiveFilters(): string[]
}

export interface ISettingsBridge {
  get(): { forceBetDirection?: 'auto' | 'tie_only' }
  update(patch: { forceBetDirection: 'auto' | 'tie_only' }): void
}

export interface IShoeChangeSource {
  onShoeChange(cb: (roomId: string, koreanName: string) => void): () => void
}

export interface IPresetStorage {
  get(): string | null
  set(value: string): void
  remove(): void
}

export interface PresetDeps {
  filterService: IFilterService
  settingsBridge: { auto: ISettingsBridge; semiauto: ISettingsBridge }
  listener: Pick<MoveOnTieListener, 'enable' | 'disable' | 'onTrigger' | 'notePendingBet' | 'signalMartinCap'>
  casinoAdapter: IShoeChangeSource
  storage: IPresetStorage
  semiAutoTriggerHandler: (roomId: string, reason: TriggerReason) => Promise<void>
  onMartinReset?: (roomId: string) => void
}

interface PersistedState {
  enabledForAuto: boolean
  enabledForSemiAuto: boolean
}

interface Snapshot {
  filterWasActive: boolean
  prevForceBetDirection: 'auto' | 'tie_only'
  unsubscribeListener: (() => void) | null
  unsubscribeShoeChange: (() => void) | null
  unsubscribeTrigger: (() => void) | null
}

const STORAGE_DEFAULT: PersistedState = { enabledForAuto: false, enabledForSemiAuto: false }

export class FreshShoeTieMartingalePreset {
  private state: PersistedState = { ...STORAGE_DEFAULT }
  private snapshots: Partial<Record<Mode, Snapshot>> = {}
  private stoppedRooms: Set<string> = new Set()
  private activeMode: Mode | null = null  // 현재 listener가 어느 모드로 enable되어 있는지

  constructor(private readonly deps: PresetDeps) {
    this.loadFromStorage()
    // 부팅 시 복원
    if (this.state.enabledForAuto) {
      try { this.applyEnable('auto') } catch (e) { console.error('[FreshShoeTieMartingalePreset] auto restore failed', e) }
    }
    if (this.state.enabledForSemiAuto) {
      try { this.applyEnable('semiauto') } catch (e) { console.error('[FreshShoeTieMartingalePreset] semiauto restore failed', e) }
    }
  }

  isEnabled(mode: Mode): boolean {
    return mode === 'auto' ? this.state.enabledForAuto : this.state.enabledForSemiAuto
  }

  isRoomStopped(roomId: string): boolean {
    return this.stoppedRooms.has(roomId)
  }

  getDescription(): string {
    return (
      '슈가 막 시작된 방에서만 베팅 (Evolution 슈 리셋 감지 기반). ' +
      'Tie에 마틴 (기존 설정 금액·마틴 한도 재사용). ' +
      '적중 / 관망 중 Tie 출현 / 마틴 한도 도달 → 자동으로 다음 fresh-shoe 방으로 이동.'
    )
  }

  enable(mode: Mode): void {
    if (this.isEnabled(mode)) return
    this.applyEnable(mode)
    if (mode === 'auto') this.state.enabledForAuto = true
    else this.state.enabledForSemiAuto = true
    this.saveToStorage()
  }

  disable(mode: Mode): void {
    if (!this.isEnabled(mode)) return
    this.applyDisable(mode)
    if (mode === 'auto') this.state.enabledForAuto = false
    else this.state.enabledForSemiAuto = false
    this.saveToStorage()
  }

  // === 내부 ===

  private applyEnable(mode: Mode): void {
    const bridge = mode === 'auto' ? this.deps.settingsBridge.auto : this.deps.settingsBridge.semiauto
    const filterWasActive = this.deps.filterService.getActiveFilters().includes('fresh_shoe')
    const prevForceBetDirection = bridge.get().forceBetDirection ?? 'auto'

    const snap: Snapshot = {
      filterWasActive,
      prevForceBetDirection,
      unsubscribeListener: null,
      unsubscribeShoeChange: null,
      unsubscribeTrigger: null,
    }

    try {
      // 1. fresh_shoe 필터 활성
      if (!filterWasActive) this.deps.filterService.toggleFilter('fresh_shoe')

      // 2. forceBetDirection='tie_only'
      bridge.update({ forceBetDirection: 'tie_only' })

      // 3. listener 활성 (다른 모드와 공존하지 않고, 가장 최근 enable이 활성 scope)
      snap.unsubscribeListener = this.deps.listener.enable(mode)
      this.activeMode = mode

      // 4. listener 트리거 콜백 연결 (모드별 분기)
      snap.unsubscribeTrigger = this.deps.listener.onTrigger((roomId, reason) => {
        if (mode === 'auto') {
          this.markRoomStopped(roomId)
        } else {
          void this.deps.semiAutoTriggerHandler(roomId, reason)
        }
      })

      // 5. shoe-change 구독 (auto 모드에서 STOPPED 해제용)
      if (mode === 'auto') {
        snap.unsubscribeShoeChange = this.deps.casinoAdapter.onShoeChange((roomId) => {
          this.stoppedRooms.delete(roomId)
        })
      }

      this.snapshots[mode] = snap
    } catch (err) {
      // rollback
      snap.unsubscribeTrigger?.()
      snap.unsubscribeShoeChange?.()
      snap.unsubscribeListener?.()
      bridge.update({ forceBetDirection: prevForceBetDirection })
      if (!filterWasActive && this.deps.filterService.getActiveFilters().includes('fresh_shoe')) {
        this.deps.filterService.toggleFilter('fresh_shoe')
      }
      this.activeMode = null
      throw err
    }
  }

  private applyDisable(mode: Mode): void {
    const snap = this.snapshots[mode]
    if (!snap) return
    snap.unsubscribeTrigger?.()
    snap.unsubscribeShoeChange?.()
    snap.unsubscribeListener?.()
    const bridge = mode === 'auto' ? this.deps.settingsBridge.auto : this.deps.settingsBridge.semiauto
    bridge.update({ forceBetDirection: snap.prevForceBetDirection })
    if (!snap.filterWasActive && this.deps.filterService.getActiveFilters().includes('fresh_shoe')) {
      this.deps.filterService.toggleFilter('fresh_shoe')
    }
    delete this.snapshots[mode]
    if (this.activeMode === mode) this.activeMode = null
    if (mode === 'auto') this.stoppedRooms.clear()
  }

  private markRoomStopped(roomId: string): void {
    this.stoppedRooms.add(roomId)
  }

  private loadFromStorage(): void {
    try {
      const raw = this.deps.storage.get()
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      this.state = {
        enabledForAuto: !!parsed.enabledForAuto,
        enabledForSemiAuto: !!parsed.enabledForSemiAuto,
      }
    } catch {
      this.state = { ...STORAGE_DEFAULT }
    }
  }

  private saveToStorage(): void {
    try {
      this.deps.storage.set(JSON.stringify(this.state))
    } catch {
      // ignore (best-effort persistence)
    }
  }
}
```

- [ ] **Step 4: Create the barrel export**

Create `src/application/services/freshshoe/index.ts`:

```ts
export { MoveOnTieListener } from './MoveOnTieListener'
export type { TriggerReason, Scope } from './MoveOnTieListener'
export { FreshShoeTieMartingalePreset } from './FreshShoeTieMartingalePreset'
export type { Mode } from './FreshShoeTieMartingalePreset'
```

- [ ] **Step 5: Run tests to confirm pass**

Run: `npm run test:run -- FreshShoeTieMartingalePreset`
Expected: All 9 cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/freshshoe/
git commit -m "feat(freshshoe): add FreshShoeTieMartingalePreset with atomic enable/disable + persistence"
```

---

### Task 10: Extend `SemiAutoService` with `handlePresetTrigger`, expose `getCurrentRoomId`, allow Tie betType in log

**Files:**
- Modify: `src/application/services/SemiAutoService.ts`
- Modify: `src/application/services/SemiAutoService.test.ts` (append if exists; create new describe block)

- [ ] **Step 1: Write failing tests**

Append to `SemiAutoService.test.ts` a new describe block (if SemiAutoService.test.ts is missing necessary scaffolding, mirror the existing `RoomFilterService.test.ts` pattern of creating minimal fakes):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SemiAutoService } from './SemiAutoService'
// Note: SemiAutoService is exported as a singleton instance. The new describe block tests methods on it.

describe('SemiAutoService preset trigger', () => {
  beforeEach(() => {
    // Reset between tests if the singleton has a reset
    if (typeof (SemiAutoService as any).resetForTest === 'function') {
      ;(SemiAutoService as any).resetForTest()
    }
  })

  it('exposes getCurrentRoomId', () => {
    expect(typeof SemiAutoService.getCurrentRoomId).toBe('function')
  })

  it("handlePresetTrigger with no candidates does not call navigateToRoom", async () => {
    const navigateSpy = vi.spyOn(SemiAutoService, 'navigateToRoom' as any).mockResolvedValue(undefined)
    ;(SemiAutoService as any).__testSetCandidatesProvider?.(() => [])  // No fresh-shoe rooms

    await SemiAutoService.handlePresetTrigger('current', 'tie_hit')

    expect(navigateSpy).not.toHaveBeenCalled()
    navigateSpy.mockRestore()
  })

  it("handlePresetTrigger with candidates navigates to first candidate that is not the current room", async () => {
    const candidates = [
      { id: 'current', name: 'Current', koreanName: '현재', history: [], gameCount: 0 } as any,
      { id: 'other', name: 'Other', koreanName: '다음', history: [], gameCount: 0 } as any,
    ]
    ;(SemiAutoService as any).__testSetCandidatesProvider?.(() => candidates)

    const navigateSpy = vi.spyOn(SemiAutoService, 'navigateToRoom' as any).mockResolvedValue(undefined)

    await SemiAutoService.handlePresetTrigger('current', 'organic_tie')

    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect((navigateSpy.mock.calls[0][0] as any).id).toBe('other')
    navigateSpy.mockRestore()
  })
})
```

Tests that depend on internal hooks should use `__testSetCandidatesProvider`. The implementation adds this hook.

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm run test:run -- SemiAutoService`
Expected: New cases fail.

- [ ] **Step 3: Implement the new methods**

In `src/application/services/SemiAutoService.ts`:

(a) Locate the existing `BetLogEvent` interface (~line 92) and extend its `betType`:

```ts
export interface BetLogEvent {
  type: 'placed' | 'result'
  roomId: string
  roomName: string
  betType: 'Banker' | 'Player' | 'Tie'    // Tie 추가
  amount: number
  won?: boolean
  profit?: number
  martinLevel: number
  timestamp: number
}
```

(b) Inside the `SemiAutoServiceImpl` class, add three new methods (place them next to `navigateToRoom`):

```ts
  getCurrentRoomId(): string | null {
    return this.internalState.currentRoomId
  }

  // 테스트용 훅 (production에서는 RoomFilterService 사용)
  private candidatesProvider: (() => any[]) | null = null
  __testSetCandidatesProvider(provider: () => any[]): void {
    this.candidatesProvider = provider
  }

  async handlePresetTrigger(currentRoomId: string, reason: import('./freshshoe').TriggerReason): Promise<void> {
    // 1) 마틴 레벨 리셋 (Idempotent — listener도 호출하지만 안전)
    // (SemiAuto가 자체 마틴 상태를 보유하면 reset; 그렇지 않으면 외부 MartingaleManager에 위임됨)

    // 2) 후보 방 산출
    const provider = this.candidatesProvider
    const candidates: any[] = provider ? provider() : await this.collectFreshShoeCandidates()
    const next = candidates.find(r => r && r.id !== currentRoomId)

    // 3) 후보 없으면 그대로 대기 (다음 멀티소켓 이벤트에서 재평가)
    if (!next) {
      console.log('[SemiAuto] handlePresetTrigger: no fresh-shoe candidate, staying', { currentRoomId, reason })
      return
    }

    // 4) CDP navigate
    await this.navigateToRoom(next)
  }

  // RoomFilterService를 통해 fresh_shoe 조건을 만족하는 방을 찾는다
  private async collectFreshShoeCandidates(): Promise<any[]> {
    // 실제 구현: container에서 RoomFilterService와 multi-room 상태를 가져와 filterRooms() 호출
    // 현재 SemiAuto가 보유한 watch-list와 prediction-state Map을 사용.
    // 자세한 와이어링은 Task 11 (DI 등록)에서 마무리되며, 여기서는 빈 배열을 안전 기본값으로 둔다.
    return []
  }
```

(c) Export `SemiAutoService` singleton as before; no signature change to existing exports.

- [ ] **Step 4: Add a resetForTest hook (only if SemiAutoService is a long-lived singleton being tested)**

If the test file needs it, add at the bottom of `SemiAutoServiceImpl`:

```ts
  // Test-only: reset minimal state between unit tests
  resetForTest(): void {
    this.candidatesProvider = null
    this.internalState.currentRoomId = null
    this.internalState.currentRoomName = null
  }
```

And expose it via the singleton.

- [ ] **Step 5: Run tests to confirm pass**

Run: `npm run test:run -- SemiAutoService`
Expected: New cases pass; existing tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/SemiAutoService.ts src/application/services/SemiAutoService.test.ts
git commit -m "feat(semiauto): add handlePresetTrigger + getCurrentRoomId; allow Tie in bet log"
```

---

### Task 11: Wire everything in DI container

**Files:**
- Modify: `src/application/di/setupContainer.ts`

- [ ] **Step 1: Inspect the existing container setup**

Open `src/application/di/setupContainer.ts` and identify the existing `RoomFilterService`, `BettingDecisionService`, `casinoAdapter` (Evolution + Pragmatic), and any auto/semi-auto wiring.

- [ ] **Step 2: Build dependencies for the listener and preset**

Add after the existing `BettingDecisionService` setup:

```ts
import { MoveOnTieListener, FreshShoeTieMartingalePreset } from '../services/freshshoe'
import { SemiAutoService } from '../services/SemiAutoService'
import { RoomFilterService } from '../services/RoomFilterService'

// MoveOnTieListener — uses Evolution adapter as the result source
const moveOnTieListener = new MoveOnTieListener({
  casinoAdapter: {
    onGameResult(cb) {
      // Adapter.onGameResult must yield events shaped { roomId, winner, roundId? }
      return evolutionAdapter.onGameResult((event: any) => {
        cb({
          roomId: event.roomId,
          winner: event.winner,
          roundId: event.roundId ?? event.gameId,
        })
      })
    },
  },
  getCurrentFocusedRoomId: () => SemiAutoService.getCurrentRoomId(),
  onMartinReset: (roomId: string) => martingaleManager.resetLevel(roomId),
})

// Re-construct BettingDecisionService with martin-cap callback
const bettingDecisionService = new BettingDecisionService(
  martingaleManager,
  restPeriodManager,
  {
    stoppedRoomsChecker: (roomId: string) => preset.isRoomStopped(roomId),
    onMartinCap: (roomId: string) => moveOnTieListener.signalMartinCap(roomId),
  },
)

// Preset — coordinates the four blocks
const preset = new FreshShoeTieMartingalePreset({
  filterService: RoomFilterService,
  settingsBridge: {
    auto: {
      get: () => autoModeSettingsManager.get(),
      update: (patch) => autoModeSettingsManager.update(patch),
    },
    semiauto: {
      get: () => semiAutoSettingsManager.get(),
      update: (patch) => semiAutoSettingsManager.update(patch),
    },
  },
  listener: moveOnTieListener,
  casinoAdapter: {
    onShoeChange: (cb) => evolutionAdapter.onShoeChange(cb),
  },
  storage: {
    get: () => window.localStorage.getItem('bcr-freshshoe-preset'),
    set: (v) => window.localStorage.setItem('bcr-freshshoe-preset', v),
    remove: () => window.localStorage.removeItem('bcr-freshshoe-preset'),
  },
  semiAutoTriggerHandler: (roomId, reason) => SemiAutoService.handlePresetTrigger(roomId, reason),
  onMartinReset: (roomId: string) => martingaleManager.resetLevel(roomId),
})

container.register('moveOnTieListener', () => moveOnTieListener)
container.register('freshShoePreset', () => preset)
```

**Note:** the exact `register()` calls must follow the project's existing DI conventions. Look at how `BettingDecisionService` is currently registered and mirror that pattern. If existing DI uses singletons, use singletons.

There is a circular dependency between `bettingDecisionService.stoppedRoomsChecker` and the `preset`. Resolve it by:

1. Construct `bettingDecisionService` with a placeholder `stoppedRoomsChecker: () => false`.
2. Construct `preset`.
3. After preset is constructed, call `bettingDecisionService.setStoppedRoomsChecker((id) => preset.isRoomStopped(id))`.

To support this, add a setter to `BettingDecisionService`:

```ts
// In BettingDecisionService.ts
setStoppedRoomsChecker(checker: (roomId: string) => boolean): void {
  this.gates.stoppedRoomsChecker = checker
}
setOnMartinCap(cb: (roomId: string) => void): void {
  this.gates.onMartinCap = cb
}
```

Then the DI block becomes:

```ts
const bettingDecisionService = new BettingDecisionService(martingaleManager, restPeriodManager, {})
const moveOnTieListener = new MoveOnTieListener({ /* as above */ })
const preset = new FreshShoeTieMartingalePreset({ /* as above */ })
bettingDecisionService.setStoppedRoomsChecker((id) => preset.isRoomStopped(id))
bettingDecisionService.setOnMartinCap((id) => moveOnTieListener.signalMartinCap(id))
```

- [ ] **Step 3: Add the setter methods to `BettingDecisionService`**

In `BettingDecisionService.ts`, inside the class:

```ts
setStoppedRoomsChecker(checker: (roomId: string) => boolean): void {
  this.gates.stoppedRoomsChecker = checker
}

setOnMartinCap(cb: (roomId: string) => void): void {
  this.gates.onMartinCap = cb
}
```

- [ ] **Step 4: Wire `notePendingBet` to bet placement**

Locate where bets are actually sent (likely in `AutoBettingService` or the orchestrator's place-bet flow). When a bet is sent in `'tie_only'` mode for a given round, call:

```ts
moveOnTieListener.notePendingBet(roomId, { roundId: currentRoundId, betType: 'Tie' })
```

Use whatever local variable holds the round identifier (`gameId`, `roundId`, or a derived index from `roomHistory.length`). If no per-round id is available, pass an empty string and rely on the (roomId, reason) dedup.

- [ ] **Step 5: Typecheck and run full test suite**

Run: `npm run build`
Expected: 0 errors.

Run: `npm run test:run`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/application/di/setupContainer.ts src/application/services/automode/BettingDecisionService.ts
git commit -m "feat(di): wire MoveOnTieListener and FreshShoeTieMartingalePreset into container"
```

---

## Phase 3 — UI

### Task 12: Add `freshShoeMaxGameNumber` input to `FilterThresholdInputs`

**Files:**
- Modify: `src/presentation/components/AutoModePanel/components/FilterThresholdInputs.tsx`

- [ ] **Step 1: Modify the component**

Replace the file with:

```tsx
// FilterThresholdInputs - Inline UI for adjusting tie_drought / fresh_room / fresh_shoe N values
// Lives inside the filter dropdown of both AutoMode and PredictMode panels.

import { useEffect, useState } from 'react'
import FilterThresholdsService from '../../../../application/services/FilterThresholdsService'
import './FilterThresholdInputs.css'

type Key = 'tieDroughtThreshold' | 'freshRoomGames' | 'freshShoeMaxGameNumber'

export default function FilterThresholdInputs() {
  const [values, setValues] = useState(FilterThresholdsService.get())

  useEffect(() => FilterThresholdsService.onChange(setValues), [])

  const update = (key: Key, raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    FilterThresholdsService.set({ [key]: n })
  }

  return (
    <div className="filter-threshold-inputs" onClick={(e) => e.stopPropagation()}>
      <div className="filter-threshold-inputs__title">필터 임계값 설정</div>
      <label className="filter-threshold-inputs__row">
        <span className="filter-threshold-inputs__label">Tie 미발생 임계</span>
        <input
          className="filter-threshold-inputs__input"
          type="number"
          min={1}
          max={200}
          value={values.tieDroughtThreshold}
          onChange={(e) => update('tieDroughtThreshold', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="filter-threshold-inputs__suffix">게임</span>
      </label>
      <label className="filter-threshold-inputs__row">
        <span className="filter-threshold-inputs__label">신규 방 기준</span>
        <input
          className="filter-threshold-inputs__input"
          type="number"
          min={1}
          max={200}
          value={values.freshRoomGames}
          onChange={(e) => update('freshRoomGames', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="filter-threshold-inputs__suffix">게임</span>
      </label>
      <label className="filter-threshold-inputs__row">
        <span className="filter-threshold-inputs__label">Fresh Shoe 기준</span>
        <input
          className="filter-threshold-inputs__input"
          type="number"
          min={1}
          max={200}
          value={values.freshShoeMaxGameNumber}
          onChange={(e) => update('freshShoeMaxGameNumber', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="filter-threshold-inputs__suffix">게임</span>
      </label>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/AutoModePanel/components/FilterThresholdInputs.tsx
git commit -m "feat(ui): add freshShoeMaxGameNumber input to FilterThresholdInputs"
```

---

### Task 13: Add preset toggle + help block to `AutoModeSettingsDialog`

**Files:**
- Modify: `src/presentation/components/AutoModePanel/AutoModeSettingsDialog.tsx`

- [ ] **Step 1: Locate the dialog and add the toggle**

Open `AutoModeSettingsDialog.tsx`. Find the section that renders strategy/martin controls. Just above that section, add:

```tsx
{/* Fresh-Shoe Tie 마틴 프리셋 토글 */}
<div style={{
  border: '1px solid var(--color-border, #444)',
  borderRadius: 8,
  padding: 12,
  margin: '12px 0',
  background: 'var(--color-surface-2, #1c1c1c)',
}}>
  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
    <input
      type="checkbox"
      checked={freshShoePreset.isEnabled('auto')}
      onChange={(e) => {
        if (e.target.checked) freshShoePreset.enable('auto')
        else freshShoePreset.disable('auto')
        // re-render the dialog
        setForceRerender(v => v + 1)
      }}
    />
    Fresh-Shoe Tie 마틴
  </label>
  <div style={{ fontSize: 12, color: 'var(--color-text-dim, #999)', marginTop: 6, lineHeight: 1.5 }}>
    {freshShoePreset.getDescription()}
  </div>
</div>
```

Import the preset from the DI container near the top of the file:

```tsx
import { container } from '../../../application/di'
const freshShoePreset = container.resolve<FreshShoeTieMartingalePreset>('freshShoePreset')
import type { FreshShoeTieMartingalePreset } from '../../../application/services/freshshoe'
```

(Adjust the import path/style to match the project's existing DI usage. If `container.resolve` is not the actual API, use the existing pattern.)

Add a local re-render trigger to refresh after toggling (since the preset's `isEnabled` is read directly, the component must re-render):

```tsx
const [, setForceRerender] = useState(0)
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/AutoModePanel/AutoModeSettingsDialog.tsx
git commit -m "feat(ui): add Fresh-Shoe Tie 마틴 toggle to AutoModeSettingsDialog"
```

---

### Task 14: Add preset toggle + help block to `SemiAutoSettingsDialog`

**Files:**
- Modify: `src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx`

- [ ] **Step 1: Mirror Task 13 with `mode='semiauto'`**

Use the same toggle/markup as Task 13 but call `freshShoePreset.enable('semiauto')` / `freshShoePreset.disable('semiauto')` and read `freshShoePreset.isEnabled('semiauto')`.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/SemiAutoPanel/components/SemiAutoSettingsDialog.tsx
git commit -m "feat(ui): add Fresh-Shoe Tie 마틴 toggle to SemiAutoSettingsDialog"
```

---

## Phase 4 — Integration tests

### Task 15: Auto-mode integration test (preset on)

**Files:**
- Create: `src/application/services/freshshoe/__integration__/freshShoeAutoFlow.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MoveOnTieListener } from '../MoveOnTieListener'
import { FreshShoeTieMartingalePreset } from '../FreshShoeTieMartingalePreset'
import { BettingDecisionService } from '../../automode/BettingDecisionService'
import { MartingaleManager } from '../../automode/MartingaleManager'
import { RestPeriodManager } from '../../automode/RestPeriodManager'
import { DEFAULT_SETTINGS, createRoomContext } from '../../automode/types'
import type { Prediction } from '../../../../domain/entities'

function makeAdapter() {
  const result: any[] = []
  const shoe: any[] = []
  return {
    onGameResult(cb: any) { result.push(cb); return () => {} },
    onShoeChange(cb: any) { shoe.push(cb); return () => {} },
    emitResult(e: any) { result.forEach(cb => cb(e)) },
    emitShoeChange(roomId: string) { shoe.forEach(cb => cb(roomId, `room-${roomId}`)) },
  }
}

function makeFilter() {
  const active = new Set<string>()
  return {
    toggleFilter(t: string) { active.has(t) ? active.delete(t) : active.add(t) },
    getActiveFilters() { return Array.from(active) },
  }
}

function makeStorage() {
  let v: string | null = null
  return { get: () => v, set: (s: string) => { v = s }, remove: () => { v = null } }
}

function pred(p: 'B' | 'P' | 'T' | null): Prediction {
  return { roomId: 'r1', prediction: p, confidence: 0.9, isSkip: false, timestamp: Date.now() } as Prediction
}

describe('Fresh-Shoe Tie Martingale — Auto mode end-to-end', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let filter: ReturnType<typeof makeFilter>
  let listener: MoveOnTieListener
  let martin: MartingaleManager
  let svc: BettingDecisionService
  let preset: FreshShoeTieMartingalePreset
  let autoSettings: any
  let semiAutoSettings: any

  beforeEach(() => {
    adapter = makeAdapter()
    filter = makeFilter()
    autoSettings = { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false, maxMartin: 3 }
    semiAutoSettings = { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false }
    martin = new MartingaleManager(3)
    listener = new MoveOnTieListener({
      casinoAdapter: adapter as any,
      getCurrentFocusedRoomId: () => null,
      onMartinReset: (id) => martin.resetLevel(id),
    })
    svc = new BettingDecisionService(martin, new RestPeriodManager(), {})
    preset = new FreshShoeTieMartingalePreset({
      filterService: filter as any,
      settingsBridge: {
        auto: { get: () => autoSettings, update: (p) => Object.assign(autoSettings, p) },
        semiauto: { get: () => semiAutoSettings, update: (p) => Object.assign(semiAutoSettings, p) },
      },
      listener: listener as any,
      casinoAdapter: adapter as any,
      storage: makeStorage(),
      semiAutoTriggerHandler: vi.fn().mockResolvedValue(undefined),
      onMartinReset: (id) => martin.resetLevel(id),
    })
    svc.setStoppedRoomsChecker((id) => preset.isRoomStopped(id))
    svc.setOnMartinCap((id) => listener.signalMartinCap(id))
  })

  it('forces Tie bet when preset is enabled', () => {
    preset.enable('auto')
    const d = svc.shouldBet('r1', pred('B'), autoSettings, createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
    expect(d.betType).toBe('Tie')
  })

  it('stops betting in room after a Tie result, resumes after shoe change', () => {
    preset.enable('auto')

    // Place a bet, then result T
    const ctx = createRoomContext('r1', 'Room')
    const d1 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d1.shouldBet).toBe(true)
    listener.notePendingBet('r1', { roundId: 'rd-1', betType: 'Tie' })

    adapter.emitResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })

    // Now blocked
    const d2 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d2.shouldBet).toBe(false)
    expect(d2.skipReason).toBe('Fresh-shoe 종료')

    // Shoe reset → unblocked
    adapter.emitShoeChange('r1')
    const d3 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d3.shouldBet).toBe(true)
  })

  it('stops betting after martin cap, resumes after shoe change', () => {
    preset.enable('auto')
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 3

    const d1 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d1.shouldBet).toBe(false)
    expect(d1.skipReason).toMatch(/최대 마틴/)

    // listener.signalMartinCap was invoked → room marked STOPPED
    const ctx2 = createRoomContext('r1', 'Room')
    ctx2.martingale.level = 0   // martin was reset
    const d2 = svc.shouldBet('r1', pred('B'), autoSettings, ctx2)
    expect(d2.shouldBet).toBe(false)
    expect(d2.skipReason).toBe('Fresh-shoe 종료')

    adapter.emitShoeChange('r1')
    const d3 = svc.shouldBet('r1', pred('B'), autoSettings, ctx2)
    expect(d3.shouldBet).toBe(true)
  })

  it('disable restores full prior behavior', () => {
    const beforeFilters = filter.getActiveFilters().slice()
    const beforeForceDir = autoSettings.forceBetDirection
    preset.enable('auto')
    preset.disable('auto')
    expect(filter.getActiveFilters()).toEqual(beforeFilters)
    expect(autoSettings.forceBetDirection).toBe(beforeForceDir)
    const d = svc.shouldBet('r1', pred('B'), autoSettings, createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
    expect(d.betType).toBe('Banker')   // back to prediction-driven
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npm run test:run -- freshShoeAutoFlow`
Expected: All four cases pass.

- [ ] **Step 3: Commit**

```bash
git add src/application/services/freshshoe/__integration__/freshShoeAutoFlow.test.ts
git commit -m "test(freshshoe): integration test for Auto-mode end-to-end flow"
```

---

### Task 16: Semi-Auto-mode integration test (preset on, navigation)

**Files:**
- Create: `src/application/services/freshshoe/__integration__/freshShoeSemiAutoFlow.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MoveOnTieListener } from '../MoveOnTieListener'
import { FreshShoeTieMartingalePreset } from '../FreshShoeTieMartingalePreset'

function makeAdapter() {
  const result: any[] = []
  const shoe: any[] = []
  return {
    onGameResult(cb: any) { result.push(cb); return () => {} },
    onShoeChange(cb: any) { shoe.push(cb); return () => {} },
    emitResult(e: any) { result.forEach(cb => cb(e)) },
  }
}

function makeFilter() {
  const active = new Set<string>()
  return {
    toggleFilter(t: string) { active.has(t) ? active.delete(t) : active.add(t) },
    getActiveFilters() { return Array.from(active) },
  }
}

function makeStorage() {
  let v: string | null = null
  return { get: () => v, set: (s: string) => { v = s }, remove: () => { v = null } }
}

describe('Fresh-Shoe Tie Martingale — Semi-Auto end-to-end', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let filter: ReturnType<typeof makeFilter>
  let semiAutoTriggerHandler: ReturnType<typeof vi.fn>
  let focusedRoomId: string | null
  let listener: MoveOnTieListener
  let preset: FreshShoeTieMartingalePreset

  beforeEach(() => {
    adapter = makeAdapter()
    filter = makeFilter()
    focusedRoomId = 'r-focus'
    semiAutoTriggerHandler = vi.fn().mockResolvedValue(undefined)
    listener = new MoveOnTieListener({
      casinoAdapter: adapter as any,
      getCurrentFocusedRoomId: () => focusedRoomId,
      onMartinReset: vi.fn(),
    })
    preset = new FreshShoeTieMartingalePreset({
      filterService: filter as any,
      settingsBridge: {
        auto: { get: () => ({ forceBetDirection: 'auto' }), update: vi.fn() },
        semiauto: { get: () => ({ forceBetDirection: 'auto' }), update: vi.fn() },
      },
      listener: listener as any,
      casinoAdapter: adapter as any,
      storage: makeStorage(),
      semiAutoTriggerHandler,
      onMartinReset: vi.fn(),
    })
  })

  it("invokes semiAutoTriggerHandler when focused room sees Tie result", () => {
    preset.enable('semiauto')
    adapter.emitResult({ roomId: 'r-focus', winner: 'T', roundId: 'rd-1' })
    expect(semiAutoTriggerHandler).toHaveBeenCalledWith('r-focus', 'organic_tie')
  })

  it("does NOT invoke handler for non-focused rooms", () => {
    preset.enable('semiauto')
    adapter.emitResult({ roomId: 'r-other', winner: 'T', roundId: 'rd-1' })
    expect(semiAutoTriggerHandler).not.toHaveBeenCalled()
  })

  it("does NOT mark STOPPED in semiauto mode (navigation handler is responsible)", () => {
    preset.enable('semiauto')
    adapter.emitResult({ roomId: 'r-focus', winner: 'T', roundId: 'rd-1' })
    expect(preset.isRoomStopped('r-focus')).toBe(false)
  })

  it("disable removes the listener subscription cleanly", () => {
    preset.enable('semiauto')
    preset.disable('semiauto')
    adapter.emitResult({ roomId: 'r-focus', winner: 'T', roundId: 'rd-1' })
    expect(semiAutoTriggerHandler).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npm run test:run -- freshShoeSemiAutoFlow`
Expected: All four cases pass.

- [ ] **Step 3: Commit**

```bash
git add src/application/services/freshshoe/__integration__/freshShoeSemiAutoFlow.test.ts
git commit -m "test(freshshoe): integration test for Semi-Auto-mode flow"
```

---

### Task 17: Regression smoke test — preset OFF == old behavior

**Files:**
- Create: `src/application/services/freshshoe/__integration__/freshShoeRegression.test.ts`

- [ ] **Step 1: Write the regression test**

```ts
import { describe, it, expect } from 'vitest'
import { BettingDecisionService } from '../../automode/BettingDecisionService'
import { MartingaleManager } from '../../automode/MartingaleManager'
import { RestPeriodManager } from '../../automode/RestPeriodManager'
import { DEFAULT_SETTINGS, createRoomContext, type AutoModeSettings } from '../../automode/types'
import type { Prediction } from '../../../../domain/entities'

function pred(p: 'B' | 'P' | 'T' | null): Prediction {
  return { roomId: 'r1', prediction: p, confidence: 0.9, isSkip: false, timestamp: Date.now() } as Prediction
}

function settings(o: Partial<AutoModeSettings> = {}): AutoModeSettings {
  return { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false, ...o }
}

describe('Preset OFF regression — BettingDecisionService unchanged', () => {
  it("defaults forceBetDirection to 'auto' and bets per prediction", () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const cases: Array<{ p: 'B' | 'P' | 'T'; expected: string }> = [
      { p: 'B', expected: 'Banker' },
      { p: 'P', expected: 'Player' },
      { p: 'T', expected: 'Tie' },
    ]
    for (const c of cases) {
      const d = svc.shouldBet('r1', pred(c.p), settings(), createRoomContext('r1', 'Room'))
      expect(d.betType).toBe(c.expected)
    }
  })

  it("BettingDecisionService without gates option preserves backward behavior", () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 5
    const d = svc.shouldBet('r1', pred('B'), settings({ maxMartin: 5 }), ctx)
    expect(d.shouldBet).toBe(false)   // martin cap blocks
    expect(d.skipReason).toMatch(/최대 마틴/)
  })
})
```

- [ ] **Step 2: Run**

Run: `npm run test:run -- freshShoeRegression`
Expected: Both cases pass.

- [ ] **Step 3: Commit**

```bash
git add src/application/services/freshshoe/__integration__/freshShoeRegression.test.ts
git commit -m "test(freshshoe): regression — preset OFF preserves prior behavior"
```

---

## Phase 5 — Verification gate

### Task 18: Full build + test pass

- [ ] **Step 1: Run build (includes typecheck)**

Run: `npm run build`
Expected: Exit code 0, no TypeScript errors.

- [ ] **Step 2: Run full test suite**

Run: `npm run test:run`
Expected: All tests pass, including the four new files and all existing files.

- [ ] **Step 3: If any failure, fix root cause (no skipping)**

If a test fails:
- Read the error output fully.
- Open the relevant test and the relevant production code side by side.
- Fix the root cause (not the test).
- Commit the fix as a separate small commit: `fix(freshshoe): <one-line>`.

- [ ] **Step 4: Commit any test-related cleanups**

```bash
git add -A
git diff --cached --stat
git commit -m "chore(freshshoe): post-implementation cleanup"
# (skip if there's nothing to commit)
```

---

### Task 19: Manual UI walkthrough (user-driven)

**Pre-condition:** Tasks 1–18 are green. The Tauri dev app builds.

- [ ] **Step 1: Launch the app**

Run: `npm run tauri:dev`
Expected: App boots, Evolution login screen appears.

- [ ] **Step 2: Toggle the preset OFF baseline check**

In Auto Mode settings dialog, confirm the new toggle is OFF and `Fresh Shoe` does not appear in active filters. Place no bet. Confirm app still functions normally (no console errors related to the preset).

- [ ] **Step 3: Toggle ON in Auto mode**

Turn the toggle ON. Verify:
- The active filter list now includes `Fresh Shoe (≤5)`.
- DevTools console shows no errors.
- The threshold input "Fresh Shoe 기준" exists in the filter dropdown and can be changed.

- [ ] **Step 4: Live behavior — wait for a real shoe reset**

Log into Evolution, watch a baccarat room. When the shoe resets:
- Confirm a small Tie bet is placed (use virtual mode for safety).
- Confirm DevTools log shows `[FreshShoe]`-tagged messages (if logging was added; otherwise check `pendingBets` via React DevTools).
- When a Tie result occurs (organic or won), confirm the room appears as STOPPED (no further bets) until the next shoe change event.

- [ ] **Step 5: Toggle OFF in Auto, verify rollback**

Turn the toggle OFF. Verify:
- `Fresh Shoe` filter is removed from active list.
- `forceBetDirection` setting is back to `'auto'` (inspect via `localStorage.getItem('smart-helper:auto-mode-settings')` if needed).
- No further preset-driven bets fire.

- [ ] **Step 6: Repeat in Semi-Auto mode**

Same flow but in the Semi-Auto panel. Watch a Tie result fire `handlePresetTrigger`. If candidate rooms exist, the CDP tab should navigate to a different fresh-shoe room. If not, the tab should stay and a console message should explain.

- [ ] **Step 7: Sign-off**

Confirm with the user (joej@gmeremit.com) that:
- [ ] Both modes' toggles work and rollback cleanly.
- [ ] Tie bets only fire in fresh-shoe rooms.
- [ ] Move-on-Tie triggers as expected (hit, organic, martin cap).
- [ ] No regression in existing Auto / Semi-Auto behavior when the preset is OFF.

Only after explicit user sign-off, mark this task complete.

---

## Self-Review Notes

After writing this plan I checked:

1. **Spec coverage:**
   - §3 (architecture) → Tasks 7, 9, 11 (each block + orchestration + DI).
   - §4.1 (`fresh_shoe` filter) → Tasks 2, 3, 4.
   - §4.2 (`forceBetDirection`) → Tasks 5, 6.
   - §4.3 (`MoveOnTieListener`) → Tasks 7, 8 (martin_cap callback).
   - §4.4 (preset) → Task 9.
   - §5 (UI) → Tasks 12, 13, 14.
   - §6 (data flow) → covered by integration Tasks 15, 16.
   - §7 (error cases E1–E11) → E1 (Task 4 cases), E2 (Task 10's no-candidate branch + Task 16 case), E3 (relies on existing code; not separately tested), E4 (covered by Task 16 timing), E5 (Task 7 dedup test), E6/E7 (allowed; no test needed beyond observed behavior), E8 (Task 9 rollback test), E9 (Tasks 9 + 15 + 16 independent toggles), E10 (Task 9 disable test), E11 (Task 15 shoe change re-entry test).
   - §8 (testing) → covered.
   - §9 (clean-code) → directly applied in code structure (small focused files).

2. **Placeholders:** none — all steps include concrete code or commands.

3. **Type consistency:** `TriggerReason`, `Scope`, `Mode`, `IFilterService`, `ISettingsBridge`, `IShoeChangeSource`, `IPresetStorage`, `BettingDecisionGates` are consistently named across the plan.

4. **Known plan-time assumptions to verify in Phase 0 (Task 1):**
   - `EvolutionAdapter.onGameResult` event shape (assumed `{ roomId, winner, roundId | gameId }`). If actual shape differs, adjust Task 11 Step 2's wiring closure.
   - `RoomPredictionState.isShoeReset` is the right source for casino-shoe-start detection. If Phase 0 shows it doesn't reliably correlate with `onShoeChange`, Task 4 Step 3 should use a different predicate (likely raw `history.length` as the only source).
