import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { BettingPhaseEvent, GameResultEvent, RoadResult, Room } from '../../domain/entities'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di/Container'
import AutoModeService from './AutoModeService'
import { VirtualBettingService } from './VirtualBettingService'

class MockCasinoAdapter implements ICasinoAdapter {
  readonly name = 'Mock'
  readonly type = 'evolution' as const

  private rooms: Map<string, Room> = new Map()
  private roomUpdateCallbacks: Array<(rooms: Room[]) => void> = []
  private gameResultCallbacks: Array<(event: GameResultEvent) => void> = []
  private bettingPhaseCallbacks: Array<(event: BettingPhaseEvent) => void> = []
  private historyUpdateCallbacks: Array<(roomId: string, history: RoadResult[]) => void> = []

  async connect(_config: any): Promise<void> {}
  async disconnect(): Promise<void> {
    this.rooms.clear()
  }
  isConnected(): boolean {
    return true
  }

  parseMessage(_raw: string): any {
    return null
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) || null
  }

  getRooms(): Map<string, Room> {
    return this.rooms
  }

  onRoomUpdate(callback: (rooms: Room[]) => void): () => void {
    this.roomUpdateCallbacks.push(callback)
    return () => {
      this.roomUpdateCallbacks = this.roomUpdateCallbacks.filter(cb => cb !== callback)
    }
  }

  onGameResult(callback: (event: GameResultEvent) => void): () => void {
    this.gameResultCallbacks.push(callback)
    return () => {
      this.gameResultCallbacks = this.gameResultCallbacks.filter(cb => cb !== callback)
    }
  }

  onBettingPhase(callback: (event: BettingPhaseEvent) => void): () => void {
    this.bettingPhaseCallbacks.push(callback)
    return () => {
      this.bettingPhaseCallbacks = this.bettingPhaseCallbacks.filter(cb => cb !== callback)
    }
  }

  onHistoryUpdate(callback: (roomId: string, history: RoadResult[]) => void): () => void {
    this.historyUpdateCallbacks.push(callback)
    return () => {
      this.historyUpdateCallbacks = this.historyUpdateCallbacks.filter(cb => cb !== callback)
    }
  }

  setRoom(room: Room): void {
    this.rooms.set(room.id, room)
  }

  emitBettingPhase(event: BettingPhaseEvent): void {
    this.bettingPhaseCallbacks.forEach(cb => cb(event))
  }

  emitGameResult(event: GameResultEvent): void {
    this.gameResultCallbacks.forEach(cb => cb(event))
  }
}

