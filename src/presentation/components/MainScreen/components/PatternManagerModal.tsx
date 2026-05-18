import { useEffect, useMemo, useRef, useState } from 'react'
import type { CustomPattern, RoomFilterType, PatternBetDirection } from '../../../../domain/entities'
import { cleanSequence } from '../../../../application/services/CustomPatternService'
import '../../common/Modal.css'

const BET_DIRECTION_LABELS: Record<PatternBetDirection, string> = {
  ai: 'AI 예측',
  B: '뱅커 (B)',
  P: '플레이어 (P)',
  T: '타이 (T)',
  skip: '스킵',
}

const DELETE_CONFIRM_WINDOW_MS = 3000

interface PatternManagerModalProps {
  isOpen: boolean
  onClose: () => void
  patterns: CustomPattern[]
  selectedPattern?: RoomFilterType | 'all'
  onCreate: (data: { name: string; sequence: string; enabled: boolean; description?: string; betDirection?: PatternBetDirection }) => void
  onUpdate: (id: string, data: { name: string; sequence: string; enabled: boolean; description?: string; betDirection?: PatternBetDirection }) => void
  onDelete: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
  onApply?: (pattern: RoomFilterType) => void
}

interface FormState {
  name: string
  sequence: string
  enabled: boolean
  description: string
  betDirection: PatternBetDirection
}

const defaultForm: FormState = {
  name: '',
  sequence: '',
  enabled: true,
  description: '',
  betDirection: 'ai',
}

