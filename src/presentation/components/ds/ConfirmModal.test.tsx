import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmModal } from './ConfirmModal'

describe('ConfirmModal', () => {
  it('open=false면 아무것도 렌더하지 않는다', () => {
    render(
      <ConfirmModal open={false} title="이렇게 걸까요?" confirmLabel="네, 뱅커에 1만원 걸기" onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(screen.queryByText('이렇게 걸까요?')).not.toBeInTheDocument()
  })

  it('제목·행·구체 동작 라벨을 렌더한다', () => {
    render(
      <ConfirmModal
        open
        title="이렇게 걸까요?"
        rows={[{ label: '금액', value: '₩ 10,000' }]}
        confirmLabel="네, 뱅커에 1만원 걸기"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('₩ 10,000')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '네, 뱅커에 1만원 걸기' })).toBeInTheDocument()
  })

  it('확인/취소 콜백이 동작한다', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmModal open title="확인" confirmLabel="자동 배팅 시작" onConfirm={onConfirm} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByRole('button', { name: '자동 배팅 시작' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '아니요, 취소' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
