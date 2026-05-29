import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { WatchView } from './WatchView'
import type { RoomCardData } from '../ds/RoomCard'
import type { RecommendItem } from './RecommendStrip'

const rooms: RoomCardData[] = [
  { id: 'a', name: '스피드 바카라 A', live: true, lastResult: 'B', hitRate: 72, bigRoad: ['B', 'P'], prediction: 'B', status: 'idle' },
  { id: 'b', name: '스피드 바카라 B', live: true, lastResult: 'P', hitRate: 61, bigRoad: ['P', 'B'], prediction: 'P', status: 'idle' },
]
const recommend: RecommendItem[] = [
  { id: 'a', rank: 1, name: '스피드 바카라 A', hits: 18, total: 25, note: '▲ 3연속 좋음' },
]

describe('WatchView', () => {
  it('방 개수와 흐름 좋은 방 수를 한글로 표시한다', () => {
    render(<WatchView rooms={rooms} recommend={recommend} density="standard" onDensityChange={() => {}} onOpenRoom={() => {}} onHome={() => {}} />)
    // 카운트 줄에 둘 다 표시(추천 띠 제목과의 중복을 피해 카운트 줄 전체 문구로 단언)
    expect(screen.getByText(/보는 방 2개 · 흐름 좋은 방 1개/)).toBeInTheDocument()
  })

  it('각 방 카드에서 1탭으로 방을 열 수 있다', () => {
    const onOpenRoom = vi.fn()
    render(<WatchView rooms={rooms} density="standard" onDensityChange={() => {}} onOpenRoom={onOpenRoom} onHome={() => {}} />)
    fireEvent.click(within(screen.getByRole('region', { name: '스피드 바카라 B' })).getByRole('button', { name: /이 방 자세히 보기/ }))
    expect(onOpenRoom).toHaveBeenCalledWith('b')
  })

  it('홈 버튼으로 허브에 복귀한다', () => {
    const onHome = vi.fn()
    render(<WatchView rooms={rooms} density="standard" onDensityChange={() => {}} onOpenRoom={() => {}} onHome={onHome} />)
    fireEvent.click(screen.getByRole('button', { name: '홈' }))
    expect(onHome).toHaveBeenCalledOnce()
  })

  it('밀도 토글이 동작한다', () => {
    const onDensityChange = vi.fn()
    render(<WatchView rooms={rooms} density="standard" onDensityChange={onDensityChange} onOpenRoom={() => {}} onHome={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '촘촘' }))
    expect(onDensityChange).toHaveBeenCalledWith('compact')
  })
})
