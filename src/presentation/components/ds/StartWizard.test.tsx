import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StartWizard, type WizardRoom } from './StartWizard'

const rooms: WizardRoom[] = [
  { id: 'a', name: '스피드 바카라 A', lastResult: 'B' },
  { id: 'b', name: '스피드 바카라 B', lastResult: 'P' },
]

describe('StartWizard', () => {
  it('한 번 탭 시작을 막고 3단계를 거쳐 평문 요약과 구체 라벨로 끝낸다', () => {
    const onStart = vi.fn()
    render(<StartWizard rooms={rooms} onCancel={() => {}} onStart={onStart} />)

    // 1단계: 방 고르기 (기본 자동 선택)
    expect(screen.getByText('어떤 방을 맡기시겠어요?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))

    // 2단계: 금액·한도
    expect(screen.getByText('한 번에 얼마씩 거시겠어요?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))

    // 3단계: 확인 — 평문 요약 + '확인' 아닌 구체 라벨
    expect(screen.getByText('이대로 시작할까요?')).toBeInTheDocument()
    expect(screen.getByText(/한 번에 10,000원씩/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '확인' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '자동 배팅 시작' }))

    expect(onStart).toHaveBeenCalledOnce()
    expect(onStart.mock.calls[0][0]).toMatchObject({ autoPick: true, baseBet: 10000, strategy: 'martin', isReal: false })
  })

  it('실제 돈으로 전환하면 시작 버튼이 빨강 구체 라벨로 바뀐다', () => {
    render(<StartWizard rooms={rooms} onCancel={() => {}} onStart={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    fireEvent.click(screen.getByRole('button', { name: /진짜 돈으로 하려면/ }))
    expect(screen.getByRole('button', { name: '진짜 돈으로 자동 배팅 시작' })).toBeInTheDocument()
  })

  it('마틴 선택 시 위험 경고를 인라인으로 보여준다', () => {
    render(<StartWizard rooms={rooms} onCancel={() => {}} onStart={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '다음 →' }))
    expect(screen.getByText(/위험할 수 있어요/)).toBeInTheDocument()
  })

  it('1단계에서 취소를 호출할 수 있다', () => {
    const onCancel = vi.fn()
    render(<StartWizard rooms={rooms} onCancel={onCancel} onStart={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
