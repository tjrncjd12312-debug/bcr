import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GuidanceCard } from './GuidanceCard'

describe('GuidanceCard', () => {
  it('bet 모드: 한글 예측칩·추천 금액·동급 두 버튼을 표시한다(raw B 금지)', () => {
    render(
      <GuidanceCard mode="bet" prediction="B" confidence={73} amount={10000} amountNote="지금 1단계" onBet={() => {}} onSkip={() => {}} />
    )
    expect(screen.getByLabelText('예측 뱅커')).toBeInTheDocument()
    expect(screen.getByText(/믿음 정도 73%/)).toBeInTheDocument()
    expect(screen.getByText(/₩ 10,000/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /이대로 걸기/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '이번 판 쉬기' })).toBeInTheDocument()
  })

  it('bet 모드: 걸기/쉬기 콜백이 동작한다(단일탭 즉시집행은 상위 확인 단계 담당)', () => {
    const onBet = vi.fn(), onSkip = vi.fn()
    render(<GuidanceCard mode="bet" prediction="P" onBet={onBet} onSkip={onSkip} />)
    fireEvent.click(screen.getByRole('button', { name: /이대로 걸기/ }))
    expect(onBet).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '이번 판 쉬기' }))
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('skip 모드: 쉬는 게 좋아요 + 사유 + 권고 따름/직접 걸기', () => {
    const onFollowSkip = vi.fn(), onBetAnyway = vi.fn()
    render(
      <GuidanceCard mode="skip" skipReason="최근 흐름이 불안정해서 한 판 건너뛰길 권해요" onFollowSkip={onFollowSkip} onBetAnyway={onBetAnyway} />
    )
    expect(screen.getByText(/쉬는 게 좋아요/)).toBeInTheDocument()
    expect(screen.getByText(/최근 흐름이 불안정/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '알겠어요, 쉴게요' }))
    expect(onFollowSkip).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '그래도 직접 걸기' }))
    expect(onBetAnyway).toHaveBeenCalledOnce()
  })
})
