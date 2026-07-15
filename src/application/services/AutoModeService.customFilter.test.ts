// AutoModeService — custom-filter end-to-end test.
//
// Asks: "If I register a custom pattern with my own sequence + bet direction +
// bet strategy, does the AutoMode actually place that exact bet when a room
// matches?"
//
// Flow verified:
//   user creates CustomPattern { sequence, betDirection, betStrategy }
//     → setActiveBettingRooms(rooms, `custom:<id>`)
//     → PatternPredictionService.findMatchedPattern → matchCustomPattern
//        - sequence matched against room.history (reversed, newest-first)
//        - betDirection ∈ {B,P,T} forces the bet type (no AI call)
//        - 'ai' would defer to AI; 'skip' would skip
//     → PatternBettingService.resolveBetStrategy('custom:<id>', global)
//        - reads CustomPattern.betStrategy
//     → AutoModeService.calculateBetAmount uses the resolved strategy
//     → placeBet emits bet_placed with the configured bet amount + bet type.
//
// We exercise this with a Player-direction custom pattern and a 'custom'
// strategy override that points at customBetAmounts[0] = 5000. The bet_placed
// event should report Player at 5000 — proving every per-pattern setting flows
// through unmodified.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BettingPhaseEvent,
  GameResultEvent,
  RoadResult,
  Room,
  CustomPattern,
} from '../../domain/entities'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di/Container'
import AutoModeService, { type AutoModeBetLogEvent } from './AutoModeService'
import { VirtualBettingService } from './VirtualBettingService'
import { PatternBettingService } from './PatternBettingService'
import { CustomPatternService } from './CustomPatternService'
import CustomStrategyService from './CustomStrategyService'
import CustomStrategyRuntime from './customstrategy/CustomStrategyRuntime'

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
  onGameResult(cb: (e: GameResultEvent) => void): () => void {
    this.gameResultCallbacks.push(cb)
    return () => { this.gameResultCallbacks = this.gameResultCallbacks.filter(c => c !== cb) }
  }
  onBettingPhase(cb: (e: BettingPhaseEvent) => void): () => void {
    this.bettingPhaseCallbacks.push(cb)
    return () => { this.bettingPhaseCallbacks = this.bettingPhaseCallbacks.filter(c => c !== cb) }
  }
  emitBettingPhase(e: BettingPhaseEvent): void { this.bettingPhaseCallbacks.forEach(cb => cb(e)) }
  emitGameResult(e: GameResultEvent): void { this.gameResultCallbacks.forEach(cb => cb(e)) }
}

function makeHistory(winners: Array<'B' | 'P' | 'T'>): RoadResult[] {
  return winners.map(w => ({ winner: w, isPlayerPair: false, isBankerPair: false }))
}

