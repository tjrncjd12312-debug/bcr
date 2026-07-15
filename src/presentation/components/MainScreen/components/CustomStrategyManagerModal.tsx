import { useEffect, useMemo, useState } from 'react'
import CustomStrategyService from '../../../../application/services/CustomStrategyService'
import AutoModeService from '../../../../application/services/AutoModeService'
import {
  describeCustomStrategy,
  type CustomEntryCondition,
  type CustomStrategyDefinitionV1,
  validateCustomStrategy,
} from '../../../../domain/strategies/customStrategy'
import type { RoomFilterType, Winner } from '../../../../domain/entities'
import '../../common/Modal.css'
import './CustomStrategyManagerModal.css'

interface CustomStrategyManagerModalProps {
  isOpen: boolean
  onClose: () => void
  activeFilter?: RoomFilterType | 'all'
  onApply: (filter: RoomFilterType) => void
}

function cloneStrategy(strategy: CustomStrategyDefinitionV1): CustomStrategyDefinitionV1 {
  return JSON.parse(JSON.stringify(strategy)) as CustomStrategyDefinitionV1
}

function conditionId(): string {
  return `condition-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
}

function stageId(): string {
  return `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
}

export default function CustomStrategyManagerModal({
  isOpen,
  onClose,
  activeFilter = 'all',
  onApply,
}: CustomStrategyManagerModalProps) {
  const [strategies, setStrategies] = useState(() => CustomStrategyService.getStrategies())
  const [selectedId, setSelectedId] = useState(() => strategies[0]?.id || '')
  const [draft, setDraft] = useState<CustomStrategyDefinitionV1 | null>(() => strategies[0] ? cloneStrategy(strategies[0]) : null)
  const [message, setMessage] = useState<string | null>(null)
  const [autoRunning, setAutoRunning] = useState(() => AutoModeService.getState().settings.enabled)

  useEffect(() => CustomStrategyService.onChange(setStrategies), [])
  useEffect(() => AutoModeService.onStateChange(state => setAutoRunning(state.settings.enabled)), [])

  useEffect(() => {
    if (!isOpen) return
    const activeId = typeof activeFilter === 'string' && activeFilter.startsWith('strategy:')
      ? activeFilter.slice('strategy:'.length)
      : null
    const next = strategies.find(strategy => strategy.id === activeId)
      ?? strategies.find(strategy => strategy.id === selectedId)
      ?? strategies[0]
    if (next) {
      setSelectedId(next.id)
      setDraft(cloneStrategy(next))
    }
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!draft && strategies.length > 0) {
      setSelectedId(strategies[0].id)
      setDraft(cloneStrategy(strategies[0]))
    }
  }, [draft, strategies])

  const validation = useMemo(() => draft
    ? validateCustomStrategy(draft)
    : { valid: false, errors: ['전략을 선택하세요.'] }, [draft])

  const updateDraft = (updater: (current: CustomStrategyDefinitionV1) => CustomStrategyDefinitionV1) => {
    setDraft(current => current ? updater(cloneStrategy(current)) : current)
    setMessage(null)
  }

  const selectStrategy = (strategy: CustomStrategyDefinitionV1) => {
    setSelectedId(strategy.id)
    setDraft(cloneStrategy(strategy))
    setMessage(null)
  }

  const saveDraft = (): CustomStrategyDefinitionV1 | null => {
    if (!draft || !validation.valid || autoRunning) return null
    try {
      const saved = CustomStrategyService.update(draft.id, draft)
      setDraft(cloneStrategy(saved))
      setMessage('저장했습니다.')
      return saved
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.')
      return null
    }
  }

  const addCondition = (type: CustomEntryCondition['type']) => {
    updateDraft(current => {
      const condition: CustomEntryCondition = type === 'max_streak'
        ? { id: conditionId(), type, targets: ['P', 'B'], max: 2, tiePolicy: 'ignore_keep_streak' }
        : type === 'result_count'
          ? { id: conditionId(), type, target: 'T', min: 0, max: 0 }
          : { id: conditionId(), type, sequence: ['P', 'B'], occurrence: 'absent' }
      current.entryFilter.conditions.push(condition)
      return current
    })
  }

  const updateCondition = (index: number, next: CustomEntryCondition) => {
    updateDraft(current => {
      current.entryFilter.conditions[index] = next
      return current
    })
  }

  const removeCondition = (index: number) => {
    updateDraft(current => {
      current.entryFilter.conditions.splice(index, 1)
      return current
    })
  }

  const changeRequiredWins = (wins: number) => {
    updateDraft(current => {
      const safeWins = Math.min(5, Math.max(1, wins))
      current.progression.requiredConsecutiveWins = safeWins
      current.progression.stages = current.progression.stages.map(stage => ({
        ...stage,
        amounts: Array.from({ length: safeWins }, (_, index) => stage.amounts[index] ?? stage.amounts[stage.amounts.length - 1] ?? 10000),
      }))
      return current
    })
  }

  if (!isOpen) return null

  return (
    <div className="modal-overlay strategy-builder-overlay" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="modal strategy-builder" role="dialog" aria-modal="true" aria-label="커스텀 전략 빌더">
        <header className="modal-header strategy-builder__header">
          <div>
            <h2>커스텀 전략 빌더</h2>
            <p>진입 조건과 단계 전이를 조합해 코드 수정 없이 전략을 만듭니다.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="닫기">×</button>
        </header>

        <div className="strategy-builder__workspace">
          <aside className="strategy-builder__rail">
            <div className="strategy-builder__rail-head">
              <span>저장된 전략</span>
              <button
                type="button"
                className="strategy-builder__text-btn"
                disabled={autoRunning}
                onClick={() => {
                  const created = CustomStrategyService.createNew()
                  selectStrategy(created)
                }}
              >새 전략</button>
            </div>
            <div className="strategy-builder__list">
              {strategies.map(strategy => {
                const active = activeFilter === `strategy:${strategy.id}`
                return (
                  <button
                    type="button"
                    key={strategy.id}
                    className={`strategy-builder__list-item ${selectedId === strategy.id ? 'is-selected' : ''}`}
                    onClick={() => selectStrategy(strategy)}
                  >
                    <span>{strategy.name}</span>
                    <small>{describeCustomStrategy(strategy)}</small>
                    {active && <em>사용 중</em>}
                  </button>
                )
              })}
            </div>
            {draft && (
              <div className="strategy-builder__rail-actions">
                <button type="button" disabled={autoRunning} onClick={() => selectStrategy(CustomStrategyService.duplicate(draft.id))}>복제</button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={autoRunning || strategies.length <= 1 || activeFilter === `strategy:${draft.id}`}
                  onClick={() => {
                    CustomStrategyService.remove(draft.id)
                    setDraft(null)
                    setSelectedId('')
                  }}
                >삭제</button>
              </div>
            )}
          </aside>

          {draft ? (
            <main className="strategy-builder__editor">
              {autoRunning && (
                <div className="strategy-builder__lock">자동모드 실행 중에는 전략을 편집할 수 없습니다. 자동모드를 먼저 정지하세요.</div>
              )}

              <section className="strategy-builder__section strategy-builder__identity">
                <label>
                  <span>전략 이름</span>
                  <input value={draft.name} disabled={autoRunning} onChange={event => updateDraft(current => ({ ...current, name: event.target.value }))} />
                </label>
                <label className="is-wide">
                  <span>설명</span>
                  <input value={draft.description || ''} disabled={autoRunning} onChange={event => updateDraft(current => ({ ...current, description: event.target.value }))} />
                </label>
                <label className="strategy-builder__switch">
                  <input type="checkbox" checked={draft.enabled} disabled={autoRunning} onChange={event => updateDraft(current => ({ ...current, enabled: event.target.checked }))} />
                  <span>필터에 표시</span>
                </label>
              </section>

              <section className="strategy-builder__section">
                <div className="strategy-builder__section-head">
                  <div><b>1. 진입 조건</b><span>슈의 어느 구간에서 어떤 결과를 찾을지 정합니다.</span></div>
                  <select disabled={autoRunning} value={draft.entryFilter.logic} onChange={event => updateDraft(current => ({ ...current, entryFilter: { ...current.entryFilter, logic: event.target.value as 'all' | 'any' } }))}>
                    <option value="all">모두 만족 (AND)</option>
                    <option value="any">하나 이상 (OR)</option>
                  </select>
                </div>
                <div className="strategy-builder__window">
                  <label><span>시작 회차</span><input type="number" min={1} disabled={autoRunning} value={draft.entryFilter.fromHand} onChange={event => updateDraft(current => ({ ...current, entryFilter: { ...current.entryFilter, fromHand: Number(event.target.value) } }))} /></label>
                  <span>→</span>
                  <label><span>종료 회차</span><input type="number" min={1} disabled={autoRunning} value={draft.entryFilter.toHand} onChange={event => updateDraft(current => ({ ...current, entryFilter: { ...current.entryFilter, toHand: Number(event.target.value) } }))} /></label>
                  <label className="strategy-builder__switch"><input type="checkbox" checked={draft.entryFilter.requireFullWindow} disabled={autoRunning} onChange={event => updateDraft(current => ({ ...current, entryFilter: { ...current.entryFilter, requireFullWindow: event.target.checked } }))} /><span>구간 완료 후 판정</span></label>
                </div>

                <div className="strategy-builder__conditions">
                  {draft.entryFilter.conditions.map((condition, index) => (
                    <ConditionEditor
                      key={condition.id}
                      condition={condition}
                      disabled={autoRunning}
                      onChange={next => updateCondition(index, next)}
                      onRemove={() => removeCondition(index)}
                    />
                  ))}
                </div>
                <div className="strategy-builder__add-row">
                  <span>조건 추가</span>
                  <button type="button" disabled={autoRunning} onClick={() => addCondition('max_streak')}>최대 연속</button>
                  <button type="button" disabled={autoRunning} onClick={() => addCondition('result_count')}>출현 횟수</button>
                  <button type="button" disabled={autoRunning} onClick={() => addCondition('sequence')}>패턴 포함/제외</button>
                </div>
              </section>

              <section className="strategy-builder__section">
                <div className="strategy-builder__section-head"><div><b>2. 진입 트리거</b><span>관찰 통과 후 베팅 방향을 확정합니다.</span></div></div>
                <div className="strategy-builder__fields">
                  <label><span>트리거</span><select disabled={autoRunning} value={draft.trigger.type} onChange={event => updateDraft(current => ({ ...current, trigger: { ...current.trigger, type: event.target.value as CustomStrategyDefinitionV1['trigger']['type'] } }))}><option value="next_non_tie">다음 P/B</option><option value="player_only">다음 플레이어</option><option value="banker_only">다음 뱅커</option></select></label>
                  <label><span>베팅 방향</span><select disabled={autoRunning} value={draft.trigger.direction} onChange={event => updateDraft(current => ({ ...current, trigger: { ...current.trigger, direction: event.target.value as CustomStrategyDefinitionV1['trigger']['direction'] } }))}><option value="follow">나온 방향 따라가기</option><option value="opposite">반대 방향</option><option value="fixed_player">플레이어 고정</option><option value="fixed_banker">뱅커 고정</option><option value="fixed_tie">타이 고정</option></select></label>
                  <label><span>베팅 시작</span><select disabled value="next_round"><option>트리거 다음 회차</option></select></label>
                </div>
              </section>

              <section className="strategy-builder__section">
                <div className="strategy-builder__section-head">
                  <div><b>3. 단계 진행</b><span>각 단계에서 연속 적중에 필요한 차수별 금액입니다.</span></div>
                  <label className="strategy-builder__wins"><span>목표 연속 적중</span><input type="number" min={1} max={5} disabled={autoRunning} value={draft.progression.requiredConsecutiveWins} onChange={event => changeRequiredWins(Number(event.target.value))} /></label>
                </div>
                <div className="strategy-builder__stage-table">
                  <div className="strategy-builder__stage-row is-head" style={{ gridTemplateColumns: `72px repeat(${draft.progression.requiredConsecutiveWins}, minmax(100px, 1fr)) 58px` }}>
                    <span>단계</span>
                    {Array.from({ length: draft.progression.requiredConsecutiveWins }, (_, index) => <span key={index}>{index + 1}차 금액</span>)}
                    <span />
                  </div>
                  {draft.progression.stages.map((stage, stageIndex) => (
                    <div className="strategy-builder__stage-row" key={stage.id} style={{ gridTemplateColumns: `72px repeat(${draft.progression.requiredConsecutiveWins}, minmax(100px, 1fr)) 58px` }}>
                      <b>{stageIndex + 1}단계</b>
                      {stage.amounts.map((amount, attemptIndex) => (
                        <input
                          key={attemptIndex}
                          type="number"
                          min={1}
                          step={1000}
                          disabled={autoRunning}
                          value={amount}
                          onChange={event => updateDraft(current => {
                            current.progression.stages[stageIndex].amounts[attemptIndex] = Number(event.target.value)
                            return current
                          })}
                          aria-label={`${stageIndex + 1}단계 ${attemptIndex + 1}차 금액`}
                        />
                      ))}
                      <button type="button" disabled={autoRunning || draft.progression.stages.length <= 1} onClick={() => updateDraft(current => { current.progression.stages.splice(stageIndex, 1); return current })}>삭제</button>
                    </div>
                  ))}
                </div>
                <div className="strategy-builder__stage-footer">
                  <button type="button" disabled={autoRunning} onClick={() => updateDraft(current => {
                    const previous = current.progression.stages[current.progression.stages.length - 1]?.amounts ?? Array(current.progression.requiredConsecutiveWins).fill(10000)
                    current.progression.stages.push({ id: stageId(), amounts: [...previous] })
                    return current
                  })}>+ 단계 추가</button>
                  <label><span>마지막 단계 실패</span><select disabled={autoRunning} value={draft.progression.onLastStageLoss} onChange={event => updateDraft(current => ({ ...current, progression: { ...current.progression, onLastStageLoss: event.target.value as 'stop_until_shoe' | 'repeat_last' } }))}><option value="stop_until_shoe">이번 슈 종료</option><option value="repeat_last">마지막 단계 반복</option></select></label>
                  <label><span>클리어 후</span><select disabled={autoRunning} value={draft.onClear} onChange={event => updateDraft(current => ({ ...current, onClear: event.target.value as 'stop_until_shoe' | 'rearm' }))}><option value="stop_until_shoe">이번 슈 종료</option><option value="rearm">다음 트리거 대기</option></select></label>
                </div>
              </section>

              <section className="strategy-builder__summary">
                <div><span>동작 요약</span><strong>{describeCustomStrategy(draft)}</strong></div>
                <p>승리하면 같은 단계의 다음 차수로 이동하고, 실패하면 다음 단계 1차로 이동합니다. 타이·거절·미체결은 현재 차수를 유지합니다.</p>
              </section>

              {!validation.valid && <div className="strategy-builder__errors">{validation.errors.map(error => <span key={error}>{error}</span>)}</div>}
              {message && <div className="strategy-builder__message">{message}</div>}

              <footer className="strategy-builder__footer">
                <button type="button" className="btn-secondary" onClick={onClose}>닫기</button>
                <button type="button" className="btn-secondary" disabled={autoRunning || !validation.valid} onClick={saveDraft}>저장</button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={autoRunning || !validation.valid || !draft.enabled}
                  onClick={() => {
                    const saved = saveDraft()
                    if (saved) onApply(`strategy:${saved.id}` as RoomFilterType)
                  }}
                >저장하고 적용</button>
              </footer>
            </main>
          ) : (
            <main className="strategy-builder__empty">전략을 만들거나 선택하세요.</main>
          )}
        </div>
      </div>
    </div>
  )
}

