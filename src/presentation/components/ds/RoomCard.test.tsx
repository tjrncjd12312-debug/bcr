import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoomCard, type RoomCardData } from './RoomCard'

const base: RoomCardData = {
  id: 'speed-a',
  name: '스피드 바카라 A',
  live: true,
  lastResult: 'B',
  hitRate: 72,
  bigRoad: ['B', 'P', 'B', 'B', 'P'],
  prediction: 'B',
  status: 'idle',
  statusLabel: '흐름 좋음(3연속)',
}

describe('RoomCard', () => {
  it('6개 핵심 데이터를 한글로 표시한다(raw B/P/T 금지)', () => {
    render(<RoomCard data={base} onOpen={() => {}} />)
    expect(screen.getByRole('heading', { name: '스피드 바카라 A' })).toBeInTheDocument()
    expect(screen.getByText('72%')).toBeInTheDocument()
    expect(screen.getByText('흐름 좋음(3연속)')).toBeInTheDocument()
    // 마지막 결과/예측 모두 한글, 영문 단독 노출 없음
    expect(screen.getByLabelText('결과 뱅커')).toBeInTheDocument()
    expect(screen.getByLabelText('예측 뱅커')).toBeInTheDocument()
    expect(screen.queryByText('B')).not.toBeInTheDocument()
  })

  it('적중률/마지막 결과가 없으면 — 로 표시한다', () => {
    render(<RoomCard data={{ ...base, hitRate: null, lastResult: null }} onOpen={() => {}} />)
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1)
  })

  it('자세히 보기 클릭 시 방 id로 onOpen을 호출한다(1탭 입장)', () => {
    const onOpen = vi.fn()
    render(<RoomCard data={base} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /이 방 자세히 보기/ }))
    expect(onOpen).toHaveBeenCalledWith('speed-a')
  })

  it('촘촘 밀도에서는 큰길/상태 줄을 접는다', () => {
    const { container } = render(<RoomCard data={base} density="compact" onOpen={() => {}} />)
    expect(container.querySelector('.room-card--compact')).toBeInTheDocument()
    expect(container.querySelector('.room-card__row--road')).not.toBeInTheDocument()
    expect(screen.queryByText('흐름 좋음(3연속)')).not.toBeInTheDocument()
  })
})