export function PatternManagerModal({
  isOpen,
  onClose,
  patterns,
  selectedPattern = 'all',
  onCreate,
  onUpdate,
  onDelete,
  onToggle,
  onApply,
}: PatternManagerModalProps) {
  const [form, setForm] = useState<FormState>(defaultForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setForm(defaultForm)
      setEditingId(null)
      setError(null)
      clearConfirmTimer()
      setConfirmDeleteId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Cleanup any pending confirm timer on unmount to prevent leaks.
  useEffect(() => {
    return () => clearConfirmTimer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearConfirmTimer() {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }

  const selectedId = useMemo(() => {
    if (typeof selectedPattern === 'string' && selectedPattern.startsWith('custom:')) {
      return selectedPattern.replace('custom:', '')
    }
    return null
  }, [selectedPattern])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const name = form.name.trim()
    const sequenceArr = cleanSequence(form.sequence)
    const description = form.description.trim() || undefined

    if (!name) {
      setError('패턴 이름을 입력해주세요.')
      return
    }
    if (sequenceArr.length < 1) {
      setError('패턴은 최소 1글자 이상 B/P/T로 입력해주세요.')
      return
    }

    if (editingId) {
      onUpdate(editingId, { name, sequence: sequenceArr.join(''), enabled: form.enabled, description, betDirection: form.betDirection })
    } else {
      onCreate({ name, sequence: sequenceArr.join(''), enabled: form.enabled, description, betDirection: form.betDirection })
    }

    setForm(defaultForm)
    setEditingId(null)
    setError(null)
  }

  const startEdit = (pattern: CustomPattern) => {
    setEditingId(pattern.id)
    setForm({
      name: pattern.name,
      sequence: pattern.sequence.join(''),
      enabled: pattern.enabled,
      description: pattern.description || '',
      betDirection: pattern.betDirection || 'ai',
    })
    setError(null)
    clearConfirmTimer()
    setConfirmDeleteId(null)
  }

  const cancelEdit = () => {
    setForm(defaultForm)
    setEditingId(null)
    setError(null)
  }

  // Two-step delete: first click arms the confirmation state with a 3s timeout,
  // second click within the window performs the delete. Prevents accidental
  // destruction without resorting to a blocking native confirm().
  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      clearConfirmTimer()
      setConfirmDeleteId(null)
      // If user was editing the pattern they're about to delete, exit edit mode first.
      if (editingId === id) {
        cancelEdit()
      }
      onDelete(id)
      return
    }
    clearConfirmTimer()
    setConfirmDeleteId(id)
    confirmTimerRef.current = setTimeout(() => {
      setConfirmDeleteId(null)
      confirmTimerRef.current = null
    }, DELETE_CONFIRM_WINDOW_MS)
  }

  const handleApply = (id: string) => {
    onApply?.(`custom:${id}` as RoomFilterType)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal pattern-modal">
        <div className="modal-header">
          <h2>패턴 설정 {editingId && <span className="pattern-modal__edit-tag">편집 중</span>}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body pattern-body">
          {/* 패턴 등록/수정 폼 */}
          <div className={`pattern-form${editingId ? ' pattern-form--editing' : ''}`}>
            <div className="pattern-form__header">
              <div>
                <div className="pattern-form__title">{editingId ? '패턴 수정' : '새 패턴 등록'}</div>
                <p className="pattern-form__hint">
                  감지할 패턴과 배팅 방향을 설정하세요.<br />
                  예) 패턴: BPBP → 배팅: 플레이어 = "BPBP가 나오면 P에 배팅"
                </p>
              </div>
              {editingId && (
                <button type="button" className="btn-secondary" onClick={cancelEdit}>
                  새 패턴으로 전환
                </button>
              )}
            </div>

            <form className="pattern-form__grid" onSubmit={handleSubmit}>
              <label className="pattern-field">
                <span>패턴 이름 *</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="예: 장줄 끊김, 퐁당 연장"
                />
              </label>

              <label className="pattern-field">
                <span>감지 패턴 * (최근 결과, B/P/T)</span>
                <input
                  type="text"
                  value={form.sequence}
                  onChange={(e) => setForm(f => ({ ...f, sequence: e.target.value.toUpperCase() }))}
                  placeholder="예: BBBB (4연속 뱅커)"
                />
              </label>

              <label className="pattern-field">
                <span>배팅 방향 *</span>
                <select
                  className="pattern-direction-select"
                  value={form.betDirection}
                  onChange={(e) => setForm(f => ({ ...f, betDirection: e.target.value as PatternBetDirection }))}
                >
                  <option value="ai">AI 예측 (서버 요청)</option>
                  <option value="B">뱅커 (B) 배팅</option>
                  <option value="P">플레이어 (P) 배팅</option>
                  <option value="T">타이 (T) 배팅</option>
                  <option value="skip">배팅 안 함 (스킵)</option>
                </select>
              </label>

              <label className="pattern-field">
                <span>메모 (선택)</span>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="패턴 설명이나 조건 메모"
                />
              </label>

              <label className="pattern-field checkbox">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm(f => ({ ...f, enabled: e.target.checked }))}
                />
                <span>패턴 활성화 (필터 드롭다운에 표시)</span>
              </label>

              {error && <div className="pattern-error">{error}</div>}

              <div className="pattern-actions">
                <button type="button" className="btn-secondary" onClick={cancelEdit}>
                  취소
                </button>
                <button type="submit" className="btn-primary">
                  {editingId ? '수정 완료' : '패턴 저장'}
                </button>
              </div>
            </form>
          </div>

          {/* 등록된 패턴 목록 */}
          <div className="pattern-list">
            <div className="pattern-list__header">
              <div>
                <div className="pattern-list__title">등록된 패턴</div>
                <p className="pattern-list__hint">패턴이 감지되면 설정한 방향으로 배팅합니다.</p>
              </div>
              {patterns.length > 0 && (
                <span className="pattern-count">{patterns.length}개</span>
              )}
            </div>

            {patterns.length === 0 ? (
              <div className="pattern-empty">
                등록된 패턴이 없습니다.<br />
                위에서 새 패턴을 추가하세요.
              </div>
            ) : (
              <ul>
                {patterns.map((pattern) => {
                  const isSelected = selectedId === pattern.id
                  const isEditing = editingId === pattern.id
                  const isConfirmingDelete = confirmDeleteId === pattern.id
                  const dirLabel = BET_DIRECTION_LABELS[pattern.betDirection || 'ai']
                  const itemClass = [
                    'pattern-item',
                    !pattern.enabled && 'disabled',
                    isEditing && 'is-editing',
                    isConfirmingDelete && 'is-confirming',
                  ].filter(Boolean).join(' ')

                  return (
                    <li key={pattern.id} className={itemClass}>
                      <div className="pattern-item__main">
                        <div className="pattern-item__title">
                          <span>{pattern.name}</span>
                          <span className={`pattern-chip ${pattern.betDirection === 'B' ? 'banker' : pattern.betDirection === 'P' ? 'player' : ''}`}>
                            {pattern.sequence.join('')} → {dirLabel}
                          </span>
                          {!pattern.enabled && <span className="pattern-chip">비활성</span>}
                          {isSelected && <span className="pattern-chip active">선택됨</span>}
                          {isEditing && <span className="pattern-chip editing">편집 중</span>}
                        </div>
                        {pattern.description && (
                          <div className="pattern-item__meta">
                            <span className="pattern-desc">{pattern.description}</span>
                          </div>
                        )}
                      </div>
                      <div className="pattern-item__actions">
                        <label className="pattern-toggle">
                          <input
                            type="checkbox"
                            checked={pattern.enabled}
                            onChange={(e) => onToggle(pattern.id, e.target.checked)}
                          />
                          <span>표시</span>
                        </label>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            startEdit(pattern)
                          }}
                        >
                          편집
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            handleApply(pattern.id)
                          }}
                          disabled={!pattern.enabled}
                          title={pattern.enabled ? '이 패턴으로 필터 적용' : '활성화 후 적용 가능'}
                        >
                          적용
                        </button>
                        <button
                          type="button"
                          className={`btn-danger${isConfirmingDelete ? ' btn-danger--confirming' : ''}`}
                          onClick={() => handleDeleteClick(pattern.id)}
                          title={isConfirmingDelete ? '한 번 더 누르면 삭제됩니다' : '삭제'}
                        >
                          {isConfirmingDelete ? '정말 삭제?' : '삭제'}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default PatternManagerModal
