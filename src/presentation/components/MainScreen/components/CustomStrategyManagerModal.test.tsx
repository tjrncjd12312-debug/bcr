import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CustomStrategyService from '../../../../application/services/CustomStrategyService'
import CustomStrategyManagerModal from './CustomStrategyManagerModal'

describe('CustomStrategyManagerModal', () => {
  beforeEach(() => {
    localStorage.clear()
    CustomStrategyService.resetToDefault()
  })

  it('renders the shipped strategy as an editable structured form', () => {
    render(
      <CustomStrategyManagerModal
        isOpen
        onClose={vi.fn()}
        onApply={vi.fn()}
      />
    )

    expect(screen.getByRole('dialog', { name: '커스텀 전략 빌더' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('15회 무3연속 · 2연승')).toBeInTheDocument()
    expect(screen.getByLabelText('1단계 1차 금액')).toHaveValue(10000)
    expect(screen.getByLabelText('3단계 2차 금액')).toHaveValue(40000)
    expect(screen.getByText(/승리하면 같은 단계의 다음 차수/)).toBeInTheDocument()
  })

  it('persists edits and applies the strategy filter in one action', () => {
    const onApply = vi.fn()
    render(
      <CustomStrategyManagerModal
        isOpen
        onClose={vi.fn()}
        onApply={onApply}
      />
    )

    fireEvent.change(screen.getByDisplayValue('15회 무3연속 · 2연승'), {
      target: { value: '내 15회 전략' },
    })
    fireEvent.change(screen.getByLabelText('2단계 1차 금액'), {
      target: { value: '25000' },
    })
    fireEvent.click(screen.getByRole('button', { name: '저장하고 적용' }))

    expect(onApply).toHaveBeenCalledWith('strategy:no-streak-15-two-hit')
    expect(CustomStrategyService.getById('no-streak-15-two-hit')).toMatchObject({
      name: '내 15회 전략',
      progression: {
        stages: [
          { amounts: [10000, 10000] },
          { amounts: [25000, 20000] },
          { amounts: [40000, 40000] },
        ],
      },
    })
  })
})
