// PatternBettingService tests — focused on the per-filter strategy override
// that backs PatternBetStrategySelect and is read by AutoModeService when
// computing the effective bet strategy at decision time.

import { describe, it, expect, beforeEach } from 'vitest'
import { PatternBettingService } from './PatternBettingService'
import type { RoomFilterType } from '../../domain/entities'

const FILTER: RoomFilterType = 'banker_dominant'

describe('PatternBettingService — per-filter bet strategy', () => {
  beforeEach(() => {
    localStorage.clear()
    PatternBettingService.dispose() // reseeds builtinConfigs from DEFAULT_PATTERN_CONFIGS
  })

  it('returns undefined when no override has been set', () => {
    expect(PatternBettingService.getBetStrategy(FILTER)).toBeUndefined()
  })

  it('resolveBetStrategy returns the supplied fallback when no override exists', () => {
    expect(PatternBettingService.resolveBetStrategy(FILTER, 'martingale')).toBe('martingale')
    expect(PatternBettingService.resolveBetStrategy(FILTER, 'flat')).toBe('flat')
  })

  it('setBetStrategy persists the override and resolveBetStrategy returns it over the fallback', () => {
    PatternBettingService.setBetStrategy(FILTER, 'fibonacci')
    expect(PatternBettingService.getBetStrategy(FILTER)).toBe('fibonacci')
    expect(PatternBettingService.resolveBetStrategy(FILTER, 'martingale')).toBe('fibonacci')

    const stored = localStorage.getItem('bcr-pattern-betting-configs')
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!) as Array<{ patternType: string; betStrategy?: string }>
    const cfg = parsed.find(c => c.patternType === FILTER)
    expect(cfg?.betStrategy).toBe('fibonacci')
  })

  it('clears the override when setBetStrategy is called with undefined', () => {
    PatternBettingService.setBetStrategy(FILTER, 'paroli')
    expect(PatternBettingService.getBetStrategy(FILTER)).toBe('paroli')

    PatternBettingService.setBetStrategy(FILTER, undefined)
    expect(PatternBettingService.getBetStrategy(FILTER)).toBeUndefined()
    expect(PatternBettingService.resolveBetStrategy(FILTER, 'martingale')).toBe('martingale')
  })

  it('emits onChange when the strategy is updated', () => {
    let calls = 0
    const unsub = PatternBettingService.onChange(() => { calls++ })
    try {
      PatternBettingService.setBetStrategy(FILTER, 'flat')
      expect(calls).toBeGreaterThan(0)
    } finally {
      unsub()
    }
  })
})
