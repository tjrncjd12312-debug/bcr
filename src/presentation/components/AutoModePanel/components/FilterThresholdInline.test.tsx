// FilterThresholdInline tests — verifies that the inline threshold input renders
// only for filters that have a threshold and round-trips writes through
// FilterThresholdsService (the per-filter UI used in the filter dropdown).

import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FilterThresholdInline from './FilterThresholdInline'
import FilterThresholdsService from '../../../../application/services/FilterThresholdsService'

describe('FilterThresholdInline', () => {
  beforeEach(() => {
    localStorage.clear()
    // Re-seed defaults by overwriting any cached state. The service reads from
    // localStorage at construction, so after clear() we just reset to defaults.
    FilterThresholdsService.set({
      tieDroughtThreshold: 20,
      freshRoomGames: 5,
      freshShoeMaxGameNumber: 5,
    })
  })

  it('renders nothing for a filter type with no threshold (e.g. banker_dominant)', () => {
    const { container } = render(<FilterThresholdInline filterType="banker_dominant" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an input bound to tieDroughtThreshold for tie_drought', () => {
    render(<FilterThresholdInline filterType="tie_drought" />)
    const input = screen.getByLabelText('필터 임계값') as HTMLInputElement
    expect(input.value).toBe('20')

    fireEvent.change(input, { target: { value: '42' } })
    expect(FilterThresholdsService.get().tieDroughtThreshold).toBe(42)
  })

  it('writes the freshRoomGames key for fresh_room filter', () => {
    render(<FilterThresholdInline filterType="fresh_room" />)
    const input = screen.getByLabelText('필터 임계값') as HTMLInputElement
    fireEvent.change(input, { target: { value: '11' } })
    expect(FilterThresholdsService.get().freshRoomGames).toBe(11)
    // Other thresholds must remain unchanged
    expect(FilterThresholdsService.get().tieDroughtThreshold).toBe(20)
  })

  it('writes the freshShoeMaxGameNumber key for fresh_shoe filter', () => {
    render(<FilterThresholdInline filterType="fresh_shoe" />)
    const input = screen.getByLabelText('필터 임계값') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(8)
  })
})
