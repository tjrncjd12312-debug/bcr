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
import AutoBettingService from './AutoBettingService'
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
  removeRoom(roomId: string): void { this.rooms.delete(roomId) }
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
    AutoModeService.resetStats()
    // 이 스위트는 '타이 자동'의 "슈 시작부터(조기진입)" 모드를 검증한다 — 새 슈
    // 첫 판부터 매칭/배팅. 기본값(구간 다 차면 진입)이 아니라 조기진입으로 고정.
    FilterThresholdsService.set({ tieFrequentRequireFullWindow: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
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

  it('blocks a new matching tie-auto room when one losing martingale room fills the only slot', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let lockedRoom = makeRoom('rOnlySlotA', ['B'])
    const otherRoom = makeRoom('rOnlySlotB', ['P'])
    adapter.setRoom(lockedRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rOnlySlotA', 'rOnlySlotB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rOnlySlotA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rOnlySlotA'])

    adapter.emitBettingPhase({ roomId: 'rOnlySlotB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.filter(b => b.roomId === 'rOnlySlotB')).toHaveLength(0)
    adapter.emitBettingPhase({ roomId: 'rOnlySlotB', remainingSeconds: 0, phase: 'end' })

    adapter.emitBettingPhase({ roomId: 'rOnlySlotA', remainingSeconds: 0, phase: 'end' })
    lockedRoom = {
      ...lockedRoom,
      history: makeHistory(['P', ...lockedRoom.history.map(h => h.winner)]),
    }
    adapter.setRoom(lockedRoom)
    adapter.emitGameResult({ roomId: 'rOnlySlotA', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rOnlySlotA')?.martinLevel).toBe(1)

    AutoModeService.setActiveBettingRooms(['rOnlySlotB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rOnlySlotB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.filter(b => b.roomId === 'rOnlySlotB')).toHaveLength(0)

    adapter.emitBettingPhase({ roomId: 'rOnlySlotA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId)).toEqual(['rOnlySlotA', 'rOnlySlotA'])
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
  })

  it('allows a new matching tie-auto room when a losing martingale room leaves a free slot', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 2 })

    let martinRoom = makeRoom('rFreeSlotA', ['B'])
    const otherRoom = makeRoom('rFreeSlotB', ['P'])
    adapter.setRoom(martinRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rFreeSlotA', 'rFreeSlotB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rFreeSlotA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rFreeSlotA'])

    adapter.emitBettingPhase({ roomId: 'rFreeSlotA', remainingSeconds: 0, phase: 'end' })
    martinRoom = {
      ...martinRoom,
      history: makeHistory(['P', ...martinRoom.history.map(h => h.winner)]),
    }
    adapter.setRoom(martinRoom)
    adapter.emitGameResult({ roomId: 'rFreeSlotA', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rFreeSlotA')?.martinLevel).toBe(1)

    AutoModeService.setActiveBettingRooms(['rFreeSlotB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rFreeSlotB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rFreeSlotA', 'rFreeSlotB'])
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rFreeSlotA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId)).toEqual(['rFreeSlotA', 'rFreeSlotB', 'rFreeSlotA'])
    expect(bets[2].betType).toBe('Tie')
    expect(bets[2].betAmount).toBe(BASE_BET * 2)
  })

  it('allows the same tie-auto room to re-enter after a Tie win when it still matches the condition', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 1,
      tieFrequentMaxCount: 99,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let room = makeRoom('rReenterSame', ['T', 'B', 'P'])
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rReenterSame' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rReenterSame'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rReenterSame', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].betType).toBe('Tie')
    expect(bets[0].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rReenterSame', remainingSeconds: 0, phase: 'end' })
    room = {
      ...room,
      history: makeHistory(['T', ...room.history.map(h => h.winner)]),
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rReenterSame', winner: 'T', playerScore: 6, bankerScore: 6 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rReenterSame')?.martinLevel).toBe(0)

    adapter.emitBettingPhase({ roomId: 'rReenterSame', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(2)
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET)
  })

  it('keeps the user-selected flat strategy for tie-auto instead of forcing martingale', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'flat')
    AutoModeService.updateSettings({ betStrategy: 'flat', maxMartin: 5, maxConcurrentBets: 1 })

    let room = makeRoom('rFlatSetting', ['B'])
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rFlatSetting' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rFlatSetting'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rFlatSetting', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rFlatSetting', remainingSeconds: 0, phase: 'end' })
    room = {
      ...room,
      history: makeHistory(['P', ...room.history.map(h => h.winner)]),
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rFlatSetting', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rFlatSetting')?.martinLevel).toBe(0)

    adapter.emitBettingPhase({ roomId: 'rFlatSetting', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(2)
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET)
  })

  it('keeps a losing tie-auto room locked while using the user-selected custom amount sequence', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', undefined)
    AutoModeService.updateSettings({
      betStrategy: 'custom',
      customBetAmounts: [BASE_BET, BASE_BET * 3, BASE_BET * 7],
      maxMartin: 5,
      maxConcurrentBets: 1,
    })

    let lockedRoom = makeRoom('rCustomA', ['B'])
    const otherRoom = makeRoom('rCustomB', ['P'])
    adapter.setRoom(lockedRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rCustomA', 'rCustomB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rCustomA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rCustomA'])
    expect(bets[0].betType).toBe('Tie')
    expect(bets[0].betAmount).toBe(BASE_BET)

    adapter.emitBettingPhase({ roomId: 'rCustomA', remainingSeconds: 0, phase: 'end' })
    lockedRoom = {
      ...lockedRoom,
      history: makeHistory(['P', ...lockedRoom.history.map(h => h.winner)]),
    }
    adapter.setRoom(lockedRoom)
    adapter.emitGameResult({ roomId: 'rCustomA', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rCustomA')?.martinLevel).toBe(1)

    AutoModeService.setActiveBettingRooms(['rCustomB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rCustomB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.filter(b => b.roomId === 'rCustomB')).toHaveLength(0)

    adapter.emitBettingPhase({ roomId: 'rCustomA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId)).toEqual(['rCustomA', 'rCustomA'])
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET * 3)
  })

  it('keeps the captured custom strategy when the active filter changes during a tie-auto chain', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', undefined)
    PatternBettingService.setBetDirection('banker_dominant', 'B')
    PatternBettingService.setBetStrategy('banker_dominant', 'flat')
    AutoModeService.updateSettings({
      betStrategy: 'custom',
      customBetAmounts: [BASE_BET, BASE_BET * 3],
      maxMartin: 5,
      maxConcurrentBets: 1,
    })

    let room = makeRoom('rStrategyCarry', ['B'])
    adapter.setRoom(room)
    adapter.setRoom(makeRoom('rStrategyOther', ['B', 'B', 'B', 'P']))

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rStrategyCarry'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rStrategyCarry', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rStrategyCarry'])
    expect(bets[0].betAmount).toBe(BASE_BET)

    AutoModeService.setActiveBettingRooms(['rStrategyOther'], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rStrategyCarry', remainingSeconds: 0, phase: 'end' })
    room = {
      ...room,
      history: makeHistory(['P', ...room.history.map(h => h.winner)]),
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rStrategyCarry', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rStrategyCarry')?.martinLevel).toBe(1)

    adapter.emitBettingPhase({ roomId: 'rStrategyCarry', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId)).toEqual(['rStrategyCarry', 'rStrategyCarry'])
    expect(bets[1].betType).toBe('Tie')
    expect(bets[1].betAmount).toBe(BASE_BET * 3)
  })

  it('does not release a stale pending tie-auto slot before history confirms the result', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    const pendingRoom = makeRoom('rPendingStale', ['B'])
    const otherRoom = makeRoom('rPendingOther', ['P'])
    adapter.setRoom(pendingRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rPendingStale', 'rPendingOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rPendingStale', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rPendingStale'])

    const pendingState = AutoModeService.getRoomState('rPendingStale')!
    pendingState.lastBetTime = Date.now() - 60000
    adapter.emitGameResult({ roomId: 'rPendingStale', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    ;(AutoModeService as unknown as { tryInferPendingResults: () => void }).tryInferPendingResults()

    expect(AutoModeService.getRoomState('rPendingStale')?.waitingForResult).toBe(true)

    AutoModeService.setActiveBettingRooms(['rPendingOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId: 'rPendingOther', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.filter(b => b.roomId === 'rPendingOther')).toHaveLength(0)
  })

  it('does not reclaim an old losing martingale slot before a Tie win', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let lockedRoom = makeRoom('rOldMartin', ['B'])
    const otherRoom = makeRoom('rOldMartinOther', ['P'])
    adapter.setRoom(lockedRoom)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rOldMartin', 'rOldMartinOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rOldMartin', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    adapter.emitBettingPhase({ roomId: 'rOldMartin', remainingSeconds: 0, phase: 'end' })
    lockedRoom = {
      ...lockedRoom,
      history: makeHistory(['P', ...lockedRoom.history.map(h => h.winner)]),
    }
    adapter.setRoom(lockedRoom)
    adapter.emitGameResult({ roomId: 'rOldMartin', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()

    const lockedState = AutoModeService.getRoomState('rOldMartin')!
    expect(lockedState.martinLevel).toBe(1)
    lockedState.lastBetTime = Date.now() - 120000
    ;(AutoModeService as unknown as { tryInferPendingResults: () => void }).tryInferPendingResults()

    expect(AutoModeService.getRoomState('rOldMartin')?.martinLevel).toBe(1)

    AutoModeService.setActiveBettingRooms(['rOldMartinOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId: 'rOldMartinOther', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.filter(b => b.roomId === 'rOldMartinOther')).toHaveLength(0)
  })

  it('continues a locked tie-auto martingale room when it disappears from the room list but still emits betting phases', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 10, maxConcurrentBets: 1 })

    let room = makeRoom('rDisappearingMartin', ['B'])
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rDisappearingMartin' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rDisappearingMartin'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    for (let loss = 0; loss < 7; loss++) {
      adapter.emitBettingPhase({ roomId: 'rDisappearingMartin', remainingSeconds: 10, phase: 'start' })
      await flush()
      await flush()
      expect(bets[bets.length - 1]?.betAmount).toBe(BASE_BET * Math.pow(2, loss))

      adapter.emitBettingPhase({ roomId: 'rDisappearingMartin', remainingSeconds: 0, phase: 'end' })
      room = {
        ...room,
        history: makeHistory(['P', ...room.history.map(h => h.winner)]),
      }
      adapter.setRoom(room)
      adapter.emitGameResult({ roomId: 'rDisappearingMartin', winner: 'P', playerScore: 9, bankerScore: 1 })
      await flush()
      await flush()
      expect(AutoModeService.getRoomState('rDisappearingMartin')?.martinLevel).toBe(loss + 1)
    }

    adapter.removeRoom('rDisappearingMartin')
    AutoModeService.setActiveBettingRooms([], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    expect(AutoModeService.getRoomState('rDisappearingMartin')?.martinLevel).toBe(7)

    adapter.emitBettingPhase({ roomId: 'rDisappearingMartin', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(AutoModeService.getRoomState('rDisappearingMartin')?.martinLevel).toBe(7)
    expect(bets).toHaveLength(8)
    expect(bets[7].betType).toBe('Tie')
    expect(bets[7].betAmount).toBe(BASE_BET * 128)
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

  // 회귀(2026-07-07): 사용자 피드백 "타이먹었는데 인식을 못하네". 자동맡기기에서 새 슈(빈 방)
  // 첫 판부터 타이 마틴 중, 타이(배팅 라운드)가 다음 판과 한 로비 업데이트에 묶여(batched)
  // 들어오면 히스토리 최신값이 B/P라 GameResult가 최신 B/P를 실어 보냈고, baseLength===0
  // "ambiguous" 가드가 히스토리 추론을 무조건 null 처리해 → 타이 적중이 '패배'로 정산됐다.
  // 이제 확정 결과 경로(fromConfirmedResult)에서는 빈 방 배팅의 가장 오래된 새 결과(=그
  // 배팅 라운드)로 정산해 타이 적중을 8배 승리로 올바르게 인식한다.
  it('settles a fresh-shoe Tie win even when the tie arrives batched with the next hand', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    adapter.setRoom(makeRoom('rFreshBatched', [])) // 빈 방 = 새 슈 첫 판
    AutoModeService.resetStats()

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rFreshBatched'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    const results: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rFreshBatched' && ev.type === 'bet_result') results.push(ev)
    })

    adapter.emitBettingPhase({ roomId: 'rFreshBatched', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    // 타이(배팅 라운드) + 다음 뱅커가 한 업데이트에 묶여 들어옴 → newest-first ['B','T'].
    const batched = { ...makeRoom('rFreshBatched', ['B', 'T']) }
    adapter.setRoom(batched)
    adapter.emitHistoryUpdate('rFreshBatched', batched.history) // 스냅샷 경로는 가드로 스킵됨
    // 실제 로비처럼 GameResult는 '최신값'(B)을 싣고 온다 — 그래도 배팅 라운드는 타이여야 한다.
    adapter.emitGameResult({ roomId: 'rFreshBatched', winner: 'B', playerScore: 5, bankerScore: 7 })
    await flush()
    await flush()
    unsub()

    const win = results.find(r => r.status === 'win')
    expect(win).toBeTruthy()
    expect(win!.winner).toBe('T')
    expect(win!.profit).toBe(BASE_BET * 8)
    expect(AutoModeService.getRoomState('rFreshBatched')?.martinLevel).toBe(0)
  })

  // 사용자 확인(2026-07-07): "이기면 그 방 나가고 다른 방 체크".
  // 정확 모델: 타이 적중 → 그 방은 필터('지금까지 타이 0개')에서 빠짐 → 패널이 배팅 대상
  // 목록에서 제외(setActiveBettingRooms) → 재배팅 안 하고 다른 매칭 방으로 회전.
  // (새 슈로 히스토리가 리셋되면 다시 매칭돼 재후보 — RoomFilterService 테스트에서 별도 검증)
  it('stops betting a won tie room after the filter drops it (정확 모델 rotation)', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    const roomA = makeRoom('rWonA', ['B', 'P', 'B'])
    adapter.setRoom(roomA)
    adapter.setRoom(makeRoom('rOtherB', ['P', 'B', 'P']))

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rWonA', 'rOtherB'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rWonA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.filter(b => b.roomId === 'rWonA')).toHaveLength(1)

    // 타이 적중 → 마틴 0 리셋. 정확 모델: A가 필터에서 빠짐 → 패널이 목록에서 제외(시뮬레이션).
    adapter.setRoom({ ...roomA, history: makeHistory(['T', 'B', 'P', 'B']) })
    adapter.emitGameResult({ roomId: 'rWonA', winner: 'T', playerScore: 7, bankerScore: 7 })
    await flush()
    await flush()
    expect(AutoModeService.getRoomState('rWonA')?.martinLevel).toBe(0)

    AutoModeService.setActiveBettingRooms(['rOtherB'], 'tie_frequent') // A 필터 탈락 반영
    await flush(FILTER_TRANSITION_WAIT_MS)
    expect(AutoModeService.isRoomEnabled('rWonA')).toBe(false)

    // 같은 방 다음 배팅창 → 재배팅 안 함 (여전히 1건)
    adapter.emitBettingPhase({ roomId: 'rWonA', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.filter(b => b.roomId === 'rWonA')).toHaveLength(1)

    // 다른 매칭 방은 정상 배팅 (회전 대상)
    adapter.emitBettingPhase({ roomId: 'rOtherB', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()
    expect(bets.some(b => b.roomId === 'rOtherB')).toBe(true)
  })

  // 사용자 요청(2026-07-08): "배팅전략을 커스텀으로 하면 거기에 맞게 배팅돼야 함".
  // 전역 전략='custom'이면, 타이 필터의 per-filter 전략이 'martingale'로 잡혀 있어도
  // 커스텀 금액 시퀀스가 우선 적용된다(예전엔 per-filter가 덮어써 base×2^단계로 폭주).
  it('does not re-bet a 1-20 no-tie room after the 21st hand is a Tie before the UI refreshes', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
      tieFrequentRequireFullWindow: true,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let room = makeRoom('rNoTie20', Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')))
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rNoTie20' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rNoTie20'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rNoTie20', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)
    expect(bets[0].betType).toBe('Tie')

    adapter.emitBettingPhase({ roomId: 'rNoTie20', remainingSeconds: 0, phase: 'end' })
    adapter.removeRoom('rNoTie20')
    adapter.emitGameResult({ roomId: 'rNoTie20', winner: 'T', playerScore: 6, bankerScore: 6 })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('rNoTie20')?.martinLevel).toBe(0)

    room = { ...room, remainingSeconds: 10 }
    adapter.setRoom(room)
    adapter.emitBettingPhase({ roomId: 'rNoTie20', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(1)
    expect(AutoModeService.isRoomEnabled('rNoTie20')).toBe(false)
  })

  it('keeps betting a 1-20 no-tie room by custom strategy until a 35th-hand Tie, then rotates away', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
      tieFrequentRequireFullWindow: true,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({
      betStrategy: 'custom',
      customBetAmounts: [
        ...Array(14).fill(BASE_BET),
        BASE_BET * 4,
      ],
      maxMartin: 15,
      maxConcurrentBets: 1,
      tieMaxBetLimit: 0,
    })

    const first20 = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')) as Array<'B' | 'P'>
    let room = makeRoom('rLateTie35', first20)
    const otherRoom = makeRoom('rLateTieOther', Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'P' : 'B')) as Array<'B' | 'P'>)
    adapter.setRoom(room)
    adapter.setRoom(otherRoom)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rLateTie35', 'rLateTieOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rLateTie35', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.map(b => b.roomId)).toEqual(['rLateTie35'])
    expect(bets[0].betAmount).toBe(BASE_BET)

    for (let i = 0; i < 14; i++) {
      const lossWinner = i % 2 === 0 ? 'P' : 'B'
      room = {
        ...room,
        history: makeHistory([lossWinner, ...room.history.map(h => h.winner)]),
      }
      adapter.setRoom(room)
      adapter.emitGameResult({
        roomId: 'rLateTie35',
        winner: lossWinner,
        playerScore: lossWinner === 'P' ? 9 : 1,
        bankerScore: lossWinner === 'B' ? 9 : 1,
      })
      await flush()
      await flush()
    }

    expect(bets.filter(b => b.roomId === 'rLateTie35')).toHaveLength(15)
    expect(bets[14].betAmount).toBe(BASE_BET * 4)

    room = {
      ...room,
      history: makeHistory(['T', ...room.history.map(h => h.winner)]),
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rLateTie35', winner: 'T', playerScore: 6, bankerScore: 6 })
    await flush()
    await flush()

    expect(AutoModeService.getState().tieAutoCompletedRoomIds).toContain('rLateTie35')
    AutoModeService.setActiveBettingRooms(['rLateTie35', 'rLateTieOther'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rLateTie35', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets.filter(b => b.roomId === 'rLateTie35')).toHaveLength(15)

    adapter.emitBettingPhase({ roomId: 'rLateTieOther', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets.map(b => b.roomId)).toEqual([
      ...Array(15).fill('rLateTie35'),
      'rLateTieOther',
    ])
    expect(bets[15].betType).toBe('Tie')
    expect(bets[15].betAmount).toBe(BASE_BET)
  })

  it('allows a completed 1-20 no-tie room to re-enter after shoe reset', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
      tieFrequentRequireFullWindow: true,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    const firstShoe = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')) as Array<'B' | 'P'>
    let room = makeRoom('rNoTieReset', firstShoe)
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rNoTieReset' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rNoTieReset'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rNoTieReset', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)

    adapter.emitBettingPhase({ roomId: 'rNoTieReset', remainingSeconds: 0, phase: 'end' })
    room = {
      ...room,
      history: makeHistory(['T', ...room.history.map(h => h.winner)]),
      remainingSeconds: 10,
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rNoTieReset', winner: 'T', playerScore: 6, bankerScore: 6 })
    await flush()
    await flush()
    expect(AutoModeService.isRoomEnabled('rNoTieReset')).toBe(false)
    expect(AutoModeService.getState().tieAutoCompletedRoomIds).toContain('rNoTieReset')

    adapter.emitShoeChange('rNoTieReset')
    const nextShoe = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'P' : 'B')) as Array<'B' | 'P'>
    room = makeRoom('rNoTieReset', nextShoe)
    adapter.setRoom(room)
    AutoModeService.setActiveBettingRooms(['rNoTieReset'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    expect(AutoModeService.getState().tieAutoCompletedRoomIds).not.toContain('rNoTieReset')
    expect(AutoModeService.isRoomEnabled('rNoTieReset')).toBe(true)

    adapter.emitBettingPhase({ roomId: 'rNoTieReset', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(2)
    expect(bets[1].betType).toBe('Tie')
  })

  it('does not re-bet when a 21st-hand Tie result arrives before history grows', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
      tieFrequentRequireFullWindow: true,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    const noTieHistory = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')) as Array<'B' | 'P'>
    const room = makeRoom('rTieBeforeHistory', noTieHistory)
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rTieBeforeHistory' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rTieBeforeHistory'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rTieBeforeHistory', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets).toHaveLength(1)

    adapter.emitBettingPhase({ roomId: 'rTieBeforeHistory', remainingSeconds: 0, phase: 'end' })
    adapter.emitGameResult({ roomId: 'rTieBeforeHistory', winner: 'T', playerScore: 6, bankerScore: 6 })
    await flush()
    await flush()

    expect(AutoModeService.getState().tieAutoCompletedRoomIds).toContain('rTieBeforeHistory')

    for (let i = 0; i < 5; i++) {
      adapter.emitBettingPhase({ roomId: 'rTieBeforeHistory', remainingSeconds: 10, phase: 'start' })
      await flush()
    }

    AutoModeService.setActiveBettingRooms(['rTieBeforeHistory'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId: 'rTieBeforeHistory', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(1)
    expect(AutoModeService.isRoomEnabled('rTieBeforeHistory')).toBe(false)
  })

  it('keeps a completed no-tie room out when the UI replays the stale active list', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
      tieFrequentRequireFullWindow: true,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let room = makeRoom('rUiReplay', Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')) as Array<'B' | 'P'>)
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rUiReplay' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rUiReplay'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId: 'rUiReplay', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    room = { ...room, history: makeHistory(['T', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rUiReplay', winner: 'T', playerScore: 7, bankerScore: 7 })
    await flush()
    await flush()

    AutoModeService.setActiveBettingRooms(['rUiReplay'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId: 'rUiReplay', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(1)
    expect(AutoModeService.isRoomEnabled('rUiReplay')).toBe(false)
  })

  it('follows updated tie-frequency thresholds even when a room was completed under 0-0', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 20,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
      tieFrequentRequireFullWindow: true,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({ maxMartin: 5, maxConcurrentBets: 1 })

    let room = makeRoom('rThresholdChange', Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'B' : 'P')) as Array<'B' | 'P'>)
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rThresholdChange' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rThresholdChange'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.emitBettingPhase({ roomId: 'rThresholdChange', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    room = { ...room, history: makeHistory(['T', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rThresholdChange', winner: 'T', playerScore: 6, bankerScore: 6 })
    await flush()
    await flush()
    expect(AutoModeService.isRoomEnabled('rThresholdChange')).toBe(false)

    FilterThresholdsService.set({
      tieFrequentMinCount: 1,
      tieFrequentMaxCount: 99,
    })
    AutoModeService.setActiveBettingRooms(['rThresholdChange'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    expect(AutoModeService.isRoomEnabled('rThresholdChange')).toBe(true)
    adapter.emitBettingPhase({ roomId: 'rThresholdChange', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()

    expect(bets).toHaveLength(2)
    expect(bets[1].betType).toBe('Tie')
  })

  it('applies the custom amount sequence even when the tie filter per-strategy is martingale', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    // per-filter 전략을 martingale로 — 전역 custom을 덮어쓰려는 상황(버그 재현 조건)
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({
      betStrategy: 'custom',
      customBetAmounts: [BASE_BET, BASE_BET, BASE_BET * 2], // 1·2단계 base, 3단계 2×base
      maxMartin: 5,
      maxConcurrentBets: 1,
    })

    let room = makeRoom('rCustomWins', ['B'])
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rCustomWins' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rCustomWins'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    // level 0 → custom[0] = base (martingale도 base라 여기선 구분 안 됨)
    adapter.emitBettingPhase({ roomId: 'rCustomWins', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets[0].betAmount).toBe(BASE_BET)

    // 패배 → level 1 → custom[1] = base (martingale이면 base×2)
    room = { ...room, history: makeHistory(['P', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rCustomWins', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()
    adapter.emitBettingPhase({ roomId: 'rCustomWins', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets[1].betAmount).toBe(BASE_BET) // custom, NOT base×2

    // 패배 → level 2 → custom[2] = 2×base (martingale이면 base×4)
    room = { ...room, history: makeHistory(['B', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rCustomWins', winner: 'B', playerScore: 1, bankerScore: 9 })
    await flush()
    await flush()
    adapter.emitBettingPhase({ roomId: 'rCustomWins', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()
    expect(bets[2].betAmount).toBe(BASE_BET * 2) // custom, NOT base×4
  })

  // 🆕 적대적 검증 회귀 (2026-07-08): martingale로 돌던 방을 라이브로 'custom'으로 바꾸면
  // 즉시 커스텀 금액을 써야 한다. 예전 버그: 방이 첫 배팅에서 martinRecoveryStrategy='martingale'을
  // 굳혀, 전환 뒤에도 resolveRoomProgressionStrategy가 그 stale 값에 `??`로 단락되어
  // base×2^단계(마틴)로 폭주했다. 통과하던 기존 테스트는 처음부터 custom이라 이 경로를 못 탔다.
  it('switches a mid-martingale room to the custom amount sequence when strategy is changed live', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    // 시작은 전역 martingale (사용자가 기본 전략으로 타이 자동을 돌리던 상황)
    AutoModeService.updateSettings({
      betStrategy: 'martingale',
      baseBetAmount: BASE_BET,
      maxMartin: 5,
      maxConcurrentBets: 1,
    })

    let room = makeRoom('rLiveSwitch', ['B'])
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rLiveSwitch' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rLiveSwitch'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    // 첫 배팅(level 0, 전역 martingale): 방이 martinRecoveryStrategy='martingale' 캡처
    adapter.emitBettingPhase({ roomId: 'rLiveSwitch', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets[0].betAmount).toBe(BASE_BET)
    // 버그 재현 전제 확인: 방이 실제로 'martingale'을 굳혔다
    expect(AutoModeService.getRoomState('rLiveSwitch')?.martinRecoveryStrategy).toBe('martingale')

    // 🔧 라이브로 custom 전환 (정지 없이) — 이후 모든 배팅은 custom 시퀀스여야 한다.
    // 구분 가능한 배수 [1,3,7]로: level1 custom=3×base(마틴이면 2×base), level2 custom=7×base(마틴 4×base).
    AutoModeService.updateSettings({
      betStrategy: 'custom',
      customBetAmounts: [BASE_BET, BASE_BET * 3, BASE_BET * 7],
    })

    // 패배 → level 1 (패배 시 즉시 이어가기 배팅이 GameResult에서 나감)
    room = { ...room, history: makeHistory(['P', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rLiveSwitch', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()
    adapter.emitBettingPhase({ roomId: 'rLiveSwitch', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(bets[1].betAmount).toBe(BASE_BET * 3) // custom[1], NOT 마틴 2×base

    // 패배 → level 2 → custom[2] = 7×base (버그면 마틴 4×base)
    room = { ...room, history: makeHistory(['B', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rLiveSwitch', winner: 'B', playerScore: 1, bankerScore: 9 })
    await flush()
    await flush()
    adapter.emitBettingPhase({ roomId: 'rLiveSwitch', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    unsub()
    expect(bets[2].betAmount).toBe(BASE_BET * 7) // custom[2], NOT 마틴 4×base
  })

  it('uses the configured custom 8th-stage amount for tie-auto bets', async () => {
    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')

    AutoModeService.updateSettings({
      betStrategy: 'custom',
      baseBetAmount: BASE_BET,
      customBetAmounts: [
        ...Array(7).fill(BASE_BET),
        ...Array(9).fill(BASE_BET * 2),
      ],
      maxMartin: 16,
      maxConcurrentBets: 1,
      tieMaxBetLimit: 0,
    })

    let room = makeRoom('rCustomStage8', ['B'])
    adapter.setRoom(room)

    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rCustomStage8' && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start()
    AutoModeService.setActiveBettingRooms(['rCustomStage8'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rCustomStage8', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    for (let i = 0; i < 7; i++) {
      room = {
        ...room,
        history: makeHistory(['P', ...room.history.map(h => h.winner)]),
      }
      adapter.setRoom(room)
      adapter.emitGameResult({ roomId: 'rCustomStage8', winner: 'P', playerScore: 9, bankerScore: 1 })
      await flush()
      await flush()
    }

    unsub()

    expect(bets).toHaveLength(8)
    expect(bets.slice(0, 7).every(b => b.betAmount === BASE_BET)).toBe(true)
    expect(bets[7].martinLevel).toBe(7)
    expect(bets[7].betType).toBe('Tie')
    expect(bets[7].betAmount).toBe(BASE_BET * 2)
  })

  it('keeps an unknown real placement pending until resolved explicitly accepts it', async () => {
    const placeSpy = vi.spyOn(AutoBettingService, 'placeBet')
      .mockResolvedValue({ success: false, placementStatus: 'unknown', error: 'confirmation-timeout' })

    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    AutoModeService.updateSettings({
      isVirtualMode: false,
      baseBetAmount: BASE_BET,
      maxMartin: 2,
      maxConcurrentBets: 1,
      tieMaxBetLimit: 0,
    })

    let room = { ...makeRoom('rUnknownPlacement', ['B']), lastResultTime: Date.now() }
    adapter.setRoom(room)
    AutoModeService.start(100000)
    AutoModeService.setActiveBettingRooms(['rUnknownPlacement'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rUnknownPlacement', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(placeSpy).toHaveBeenCalledTimes(1)
    expect(AutoModeService.getRoomState('rUnknownPlacement')).toMatchObject({
      waitingForResult: true,
      placementStatus: 'unknown',
    })

    room = { ...room, history: makeHistory(['P', ...room.history.map(h => h.winner)]) }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rUnknownPlacement', winner: 'P' })
    expect(AutoModeService.getRoomState('rUnknownPlacement')?.waitingForResult).toBe(true)
    expect(AutoModeService.getState().cumulativeProfit).toBe(0)

    adapter.emitGameResult({
      roomId: 'rUnknownPlacement',
      winner: 'P',
      betOutcome: { acceptedBets: { Tie: BASE_BET }, rejectedBets: {} },
    })
    expect(AutoModeService.getRoomState('rUnknownPlacement')?.waitingForResult).toBe(false)
    expect(AutoModeService.getState().cumulativeProfit).toBe(-BASE_BET)

    placeSpy.mockRestore()
  })

  it('keeps real pending tie bets until a confirmed result settles them', async () => {
    const placeSpy = vi.spyOn(AutoBettingService, 'placeBet')
      .mockResolvedValue({ success: true, placementStatus: 'confirmed' })

    FilterThresholdsService.set({
      tieFrequentStart: 1,
      tieFrequentWindow: 5,
      tieFrequentMinCount: 0,
      tieFrequentMaxCount: 0,
    })
    PatternBettingService.setBetDirection('tie_frequent', 'T')
    PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    AutoModeService.updateSettings({
      isVirtualMode: false,
      betStrategy: 'custom',
      baseBetAmount: BASE_BET,
      customBetAmounts: [BASE_BET, BASE_BET * 2],
      maxMartin: 2,
      maxConcurrentBets: 1,
      tieMaxBetLimit: 0,
    })

    let room = {
      ...makeRoom('rRealPending', ['B']),
      lastResultTime: Date.now(),
    }
    adapter.setRoom(room)

    const results: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog((ev) => {
      if (ev.roomId === 'rRealPending' && ev.type === 'bet_result') results.push(ev)
    })

    AutoModeService.start(100000)
    AutoModeService.setActiveBettingRooms(['rRealPending'], 'tie_frequent')
    await flush(FILTER_TRANSITION_WAIT_MS)

    adapter.emitBettingPhase({ roomId: 'rRealPending', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(placeSpy).toHaveBeenCalledTimes(1)
    expect(AutoModeService.getRoomState('rRealPending')?.waitingForResult).toBe(true)

    for (let i = 0; i < 5; i++) {
      adapter.emitBettingPhase({ roomId: 'rRealPending', remainingSeconds: 10, phase: 'start' })
      await flush()
      await flush()
    }

    expect(AutoModeService.getRoomState('rRealPending')?.waitingForResult).toBe(true)

    room = {
      ...room,
      history: makeHistory(['P', ...room.history.map(h => h.winner)]),
    }
    adapter.setRoom(room)
    adapter.emitGameResult({ roomId: 'rRealPending', winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush()
    await flush()
    unsub()

    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('loss')
    expect(results[0].profit).toBe(-BASE_BET)
    expect(AutoModeService.getState().cumulativeProfit).toBe(-BASE_BET)

    placeSpy.mockRestore()
  })
})
