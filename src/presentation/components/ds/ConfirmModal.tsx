// ConfirmModal — 통합 디자인시스템: 돈 동작 등 되돌릴 수 없는 행동 앞 의도적 마찰
// 리디자인 1단계. 확인 버튼은 반드시 '구체 동작 + 금액'('네, 뱅커에 1만원 걸기' / '자동 배팅 시작').
// 절대 '확인'·'계속' 같은 일반 라벨 금지.
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import './ConfirmModal.css'

export interface ConfirmRow {
  label: string
  value: ReactNode
}

interface ConfirmModalProps {
  open: boolean
  title: string
  rows?: ConfirmRow[]
  /** 구체 동작 라벨(필수). 예: '네, 뱅커에 1만원 걸기' */
  confirmLabel: string
  cancelLabel?: string
  /** 실제 돈 등 위험 동작이면 true → 확인 버튼 빨강 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({
  open,
  title,
  rows,
  confirmLabel,
  cancelLabel = '아니요, 취소',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="confirm-modal__backdrop" onClick={onCancel}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-modal__title">{title}</h2>

        {rows && rows.length > 0 && (
          <dl className="confirm-modal__rows">
            {rows.map((r, i) => (
              <div className="confirm-modal__row" key={i}>
                <dt className="confirm-modal__row-label">{r.label}</dt>
                <dd className="confirm-modal__row-value">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="confirm-modal__actions">
          <button
            type="button"
            className={`confirm-modal__confirm ${danger ? 'is-danger' : ''}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
          <button type="button" className="confirm-modal__cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmModal
