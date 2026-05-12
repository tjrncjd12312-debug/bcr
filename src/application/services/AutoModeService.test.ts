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

})
