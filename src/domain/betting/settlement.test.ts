import { describe, expect, it } from 'vitest'
import type { BetOutcome } from '../entities'
import { isBetAccepted, isBetRejected, predResultToSpot } from './settlement'

describe('predResultToSpot', () => {
  it('maps B/P/T to the plain Evolution bet spot', () => {
    expect(predResultToSpot('B')).toBe('Banker')
    expect(predResultToSpot('P')).toBe('Player')
    expect(predResultToSpot('T')).toBe('Tie')
  })
})

describe('isBetRejected — 실배팅 거절 정산 제외', () => {
  it('flags a bet Evolution rejected with error 1013 (below table minimum)', () => {
    // ★ 라이브 캡처(2026-06-23): 2000원을 1만원 최소 테이블에 넣어 거절된 실제 형식.
    const outcome: BetOutcome = {
      acceptedBets: {},
      rejectedBets: { Banker: { amount: 2000, error: '1013' } },
    }
    expect(isBetRejected(outcome, 'B')).toEqual({ rejected: true, errorCode: '1013' })
  })

  it('does NOT flag when my spot is absent from rejectedBets (someone else / other spot)', () => {
    const outcome: BetOutcome = { rejectedBets: { Player: { amount: 2000, error: '1013' } } }
    expect(isBetRejected(outcome, 'B')).toEqual({ rejected: false })
  })

  it('does NOT flag an accepted bet (so normal settlement proceeds)', () => {
    const outcome: BetOutcome = { acceptedBets: { Banker: 10000 }, winningSpots: ['Banker', 'Big'] }
    expect(isBetRejected(outcome, 'B')).toEqual({ rejected: false })
  })

  it('falls back to not-rejected when betOutcome is absent (history-inferred result)', () => {
    expect(isBetRejected(undefined, 'B')).toEqual({ rejected: false })
  })
})

describe('isBetAccepted — 실배팅 명시 체결 확인', () => {
  it('accepts numeric and live object amounts for the requested spot', () => {
    expect(isBetAccepted({ acceptedBets: { Banker: 10000 } }, 'B')).toBe(true)
    expect(isBetAccepted({ acceptedBets: { Tie: { amount: 2000, payoff: 18000 } } }, 'T')).toBe(true)
  })

  it('fails closed when the spot or positive amount is absent', () => {
    expect(isBetAccepted({ acceptedBets: { Player: 10000 } }, 'B')).toBe(false)
    expect(isBetAccepted({ acceptedBets: { Banker: { amount: 0 } } }, 'B')).toBe(false)
    expect(isBetAccepted(undefined, 'B')).toBe(false)
  })
})
