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

  // ─────────────── Characterization tests (M1 baseline) ───────────────
  // Pin current observable behaviour so later lanes (F1 memoization,
  // F3 history eviction) can refactor without silently breaking flows.
  // Every assertion below describes the state of the code as of the
  // baseline PR — failing any of these is a regression signal.

  it('dispose is idempotent — safe to call before and after work', async () => {
    expect(() => MultiRoomPredictionService.dispose()).not.toThrow()

    const room: Room = {
      id: 'roomA',
      name: 'Room A',
      koreanName: 'Room A',
      history: [
        { winner: 'B', isPlayerPair: false, isBankerPair: false },
        { winner: 'P', isPlayerPair: false, isBankerPair: false },
      ],
      gameCount: 2,
      remainingSeconds: 12,
    }
    adapter.setRoom(room)
    await MultiRoomPredictionService.requestPrediction(room)

    expect(() => MultiRoomPredictionService.dispose()).not.toThrow()
    expect(() => MultiRoomPredictionService.dispose()).not.toThrow()
  })

  it('tolerates onGameResult for a room without an outstanding prediction', async () => {
    const room: Room = {
      id: 'orphan',
      name: 'Orphan',
      koreanName: 'Orphan',
      history: [
        { winner: 'B', isPlayerPair: false, isBankerPair: false },
      ],
      gameCount: 1,
      remainingSeconds: 12,
    }
    adapter.setRoom(room)

    await expect(
      MultiRoomPredictionService.onGameResult({ roomId: 'orphan', winner: 'B' }, room),
    ).resolves.not.toThrow()
  })

  describe('syncActiveRooms eviction (Lane F3)', () => {
    async function seedRooms(count: number): Promise<Room[]> {
      const rooms: Room[] = []
      for (let i = 0; i < count; i++) {
        const r: Room = {
          id: `room${i}`,
          name: `Room ${i}`,
          koreanName: `Room ${i}`,
          history: Array.from({ length: 10 }, (_, j) => ({
            winner: (['B', 'P', 'T'] as const)[j % 3],
            isPlayerPair: false,
            isBankerPair: false,
          })),
          gameCount: 10,
          remainingSeconds: 12,
        }
        adapter.setRoom(r)
        await MultiRoomPredictionService.requestPrediction(r)
        rooms.push(r)
      }
      return rooms
    }

    it('evicts room state for rooms outside the active set', async () => {
      await seedRooms(5)
      const allStates = MultiRoomPredictionService.getAllRoomStates()
      expect(allStates.size).toBe(5)

      MultiRoomPredictionService.syncActiveRooms(new Set(['room1', 'room2']))

      const remaining = MultiRoomPredictionService.getAllRoomStates()
      expect(remaining.size).toBe(2)
      expect(remaining.has('room1')).toBe(true)
      expect(remaining.has('room2')).toBe(true)
      expect(remaining.has('room0')).toBe(false)
      expect(remaining.has('room3')).toBe(false)
      expect(remaining.has('room4')).toBe(false)
    })

    it('is idempotent — calling twice with the same set is a no-op', async () => {
      await seedRooms(3)

      const stateChanges = vi.fn()
      const unsub = MultiRoomPredictionService.onStateChange(stateChanges)

      MultiRoomPredictionService.syncActiveRooms(new Set(['room0']))
      const firstCallCount = stateChanges.mock.calls.length

      MultiRoomPredictionService.syncActiveRooms(new Set(['room0']))
      const secondCallCount = stateChanges.mock.calls.length

      expect(secondCallCount).toBe(firstCallCount)
      expect(MultiRoomPredictionService.getAllRoomStates().size).toBe(1)

      unsub()
    })

    it('clears everything when the active set is empty', async () => {
      await seedRooms(4)
      expect(MultiRoomPredictionService.getAllRoomStates().size).toBe(4)

      MultiRoomPredictionService.syncActiveRooms(new Set())

      expect(MultiRoomPredictionService.getAllRoomStates().size).toBe(0)
    })

    it('emits a state change only when at least one entry is evicted', async () => {
      await seedRooms(2)

      const stateChanges = vi.fn()
      const unsub = MultiRoomPredictionService.onStateChange(stateChanges)

      // All active -> no eviction -> no extra emit
      const before = stateChanges.mock.calls.length
      MultiRoomPredictionService.syncActiveRooms(new Set(['room0', 'room1']))
      expect(stateChanges.mock.calls.length).toBe(before)

      // Drop one -> eviction -> emit
      MultiRoomPredictionService.syncActiveRooms(new Set(['room0']))
      expect(stateChanges.mock.calls.length).toBeGreaterThan(before)

      unsub()
    })
  })

  it('handles concurrent predictions across multiple rooms', async () => {
    const rooms: Room[] = []
    for (let i = 0; i < 5; i++) {
      const r: Room = {
        id: `room${i}`,
        name: `Room ${i}`,
        koreanName: `Room ${i}`,
        history: Array.from({ length: 10 }, (_, j) => ({
          winner: (['B', 'P', 'T'] as const)[j % 3],
          isPlayerPair: false,
          isBankerPair: false,
        })),
        gameCount: 10,
        remainingSeconds: 12,
      }
      adapter.setRoom(r)
      rooms.push(r)
    }

    const results = await Promise.all(
      rooms.map(r => MultiRoomPredictionService.requestPrediction(r)),
    )
    expect(results).toHaveLength(5)
  })
})
