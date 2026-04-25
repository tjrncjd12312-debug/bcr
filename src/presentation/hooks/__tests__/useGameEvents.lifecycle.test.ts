// Characterization tests for useGameEvents hook (M1 baseline).
//
// useGameEvents receives all dependencies as props (no Context), so it is
// directly testable with renderHook. These tests pin the CURRENT observable
// behaviour — they're the safety net that later lanes (F1 memoization,
// F4 chart debounce) must keep green.

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Room, RoomPredictionState, VirtualBetSettings } from '../../../domain/entities'
import { useGameEvents } from '../useGameEvents'

function makeOptions(overrides: Partial<Parameters<typeof useGameEvents>[0]> = {}) {
  const virtualSettings: VirtualBetSettings = {
    baseBet: 1000,
    strategy: 'flat',
    maxLevel: 5,
    multiplier: 2,
  } as unknown as VirtualBetSettings

  const rooms = new Map<string, Room>()
  const roomStates = new Map<string, RoomPredictionState>()

  const options: Parameters<typeof useGameEvents>[0] = {
    rooms,
    selectedRoom: null,
    roomStates,
    globalStats: { total: 0, correct: 0, winRate: 0 },
    virtualBettingEnabled: false,
    globalBalance: 0,
    virtualSettings,
    onMultiRoomBetting: vi.fn(),
    onMultiRoomResult: vi.fn(),
    onBettingPhase: vi.fn(() => () => {}),
    onCasinoGameResult: vi.fn(() => () => {}),
    onPrediction: vi.fn(() => () => {}),
    onResult: vi.fn(() => () => {}),
    onBetLog: vi.fn(() => () => {}),
    formatCurrency: (n: number) => `₩${n.toLocaleString()}`,
    getMartingaleLevelText: (level: number) => `L${level}`,
    showDanger: vi.fn(),
    ...overrides,
  }
  return options
}

describe('useGameEvents — lifecycle characterization', () => {
  it('mounts without throwing and exposes the expected result shape', () => {
    const options = makeOptions()
    const { result, unmount } = renderHook(() => useGameEvents(options))

    expect(result.current).toBeDefined()
    expect(result.current.bettingTimer).toBe(0)
    expect(result.current.roomTimers).toBeInstanceOf(Map)
    expect(result.current.flashingRooms).toBeInstanceOf(Set)
    expect(result.current.lastResults).toBeInstanceOf(Map)
    expect(Array.isArray(result.current.chartData)).toBe(true)
    expect(Array.isArray(result.current.logs)).toBe(true)
    expect(typeof result.current.addLog).toBe('function')
    expect(typeof result.current.clearLogs).toBe('function')

    expect(() => unmount()).not.toThrow()
  })

  it('registers one subscription per event callback on mount', () => {
    const options = makeOptions()
    renderHook(() => useGameEvents(options))

    expect(options.onBettingPhase).toHaveBeenCalledTimes(1)
    expect(options.onCasinoGameResult).toHaveBeenCalledTimes(1)
    expect(options.onPrediction).toHaveBeenCalledTimes(1)
    expect(options.onResult).toHaveBeenCalledTimes(1)
  })

  it('addLog / clearLogs work through the exposed actions', () => {
    const options = makeOptions()
    const { result } = renderHook(() => useGameEvents(options))

    act(() => {
      result.current.addLog('hello', 'info')
    })
    expect(result.current.logs.length).toBeGreaterThanOrEqual(1)

    act(() => {
      result.current.clearLogs()
    })
    expect(result.current.logs.length).toBe(0)
  })

  it('unmounts cleanly after log activity (no timer throws)', () => {
    const options = makeOptions()
    const { result, unmount } = renderHook(() => useGameEvents(options))

    act(() => {
      for (let i = 0; i < 20; i++) {
        result.current.addLog(`msg ${i}`, 'info')
      }
    })

    expect(() => unmount()).not.toThrow()
  })
})
