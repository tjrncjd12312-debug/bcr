// PatternBetDirectionSelect tests — verifies the segmented control wires through
// to PatternBettingService for both reading and writing the bet direction, and
// that external service mutations re-render the component.

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import PatternBetDirectionSelect from './PatternBetDirectionSelect'
import PatternBettingService from '../../../../application/services/PatternBettingService'
import type { RoomFilterType, PatternBetDirection } from '../../../../domain/entities'

const PATTERN: RoomFilterType = 'banker_dominant'

function getBtn(label: string) {
  return screen.getByRole('radio', { name: label })
}

describe('PatternBetDirectionSelect', () => {
  beforeEach(() => {
    localStorage.clear()
    // dispose() reinitializes builtinConfigs to DEFAULT_PATTERN_CONFIGS
    PatternBettingService.dispose()
  })

  it('renders all five direction buttons', () => {
    render(<PatternBetDirectionSelect patternType={PATTERN} />)
    expect(getBtn('AI')).toBeInTheDocument()
    expect(getBtn('B')).toBeInTheDocument()
    expect(getBtn('P')).toBeInTheDocument()
    expect(getBtn('T')).toBeInTheDocument()
    expect(getBtn('✕')).toBeInTheDocument()
  })

  it('reflects the current bet direction as the active option', () => {
    // banker_dominant defaults to 'B' per DEFAULT_PATTERN_CONFIGS
    render(<PatternBetDirectionSelect patternType={PATTERN} />)
    expect(getBtn('B')).toHaveAttribute('aria-checked', 'true')
    expect(getBtn('AI')).toHaveAttribute('aria-checked', 'false')
  })

  it('persists a new direction through PatternBettingService when clicked', () => {
    render(<PatternBetDirectionSelect patternType={PATTERN} />)

    fireEvent.click(getBtn('T'))

    expect(PatternBettingService.getBetDirection(PATTERN)).toBe<PatternBetDirection>('T')
    expect(getBtn('T')).toHaveAttribute('aria-checked', 'true')

    const stored = localStorage.getItem('bcr-pattern-betting-configs')
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!) as Array<{ patternType: string; betDirection: string }>
    const cfg = parsed.find(c => c.patternType === PATTERN)
    expect(cfg?.betDirection).toBe('T')
  })

  it('updates when PatternBettingService emits a change from outside', () => {
    render(<PatternBetDirectionSelect patternType={PATTERN} />)

    act(() => {
      PatternBettingService.setBetDirection(PATTERN, 'skip')
    })

    expect(getBtn('✕')).toHaveAttribute('aria-checked', 'true')
    expect(getBtn('B')).toHaveAttribute('aria-checked', 'false')
  })

  it('does not bubble clicks to a wrapping row (so a filter toggle is not fired)', () => {
    let outerClicks = 0
    render(
      <div onClick={() => { outerClicks++ }}>
        <PatternBetDirectionSelect patternType={PATTERN} />
      </div>
    )

    fireEvent.click(getBtn('P'))

    expect(PatternBettingService.getBetDirection(PATTERN)).toBe<PatternBetDirection>('P')
    expect(outerClicks).toBe(0)
  })
})
