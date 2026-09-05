// 마틴 이어치기 ↔ 패턴 묶음(2026-09-05 사용자: "패턴 설정 시 마틴을 설정하더라도 그 패턴에만 배팅돼야 해").
//   martinRequiresPattern=true(기본): 졌던 방은 단계를 기억하되 패턴이 다시 맞는 판에만 다음 단계 금액으로 배팅.
//   false: 예전처럼 패턴과 무관하게 같은 방향으로 매판 이어치기.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { BettingPhaseEvent, GameResultEvent, RoadResult, Room } from '../../domain/entities'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di/Container'
import AutoModeService, { type AutoModeBetLogEvent } from './AutoModeService'
import { VirtualBettingService } from './VirtualBettingService'
import { PatternBettingService } from './PatternBettingService'
import { CustomPatternService } from './CustomPatternService'

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
  onShoeChange(): () => void { return () => {} }
  emitBettingPhase(e: BettingPhaseEvent): void { this.bettingPhaseCallbacks.forEach(cb => cb(e)) }
  emitGameResult(e: GameResultEvent): void { this.gameResultCallbacks.forEach(cb => cb(e)) }
}

function makeHistory(winners: Array<'B' | 'P' | 'T'>): RoadResult[] {
  return winners.map(w => ({ winner: w, isPlayerPair: false, isBankerPair: false }))
}
function makeRoom(id: string, winners: Array<'B' | 'P' | 'T'>): Room {
  const history = makeHistory(winners)
  return {
    id, name: id, koreanName: id, history, gameCount: history.length,
    gameState: { playerHand: { score: 0, cards: ['AS', 'KD'] }, bankerHand: { score: 0, cards: ['2H', '3C'] } },
  }
}
const flush = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))
const BASE_BET = 1000
const FILTER_TRANSITION_WAIT_MS = 220

// 최근 10판 B > P 이고 5판 이상 → banker_dominant 매칭. P가 더 많으면 미매칭.
const BANKER_HEAVY: Array<'B' | 'P'> = ['B', 'B', 'B', 'P', 'B', 'B']
const PLAYER_HEAVY: Array<'B' | 'P'> = ['P', 'P', 'P', 'B', 'P', 'P']

