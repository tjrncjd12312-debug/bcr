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

  // 사용자 시나리오: "그방에서 성공하면 같은 필터 조건을 물색해서 똑같이 마틴쳐야함"
  // 흐름:
  //   1) 두 방 A, B 모두 tie_frequent(0~0, 처음 5판) 매칭
  //   2) A에 베팅 진행 → A는 락 (waitingForResult)
  //   3) A의 같은 시점 B에는 BettingPhase 와도 락에 막혀 베팅 안 됨
  //   4) A에 타이 결과 → A 적중, martinLevel 리셋, A 히스토리에 T 추가되어 필터 깨짐
  //   5) 락 해제 후 B의 BettingPhase → 같은 필터 매칭하므로 B에 새 마틴 시작
  it('after a win in the locked room, the next BettingPhase from another matching room starts a fresh martingale there', async () => {
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
    expect(bBets).toHaveLength(0)

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
})
