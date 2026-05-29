import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MiniBigRoad } from './MiniBigRoad'

describe('MiniBigRoad', () => {
  it('결과가 없으면 "기록 모으는 중"을 표시한다', () => {
    render(<MiniBigRoad results={[]} />)
    expect(screen.getByText('기록 모으는 중')).toBeInTheDocument()
  })

  it('게임색 클래스로 점을 렌더하고 끝에서 max개만 자른다', () => {
    const { container } = render(
      <MiniBigRoad results={['B', 'P', 'T', 'B', 'P']} max={3} />
    )
    const dots = container.querySelectorAll('.mini-road__dot')
    expect(dots.length).toBe(3)
    // 끝에서 3개 = [T, B, P]
    expect(dots[0].className).toContain('mini-road__dot--tie')
    expect(dots[1].className).toContain('mini-road__dot--banker')
    expect(dots[2].className).toContain('mini-road__dot--player')
  })
})