describe('AutoModeService — 마틴 이어치기와 패턴 묶음', () => {
  let adapter: MockCasinoAdapter
  let predictionPort: IMultiRoomPredictionPort
  const ROOM = 'rPattern'

  async function betOnceAndLose(): Promise<void> {
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 10, phase: 'start' })
    await flush(); await flush()
    // 배팅창을 닫고 나서 결과를 준다(안 닫으면 결과 처리 직후 열린 창으로 다시 배팅한다)
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 0, phase: 'end' })
    const prev = adapter.getRoom(ROOM)!.history.map(h => h.winner)
    // B에 걸었으니 P가 나오면 패배
    adapter.setRoom(makeRoom(ROOM, ['P', ...prev]))
    adapter.emitGameResult({ roomId: ROOM, winner: 'P', playerScore: 9, bankerScore: 1 })
    await flush(); await flush()
  }

  beforeEach(() => {
    localStorage.clear()
    container.clear()
    adapter = new MockCasinoAdapter()
    predictionPort = {
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
      isVirtualMode: true, baseBetAmount: BASE_BET, betStrategy: 'martingale', maxMartin: 5,
      maxConcurrentBets: 0, winCutAmount: 0, lossCutAmount: 0, martinRequiresPattern: true,
    })
    AutoModeService.resetStats()
    PatternBettingService.setBetDirection('banker_dominant', 'B')
    PatternBettingService.setBetStrategy('banker_dominant', 'martingale')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    AutoModeService.stop()
    AutoModeService.dispose()
    VirtualBettingService.disable()
    PatternBettingService.dispose()
    CustomPatternService.clear()
  })

  it('기본값: 마틴 중 패턴이 안 맞는 판은 건너뛰고(단계 유지), 다시 맞는 판에 다음 단계 금액으로 배팅한다', async () => {
    adapter.setRoom(makeRoom(ROOM, BANKER_HEAVY))
    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(ev => {
      if (ev.roomId !== ROOM) return
      if (ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start(100000)
    AutoModeService.setActiveBettingRooms([ROOM], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    // 1) 패턴 매칭 → B 1,000원 → 패배 → 마틴 1단계
    await betOnceAndLose()
    expect(bets).toHaveLength(1)
    expect(bets[0].betAmount).toBe(BASE_BET)
    expect(AutoModeService.getRoomState(ROOM)?.martinLevel).toBe(1)

    // 2) 히스토리가 P 우세로 바뀜 → 패턴 미매칭 → 배팅 없음, 단계는 그대로
    adapter.setRoom(makeRoom(ROOM, PLAYER_HEAVY))
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 10, phase: 'start' })
    await flush(); await flush()
    expect(bets).toHaveLength(1)
    expect(AutoModeService.getRoomState(ROOM)?.martinLevel).toBe(1)
    expect(AutoModeService.getRoomState(ROOM)?.waitingForResult).toBe(false)
    expect(AutoModeService.getRoomState(ROOM)?.patternWait).toBe(true)

    // 3) 다시 B 우세 → 패턴 매칭 → 2단계 금액(2,000원)으로 배팅
    adapter.setRoom(makeRoom(ROOM, BANKER_HEAVY))
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 10, phase: 'start' })
    await flush(); await flush()
    expect(bets).toHaveLength(2)
    expect(bets[1].martinLevel).toBe(1)
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
    expect(bets[1].prediction).toBe('B')
    expect(AutoModeService.getRoomState(ROOM)?.patternWait).toBe(false)
    unsub()
  })

  it('martinRequiresPattern=false: 예전처럼 패턴과 무관하게 같은 방향으로 매판 이어친다', async () => {
    AutoModeService.updateSettings({ martinRequiresPattern: false })
    adapter.setRoom(makeRoom(ROOM, BANKER_HEAVY))
    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(ev => {
      if (ev.roomId === ROOM && ev.type === 'bet_placed') bets.push(ev)
    })

    AutoModeService.start(100000)
    AutoModeService.setActiveBettingRooms([ROOM], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)

    await betOnceAndLose()
    expect(bets).toHaveLength(1)

    adapter.setRoom(makeRoom(ROOM, PLAYER_HEAVY))
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 10, phase: 'start' })
    await flush(); await flush()
    expect(bets).toHaveLength(2)
    expect(bets[1].martinLevel).toBe(1)
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
    expect(bets[1].prediction).toBe('B')
    unsub()
  })

  it('체인 중 필터를 바꿔도 그 방은 체인을 시작한 패턴으로 판정한다', async () => {
    PatternBettingService.setBetDirection('player_dominant', 'P')
    adapter.setRoom(makeRoom(ROOM, BANKER_HEAVY))
    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(ev => {
      if (ev.roomId === ROOM && ev.type === 'bet_placed') bets.push(ev)
    })
    AutoModeService.start(100000)
    AutoModeService.setActiveBettingRooms([ROOM], 'banker_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)
    await betOnceAndLose()
    expect(bets).toHaveLength(1)
    expect(AutoModeService.getRoomState(ROOM)?.martinChainFilter).toBe('banker_dominant')

    // 사용자가 P우세로 필터를 바꿈 — 이 방은 마틴 잠금이라 대상에 남고, 판정은 B우세(체인 시작 패턴)로 한다
    AutoModeService.setActiveBettingRooms([], 'player_dominant')
    await flush(FILTER_TRANSITION_WAIT_MS)
    adapter.setRoom(makeRoom(ROOM, BANKER_HEAVY)) // B우세는 맞고 P우세는 안 맞는 히스토리
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 10, phase: 'start' })
    await flush(); await flush()
    expect(bets).toHaveLength(2)
    expect(bets[1].prediction).toBe('B')
    expect(bets[1].betAmount).toBe(BASE_BET * 2)
    unsub()
  })

  it('전체(all·패턴 없음)에서 시작한 체인은 옵션과 무관하게 같은 방향으로 이어친다', async () => {
    // all 필터는 AI 예측 경로 — 포트가 첫 판에 B를 주고 그 뒤로는 P를 줘도 이어치기는 B로 고정돼야 한다
    let call = 0
    ;(predictionPort.requestPredictionForRoom as ReturnType<typeof vi.fn>).mockImplementation(async (roomId: string) => ({
      roomId, prediction: call++ === 0 ? 'B' : 'P', confidence: 80, reasoning: 'ai', isSkip: false, timestamp: Date.now(),
    }))
    adapter.setRoom(makeRoom(ROOM, BANKER_HEAVY))
    const bets: AutoModeBetLogEvent[] = []
    const unsub = AutoModeService.onBetLog(ev => {
      if (ev.roomId === ROOM && ev.type === 'bet_placed') bets.push(ev)
    })
    AutoModeService.start(100000)
    AutoModeService.setActiveBettingRooms([ROOM], 'all')
    await flush(FILTER_TRANSITION_WAIT_MS)
    await betOnceAndLose()
    expect(bets).toHaveLength(1)
    expect(bets[0].prediction).toBe('B')
    expect(AutoModeService.getRoomState(ROOM)?.martinChainFilter).toBe('all')

    adapter.setRoom(makeRoom(ROOM, PLAYER_HEAVY))
    adapter.emitBettingPhase({ roomId: ROOM, remainingSeconds: 10, phase: 'start' })
    await flush(); await flush()
    expect(bets).toHaveLength(2)
    expect(bets[1].martinLevel).toBe(1)
    expect(bets[1].prediction).toBe('B')
    unsub()
  })
})
