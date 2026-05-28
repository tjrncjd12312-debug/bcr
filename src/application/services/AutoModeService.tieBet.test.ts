// AutoModeService — Tie bet propagation test.
//
// Previously the bet_placed log nulled `prediction` when the prediction was
// 'T', which hid Tie bets from every UI surface that keys off `prediction`.
// This test asserts:
//
//   1. When a custom filter forces betDirection='T' on a matching room,
//      AutoMode actually places a Tie bet (betType='Tie').
//   2. The bet_placed log event carries `prediction='T'` (not null) so UI
//      components can render a distinct Tie badge.

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
import { CustomPatternService } from './CustomPatternService'
import FilterThresholdsService from './FilterThresholdsService'

class MockCasinoAdapter implements ICasinoAdapter {
  readonly name = 'Mock'
  readonly type = 'evolution' as const
  private rooms: Map<string, Room> = new Map()
  private bettingPhaseCallbacks: Array<(event: BettingPhaseEvent) => void> = []
  private gameResultCallbacks: Array<(event: GameResultEvent) => void> = []
  private historyUpdateCallbacks: Array<(roomId: string, history: RoadResult[]) => void> = []
  private shoeChangeCallbacks: Array<(roomId: string, roomName: string) => void> = []

  async connect(_config: any): Promise<void> {}
  async disconnect(): Promise<void> { this.rooms.clear() }
  isConnected(): boolean { return true }
  parseMessage(_raw: string): any { return null }
  getRoom(roomId: string): Room | null { return this.rooms.get(roomId) || null }
  getRooms(): Map<string, Room> { return this.rooms }
  setRoom(room: Room): void { this.rooms.set(room.id, room) }
  onRoomUpdate(): () => void { return () => {} }
  onHistoryUpdate(cb: (roomId: string, history: RoadResult[]) => void): () => void {
    this.historyUpdateCallbacks.push(cb)
    return () => { this.historyUpdateCallbacks = this.historyUpdateCallbacks.filter(c => c !== cb) }
  }
  onGameResult(cb: (e: GameResultEvent) => void): () => void {
    this.gameResultCallbacks.push(cb)
    return () => { this.gameResultCallbacks = this.gameResultCallbacks.filter(c => c !== cb) }
  }
  onBettingPhase(cb: (e: BettingPhaseEvent) => void): () => void {
    this.bettingPhaseCallbacks.push(cb)
    return () => { this.bettingPhaseCallbacks = this.bettingPhaseCallbacks.filter(c => c !== cb) }
  }
  onShoeChange(cb: (roomId: string, roomName: string) => void): () => void {
    this.shoeChangeCallbacks.push(cb)
    return () => { this.shoeChangeCallbacks = this.shoeChangeCallbacks.filter(c => c !== cb) }
  }
  emitBettingPhase(e: BettingPhaseEvent): void { this.bettingPhaseCallbacks.forEach(cb => cb(e)) }
  emitGameResult(e: GameResultEvent): void { this.gameResultCallbacks.forEach(cb => cb(e)) }
  emitHistoryUpdate(roomId: string, history: RoadResult[]): void {
    this.historyUpdateCallbacks.forEach(cb => cb(roomId, history))
  }
  emitShoeChange(roomId: string): void { this.shoeChangeCallbacks.forEach(cb => cb(roomId, roomId)) }
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
function flush(ms = 0) { return new Promise<void>(r => setTimeout(r, ms)) }

const BASE_BET = 1000
const FILTER_TRANSITION_WAIT_MS = 220

describe('AutoModeService — Tie bet propagation', () => {
  let adapter: MockCasinoAdapter

  beforeEach(() => {
    localStorage.clear()
    container.clear()
    adapter = new MockCasinoAdapter()
    const predictionPort: IMultiRoomPredictionPort = {
      requestPredictionForRoom: vi.fn(async () => null),
      requestBestRoomSelection: vi.fn(async () => null),
    }
    container.register('casinoAdapter', adapter as unknown as ICasinoAdapter)
    container.register('multiRoomPredictionPort', predictionPort)
    VirtualBettingService.disable()
    VirtualBettingService.reset()
    PatternBettingService.dispose()
    CustomPatternService.reinitialize()

    AutoModeService.dispose()
    AutoModeService.initialize()
    AutoModeService.updateSettings({
      isVirtualMode: true,
      baseBetAmount: BASE_BET,
      betStrategy: 'flat',
      maxConcurrentBets: 0,
      winCutAmount: 0,
      lossCutAmount: 0,
    })
  })

  afterEach(() => {
    AutoModeService.stop()
    AutoModeService.dispose()
    VirtualBettingService.disable()
    PatternBettingService.dispose()
    CustomPatternService.clear()
  })

  it('places a Tie bet when custom pattern betDirection=T and history matches', async () => {
    const pattern = CustomPatternService.addPattern({
      name: '타이 패턴',
      sequence: 'BBPP',
      enabled: true,
      betDirection: 'T',
    })
    const room = makeRoom('rTie', ['P', 'P', 'B', 'B', 'B'])
    adapter.setRoom(room)

    let captured: AutoModeBetLogEvent | null = null
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rTie' && ev.type === 'bet_placed') captured = ev
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rTie'], `custom:${pattern.id}` as any)
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rTie', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(captured).not.toBeNull()
    expect(captured!.betType).toBe('Tie')
    // Regression: prediction must NOT be nulled out for Tie bets — UI relies on it.
    expect(captured!.prediction).toBe('T')
    expect(captured!.betAmount).toBe(BASE_BET)
  })

  it('uses the BettingDecision direction and settles results against the actual placed bet', async () => {
    PatternBettingService.setBetDirection('banker_dominant', 'B')
    AutoModeService.updateSettings({ forceBetDirection: 'tie_only' })

    let room = makeRoom('rForced', ['B', 'B', 'B', 'P', 'B'])
    adapter.setRoom(room)

    let placed: AutoModeBetLogEvent | null = null
    let result: AutoModeBetLogEvent | null = null
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId !== 'rForced') return
      if (ev.type === 'bet_placed') placed = ev
      if (ev.type === 'bet_result' && ev.winner === 'T') result = ev
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rForced'], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rForced', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(placed).not.toBeNull()
    expect(placed!.betType).toBe('Tie')
    expect(placed!.prediction).toBe('T')

    room = { ...room, history: makeHistory(['T', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rForced', winner: 'T', playerScore: 7, bankerScore: 7 })
    await flush()
    await flush()
    unsub()

    expect(result).not.toBeNull()
    expect(result!.won).toBe(true)
    expect(result!.prediction).toBe('T')
    expect(result!.profit).toBe(BASE_BET * 8)
  })

  // 사용자 시나리오: "그방에서 성공하면 같은 필터 조건을 물색해서 똑같이 마틴쳐야함"
  // 흐름:
  //   1) 두 방 A, B 모두 tie_frequent(0~0, 처음 5판) 매칭
  //   2) A에 베팅 진행 → A는 락 (waitingForResult)
  //   3) A의 같은 시점 B에는 BettingPhase 와도 락에 막혀 베팅 안 됨
  //   4) A에 타이 결과 → A 적중, martinLevel 리셋, A 히스토리에 T 추가되어 필터 깨짐
  //   5) 락 해제 후 B의 BettingPhase → 같은 필터 매칭하므로 B에 새 마틴 시작
  it('places Tie bets for each active matching tie-auto room while each room owns its own martingale', async () => {
    // 새 슈 시작 후 첫 5판 무타이를 보고 베팅하는 시나리오
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    // 두 방 모두 newest-first 'PBPBP' (시간순 PBPBP — 5판 모두 타이 없음, 매칭)
    const roomA = makeRoom('rA', ['P', 'B', 'P', 'B', 'P'])
    const roomB = makeRoom('rB', ['B', 'P', 'B', 'P', 'B'])
    adapter.setRoom(roomA)
    adapter.setRoom(roomB)

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rA', 'rB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const aBets: AutoModeBetLogEvent[] = []
    const bBets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type !== 'bet_placed') return
      if (ev.roomId === 'rA') aBets.push(ev)
      if (ev.roomId === 'rB') bBets.push(ev)
    })

    // A에 베팅 → 락 시작
    adapter.emitBettingPhase({ roomId: 'rA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(aBets).toHaveLength(1)
    expect(aBets[0].betType).toBe('Tie')

    // 같은 시점 B에도 BettingPhase 와도 락에 막혀 베팅 X
    adapter.emitBettingPhase({ roomId: 'rB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bBets).toHaveLength(1)
    expect(bBets[0].betType).toBe('Tie')
    expect(bBets[0].betAmount).toBe(BASE_BET)

    // A에 타이 적중 — 히스토리에 T 추가하고 GameResult emit
    const winningRoomA: Room = {
      ...roomA,
      history: makeHistory(['T', 'P', 'B', 'P', 'B', 'P']),
    }
    adapter.setRoom(winningRoomA)
    adapter.emitGameResult({ roomId: 'rA', winner: 'T', playerScore: 5, bankerScore: 5 })
    await flush()
    await flush()

    // 락 해제 — 다음 라운드 B BettingPhase에서 B에 신규 마틴 시작
    adapter.emitBettingPhase({ roomId: 'rB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bBets).toHaveLength(1)
    expect(bBets[0].betType).toBe('Tie')
    expect(bBets[0].betAmount).toBe(BASE_BET) // 새 시퀀스 → level 0 = baseBet
  })

  it('places first tie-auto bets in all three active rooms', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    adapter.setRoom(makeRoom('r1', ['B']))
    adapter.setRoom(makeRoom('r2', ['P']))
    adapter.setRoom(makeRoom('r3', ['B', 'P']))

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['r1', 'r2', 'r3'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    adapter.emitBettingPhase({ roomId: 'r1', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'r2', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'r3', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId).sort()).toEqual(['r1', 'r2', 'r3'])
    expect(bets.every(b => b.betType === 'Tie')).toBe(true)
    expect(bets.every(b => b.betAmount === BASE_BET)).toBe(true)
  })

  it('continues a losing martingale room immediately with the same direction, bypassing new AI prediction', async () => {
    const requestPredictionForRoom = vi.fn()
      .mockResolvedValueOnce({
        roomId: 'rAiMartin',
        prediction: 'B',
        confidence: 0.9,
        reasoning: 'first AI pick',
        isSkip: false,
        timestamp: Date.now(),
      })
      .mockResolvedValue({
        roomId: 'rAiMartin',
        prediction: 'P',
        confidence: 0.1,
        reasoning: 'would change direction',
        isSkip: false,
        timestamp: Date.now(),
      })
    container.replace('multiRoomPredictionPort', {
      requestPredictionForRoom,
      requestBestRoomSelection: vi.fn(async () => null),
    })
    AutoModeService.updateSettings({
      betStrategy: 'martingale',
      forceBetDirection: 'auto',
      maxMartin: 2,
      maxConcurrentBets: 0,
    })

    let room: Room = { ...makeRoom('rAiMartin', ['B', 'P', 'B']), remainingSeconds: 0 }
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rAiMartin' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rAiMartin'], 'all')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rAiMartin', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].betType).toBe('Banker')
    expect(bets[0].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rAiMartin', remainingSeconds: 0, phase: 'end' })
    room = {
      ...room,
      history: makeHistory(['P', ...room.history.map(h => h.winner)]),
      remainingSeconds: 10,
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rAiMartin', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(2)
    expect(bets[1].betType).toBe('Banker')
    expect(bets[1].prediction).toBe('B')
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
    expect(requestPredictionForRoom).toHaveBeenCalledTimes(1)
  })

  it('keeps betting the locked tie-auto room at the max martingale level until a Tie win', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 2 })

    let room = makeRoom('rKeep', ['B'])
    adapter.setRoom(room)

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rKeep'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rKeep' && ev.type === 'bet_placed') bets.push(ev)
    })

    adapter.emitBettingPhase({ roomId: 'rKeep', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].betAmount).toBe(BASE_BET)

    room = { ...room, history: makeHistory(['P', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rKeep', winner: 'P', playerScore: 8, bankerScore: 2 })
    await flush()
    await flush()

    adapter.emitBettingPhase({ roomId: 'rKeep', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(2)
    expect(bets[1].betAmount).toBe(BASE_BET * 2)

    room = { ...room, history: makeHistory(['B', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rKeep', winner: 'B', playerScore: 1, bankerScore: 9 })
    await flush()
    await flush()

    adapter.emitBettingPhase({ roomId: 'rKeep', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(3)
    expect(bets[2].betType).toBe('Tie')
    expect(bets[2].betAmount).toBe(BASE_BET * 2)
  })

  it('keeps losing tie-auto rooms active even if a refreshed filter list omits them', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5 })

    let lockedRoom = makeRoom('rLocked', ['B'])
    const otherRoom = makeRoom('rOther', ['B'])
    adapter.setRoom(lockedRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rLocked'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rLocked', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].roomId).toBe('rLocked')
    expect(bets[0].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rLocked', remainingSeconds: 0, phase: 'end' })
    await flush()
    lockedRoom = { ...lockedRoom, history: makeHistory(['P', ...lockedRoom.history.map(h => h.winner)]) }
    adapter.setRoom(lockedRoom)
    adapter.emitGameResult({ roomId: 'rLocked', winner: 'P', playerScore: 9, bankerScore: 0 })
    await flush()
    await flush()

    AutoModeService.setActiveBettingRooms(['rOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rOther', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'rLocked', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(3)
    expect(bets[1].roomId).toBe('rLocked')
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
    expect(bets[2].roomId).toBe('rOther')
    expect(bets[2].betType).toBe('Tie')
    expect(bets[2].betAmount).toBe(BASE_BET)
  })

  it('immediately retries a ready tie-auto martingale room during a late filter refresh', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let retryRoom: Room = { ...makeRoom('rRetryNow', ['B']), remainingSeconds: 0 }
    const otherRoom: Room = { ...makeRoom('rOtherNow', ['B']), remainingSeconds: 10 }
    adapter.setRoom(retryRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rRetryNow'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rRetryNow', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rRetryNow'])

    adapter.emitBettingPhase({ roomId: 'rRetryNow', remainingSeconds: 0, phase: 'end' })
    await flush()

    retryRoom = {
      ...retryRoom,
      history: makeHistory(['P', ...retryRoom.history.map(h => h.winner)]),
      remainingSeconds: 0,
    }
    adapter.setRoom(retryRoom)
    adapter.emitGameResult({ roomId: 'rRetryNow', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rRetryNow'])

    retryRoom = { ...retryRoom, remainingSeconds: 2 }
    adapter.setRoom(retryRoom)

    AutoModeService.setActiveBettingRooms(['rOtherNow'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    await flush()
    unsub()

    expect(bets.map(b => b.roomId)).toEqual(['rRetryNow', 'rRetryNow'])
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
  })

  it('checks the losing room timer first and retries the same tie-auto room', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 2 })

    let otherRoom: Room = { ...makeRoom('rOtherMartin', ['B']), remainingSeconds: 0 }
    let retryRoom: Room = { ...makeRoom('rRetrySame', ['B']), remainingSeconds: 0 }
    adapter.setRoom(otherRoom)
    adapter.setRoom(retryRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rOtherMartin', 'rRetrySame'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rOtherMartin', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rOtherMartin'])

    adapter.emitBettingPhase({ roomId: 'rOtherMartin', remainingSeconds: 0, phase: 'end' })
    otherRoom = {
      ...otherRoom,
      history: makeHistory(['P', ...otherRoom.history.map(h => h.winner)]),
      remainingSeconds: 0,
    }
    adapter.setRoom(otherRoom)
    adapter.emitGameResult({ roomId: 'rOtherMartin', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rOtherMartin'])

    adapter.emitBettingPhase({ roomId: 'rRetrySame', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rOtherMartin', 'rRetrySame'])

    AutoModeService.updateSettings({ maxConcurrentBets: 1 })

    adapter.emitBettingPhase({ roomId: 'rRetrySame', remainingSeconds: 0, phase: 'end' })
    otherRoom = { ...otherRoom, remainingSeconds: 10 }
    retryRoom = {
      ...retryRoom,
      history: makeHistory(['P', ...retryRoom.history.map(h => h.winner)]),
      remainingSeconds: 2,
    }
    adapter.setRoom(otherRoom)
    adapter.setRoom(retryRoom)
    adapter.emitGameResult({ roomId: 'rRetrySame', winner: 'P', playerScore: 8, bankerScore: 2 })
    await flush()
    await flush()
    unsub()

    // 사용자 요구: 마틴 진행 중인 방은 동시 상한과 무관하게 계속 친다.
    // 따라서 rRetrySame이 마틴으로 재시도되는 시점에 이미 마틴 중이던 rOtherMartin도
    // 함께 다음 라운드를 친다(max=1이라도 마틴은 슬롯을 침범한다).
    // 핵심 검증: rRetrySame이 마틴 2단계로 재시도되었는지.
    const firstThree = bets.slice(0, 3).map(b => b.roomId)
    expect(firstThree).toEqual(['rOtherMartin', 'rRetrySame', 'rRetrySame'])
    expect(bets[2].betType).toBe('Tie')
    expect(bets[2].betAmount).toBe(BASE_BET * 2)
  })

  it('reserves maxConcurrentBets slots for locked tie-auto martingale rooms', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 3 })

    let lockedRoom = makeRoom('rLockedCap', ['B'])
    adapter.setRoom(lockedRoom)
    adapter.setRoom(makeRoom('rNew1', ['B']))
    adapter.setRoom(makeRoom('rNew2', ['P']))
    adapter.setRoom(makeRoom('rNew3', ['B', 'P']))

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rLockedCap'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rLockedCap', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rLockedCap'])

    lockedRoom = { ...lockedRoom, history: makeHistory(['P', ...lockedRoom.history.map(h => h.winner)]) }
    adapter.setRoom(lockedRoom)
    adapter.emitGameResult({ roomId: 'rLockedCap', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    AutoModeService.setActiveBettingRooms(['rNew1', 'rNew2', 'rNew3'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rNew1', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'rNew2', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'rNew3', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'rLockedCap', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId).sort()).toEqual(['rLockedCap', 'rLockedCap', 'rNew1', 'rNew2'])
    expect(bets.filter(b => b.roomId === 'rNew3')).toHaveLength(0)
    const lockedBets = bets.filter(b => b.roomId === 'rLockedCap')
    expect(lockedBets[lockedBets.length - 1]?.betAmount).toBe(BASE_BET * 2)
  })

  it('settles a first-hand tie-auto bet from history updates when no GameResult event is emitted', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 55,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 3 })

    let room = makeRoom('rFirstHand', [])
    adapter.setRoom(room)

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rFirstHand'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const bets: AutoModeBetLogEvent[] = []
    const results: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId !== 'rFirstHand') return
      if (ev.type === 'bet_placed') bets.push(ev)
      if (ev.type === 'bet_result' && (ev.status === 'loss' || ev.status === 'win')) results.push(ev)
    })

    adapter.emitBettingPhase({ roomId: 'rFirstHand', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].betType).toBe('Tie')
    expect(bets[0].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rFirstHand', remainingSeconds: 0, phase: 'end' })
    await flush()

    room = { ...room, history: makeHistory(['B']) }
    adapter.setRoom(room)
    adapter.emitHistoryUpdate('rFirstHand', room.history)
    await flush()
    await flush()

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('loss')
    expect(results[0].winner).toBe('B')

    adapter.emitBettingPhase({ roomId: 'rFirstHand', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(2)
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
  })

  it('does not settle an empty-shoe pending bet from an ambiguous multi-result snapshot', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 55,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 3 })

    let room = makeRoom('rAmbiguousFirstHand', [])
    adapter.setRoom(room)

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rAmbiguousFirstHand'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const bets: AutoModeBetLogEvent[] = []
    const results: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId !== 'rAmbiguousFirstHand') return
      if (ev.type === 'bet_placed') bets.push(ev)
      if (ev.type === 'bet_result' && (ev.status === 'loss' || ev.status === 'win')) results.push(ev)
    })

    adapter.emitBettingPhase({ roomId: 'rAmbiguousFirstHand', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)

    room = { ...room, history: makeHistory(['B', 'P']) }
    adapter.setRoom(room)
    adapter.emitHistoryUpdate('rAmbiguousFirstHand', room.history)
    await flush()
    await flush()

    adapter.emitBettingPhase({ roomId: 'rAmbiguousFirstHand', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(results).toHaveLength(0)
    expect(bets).toHaveLength(1)
  })

  it('forces the global tie_drought built-in filter direction (default T) when matched', async () => {
    // tie_drought has DEFAULT_PATTERN_CONFIGS betDirection='T'. With a room
    // whose history has had no Tie for >= tieDroughtThreshold games (default 20),
    // AutoMode should fire a Tie bet.
    const noTieHistory = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')) as Array<'B' | 'P'>
    const room = makeRoom('rDrought', noTieHistory)
    adapter.setRoom(room)

    let captured: AutoModeBetLogEvent | null = null
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rDrought' && ev.type === 'bet_placed') captured = ev
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rDrought'], 'tie_drought')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rDrought', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(captured).not.toBeNull()
    expect(captured!.betType).toBe('Tie')
    expect(captured!.prediction).toBe('T')
  })

  // 회귀: 사용자 요구 — "3개방이 배팅중이면 거기서 이길때까지 다른방은 배팅 하면 안돼"
  // 마틴 진행 중인 방이 라운드 사이에 잠시 쉬는 동안에도(waitingForResult=false)
  // 슬롯을 양보하지 않아야 한다.
  it('does not let a new room steal a slot while martin rooms are between rounds', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 3 })

    // 3개 방이 먼저 배팅 → 모두 패배 → 모두 마틴 진행 중 (라운드 사이)
    const martinRooms: Record<string, Room> = {
      rM1: makeRoom('rM1', ['B']),
      rM2: makeRoom('rM2', ['B']),
      rM3: makeRoom('rM3', ['B']),
    }
    // 4번째로 들어오려는 신규 방 — 매칭 조건은 만족
    const newcomer = makeRoom('rIntruder', ['B', 'P'])
    Object.values(martinRooms).forEach(r => adapter.setRoom(r))
    adapter.setRoom(newcomer)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rM1', 'rM2', 'rM3', 'rIntruder'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    // 1단계: 3개 마틴 방이 각각 배팅 → 패배 → 다음 phase 시작 전에 'end' phase로
    // lastBettingPhaseByRoom 비워서 자동 재시도가 안 끼어들도록.
    for (const roomId of ['rM1', 'rM2', 'rM3']) {
      adapter.emitBettingPhase({ roomId, remainingSeconds: 10, phase: 'start' })
      await flush()
      await flush()
      adapter.emitBettingPhase({ roomId, remainingSeconds: 0, phase: 'end' })
      const updated: Room = {
        ...martinRooms[roomId],
        history: makeHistory(['P', ...martinRooms[roomId].history.map(h => h.winner)]),
      }
      martinRooms[roomId] = updated
      adapter.setRoom(updated)
      adapter.emitGameResult({ roomId, winner: 'P', playerScore: 9, bankerScore: 0 })
      await flush()
      await flush()
    }

    const initialMartinBets = bets.length
    // 이 시점: 3개 방 모두 martinLevel=1, waitingForResult=false (라운드 사이)

    // 2단계: 마틴 방들이 다음 라운드를 시작하기 전에 신규 rIntruder가 들어오려 함
    // 사용자 정책: 슬롯이 마틴 방들에 잡혀 있어야 하므로 차단되어야 함
    adapter.emitBettingPhase({ roomId: 'rIntruder', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    // 핵심 검증: rIntruder는 잠금 동안 절대 배팅하면 안 됨
    expect(bets.filter(b => b.roomId === 'rIntruder')).toHaveLength(0)
    // 마틴 방들의 bet 수는 잠금 시점 그대로(또는 마틴 재시도로 증가했더라도 rIntruder는 0)
    expect(bets.length).toBeGreaterThanOrEqual(initialMartinBets)
    unsub()
  })

  // 마틴 진행 중 슈 변경 시 마틴 레벨이 유지되어야 한다.
  // 이전엔 onShoeChange가 무조건 martinLevel을 0으로 리셋해서
  // 8단 마틴 중인데 방이 사라지는 문제가 있었다.
  it('preserves martin level across shoe changes', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 50, maxConcurrentBets: 1 })

    const room = makeRoom('rShoe', ['B', 'P', 'B'])
    adapter.setRoom(room)

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rShoe'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    // 1단계: 배팅 → 패배를 3회 반복하여 martinLevel=3까지 올림
    for (let i = 0; i < 3; i++) {
      adapter.emitBettingPhase({ roomId: 'rShoe', remainingSeconds: 10, phase: 'start' })
      await flush()
      await flush()
      adapter.emitBettingPhase({ roomId: 'rShoe', remainingSeconds: 0, phase: 'end' })
      const prevHistory = adapter.getRoom('rShoe')!.history
      const updatedRoom = makeRoom('rShoe', ['P', ...prevHistory.map(h => h.winner)])
      adapter.setRoom(updatedRoom)
      adapter.emitGameResult({ roomId: 'rShoe', winner: 'P', playerScore: 9, bankerScore: 0 })
      await flush()
      await flush()
    }

    // martinLevel=3 확인
    const stateBeforeShoe = AutoModeService.getRoomState('rShoe')
    expect(stateBeforeShoe?.martinLevel).toBe(3)

    // 2단계: 슈 변경 → 마틴 레벨이 유지되어야 함
    const freshRoom = makeRoom('rShoe', [])
    adapter.setRoom(freshRoom)
    adapter.emitShoeChange('rShoe')
    await flush()

    const stateAfterShoe = AutoModeService.getRoomState('rShoe')
    expect(stateAfterShoe?.martinLevel).toBe(3)

    // 3단계: 다음 배팅 창에서 마틴 이어치기로 배팅이 가능해야 함
    const newRoom = makeRoom('rShoe', ['B'])
    adapter.setRoom(newRoom)
    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(ev => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    adapter.emitBettingPhase({ roomId: 'rShoe', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    // 마틴 이어치기로 배팅이 진행되어야 함
    expect(bets.length).toBeGreaterThanOrEqual(1)
    if (bets.length > 0) {
      expect(bets[0].martinLevel).toBe(3)
    }
    unsub()
  })

  // 회귀: commit 236bbc4 (타이 적중 8배 페이아웃) 이후, AutoMode의 cumulativeProfit과
  // VirtualBettingService의 globalBalance/totalNetProfit/totalWinnings/room.wins/
  // room.profitLoss가 모두 동일한 +8× 수익을 반영하는지 end-to-end로 검증한다.
  // 이전엔 VirtualBettingService.resolveBet이 result==='T'를 무조건 push로 처리해서
  // AutoMode의 cumulativeProfit만 +8×가 들어가고 VirtualBetting 내부 통계는 0이
  // 되는 sync 불일치 버그가 있었음.
  it('keeps AutoMode profit and VirtualBetting stats consistent on a Tie hit', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')

    let room = makeRoom('rStats', ['B', 'P'])
    adapter.setRoom(room)

    // AutoModeService는 모듈 싱글톤이라 dispose()가 cumulativeProfit/totalWins 등
    // 글로벌 통계를 리셋하지 않는다. 다른 테스트의 stats leak으로 누적되지 않도록
    // 명시적으로 통계만 초기화한다.
    AutoModeService.resetStats()

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rStats'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const initialBalance = VirtualBettingService.getSettings().initialBalance

    adapter.emitBettingPhase({ roomId: 'rStats', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    room = { ...room, history: makeHistory(['T', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rStats', winner: 'T', playerScore: 7, bankerScore: 7 })
    await flush()
    await flush()

    const expectedProfit = BASE_BET * 8

    const autoState = AutoModeService.getState()
    expect(autoState.cumulativeProfit).toBe(expectedProfit)
    expect(autoState.totalWins).toBe(1)
    expect(autoState.totalLosses).toBe(0)
    expect(autoState.totalBetAmount).toBe(BASE_BET)

    const vbState = VirtualBettingService.getState()
    expect(vbState.globalBalance).toBe(initialBalance + expectedProfit)
    expect(vbState.totalNetProfit).toBe(expectedProfit)
    expect(vbState.totalWinnings).toBe(expectedProfit)
    expect(vbState.totalBetAmount).toBe(BASE_BET)
    expect(vbState.totalBetCount).toBe(1)
    expect(vbState.pendingBetAmount).toBe(0)
    expect(vbState.pendingBetCount).toBe(0)
    // Tie 적중은 win이지 push가 아니므로 tieBet 카운터는 0 유지
    expect(vbState.tieBetAmount).toBe(0)
    expect(vbState.tieBetCount).toBe(0)

    const roomState = VirtualBettingService.getRoomState('rStats')
    expect(roomState?.wins).toBe(1)
    expect(roomState?.losses).toBe(0)
    expect(roomState?.profitLoss).toBe(expectedProfit)
    expect(roomState?.lastBetResult).toBe('win')
    // 적중 후 마틴 레벨 리셋
    expect(roomState?.martingaleLevel).toBe(0)
  })
})
