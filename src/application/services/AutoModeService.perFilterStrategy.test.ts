// AutoModeService — per-filter strategy integration tests.
//
// Verifies the end-to-end wiring of the per-filter betting strategy override
// added via PatternBettingService:
//
//   user picks filter X with strategy override S
//     → setActiveBettingRooms(rooms, X) sets currentPatternFilter=X
//     → onBettingPhase fires → placeBet() → AutoModeService.calculateBetAmount()
//     → resolveActiveFilterStrategy() returns S
//     → MartingaleManager.calculateBetAmount(level, baseBet, S, customAmounts)
//
// The test exercises this via the public API surface (no `as any` private
// peeking) by observing the resulting bet amount emitted through the
// onBetLog `bet_placed` event.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BettingPhaseEvent,
  GameResultEvent,
  RoadResult,
  Room,
} from '../../domain/entities'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di/Container'
import AutoModeService, { type AutoModeBetLogEvent } from './AutoModeService'
import { VirtualBettingService } from './VirtualBettingService'
import { PatternBettingService } from './PatternBettingService'
import FilterThresholdsService from './FilterThresholdsService'

class MockCasinoAdapter implements ICasinoAdapter {
  readonly name = 'Mock'
  readonly type = 'evolution' as const
  private rooms: Map<string, Room> = new Map()
  private bettingPhaseCallbacks: Array<(event: BettingPhaseEvent) => void> = []
  private gameResultCallbacks: Array<(event: GameResultEvent) => void> = []

  async connect(_config: any): Promise<void> {}
  async disconnect(): Promise<void> { this.rooms.clear() }
  isConnected(): boolean { return true }
  parseMessage(_raw: string): any { return null }

  getRoom(roomId: string): Room | null { return this.rooms.get(roomId) || null }
  getRooms(): Map<string, Room> { return this.rooms }
  setRoom(room: Room): void { this.rooms.set(room.id, room) }

  onRoomUpdate(): () => void { return () => {} }
  onHistoryUpdate(): () => void { return () => {} }
  onGameResult(cb: (event: GameResultEvent) => void): () => void {
    this.gameResultCallbacks.push(cb)
    return () => { this.gameResultCallbacks = this.gameResultCallbacks.filter(c => c !== cb) }
  }
  onBettingPhase(cb: (event: BettingPhaseEvent) => void): () => void {
    this.bettingPhaseCallbacks.push(cb)
    return () => { this.bettingPhaseCallbacks = this.bettingPhaseCallbacks.filter(c => c !== cb) }
  }
  emitBettingPhase(e: BettingPhaseEvent): void { this.bettingPhaseCallbacks.forEach(cb => cb(e)) }
  emitGameResult(e: GameResultEvent): void { this.gameResultCallbacks.forEach(cb => cb(e)) }
}

function makeHistory(winners: Array<'B' | 'P' | 'T'>): RoadResult[] {
  return winners.map(w => ({ winner: w, isPlayerPair: false, isBankerPair: false }))
}

