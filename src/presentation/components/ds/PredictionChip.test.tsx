import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PredictionChip } from './PredictionChip'

describe('PredictionChip', () => {
  it('한글 라벨을 쓰고 raw B/P/T는 절대 노출하지 않는다', () => {
    const { rerender } = render(<PredictionChip value="B" />)
    expect(screen.getByText('뱅커')).toBeInTheDocument()
    expect(screen.queryByText('B')).not.toBeInTheDocument()

    rerender(<PredictionChip value="P" />)
    expect(screen.getByText('플레이어')).toBeInTheDocument()
    expect(screen.queryByText('P')).not.toBeInTheDocument()

    rerender(<PredictionChip value="T" />)
    expect(screen.getByText('타이')).toBeInTheDocument()
    expect(screen.queryByText('T')).not.toBeInTheDocument()
  })

  it('null/대기 값은 "준비 중"으로 표시한다', () => {
    render(<PredictionChip value={null} />)
    expect(screen.getByText('준비 중')).toBeInTheDocument()
  })

  it('aria-label로 예측을 한글로 안내한다', () => {
    render(<PredictionChip value="B" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '예측 뱅커')
  })

  it('신뢰도는 hero 크기에서만 노출한다', () => {
    const { rerender } = render(<PredictionChip value="B" confidence={73} />)
    expect(screen.queryByText('신뢰도 73%')).not.toBeInTheDocument()

    rerender(<PredictionChip value="B" size="hero" confidence={73} />)
    expect(screen.getByText('신뢰도 73%')).toBeInTheDocument()
  })
})