function makeHistory(winners: Array<'B' | 'P' | 'T'>): RoadResult[] {
  return winners.map(winner => ({
    winner,
    isPlayerPair: false,
    isBankerPair: false,
  }))
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('AutoModeService', () => {
  let adapter: MockCasinoAdapter

  beforeEach(() => {
    localStorage.removeItem('smart-helper:auto-mode-settings')

    container.clear()
    adapter = new MockCasinoAdapter()

    const predictionPort: IMultiRoomPredictionPort = {
      requestPredictionForRoom: vi.fn(async (roomId: string) => ({
        roomId,
        prediction: 'B' as const,
        confidence: 0.8,
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

    AutoModeService.dispose()
    AutoModeService.initialize()
    AutoModeService.updateSettings({
      isVirtualMode: true,
      baseBetAmount: 1000,
      winCutAmount: 0,
      lossCutAmount: 0,
    })
  })

  afterEach(() => {
    AutoModeService.stop()
    AutoModeService.dispose()
    VirtualBettingService.disable()
  })

  it('resolves tie results and clears pending virtual bet', async () => {
    const room: Room = {
      id: 'room1',
      name: 'Room 1',
      koreanName: 'Room 1',
      history: makeHistory(['B', 'P', 'B', 'P', 'B']),
      gameCount: 5,
      gameState: {
        playerHand: { score: 0, cards: ['AS', 'KD'] },
        bankerHand: { score: 0, cards: ['2H', '3C'] },
      },
    }
    adapter.setRoom(room)

    AutoModeService.start()
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(VirtualBettingService.getRoomState('room1')?.lastBetResult).toBe('pending')

    // History should advance when a round resolves (newest-first)
    const historyWithTie = [makeHistory(['T'])[0], ...room.history]
    adapter.setRoom({
      ...room,
      history: historyWithTie,
      gameCount: historyWithTie.length,
    })
    adapter.emitGameResult({ roomId: 'room1', winner: 'T' })

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(false)
    expect(AutoModeService.getRoomState('room1')?.lastPrediction).toBe(null)
    expect(VirtualBettingService.getRoomState('room1')?.lastBetResult).toBe('tie')

    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
  })

  it('does not mis-associate stale gameResult when bettingPhase arrives first', async () => {
    const baseHistory = makeHistory(['B', 'P', 'B', 'P', 'B'])
    const room: Room = {
      id: 'room1',
      name: 'Room 1',
      koreanName: 'Room 1',
      history: baseHistory,
      gameCount: baseHistory.length,
      gameState: {
        playerHand: { score: 0, cards: ['AS', 'KD'] },
        bankerHand: { score: 0, cards: ['2H', '3C'] },
      },
    }
    adapter.setRoom(room)

    AutoModeService.start()

    // 1) Place first bet at history length 5
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(AutoModeService.getRoomState('room1')?.lastBetHistoryLength).toBe(5)

    // 2) Simulate new result applied to history BEFORE gameResult event fires
    const historyWithNewResult = [makeHistory(['P'])[0], ...baseHistory]
    adapter.setRoom({
      ...room,
      history: historyWithNewResult,
      gameCount: historyWithNewResult.length,
    })

    // 3) Next betting phase arrives first → should resolve previous bet via history and place next bet
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(AutoModeService.getRoomState('room1')?.lastBetHistoryLength).toBe(6)

    // 4) Stale game result for previous round arrives late → should be ignored for current pending bet
    adapter.emitGameResult({ roomId: 'room1', winner: 'P' })
    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)

    // 5) Actual result for current bet arrives (history length increments again)
    const historyWithAnotherResult = [makeHistory(['B'])[0], ...historyWithNewResult]
    adapter.setRoom({
      ...room,
      history: historyWithAnotherResult,
      gameCount: historyWithAnotherResult.length,
    })
    adapter.emitGameResult({ roomId: 'room1', winner: 'B' })

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(false)
  })

  it('places a bet when enabled mid betting window', async () => {
    const room: Room = {
      id: 'room1',
      name: 'Room 1',
      koreanName: 'Room 1',
      history: makeHistory(['B', 'P', 'B', 'P', 'B']),
      gameCount: 5,
      gameState: {
        playerHand: { score: 0, cards: ['AS', 'KD'] },
        bankerHand: { score: 0, cards: ['2H', '3C'] },
      },
    }
    adapter.setRoom(room)

    // Betting phase arrives while OFF → should cache snapshot but not bet
    AutoModeService.stop()
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()

    expect(AutoModeService.getRoomState('room1')).toBe(null)

    // Turn ON mid countdown → should immediately place a bet using cached snapshot
    AutoModeService.start()
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(VirtualBettingService.getRoomState('room1')?.lastBetResult).toBe('pending')
  })

  it('stops new bets without discarding an accepted real bet result', async () => {
    const room: Room = {
      id: 'room1',
      name: 'Room 1',
      koreanName: 'Room 1',
      history: makeHistory(['B', 'P', 'B', 'P', 'B']),
      gameCount: 5,
      gameState: {
        playerHand: { score: 0, cards: ['AS', 'KD'] },
        bankerHand: { score: 0, cards: ['2H', '3C'] },
      },
    }
    adapter.setRoom(room)

    AutoModeService.start()
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    const pendingState = AutoModeService.getRoomState('room1')
    expect(pendingState?.waitingForResult).toBe(true)

    // The placement path records this flag as false after a confirmed real bet.
    pendingState!.wasVirtualBet = false
    pendingState!.lastBetTime = Date.now() - 20_000
    ;(AutoModeService as unknown as { tryInferPendingResults: () => void }).tryInferPendingResults()
    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)

    const totalBetAmountBeforeReset = AutoModeService.getState().totalBetAmount
    AutoModeService.resetStats()

    expect(AutoModeService.getState().totalBetAmount).toBe(totalBetAmountBeforeReset)
    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(AutoModeService.getState().statusMessage).toBe('통계 초기화 보류 (실베팅 1건 결과 대기)')

    AutoModeService.stop()

    expect(AutoModeService.getSettings().enabled).toBe(false)
    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(AutoModeService.getRoomState('room1')?.lastPrediction?.prediction).toBe('B')
    expect(AutoModeService.getState().statusMessage).toBe('정지됨 (실베팅 1건 결과 대기)')
  })

  it('dispose disables the service and clears its periodic timers', () => {
    const internal = AutoModeService as unknown as {
      diagnosticTimerId: ReturnType<typeof setInterval> | null
      continuousBettingTimerId: ReturnType<typeof setInterval> | null
    }

    AutoModeService.start()
    expect(internal.diagnosticTimerId).not.toBeNull()
    expect(internal.continuousBettingTimerId).not.toBeNull()

    AutoModeService.dispose()

    expect(AutoModeService.getSettings().enabled).toBe(false)
    expect(internal.diagnosticTimerId).toBeNull()
    expect(internal.continuousBettingTimerId).toBeNull()
  })

  // ==================== 가상 모드 보유금 불일치(2026-09-05) ====================

  function makeVirtualRoom(id: string, winners: Array<'B' | 'P' | 'T'> = ['B', 'P', 'B', 'P', 'B']): Room {
    return {
      id,
      name: id,
      koreanName: id,
      history: makeHistory(winners),
      gameCount: winners.length,
      gameState: {
        playerHand: { score: 0, cards: ['AS', 'KD'] },
        bankerHand: { score: 0, cards: ['2H', '3C'] },
      },
    }
  }

  it('keeps the VirtualBettingService balance pending-aware across concurrent virtual bets (가상 보유금 불일치)', async () => {
    AutoModeService.resetStats() // 싱글턴에 남은 이전 테스트의 누적 손익 제거
    const initialBalance = VirtualBettingService.getSettings().initialBalance
    const room1 = makeVirtualRoom('room1')
    const room2 = makeVirtualRoom('room2')
    adapter.setRoom(room1)
    adapter.setRoom(room2)

    AutoModeService.start()
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    adapter.emitBettingPhase({ roomId: 'room2', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(AutoModeService.getRoomState('room2')?.waitingForResult).toBe(true)
    // 두 방 pending 1,000원씩 → 둘 다 차감돼야 한다. 종전엔 두 번째 배팅 직전 동기화(초기+손익)가 첫 방 pending을
    // 되살려 −1,000만 반영됐다(패널은 초기+손익−현재배팅=−2,000 → 불일치).
    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance - 2000)
    expect(VirtualBettingService.getState().pendingBetCount).toBe(2)

    // 배팅창 마감(즉시 재배팅 방지) 후 room1 패배(B 예측, P 결과) → 손익 −1,000, room2는 여전히 pending
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 0, phase: 'end' })
    adapter.emitBettingPhase({ roomId: 'room2', remainingSeconds: 0, phase: 'end' })
    const h1 = [makeHistory(['P'])[0], ...room1.history]
    adapter.setRoom({ ...room1, history: h1, gameCount: h1.length })
    adapter.emitGameResult({ roomId: 'room1', winner: 'P' })

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(false)
    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance - 1000 - 1000)
    expect(VirtualBettingService.getState().pendingBetCount).toBe(1)

    // room2 승리(B, 5% 커미션 → +950) → pending 0, 잔액 = 초기 −1,000 +950
    const h2 = [makeHistory(['B'])[0], ...room2.history]
    adapter.setRoom({ ...room2, history: h2, gameCount: h2.length })
    adapter.emitGameResult({ roomId: 'room2', winner: 'B' })

    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance - 1000 + 950)
    expect(VirtualBettingService.getState().pendingBetCount).toBe(0)
  })

  it('skips a virtual bet once the betting window is closed, like a real bet would be (가상=실제 마감 규칙)', async () => {
    AutoModeService.resetStats()
    const initialBalance = VirtualBettingService.getSettings().initialBalance
    // 서버 마감 시각이 이미 지난 방(BetsClosed 뒤 늦게 도착한 start/poll)
    adapter.setRoom({ ...makeVirtualRoom('room1'), bettingDeadlineAt: Date.now() - 500 })

    AutoModeService.start()
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(false)
    expect(VirtualBettingService.getRoomState('room1')?.lastBetResult ?? 'none').not.toBe('pending')
    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance)

    // 딜링 중(phase=dealing)으로 표시된 방도 같은 규칙으로 스킵
    adapter.setRoom({ ...makeVirtualRoom('room2'), phase: 'dealing' })
    adapter.emitBettingPhase({ roomId: 'room2', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()

    expect(AutoModeService.getRoomState('room2')?.waitingForResult).toBe(false)
    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance)
  })

  it('refunds the VirtualBettingService pending bet when a waiting virtual bet is force-reset', async () => {
    AutoModeService.resetStats()
    const initialBalance = VirtualBettingService.getSettings().initialBalance
    const room = makeVirtualRoom('room1')
    adapter.setRoom(room)

    AutoModeService.start()
    adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
    await flush()
    await flush()
    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance - 1000)

    // 결과가 오지 않는 채로 다음 배팅창 이벤트가 반복(히스토리 미증가) → 5회째 재시도에서 강제 리셋 후 새 배팅.
    for (let i = 0; i < 5; i++) {
      adapter.emitBettingPhase({ roomId: 'room1', remainingSeconds: 10, phase: 'start' })
      await flush()
      await flush()
    }

    // 종전: 옛 pending이 VBS에 남아 새 배팅이 duplicate_bet으로 실패하고, 동기화가 잔액을 초기값으로 되돌려
    //       '배팅 없음 + 잔액 초기값' 상태가 됐다. 이제 옛 pending은 환불되고 새 배팅 1건만 차감된다.
    expect(AutoModeService.getRoomState('room1')?.waitingForResult).toBe(true)
    expect(VirtualBettingService.getState().pendingBetCount).toBe(1)
    expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance - 1000)
  })

})