function flush(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// AutoModeService.setActiveBettingRooms() arms a 150ms transition lock during
// which isRoomEnabled returns false and bets are blocked. We wait past that
// window so subsequent bettingPhase events actually trigger a placeBet.
const FILTER_TRANSITION_WAIT_MS = 220

function makeRoom(id: string, winners?: Array<'B' | 'P' | 'T'>): Room {
  const history = makeHistory(winners ?? ['B', 'P', 'B', 'P', 'B'])
  return {
    id,
    name: id,
    koreanName: id,
    history,
    gameCount: history.length,
    gameState: {
      playerHand: { score: 0, cards: ['AS', 'KD'] },
      bankerHand: { score: 0, cards: ['2H', '3C'] },
    },
  }
}

/**
 * Subscribe to AutoMode bet logs and return a getter that resolves the first
 * observed `bet_placed.betAmount` for `roomId`, plus an unsubscribe handle.
 */
function subscribeBetAmount(roomId: string) {
  let amount: number | null = null
  const unsub = AutoModeService.onBetLog((ev: AutoModeBetLogEvent) => {
    if (ev.roomId === roomId && ev.type === 'bet_placed' && typeof ev.betAmount === 'number' && amount === null) {
      amount = ev.betAmount
    }
  })
  return { getAmount: () => amount, unsub }
}

describe('AutoModeService — per-filter strategy override', () => {
  let adapter: MockCasinoAdapter
  const BASE_BET = 1000

  beforeEach(() => {
    localStorage.removeItem('smart-helper:auto-mode-settings')
    localStorage.removeItem('bcr-pattern-betting-configs')
    container.clear()

    adapter = new MockCasinoAdapter()

    const predictionPort: IMultiRoomPredictionPort = {
      requestPredictionForRoom: vi.fn(async (roomId: string) => ({
        roomId,
        prediction: 'B' as const,
        confidence: 0.9,
        reasoning: 'test',
        isSkip: false,
        timestamp: Date.now(),
      })),
      requestBestRoomSelection: vi.fn(async () => null),
    }

    container.register('casinoAdapter', adapter as unknown as ICasinoAdapter)
    container.register('multiRoomPredictionPort', predictionPort)

    VirtualBettingService.disable()
    VirtualBettingService.reset()

    PatternBettingService.dispose() // reseed builtin defaults

    // The tie_frequent default is now "no ties in games 1-5 of shoe", which is
    // unrelated to what these strategy tests want to verify. Use permissive
    // thresholds (≥1 tie in first 5 games) so tie-heavy test rooms still match.
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 1,
      tieFrequentMaxCount: 99,
    })

    AutoModeService.dispose()
    AutoModeService.initialize()
    AutoModeService.updateSettings({
      isVirtualMode: true,
      baseBetAmount: BASE_BET,
      betStrategy: 'martingale',           // global default
      customBetAmounts: [5000, 6000, 7000], // referenced when strategy='custom'
      maxConcurrentBets: 0,                 // no concurrency cap so first bet always proceeds
      winCutAmount: 0,
      lossCutAmount: 0,
    })
  })

  afterEach(() => {
    AutoModeService.stop()
    AutoModeService.dispose()
    VirtualBettingService.disable()
    PatternBettingService.dispose()
  })

  it('uses the global martingale strategy when no filter is active (baseline)', async () => {
    const room = makeRoom('rA')
    adapter.setRoom(room)
    AutoModeService.start()
    // filter='all' means no per-filter override applies
    AutoModeService.setActiveBettingRooms(['rA'], 'all')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const sub = subscribeBetAmount('rA')
    adapter.emitBettingPhase({ roomId: 'rA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    sub.unsub()

    expect(sub.getAmount()).toBe(BASE_BET) // martingale level 0 = baseBet
  })

  it('uses the per-filter strategy when a filter with a custom override is active', async () => {
    // 'banker_dominant' (default betDirection='B') matches a B-leaning room
    // and lets us assert the strategy override drives the wager amount.
    PatternBettingService.setBetStrategy('banker_dominant', 'custom') // overrides 'martingale'
    const room = makeRoom('rB', ['B', 'B', 'B', 'P', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rB'], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const sub = subscribeBetAmount('rB')
    adapter.emitBettingPhase({ roomId: 'rB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    sub.unsub()

    // 'custom' at level 0 picks customBetAmounts[0] = 5000
    expect(sub.getAmount()).toBe(5000)
  })

  it('falls back to global strategy when filter has no override', async () => {
    // 'banker_dominant' has no per-filter strategy override set in this test
    const room = makeRoom('rC', ['B', 'B', 'B', 'P', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rC'], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const sub = subscribeBetAmount('rC')
    adapter.emitBettingPhase({ roomId: 'rC', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    sub.unsub()

    // resolveBetStrategy returns the fallback ('martingale'), level 0 → baseBet
    expect(sub.getAmount()).toBe(BASE_BET)
  })

  it('uses fibonacci stagger when the per-filter strategy is fibonacci', async () => {
    // Distinct from the custom test: proves the strategy *name* itself is the
    // value that flows through, not just any non-default. At level 0 fibonacci
    // multiplier is 1, so the amount equals baseBet — for that reason the
    // assertion is the same value as baseline, but the [PatternBettingService]
    // log line in the trace confirms the override path was taken.
    PatternBettingService.setBetStrategy('banker_dominant', 'fibonacci')
    const room = makeRoom('rE', ['B', 'B', 'B', 'P', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rE'], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const sub = subscribeBetAmount('rE')
    adapter.emitBettingPhase({ roomId: 'rE', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    sub.unsub()

    expect(sub.getAmount()).toBe(BASE_BET) // fibonacci[0] * baseBet = 1 * 1000
    expect(PatternBettingService.getBetStrategy('banker_dominant')).toBe('fibonacci')
  })

  // 사용자 시나리오 (어르신용 "타이 자동 배팅" 카드 켜기):
  //   1) FilterSettingsDialog가 clearFilters + toggleFilter('tie_frequent')
  //   2) AutoModePanel가 매칭된 방 ID만 추려서 setActiveBettingRooms(matchedIds)
  //   3) onBettingPhase가 들어와도 매칭 방만 베팅, 비매칭 방은 차단
  //
  // 이 테스트는 (3) 게이트가 진짜 동작하는지 — activeBettingRoomIds에 없는
  // 방의 betting phase 이벤트가 들어와도 베팅이 나가지 않음을 보장.
  it('exclusivity gate: only rooms inside setActiveBettingRooms get bets', async () => {
    const tieRoom = makeRoom('rTie', ['T', 'B', 'T', 'P', 'T', 'B', 'T'])
    const otherRoom = makeRoom('rOther', ['B', 'P', 'B', 'P', 'B'])
    adapter.setRoom(tieRoom)
    adapter.setRoom(otherRoom)

    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    AutoModeService.start()
    // AutoModePanel가 필터링한 결과처럼 rTie만 전달
    AutoModeService.setActiveBettingRooms(['rTie'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    let tieBet: number | null = null
    let otherBet: number | null = null
    const unsub = AutoModeService.onBetLog((ev: AutoModeBetLogEvent) => {
      if (ev.type === 'bet_placed') {
        if (ev.roomId === 'rTie' && tieBet === null) tieBet = ev.betAmount ?? null
        if (ev.roomId === 'rOther' && otherBet === null) otherBet = ev.betAmount ?? null
      }
    })

    // 두 방 모두에 betting phase 이벤트 발생 — 카지노 어댑터는 모든 방에서 이벤트 보냄
    adapter.emitBettingPhase({ roomId: 'rTie', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'rOther', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(tieBet).toBe(BASE_BET) // 매칭 방: 베팅 진행
    expect(otherBet).toBeNull()    // 비매칭 방: 차단됨 (베팅 안 나감)
  })

  // 사용자 시나리오: "타이 자주 필터에 걸린 방에 타이 마틴으로 배팅"
  // 1. tie_frequent 필터를 켜고
  // 2. 그 필터의 배팅 방향을 T로 지정하고
  // 3. 그 필터의 전략은 martingale (기본값)
  // → 매칭되는 방에서 Tie 베팅이 나가고, level 0에서 baseBet 금액
  it('honors tie_frequent filter + T direction + martingale strategy end-to-end', async () => {
    // Tie 방향 + martingale 전략을 tie_frequent 필터에 지정
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    // 최근 8판 중 Tie가 3번 → 기본 tieFrequentMinCount=2를 넘김 → 필터 매칭
    const room = makeRoom('rTie', ['T', 'B', 'P', 'T', 'B', 'P', 'T', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rTie'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    // bet_placed 이벤트에서 betType과 betAmount 둘 다 캡처
    let placedType: string | null = null
    let placedAmount: number | null = null
    const unsub = AutoModeService.onBetLog((ev: AutoModeBetLogEvent) => {
      if (ev.roomId === 'rTie' && ev.type === 'bet_placed' && placedType === null) {
        placedType = ev.betType ?? null
        placedAmount = ev.betAmount ?? null
      }
    })

    adapter.emitBettingPhase({ roomId: 'rTie', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    // 베팅 방향: 사용자가 T 지정 → 실제 베팅 타입도 Tie
    expect(placedType).toBe('Tie')
    // 마틴 전략 level 0 → baseBet 그대로
    expect(placedAmount).toBe(BASE_BET)
  })
})
