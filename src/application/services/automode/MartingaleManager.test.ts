// MartingaleManager.calculateBetAmount tests — verifies all five strategies
// produce the configured bet amount at every level the UI now allows (1–100).
//
// User requirement: whatever maxMartin + strategy the user sets, the system
// must place that exact amount when the corresponding martin level is reached.
// We don't enforce seed/wallet safety here — that's a separate concern.

import { describe, it, expect, beforeEach } from 'vitest'
import { MartingaleManager } from './MartingaleManager'

const BASE = 10_000

describe('MartingaleManager.calculateBetAmount — strategy correctness at extended levels', () => {
  let mgr: MartingaleManager

  beforeEach(() => {
    mgr = new MartingaleManager()
  })

  describe('martingale (doubling)', () => {
    it.each([
      [0, BASE],
      [1, BASE * 2],
      [2, BASE * 4],
      [10, BASE * 1024],
      [13, BASE * 8192],          // last level fully within 100M seed
      [57, BASE * Math.pow(2, 57)], // user-quoted 58단 (level=57)
      [99, BASE * Math.pow(2, 99)], // UI max edge
    ])('level %i → base × 2^level', (level, expected) => {
      expect(mgr.calculateBetAmount(level, BASE, 'martingale')).toBe(expected)
    })
  })

  describe('fibonacci', () => {
    // Fibonacci multipliers: 1,1,2,3,5,8,13,21,34,55,89,...
    // Compute reference inline so the test independently validates the
    // pre-computed table inside MartingaleManager.
    function fib(n: number): number {
      let a = 1, b = 1
      for (let i = 2; i <= n; i++) [a, b] = [b, a + b]
      return n === 0 ? 1 : b
    }

    it.each([0, 1, 2, 5, 9, 13, 18, 57, 99])('level %i → base × fib(level)', (level) => {
      expect(mgr.calculateBetAmount(level, BASE, 'fibonacci')).toBe(BASE * fib(level))
    })
  })

  describe('paroli (caps at level 2)', () => {
    it.each([
      [0, BASE],
      [1, BASE * 2],
      [2, BASE * 4],
      [3, BASE * 4],   // capped
      [10, BASE * 4],  // capped
      [57, BASE * 4],  // capped — paroli design
      [99, BASE * 4],
    ])('level %i → base × 2^min(level, 2) = %s', (level, expected) => {
      expect(mgr.calculateBetAmount(level, BASE, 'paroli')).toBe(expected)
    })
  })

  describe('flat (constant)', () => {
    it.each([0, 1, 13, 57, 99])('level %i → base', (level) => {
      expect(mgr.calculateBetAmount(level, BASE, 'flat')).toBe(BASE)
    })
  })

  describe('custom (user-defined per-level amounts)', () => {
    it('returns the array entry at each level', () => {
      // Build a 100-element array where each entry is unique so we can verify
      // by-index lookup, not just bounds.
      const custom = Array.from({ length: 100 }, (_, i) => 10_000 + i * 1_000)
      for (const lvl of [0, 1, 13, 57, 99]) {
        expect(mgr.calculateBetAmount(lvl, BASE, 'custom', custom)).toBe(custom[lvl])
      }
    })

    it('falls back to the last element when level exceeds array length', () => {
      const custom = [10_000, 20_000, 30_000] // only 3 entries
      expect(mgr.calculateBetAmount(2, BASE, 'custom', custom)).toBe(30_000)
      expect(mgr.calculateBetAmount(3, BASE, 'custom', custom)).toBe(30_000)
      expect(mgr.calculateBetAmount(57, BASE, 'custom', custom)).toBe(30_000)
    })

    it('falls back to baseBet when customAmounts is missing or empty', () => {
      expect(mgr.calculateBetAmount(5, BASE, 'custom')).toBe(BASE)
      expect(mgr.calculateBetAmount(5, BASE, 'custom', [])).toBe(BASE)
    })
  })

  describe('cumulative loss matches sum of per-level bets', () => {
    it('martingale cumulative at level 13 equals base × (2^13 − 1)', () => {
      // The "13단" boundary the user is likely interested in given a 100M seed.
      const cum = mgr.calculateCumulativeLoss(13, BASE, 'martingale')
      expect(cum).toBe(BASE * (Math.pow(2, 13) - 1)) // = 81,910,000
    })

    it('flat cumulative at level 58 equals base × 58', () => {
      const cum = mgr.calculateCumulativeLoss(58, BASE, 'flat')
      expect(cum).toBe(BASE * 58)
    })

    it('custom cumulative is the sum of the first N entries', () => {
      const custom = [10_000, 20_000, 30_000, 40_000, 50_000]
      const cum = mgr.calculateCumulativeLoss(5, BASE, 'custom', custom)
      expect(cum).toBe(10_000 + 20_000 + 30_000 + 40_000 + 50_000)
    })
  })
})
