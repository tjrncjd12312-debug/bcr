import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FocusedRoomView } from './FocusedRoomView'

const baseProps = {
  roomName: '스피드 바카라 A',
  breadcrumb: '살펴보기 › 스피드 바카라 A › 자세히',
  prediction: 'B' as const,
  confidence: 73,
  counts: { banker: 18, player: 15, tie: 3 },
  shoeProgress: { played: 32, total: 78 },
  patternLabel: '뱅커 3연속 (장줄)',
  primaryActionLabel: '이 방에서 도움받기',
  onPrimaryAction: () => {},
  onBack: () => {},
}

describe('FocusedRoomView', () => {
  it('예측을 한글 hero 칩 + 신뢰도로, 카운트를 한글로 표시한다', () => {
    render(<FocusedRoomView {...baseProps} />)
    expect(screen.getByLabelText('예측 뱅커')).toBeInTheDocument()
    expect(screen.getByText('신뢰도 73%')).toBeInTheDocument()
    expect(screen.getByText('뱅커 18')).toBeInTheDocument()
    expect(screen.getByText('플레이어 15')).toBeInTheDocument()
    expect(screen.getByText('타이 3')).toBeInTheDocument()
    expect(screen.getByText(/32\/78패/)).toBeInTheDocument()
    expect(screen.getByText(/뱅커 3연속 \(장줄\)/)).toBeInTheDocument()
  })

  it('큰길/비드플레이트 슬롯을 주입할 수 있다', () => {
    render(
      <FocusedRoomView
        {...baseProps}
        bigRoadSlot={<div data-testid="big-road">BIGROAD</div>}
        beadPlateSlot={<div data-testid="bead">BEAD</div>}
      />
    )
    expect(screen.getByTestId('big-road')).toBeInTheDocument()
    expect(screen.getByTestId('bead')).toBeInTheDocument()
  })

  it('단일 주요 액션과 뒤로가기 콜백이 동작한다', () => {
    const onPrimaryAction = vi.fn()
    const onBack = vi.fn()
    render(<FocusedRoomView {...baseProps} onPrimaryAction={onPrimaryAction} onBack={onBack} />)
    fireEvent.click(screen.getByRole('button', { name: '이 방에서 도움받기' }))
    expect(onPrimaryAction).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '← 방 목록' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('자세히 보기는 기본 접힘이며 토글로 펼친다(점진적 공개)', () => {
    render(<FocusedRoomView {...baseProps} detail={<div>파생 로드 내용</div>} />)
    expect(screen.queryByText('파생 로드 내용')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /자세히 보기/ }))
    expect(screen.getByText('파생 로드 내용')).toBeInTheDocument()
  })
})
