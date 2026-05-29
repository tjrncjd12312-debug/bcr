import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MoneySafetyHeader } from './MoneySafetyHeader'

describe('MoneySafetyHeader', () => {
  it('실제 배팅이면 빨강 한글 칩으로 명시한다', () => {
    const { container } = render(
      <MoneySafetyHeader isReal balance={1240000} sessionProfit={38000} sessionProfitPct={3.1} />
    )
    expect(screen.getByText('실제 배팅')).toBeInTheDocument()
    expect(container.querySelector('.money-header__chip.is-real')).toBeInTheDocument()
  })

  it('연습 모드이면 중립 칩으로 표시한다', () => {
    const { container } = render(<MoneySafetyHeader isReal={false} balance={1000000} sessionProfit={0} />)
    expect(screen.getByText('연습 중')).toBeInTheDocument()
    expect(container.querySelector('.money-header__chip.is-virtual')).toBeInTheDocument()
  })

  it('세션 손익을 부호와 함께, 따면 초록/잃으면 빨강 톤으로 표시한다', () => {
    const { container, rerender } = render(<MoneySafetyHeader isReal balance={0} sessionProfit={38000} />)
    expect(screen.getByText(/＋38,000원/)).toBeInTheDocument()
    expect(container.querySelector('.money-header__profit--up')).toBeInTheDocument()

    rerender(<MoneySafetyHeader isReal balance={0} sessionProfit={-25000} />)
    expect(screen.getByText(/－25,000원/)).toBeInTheDocument()
    expect(container.querySelector('.money-header__profit--down')).toBeInTheDocument()
  })

  it('목표까지/손절까지 진행바를 표시한다', () => {
    render(
      <MoneySafetyHeader
        isReal
        balance={0}
        sessionProfit={38000}
        target={{ current: 38000, limit: 100000 }}
        stopLoss={{ current: -38000, limit: -100000 }}
      />
    )
    expect(screen.getByText(/목표까지/)).toBeInTheDocument()
    expect(screen.getByText(/손절까지/)).toBeInTheDocument()
  })
})
