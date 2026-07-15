import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { HomeHub } from './HomeHub'

describe('HomeHub', () => {
  it('세 작업(예측 보기/추천 받기/자동 배팅)을 신뢰 사다리 순으로 렌더한다', () => {
    render(<HomeHub onSelectTask={() => {}} />)
    expect(screen.getByRole('heading', { name: '무엇을 도와드릴까요?' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '예측 보기' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '추천 받기' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '자동 배팅' })).toBeInTheDocument()
  })

  it('각 작업 카드의 시작 버튼이 올바른 task로 onSelectTask를 호출한다', () => {
    const onSelectTask = vi.fn()
    render(<HomeHub onSelectTask={onSelectTask} />)

    fireEvent.click(within(screen.getByRole('region', { name: '예측 보기' })).getByRole('button', { name: /시작하기/ }))
    expect(onSelectTask).toHaveBeenLastCalledWith('watch')

    fireEvent.click(within(screen.getByRole('region', { name: '추천 받기' })).getByRole('button', { name: /시작하기/ }))
    expect(onSelectTask).toHaveBeenLastCalledWith('assist')

    fireEvent.click(within(screen.getByRole('region', { name: '자동 배팅' })).getByRole('button', { name: /시작하기/ }))
    expect(onSelectTask).toHaveBeenLastCalledWith('auto')
  })

  it('자동 배팅이 꺼져 있으면 안전 띠를 표시하지 않는다', () => {
    render(<HomeHub onSelectTask={() => {}} autoRunning={false} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('실제 자동 배팅 중이면 안전 띠와 즉시 정지를 표시한다', () => {
    const onEmergencyStop = vi.fn()
    render(
      <HomeHub
        onSelectTask={() => {}}
        autoRunning
        autoIsReal
        autoRoomCount={3}
        onEmergencyStop={onEmergencyStop}
      />
    )
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(/실제 배팅 중입니다 · 진행 중 3개/)).toBeInTheDocument()
    fireEvent.click(within(alert).getByRole('button', { name: '자동 배팅 즉시 정지' }))
    expect(onEmergencyStop).toHaveBeenCalledOnce()
  })
})
