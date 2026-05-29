import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TaskCard } from './TaskCard'

describe('TaskCard', () => {
  it('제목·설명·시작 버튼을 렌더한다', () => {
    render(<TaskCard title="살펴보기" description="흐름을 살펴봐요." onStart={() => {}} />)
    expect(screen.getByText('살펴보기')).toBeInTheDocument()
    expect(screen.getByText('흐름을 살펴봐요.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /시작하기/ })).toBeInTheDocument()
  })

  it('시작 버튼 클릭 시 onStart를 호출한다', () => {
    const onStart = vi.fn()
    render(<TaskCard title="자동맡기기" description="맡겨요." onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: /시작하기/ }))
    expect(onStart).toHaveBeenCalledOnce()
  })

  it('liveBadge가 있으면 실제 배팅 신호를 표시한다', () => {
    render(<TaskCard title="자동맡기기" description="맡겨요." liveBadge="실제 배팅 중" onStart={() => {}} />)
    expect(screen.getByText(/실제 배팅 중/)).toBeInTheDocument()
  })
})