function makeRoom(id: string, winners: Array<'B' | 'P' | 'T'>): Room {
  const history = makeHistory(winners)
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

function flush(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface CapturedBet {
  betAmount?: number
  betType?: string
  prediction?: string | null
}

function subscribeBet(roomId: string) {
  const capture: CapturedBet = {}
  const unsub = AutoModeService.onBetLog((ev: AutoModeBetLogEvent) => {
    if (ev.roomId === roomId && ev.type === 'bet_placed') {
      capture.betAmount = ev.betAmount
      capture.betType = ev.betType
      capture.prediction = ev.prediction ?? null
    }
  })
  return { capture, unsub }
}

const FILTER_TRANSITION_WAIT_MS = 220
const BASE_BET = 1000

describe('AutoModeService — custom filter end-to-end', () => {
  let adapter: MockCasinoAdapter
  let createdPattern: CustomPattern

  beforeEach(() => {
    localStorage.clear()
    container.clear()

    adapter = new MockCasinoAdapter()
    const predictionPort: IMultiRoomPredictionPort = {
      // AI is intentionally a noop here — custom pattern with betDirection
      // 'B'/'P'/'T' should bypass the AI call entirely.
      requestPredictionForRoom: vi.fn(async () => null),
      requestBestRoomSelection: vi.fn(async () => null),
    }
    container.register('casinoAdapter', adapter as unknown as ICasinoAdapter)
    container.register('multiRoomPredictionPort', predictionPort)

    VirtualBettingService.disable()
    VirtualBettingService.reset()
    PatternBettingService.dispose()
    // Reseed CustomPatternService from cleared localStorage so the pattern
    // created in this test is the only one the system sees.
    CustomPatternService.reinitialize()
    CustomStrategyService.resetToDefault()
    CustomStrategyRuntime.resetAll()

    AutoModeService.dispose()
    AutoModeService.initialize()
    AutoModeService.updateSettings({
      isVirtualMode: true,
      baseBetAmount: BASE_BET,
      betStrategy: 'martingale',
      customBetAmounts: [5000, 6000, 7000],
      maxConcurrentBets: 0,
      winCutAmount: 0,
      lossCutAmount: 0,
    })

    // Register the custom pattern the user would set up via PatternManagerModal.
    // Sequence "BBPP" reads oldest→newest (matches the modal input convention).
    createdPattern = CustomPatternService.addPattern({
      name: '내 패턴',
      sequence: 'BBPP',
      enabled: true,
      betDirection: 'P', // force Player bet on match
    })
    // Per-filter strategy override that points at customBetAmounts[0]
    PatternBettingService.setBetStrategy(`custom:${createdPattern.id}`, 'custom')
  })

  afterEach(() => {
    AutoModeService.stop()
    AutoModeService.dispose()
    VirtualBettingService.disable()
    PatternBettingService.dispose()
    CustomPatternService.clear()
  })

  it('matches sequence + uses custom betDirection (Player) + custom strategy amount', async () => {
    // history is newest-first; for pattern "BBPP" (chronological) the last 4
    // games should be B,B,P,P with P being the most recent. So newest-first
    // history = P,P,B,B,... — the test room provides exactly that.
    const room = makeRoom('rCustom', ['P', 'P', 'B', 'B', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rCustom'], `custom:${createdPattern.id}` as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    const { capture, unsub } = subscribeBet('rCustom')
    adapter.emitBettingPhase({ roomId: 'rCustom', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    // Bet direction came from CustomPattern.betDirection = 'P' (no AI was called)
    expect(capture.betType).toBe('Player')
    expect(capture.prediction).toBe('P')
    // Bet amount came from per-filter strategy 'custom' → customBetAmounts[0]
    expect(capture.betAmount).toBe(5000)
  })

  it('does not place a bet when the room history does not match the custom sequence', async () => {
    // History does NOT end in P,P,B,B — newest is B, not P. Should not match.
    const room = makeRoom('rNoMatch', ['B', 'P', 'B', 'P', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rNoMatch'], `custom:${createdPattern.id}` as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    const { capture, unsub } = subscribeBet('rNoMatch')
    adapter.emitBettingPhase({ roomId: 'rNoMatch', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(capture.betAmount).toBeUndefined()
    expect(capture.betType).toBeUndefined()
  })

  it('honors betDirection=skip on the custom pattern (matched but no bet placed)', async () => {
    // Replace the existing pattern with a 'skip' direction.
    CustomPatternService.updatePattern(createdPattern.id, { betDirection: 'skip' })

    const room = makeRoom('rSkip', ['P', 'P', 'B', 'B', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rSkip'], `custom:${createdPattern.id}` as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    const { capture, unsub } = subscribeBet('rSkip')
    adapter.emitBettingPhase({ roomId: 'rSkip', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(capture.betAmount).toBeUndefined()
  })

  it('honors betDirection=B on the custom pattern (forces Banker)', async () => {
    CustomPatternService.updatePattern(createdPattern.id, { betDirection: 'B' })

    const room = makeRoom('rBanker', ['P', 'P', 'B', 'B', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rBanker'], `custom:${createdPattern.id}` as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    const { capture, unsub } = subscribeBet('rBanker')
    adapter.emitBettingPhase({ roomId: 'rBanker', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(capture.betType).toBe('Banker')
    expect(capture.prediction).toBe('B')
    expect(capture.betAmount).toBe(5000) // still using custom strategy override
  })

  it('uses global strategy when the custom pattern has no per-filter strategy override', async () => {
    // Clear the strategy override we set up in beforeEach.
    PatternBettingService.setBetStrategy(`custom:${createdPattern.id}`, undefined)

    const room = makeRoom('rNoOverride', ['P', 'P', 'B', 'B', 'B'])
    adapter.setRoom(room)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rNoOverride'], `custom:${createdPattern.id}` as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    const { capture, unsub } = subscribeBet('rNoOverride')
    adapter.emitBettingPhase({ roomId: 'rNoOverride', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    // Strategy resolves to global 'martingale' at level 0 → BASE_BET
    expect(capture.betAmount).toBe(BASE_BET)
    // Bet direction still comes from custom pattern (P)
    expect(capture.betType).toBe('Player')
  })

  it('runs a structured strategy through trigger, first win, second win, and clear', async () => {
    const chronological = 'PPBBPPBBPPBBPPB'.split('') as Array<'P' | 'B'>
    const roomId = 'rStructured'
    const roomAt15 = makeRoom(roomId, [...chronological].reverse())
    adapter.setRoom(roomAt15)
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms([roomId], 'strategy:no-streak-15-two-hit' as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    const placed: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(event => {
      if (event.roomId === roomId && event.type === 'bet_placed') placed.push(event)
    })

    // Hand 15 only arms the strategy. It must not bet until the next P/B result.
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()
    expect(placed).toHaveLength(0)

    // Hand 16 is the trigger P; the bet begins in hand 17.
    const roomAt16 = makeRoom(roomId, ['P', ...[...chronological].reverse()])
    adapter.setRoom(roomAt16)
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()
    expect(placed[0]).toMatchObject({
      prediction: 'P',
      betType: 'Player',
      betAmount: 10000,
      customStrategyStage: 1,
      customStrategyAttempt: 1,
    })

    // First win advances inside the same stage to attempt 2 instead of resetting.
    const roomAt17 = makeRoom(roomId, ['P', 'P', ...[...chronological].reverse()])
    adapter.setRoom(roomAt17)
    adapter.emitGameResult({ roomId, winner: 'P' })
    await flush()
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()
    expect(placed[1]).toMatchObject({ betAmount: 10000, customStrategyStage: 1, customStrategyAttempt: 2 })

    // Second consecutive win clears this room for the shoe.
    const roomAt18 = makeRoom(roomId, ['P', 'P', 'P', ...[...chronological].reverse()])
    adapter.setRoom(roomAt18)
    adapter.emitGameResult({ roomId, winner: 'P' })
    await flush()
    expect(CustomStrategyRuntime.getSession('no-streak-15-two-hit', roomId)).toMatchObject({ status: 'cleared' })
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()
    expect(placed).toHaveLength(2)
    unsub()
  })

  it('moves a first-attempt loss to the next stage amount without invoking martin progression', async () => {
    const chronological = 'PPBBPPBBPPBBPPB'.split('') as Array<'P' | 'B'>
    const roomId = 'rStructuredLoss'
    adapter.setRoom(makeRoom(roomId, [...chronological].reverse()))
    AutoModeService.start()
    AutoModeService.setActiveBettingRooms([roomId], 'strategy:no-streak-15-two-hit' as any)
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()

    const placed: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(event => {
      if (event.roomId === roomId && event.type === 'bet_placed') placed.push(event)
    })
    adapter.setRoom(makeRoom(roomId, ['P', ...[...chronological].reverse()]))
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()
    expect(placed[0]?.betAmount).toBe(10000)

    adapter.setRoom(makeRoom(roomId, ['B', 'P', ...[...chronological].reverse()]))
    adapter.emitGameResult({ roomId, winner: 'B' })
    await flush()
    adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
    await flush()
    expect(placed[1]).toMatchObject({ betAmount: 20000, customStrategyStage: 2, customStrategyAttempt: 1 })
    expect(AutoModeService.getRoomState(roomId)?.martinLevel).toBe(0)
    unsub()
  })
})
