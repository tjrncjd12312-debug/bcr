// PatternManagerModal tests — verify the user-facing CRUD flow that the
// modal exposes to the rest of the app:
//   1. Creating: form submission with valid input emits onCreate.
//   2. Editing: clicking 편집 loads the row into the form; submitting emits
//      onUpdate with the same id.
//   3. Two-step delete: first click arms 정말 삭제?; second click within the
//      window calls onDelete. A timeout cancels the confirmation.
// The modal owns its own input/edit/confirm state, so we exercise it as a
// component instead of stubbing internals.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import PatternManagerModal from './PatternManagerModal'
import type { CustomPattern, RoomFilterType, PatternBetDirection } from '../../../../domain/entities'

function pattern(over: Partial<CustomPattern> = {}): CustomPattern {
  const now = Date.now()
  return {
    id: 'cp-1',
    name: 'Sample',
    sequence: ['B', 'B', 'P'],
    enabled: true,
    description: 'memo',
    betDirection: 'B',
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

type CreatePayload = { name: string; sequence: string; enabled: boolean; description?: string; betDirection?: PatternBetDirection }

interface Handlers {
  onClose: Mock<() => void>
  onCreate: Mock<(data: CreatePayload) => void>
  onUpdate: Mock<(id: string, data: CreatePayload) => void>
  onDelete: Mock<(id: string) => void>
  onToggle: Mock<(id: string, enabled: boolean) => void>
  onApply: Mock<(pattern: RoomFilterType) => void>
}

function makeHandlers(): Handlers {
  return {
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
    onApply: vi.fn(),
  }
}

function renderModal(patterns: CustomPattern[], handlers: Handlers) {
  return render(
    <PatternManagerModal
      isOpen
      patterns={patterns}
      onClose={handlers.onClose}
      onCreate={handlers.onCreate}
      onUpdate={handlers.onUpdate}
      onDelete={handlers.onDelete}
      onToggle={handlers.onToggle}
      onApply={handlers.onApply}
    />
  )
}

describe('PatternManagerModal', () => {
  let handlers: Handlers
  beforeEach(() => {
    handlers = makeHandlers()
  })

  describe('create', () => {
    it('submits onCreate with the form values', () => {
      renderModal([], handlers)
      fireEvent.change(screen.getByPlaceholderText(/예: 장줄 끊김/), { target: { value: '내 패턴' } })
      fireEvent.change(screen.getByPlaceholderText(/4연속 뱅커/), { target: { value: 'bbpp' } })
      fireEvent.change(screen.getByDisplayValue('AI 예측 (서버 요청)'), { target: { value: 'P' } })

      fireEvent.click(screen.getByRole('button', { name: '패턴 저장' }))

      expect(handlers.onCreate).toHaveBeenCalledTimes(1)
      expect(handlers.onCreate.mock.calls[0][0]).toMatchObject({
        name: '내 패턴',
        sequence: 'BBPP',
        betDirection: 'P',
        enabled: true,
      })
    })

    it('blocks submission and shows an error when name is empty', () => {
      renderModal([], handlers)
      fireEvent.change(screen.getByPlaceholderText(/4연속 뱅커/), { target: { value: 'BB' } })
      fireEvent.click(screen.getByRole('button', { name: '패턴 저장' }))
      expect(handlers.onCreate).not.toHaveBeenCalled()
      expect(screen.getByText(/패턴 이름을 입력/)).toBeInTheDocument()
    })

    it('blocks submission and shows an error when sequence is empty/invalid', () => {
      renderModal([], handlers)
      fireEvent.change(screen.getByPlaceholderText(/예: 장줄 끊김/), { target: { value: '이름만' } })
      fireEvent.change(screen.getByPlaceholderText(/4연속 뱅커/), { target: { value: 'XYZ' } })
      fireEvent.click(screen.getByRole('button', { name: '패턴 저장' }))
      expect(handlers.onCreate).not.toHaveBeenCalled()
      expect(screen.getByText(/B\/P\/T로 입력/)).toBeInTheDocument()
    })
  })

  describe('edit', () => {
    it('loads the row into the form, switches header to 패턴 수정, and calls onUpdate', () => {
      const p = pattern({ id: 'cp-edit', name: 'Old', sequence: ['B', 'P'], betDirection: 'T' })
      renderModal([p], handlers)

      fireEvent.click(screen.getByRole('button', { name: '편집' }))

      expect(screen.getByText('패턴 수정')).toBeInTheDocument()
      // The form should be prefilled with the pattern values
      expect(screen.getByDisplayValue('Old')).toBeInTheDocument()
      expect(screen.getByDisplayValue('BP')).toBeInTheDocument()
      // Both the header tag and the row chip read 편집 중 — assert both exist
      expect(screen.getAllByText('편집 중').length).toBeGreaterThanOrEqual(2)

      // Modify and submit
      fireEvent.change(screen.getByDisplayValue('Old'), { target: { value: 'New' } })
      fireEvent.click(screen.getByRole('button', { name: '수정 완료' }))

      expect(handlers.onUpdate).toHaveBeenCalledTimes(1)
      expect(handlers.onUpdate.mock.calls[0][0]).toBe('cp-edit')
      expect(handlers.onUpdate.mock.calls[0][1]).toMatchObject({
        name: 'New',
        sequence: 'BP',
        betDirection: 'T',
      })
      // After submit it should return to "new pattern" mode (no edit chip)
      expect(screen.queryByText('편집 중')).not.toBeInTheDocument()
    })
  })

  describe('two-step delete', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not delete on first click; arms 정말 삭제? state instead', () => {
      const p = pattern({ id: 'cp-del' })
      renderModal([p], handlers)

      fireEvent.click(screen.getByRole('button', { name: '삭제' }))

      expect(handlers.onDelete).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: '정말 삭제?' })).toBeInTheDocument()
    })

    it('deletes when the confirm button is clicked within the window', () => {
      const p = pattern({ id: 'cp-del' })
      renderModal([p], handlers)

      fireEvent.click(screen.getByRole('button', { name: '삭제' }))
      fireEvent.click(screen.getByRole('button', { name: '정말 삭제?' }))

      expect(handlers.onDelete).toHaveBeenCalledTimes(1)
      expect(handlers.onDelete).toHaveBeenCalledWith('cp-del')
    })

    it('cancels the armed state after the timeout elapses', () => {
      const p = pattern({ id: 'cp-del' })
      renderModal([p], handlers)

      fireEvent.click(screen.getByRole('button', { name: '삭제' }))
      expect(screen.getByRole('button', { name: '정말 삭제?' })).toBeInTheDocument()

      act(() => { vi.advanceTimersByTime(3100) })

      expect(screen.queryByRole('button', { name: '정말 삭제?' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: '삭제' })).toBeInTheDocument()
      expect(handlers.onDelete).not.toHaveBeenCalled()
    })
  })

  describe('toggle', () => {
    it('forwards the new enabled state via onToggle when the row 표시 toggle is clicked', () => {
      const p = pattern({ id: 'cp-tg', enabled: true })
      renderModal([p], handlers)

      // Two checkboxes exist (form's 패턴 활성화 + row's 표시). The row toggle
      // sits inside .pattern-item__actions; scope the query to that.
      const row = document.querySelector('.pattern-item__actions') as HTMLElement
      expect(row).not.toBeNull()
      const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement
      fireEvent.click(checkbox)

      expect(handlers.onToggle).toHaveBeenCalledWith('cp-tg', false)
    })
  })
})
