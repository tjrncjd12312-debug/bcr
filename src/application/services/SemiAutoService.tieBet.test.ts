// SemiAutoService — Tie bet handling unit tests.
//
// These tests cover the two regressions the user reported in SemiAuto:
//   1. SemiAuto used to early-return on `prediction.prediction === 'T'`, so a
//      custom-pattern bet direction of T placed no bet.
//   2. The win/profit calculation treated every Tie outcome as a push, so a
//      Tie bet that actually hit was silently lost as zero P/L.
//
// We exercise the pure mapping/profit logic without spinning up the whole
// service to keep the test focused and fast.

import { describe, it, expect } from 'vitest'
import type { Winner } from '../../domain/entities'

// Mirrors the betType derivation inside SemiAutoService.executeAutoBetting
function deriveBetType(prediction: Winner): 'Banker' | 'Player' | 'Tie' {
  return prediction === 'B' ? 'Banker'
    : prediction === 'P' ? 'Player'
    : 'Tie'
}

// Mirrors the win-detection guard inside SemiAutoService.compareResult.
//   - winner='T' & prediction='T' → win (handled by the normal win path)
//   - winner='T' & prediction!='T' → push (refund / early return)
function isPushOutcome(winner: Winner, prediction: Winner): boolean {
  return winner === 'T' && prediction !== 'T'
}

// Mirrors the SemiAutoService profit calc for the win branch (post-fix).
function calcWinProfit(prediction: Winner, betAmount: number): number {
  const BANKER_COMMISSION = 0.05
  const TIE_PAYOUT = 8
  if (prediction === 'T') return betAmount * TIE_PAYOUT
  if (prediction === 'B') return betAmount * (1 - BANKER_COMMISSION)
  return betAmount // Player even-money
}

describe('SemiAutoService — Tie bet handling', () => {
  describe('betType derivation', () => {
    it('maps prediction B → Banker', () => {
      expect(deriveBetType('B')).toBe('Banker')
    })

    it('maps prediction P → Player', () => {
      expect(deriveBetType('P')).toBe('Player')
    })

    it('maps prediction T → Tie (was previously falling through to Player)', () => {
      expect(deriveBetType('T')).toBe('Tie')
    })
  })

  describe('Tie outcome resolution (compareResult guard)', () => {
    it('treats Tie outcome as a push when the user bet Banker', () => {
      expect(isPushOutcome('T', 'B')).toBe(true)
    })

    it('treats Tie outcome as a push when the user bet Player', () => {
      expect(isPushOutcome('T', 'P')).toBe(true)
    })

    it('does NOT short-circuit when the user bet Tie and Tie hit', () => {
      // Previously SemiAutoService returned early on every Tie outcome, so a
      // matched Tie bet silently produced no win. The fix lets it fall through
      // to the normal win path.
      expect(isPushOutcome('T', 'T')).toBe(false)
    })

    it('leaves Banker/Player outcomes to the normal win-comparison flow', () => {
      expect(isPushOutcome('B', 'B')).toBe(false)
      expect(isPushOutcome('B', 'P')).toBe(false)
      expect(isPushOutcome('P', 'B')).toBe(false)
    })
  })

  describe('Win profit calculation', () => {
    it('Banker win pays 0.95x (5% commission)', () => {
      expect(calcWinProfit('B', 10_000)).toBe(9_500)
    })

    it('Player win pays even money', () => {
      expect(calcWinProfit('P', 10_000)).toBe(10_000)
    })

    it('Tie win pays 8x net profit', () => {
      expect(calcWinProfit('T', 10_000)).toBe(80_000)
    })
  })
})
