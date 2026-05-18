// PatternBetStrategySelect tests — verifies the per-filter strategy override
// UI: defaults to '전역' (no override), saves an override, switching back to
// '전역' clears the override, and external service mutations re-render.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import PatternBetStrategySelect from './PatternBetStrategySelect'
import PatternBettingService from '../../../../application/services/PatternBettingService'
import type { RoomFilterType } from '../../../../domain/entities'

const FILTER: RoomFilterType = 'long_streak'

function getSelect(): HTMLSelectElement {
  return screen.getByLabelText('필터별 배팅 전략') as HTMLSelectElement
}

describe('PatternBetStrategySelect', () => {
  beforeEach(() => {
    localStorage.clear()
    PatternBettingService.dispose()
  })

  it('defaults to the 전역 (auto) option when no override is set', () => {
    render(<PatternBetStrategySelect patternType={FILTER} />)
    expect(getSelect().value).toBe('__auto__')
  })

  it('writes a strategy override when the user picks one', () => {
    render(<PatternBetStrategySelect patternType={FILTER} />)
    fireEvent.change(getSelect(), { target: { value: 'fibonacci' } })
    expect(PatternBettingService.getBetStrategy(FILTER)).toBe('fibonacci')
    expect(getSelect().value).toBe('fibonacci')
  })

  it('clears the override when the user switches back to 전역', () => {
    PatternBettingService.setBetStrategy(FILTER, 'paroli')
    render(<PatternBetStrategySelect patternType={FILTER} />)
    expect(getSelect().value).toBe('paroli')

    fireEvent.change(getSelect(), { target: { value: '__auto__' } })
    expect(PatternBettingService.getBetStrategy(FILTER)).toBeUndefined()
  })

  it('re-renders when the underlying service emits a change', () => {
    render(<PatternBetStrategySelect patternType={FILTER} />)
    expect(getSelect().value).toBe('__auto__')

    act(() => {
      PatternBettingService.setBetStrategy(FILTER, 'flat')
    })

    expect(getSelect().value).toBe('flat')
  })
})
