import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatCard } from './StatCard'

describe('StatCard', () => {
  it('renders the label and value', () => {
    render(<StatCard label="승률" value="73%" />)
    expect(screen.getByText('승률')).toBeInTheDocument()
    expect(screen.getByText('73%')).toBeInTheDocument()
  })

  it('renders a ReactNode value', () => {
    render(<StatCard label="승/패" value={<><span className="positive">10</span>/<span className="negative">3</span></>} />)
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('applies the tone class when provided', () => {
    const { container } = render(<StatCard label="손익" value="+50,000" tone="positive" />)
    expect(container.querySelector('.settings-stat-card.positive')).toBeInTheDocument()
  })

  it('defaults to neutral tone', () => {
    const { container } = render(<StatCard label="잔액" value="100,000" />)
    expect(container.querySelector('.settings-stat-card.neutral')).toBeInTheDocument()
  })
})
