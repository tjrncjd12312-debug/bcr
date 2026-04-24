import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room } from '../../domain/entities'
import type { ICasinoAdapter, IMultiRoomPredictionPort, IRoomFilterUseCase, IVirtualBettingUseCase } from '../../domain/interfaces'
import { container } from '../di/Container'
import MultiRoomPredictionService from './MultiRoomPredictionService'

class MockCasinoAdapter implements ICasinoAdapter {
  readonly name = 'Mock'
  readonly type = 'evolution' as const

  private rooms: Map<string, Room> = new Map()

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

  onRoomUpdate(): () => void {
    return () => {}
  }

  onGameResult(): () => void {
    return () => {}
  }

  onBettingPhase(): () => void {
    return () => {}
  }

  onHistoryUpdate(): () => void {
    return () => {}
  }

  setRoom(room: Room): void {
    this.rooms.set(room.id, room)
  }
}

describe('MultiRoomPredictionService', () => {
  let adapter: MockCasinoAdapter
  const virtualBetting = {
    resetRoom: vi.fn(),
    placeBet: vi.fn(() => true),
    resolveBet: vi.fn(() => null),
  } as unknown as IVirtualBettingUseCase

  beforeEach(() => {
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

    const roomFilterUseCase: IRoomFilterUseCase = {
      getActiveFilters: () => [],
      toggleFilter: () => {},
      setFilters: () => {},
      clearFilters: () => {},
      detectPattern: () => null,
      matchesFilter: () => true,
      onFilterChange: () => () => {},
    }

    container.register('casinoAdapter', adapter as unknown as ICasinoAdapter)
    container.register('multiRoomPredictionPort', predictionPort)
    container.register('roomFilterUseCase', roomFilterUseCase)
    container.register('virtualBettingUseCase', virtualBetting)

    MultiRoomPredictionService.dispose()
  })

  afterEach(() => {
    MultiRoomPredictionService.dispose()
  })

  it('refunds virtual bet on tie results', async () => {
    const room: Room = {
      id: 'room1',
      name: 'Room 1',
      koreanName: 'Room 1',
      history: [
        { winner: 'B', isPlayerPair: false, isBankerPair: false },
        { winner: 'P', isPlayerPair: false, isBankerPair: false },
        { winner: 'B', isPlayerPair: false, isBankerPair: false },
        { winner: 'P', isPlayerPair: false, isBankerPair: false },
        { winner: 'B', isPlayerPair: false, isBankerPair: false },
      ],
      gameCount: 5,
      remainingSeconds: 12,
    }
    adapter.setRoom(room)

    await MultiRoomPredictionService.requestPrediction(room)
    expect(virtualBetting.placeBet).toHaveBeenCalled()

    await MultiRoomPredictionService.onGameResult({ roomId: 'room1', winner: 'T' }, room)

    expect(virtualBetting.resolveBet).toHaveBeenCalledWith('room1', 'Room 1', 'B', 'T')
  })
})
