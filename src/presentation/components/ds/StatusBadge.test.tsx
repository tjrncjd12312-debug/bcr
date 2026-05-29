import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from './StatusBadge'

describe('StatusBadge', () => {
  it('상태별 한글 라벨과 모양을 함께 표시한다(색 단독 의존 금지)', () => {
    const { rerender, container } = render(<StatusBadge status="betting" />)
    expect(screen.getByText('배팅 중')).toBeInTheDocument()
    expect(container.querySelector('.status-badge__shape')?.textContent).toBe('◆')

    rerender(<StatusBadge status="alert" />)
    expect(screen.getByText('경보')).toBeInTheDocument()
    expect(container.querySelector('.status-badge__shape')?.textContent).toBe('▲')

    rerender(<StatusBadge status="offline" />)
    expect(screen.getByText('연결 끊김')).toBeInTheDocument()
  })

  it('label로 기본 라벨을 대체할 수 있다', () => {
    render(<StatusBadge status="alert" label="경보 · 4연패" />)
    expect(screen.getByText('경보 · 4연패')).toBeInTheDocument()
  })

  it('상태 클래스를 적용한다', () => {
    const { container } = render(<StatusBadge status="idle" />)
    expect(container.querySelector('.status-badge--idle')).toBeInTheDocument()
  })
})
