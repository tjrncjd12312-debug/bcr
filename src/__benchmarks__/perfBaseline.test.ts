// Performance baseline micro-benches for the frontend service layer.
//
// Runs under vitest (`npm run test:run`) so the same harness reports timings.
// These are NOT accuracy tests — they fail only on crash, not on perf regression.
// Timings are printed to stdout; record them in `.forge/perf-plan/baseline.md`.
//
// Scope: pure TypeScript hot paths. The React tree / Profiler-level
// measurements are documented as a manual procedure in baseline.md.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room, RoadResult } from '../domain/entities'
import type {
  ICasinoAdapter,
  IMultiRoomPredictionPort,
  IRoomFilterUseCase,
  IVirtualBettingUseCase,
} from '../domain/interfaces'
import { container } from '../application/di/Container'
import MultiRoomPredictionService from '../application/services/MultiRoomPredictionService'

class MinimalAdapter implements ICasinoAdapter {
  readonly name = 'Bench'
  readonly type = 'evolution' as const
  private rooms: Map<string, Room> = new Map()
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> { this.rooms.clear() }
  isConnected(): boolean { return true }
  parseMessage(): any { return null }
  getRoom(id: string): Room | null { return this.rooms.get(id) || null }
  getRooms(): Map<string, Room> { return this.rooms }
  onRoomUpdate(): () => void { return () => {} }
  onGameResult(): () => void { return () => {} }
  onBettingPhase(): () => void { return () => {} }
  onHistoryUpdate(): () => void { return () => {} }
  setRoom(room: Room): void { this.rooms.set(room.id, room) }
}

function makeHistory(n: number): RoadResult[] {
  const out: RoadResult[] = []
  for (let i = 0; i < n; i++) {
    const winners: Array<'B' | 'P' | 'T'> = ['B', 'P', 'T']
    out.push({
      winner: winners[i % 3],
      isPlayerPair: i % 5 === 0,
      isBankerPair: i % 7 === 0,
    })
  }
  return out
}

function makeRoom(id: string, historyLength: number): Room {
  return {
    id,
    name: id,
    koreanName: id,
    history: makeHistory(historyLength),
    gameCount: historyLength,
    remainingSeconds: 12,
  }
}

function ms(label: string, start: number, end: number, iterations: number) {
  const totalMs = end - start
  const perOp = totalMs / iterations
  // eslint-disable-next-line no-console
  console.log(
    `[bench] ${label}: total=${totalMs.toFixed(2)}ms, ops=${iterations}, per_op=${perOp.toFixed(4)}ms`
  )
}

describe('perf baseline (record to .forge/perf-plan/baseline.md)', () => {
  let adapter: MinimalAdapter
  const virtualBetting = {
    resetRoom: vi.fn(),
    placeBet: vi.fn(() => true),
    resolveBet: vi.fn(() => null),
  } as unknown as IVirtualBettingUseCase

  beforeEach(() => {
    container.clear()
    adapter = new MinimalAdapter()

    const predictionPort: IMultiRoomPredictionPort = {
      requestPredictionForRoom: vi.fn(async (roomId: string) => ({
        roomId,
        prediction: 'B' as const,
        confidence: 0.8,
        reasoning: 'bench',
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

  it('requestPrediction p50 over 30-room × 10-round workload', async () => {
    const ROOMS = 30
    const ROUNDS_PER_ROOM = 10
    const rooms: Room[] = []
    for (let i = 0; i < ROOMS; i++) {
      const room = makeRoom(`room${i}`, 80)
      adapter.setRoom(room)
      rooms.push(room)
    }

    const timings: number[] = []
    for (let round = 0; round < ROUNDS_PER_ROOM; round++) {
      for (const room of rooms) {
        const t0 = performance.now()
        await MultiRoomPredictionService.requestPrediction(room)
        timings.push(performance.now() - t0)
      }
    }

    timings.sort((a, b) => a - b)
    const p50 = timings[Math.floor(timings.length * 0.5)]
    const p95 = timings[Math.floor(timings.length * 0.95)]
    // eslint-disable-next-line no-console
    console.log(
      `[bench] requestPrediction: samples=${timings.length}, p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms`
    )

    expect(timings.length).toBe(ROOMS * ROUNDS_PER_ROOM)
  })

  it('onGameResult throughput — 30 rooms × 20 results', async () => {
    const ROOMS = 30
    const RESULTS_PER_ROOM = 20
    const rooms: Room[] = []
    for (let i = 0; i < ROOMS; i++) {
      const room = makeRoom(`room${i}`, 80)
      adapter.setRoom(room)
      rooms.push(room)
    }

    const start = performance.now()
    for (let r = 0; r < RESULTS_PER_ROOM; r++) {
      for (const room of rooms) {
        await MultiRoomPredictionService.onGameResult(
          { roomId: room.id, winner: 'B' },
          room
        )
      }
    }
    const end = performance.now()

    ms('onGameResult', start, end, ROOMS * RESULTS_PER_ROOM)
    expect(end).toBeGreaterThan(start)
  })

  it('dispose does not throw after active workload', async () => {
    const room = makeRoom('r0', 100)
    adapter.setRoom(room)
    await MultiRoomPredictionService.requestPrediction(room)
    await MultiRoomPredictionService.onGameResult(
      { roomId: 'r0', winner: 'B' },
      room
    )
    expect(() => MultiRoomPredictionService.dispose()).not.toThrow()
  })
})