function ConditionEditor({
  condition,
  disabled,
  onChange,
  onRemove,
}: {
  condition: CustomEntryCondition
  disabled: boolean
  onChange: (next: CustomEntryCondition) => void
  onRemove: () => void
}) {
  const switchType = (type: CustomEntryCondition['type']) => {
    if (type === 'max_streak') onChange({ id: condition.id, type, targets: ['P', 'B'], max: 2, tiePolicy: 'ignore_keep_streak' })
    else if (type === 'result_count') onChange({ id: condition.id, type, target: 'T', min: 0, max: 0 })
    else onChange({ id: condition.id, type, sequence: ['P', 'B'], occurrence: 'absent' })
  }

  return (
    <div className="strategy-builder__condition">
      <select disabled={disabled} value={condition.type} onChange={event => switchType(event.target.value as CustomEntryCondition['type'])}>
        <option value="max_streak">최대 연속</option>
        <option value="result_count">출현 횟수</option>
        <option value="sequence">패턴 포함/제외</option>
      </select>

      {condition.type === 'max_streak' && (
        <>
          <div className="strategy-builder__target-checks">
            {(['P', 'B', 'T'] as const).map(target => (
              <label key={target}><input type="checkbox" disabled={disabled} checked={condition.targets.includes(target)} onChange={event => {
                const targets = event.target.checked
                  ? Array.from(new Set([...condition.targets, target]))
                  : condition.targets.filter(current => current !== target)
                onChange({ ...condition, targets })
              }} />{target}</label>
            ))}
          </div>
          <span>허용 최대</span>
          <input type="number" min={1} disabled={disabled} value={condition.max} onChange={event => onChange({ ...condition, max: Number(event.target.value) })} />
          <select disabled={disabled} value={condition.tiePolicy} onChange={event => onChange({ ...condition, tiePolicy: event.target.value as 'ignore_keep_streak' | 'break_streak' })}><option value="ignore_keep_streak">타이 무시·연속 유지</option><option value="break_streak">타이가 연속 끊음</option></select>
        </>
      )}

      {condition.type === 'result_count' && (
        <>
          <select disabled={disabled} value={condition.target} onChange={event => onChange({ ...condition, target: event.target.value as 'P' | 'B' | 'T' })}><option value="P">플레이어</option><option value="B">뱅커</option><option value="T">타이</option></select>
          <input type="number" min={0} disabled={disabled} value={condition.min} onChange={event => onChange({ ...condition, min: Number(event.target.value) })} />
          <span>~</span>
          <input type="number" min={0} disabled={disabled} value={condition.max} onChange={event => onChange({ ...condition, max: Number(event.target.value) })} />
          <span>회</span>
        </>
      )}

      {condition.type === 'sequence' && (
        <>
          <input className="is-sequence" disabled={disabled} value={condition.sequence.join('')} onChange={event => {
            const sequence = event.target.value.toUpperCase().replace(/[^BPT]/g, '').split('') as Winner[]
            onChange({ ...condition, sequence })
          }} placeholder="예: BPBP" />
          <select disabled={disabled} value={condition.occurrence} onChange={event => onChange({ ...condition, occurrence: event.target.value as 'present' | 'absent' })}><option value="present">포함</option><option value="absent">없음</option></select>
        </>
      )}

      <button type="button" className="strategy-builder__remove" disabled={disabled} onClick={onRemove}>×</button>
    </div>
  )
}
