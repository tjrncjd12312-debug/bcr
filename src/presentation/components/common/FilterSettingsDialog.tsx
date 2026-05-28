// FilterSettingsDialog — one place for all filter-related settings.
// Backing services are unchanged; this is UI consolidation only.

import { useEffect, useState } from 'react'
import { SettingsDialogFrame } from './SettingsDialogFrame'
import { FreshShoeToggle, type FreshShoeScope } from './FreshShoeToggle'
import FilterThresholdInline from '../AutoModePanel/components/FilterThresholdInline'
import PatternBetDirectionSelect from '../AutoModePanel/components/PatternBetDirectionSelect'
import PatternBetStrategySelect from '../AutoModePanel/components/PatternBetStrategySelect'
import PatternBettingService from '../../../application/services/PatternBettingService'
import FilterThresholdsService from '../../../application/services/FilterThresholdsService'
import AutoModeService from '../../../application/services/AutoModeService'
import type { RoomFilter, RoomFilterType } from '../../../domain/entities'
import './FilterSettingsDialog.css'

interface FilterSettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  availableFilters: RoomFilter[]
  activeFilters: RoomFilterType[]
  toggleFilter: (type: RoomFilterType) => void
  clearFilters: () => void
  filterCounts?: Record<string, number>
  onOpenPatternManager: () => void
  freshShoeScope: FreshShoeScope
}

// "타이오토" 켜짐 조건:
//   - tie_frequent 필터가 활성 필터의 유일한 항목
//   - 방향 = T
// 전략은 글로벌(또는 사용자가 per-filter 드롭다운에서 따로 정한 값)을 따른다.
// 켜기 버튼이 전략을 'martingale'로 강제하면 글로벌에 설정한 커스텀 마틴 시퀀스가
// 무시되므로, 전략은 이 카드의 ON/OFF 판정에서 제외한다.
function useTieAutoState(activeFilters: RoomFilterType[]) {
  const isExclusiveTieFilter =
    activeFilters.length === 1 && activeFilters[0] === 'tie_frequent'
  const [direction, setDirection] = useState(() =>
    PatternBettingService.getBetDirection('tie_frequent')
  )

  useEffect(() => {
    const sync = () => {
      setDirection(PatternBettingService.getBetDirection('tie_frequent'))
    }
    sync()
    return PatternBettingService.onChange(sync)
  }, [])

  return isExclusiveTieFilter && direction === 'T'
}

// Easy 카드의 필터 임계값(시작 + 윈도우 + min/max 출현 횟수)을 실시간으로 따라가는 훅.
function useTieFrequentControls() {
  const [values, setValues] = useState(() => {
    const v = FilterThresholdsService.get()
    return {
      start: v.tieFrequentStart,
      window: v.tieFrequentWindow,
      min: v.tieFrequentMinCount,
      max: v.tieFrequentMaxCount,
    }
  })
  useEffect(() => {
    const sync = () => {
      const v = FilterThresholdsService.get()
      setValues({
        start: v.tieFrequentStart,
        window: v.tieFrequentWindow,
        min: v.tieFrequentMinCount,
        max: v.tieFrequentMaxCount,
      })
    }
    sync()
    return FilterThresholdsService.onChange(sync)
  }, [])
  return values
}

// Easy 카드의 금액/마틴 설정 — 글로벌 AutoModeService.settings에 직접 쓴다.
// "타이 자동"이 켜져 있을 땐 다른 필터가 모두 꺼진 상태(exclusive)라 사실상 타이에만 적용됨.
function useAutoBetSettings() {
  const [s, setS] = useState(() => AutoModeService.getState().settings)
  useEffect(() => {
    return AutoModeService.onStateChange(next => setS(next.settings))
  }, [])
  return {
    baseBetAmount: s.baseBetAmount,
    maxMartin: s.maxMartin,
    maxConcurrentBets: s.maxConcurrentBets ?? 0,
  }
}

export function FilterSettingsDialog({
  isOpen,
  onClose,
  availableFilters,
  activeFilters,
  toggleFilter,
  clearFilters,
  filterCounts = {},
  onOpenPatternManager,
  freshShoeScope,
}: FilterSettingsDialogProps) {
  const tieAutoOn = useTieAutoState(activeFilters)
  // 타이 자동이 켜져 있으면 "전체"는 강제 OFF — 다른 필터로 빠지지 않도록.
  const isAllActive = !tieAutoOn && activeFilters.length === 0
  const { start: tieStart, window: tieWindow, min: tieMin, max: tieMax } = useTieFrequentControls()
  const { baseBetAmount, maxMartin, maxConcurrentBets } = useAutoBetSettings()
  const tieMatchCount = filterCounts.tie_frequent ?? 0
  const tieConcurrentLimit = maxConcurrentBets > 0
    ? Math.min(tieMatchCount, maxConcurrentBets)
    : tieMatchCount
  const tieConcurrentLabel = maxConcurrentBets > 0
    ? `동시 최대 ${maxConcurrentBets}개`
    : '동시 제한 없음'
  const isTieConcurrentLimited = tieAutoOn && maxConcurrentBets > 0 && maxConcurrentBets < tieMatchCount

  const handleTieAutoToggle = () => {
    if (tieAutoOn) {
      if (activeFilters.includes('tie_frequent')) toggleFilter('tie_frequent')
      // OFF 시 per-filter 전략 override를 비워 글로벌 전략이 다시 적용되도록 한다.
      // (이전에 ON에서 'martingale'을 박아두면 OFF 후에도 sticky하게 남아
      //  글로벌 커스텀 시퀀스를 계속 덮어쓰는 문제가 있었다.)
      PatternBettingService.setBetStrategy('tie_frequent', undefined)
    } else {
      clearFilters()
      toggleFilter('tie_frequent')
      PatternBettingService.setBetDirection('tie_frequent', 'T')
      // 전략은 글로벌(또는 사용자가 per-filter 드롭다운에서 정한 값)을 따른다.
      // 'martingale'을 강제하면 글로벌에 설정한 커스텀/피보나치/파롤리 시퀀스가
      // 무시되어 사용자가 설정한 패턴대로 배팅되지 않는다(커밋 44dfd72 회귀 방지).
      PatternBettingService.setBetStrategy('tie_frequent', undefined)
    }
  }

  const setIntThreshold = (key: 'tieFrequentWindow' | 'tieFrequentStart' | 'tieFrequentMinCount' | 'tieFrequentMaxCount') =>
    (raw: string) => {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n)) FilterThresholdsService.set({ [key]: n })
    }

  const setIntAutoSetting = (key: 'baseBetAmount' | 'maxMartin' | 'maxConcurrentBets') =>
    (raw: string) => {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n)) {
        AutoModeService.updateSettings({ [key]: key === 'maxConcurrentBets' ? Math.max(0, n) : n })
      }
    }

  return (
    <SettingsDialogFrame
      isOpen={isOpen}
      onClose={onClose}
      title="필터 설정"
      footer={
        <button className="btn-primary" onClick={onClose}>
          확인
        </button>
      }
    >
      <section className={`filter-settings__quick ${tieAutoOn ? 'is-on' : ''}`}>
        <div className="filter-settings__quick-head">
          <div>
            <h3 className="filter-settings__quick-title">타이 자동 배팅</h3>
            <p className="filter-settings__quick-desc">
              슈 시작부터 일정 구간에 <strong>타이가 정해진 횟수만큼 나온(또는 안 나온) 방</strong>에서 <strong>타이에 마틴</strong>을 겁니다. 한 방에 들어가면 타이가 나올 때까지 그 방에서만 진행.
            </p>
          </div>
          <button
            type="button"
            className={`filter-settings__quick-btn ${tieAutoOn ? 'is-on' : ''}`}
            onClick={handleTieAutoToggle}
            aria-pressed={tieAutoOn}
          >
            {tieAutoOn ? '끄기' : '켜기'}
          </button>
        </div>
        <div className="filter-settings__quick-row">
          <span className="filter-settings__quick-row-label">시작</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={1}
            max={200}
            value={tieStart}
            onChange={(e) => setIntThreshold('tieFrequentStart')(e.target.value)}
            aria-label="관측 시작 게임 번호"
          />
          <span className="filter-settings__quick-row-label">번째 게임부터</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={1}
            max={200}
            value={tieWindow}
            onChange={(e) => setIntThreshold('tieFrequentWindow')(e.target.value)}
            aria-label="관측 윈도우 (판수)"
          />
          <span className="filter-settings__quick-row-label">판 안에 타이가</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={0}
            max={30}
            value={tieMin}
            onChange={(e) => setIntThreshold('tieFrequentMinCount')(e.target.value)}
            aria-label="타이 출현 최소 횟수"
          />
          <span className="filter-settings__quick-row-label">~</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={0}
            max={30}
            value={tieMax}
            onChange={(e) => setIntThreshold('tieFrequentMaxCount')(e.target.value)}
            aria-label="타이 출현 최대 횟수"
          />
          <span className="filter-settings__quick-row-label">번 나온 방만 배팅</span>
        </div>
        <div className="filter-settings__quick-row">
          <span className="filter-settings__quick-row-label">배팅 금액</span>
          <input
            className="filter-settings__quick-amount"
            type="number"
            min={1000}
            step={1000}
            value={baseBetAmount}
            onChange={(e) => setIntAutoSetting('baseBetAmount')(e.target.value)}
            aria-label="기본 배팅 금액"
          />
          <span className="filter-settings__quick-row-label">원 · 마틴 최대</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={1}
            max={100}
            value={maxMartin}
            onChange={(e) => setIntAutoSetting('maxMartin')(e.target.value)}
            aria-label="마틴 최대 단계"
          />
          <span className="filter-settings__quick-row-label">단계 · 동시</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={0}
            max={999}
            value={maxConcurrentBets}
            onChange={(e) => setIntAutoSetting('maxConcurrentBets')(e.target.value)}
            aria-label="동시 배팅 최대 방 수"
          />
          <span className="filter-settings__quick-row-label">개까지</span>
          <span className="filter-settings__quick-row-hint">0=제한 없음</span>
        </div>
        <div className="filter-settings__quick-status">
          {tieAutoOn
            ? `✓ 작동 중 · 조건 맞는 방 ${tieMatchCount}개 · 실제 진입 최대 ${tieConcurrentLimit}개 · ${tieConcurrentLabel}`
            : '꺼짐 — 위 숫자를 정한 뒤 켜기를 누르세요. 켜면 다른 필터는 모두 꺼집니다.'}
        </div>
        {isTieConcurrentLimited && (
          <div className="filter-settings__quick-warning">
            조건은 {tieMatchCount}개지만 동시 배팅 제한이 {maxConcurrentBets}개라 실제 배팅은 한 번에 최대 {maxConcurrentBets}개만 진행됩니다.
          </div>
        )}
      </section>

      <section className="filter-settings__section">
        <h3 className="settings-section-title">활성 필터</h3>
        <p className="filter-settings__hint">
          {tieAutoOn
            ? '타이 자동 배팅이 켜져 있어 다른 필터는 잠겨 있습니다. 변경하려면 위에서 끄기 누르세요.'
            : '사용할 필터를 켜고 끄세요'}
        </p>
        <div className={`filter-settings__filter-list ${tieAutoOn ? 'is-locked' : ''}`}>
          <label className="filter-settings__filter-row">
            <input
              type="checkbox"
              checked={isAllActive}
              disabled={tieAutoOn}
              onChange={() => {
                if (!isAllActive) clearFilters()
              }}
            />
            <span className="filter-settings__filter-label">전체 (AI 자동)</span>
            <span className="filter-settings__filter-count">{filterCounts.all ?? 0}</span>
          </label>
          {availableFilters.map(filter => {
            const isActive = activeFilters.includes(filter.type)
            const lockedByTieAuto = tieAutoOn && filter.type !== 'tie_frequent'
            return (
              <label key={filter.type} className="filter-settings__filter-row">
                <input
                  type="checkbox"
                  checked={isActive}
                  disabled={lockedByTieAuto}
                  onChange={() => toggleFilter(filter.type)}
                />
                <span className="filter-settings__filter-label">{filter.label}</span>
                <span className="filter-settings__filter-count">
                  {filterCounts[filter.type] ?? 0}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section className="filter-settings__section">
        <h3 className="settings-section-title">필터별 세부 설정</h3>
        <p className="filter-settings__hint">필터마다 기준값·배팅 방향·전략을 직접 정합니다 (고급)</p>
        <div className="filter-settings__detail-list">
          {availableFilters.map(filter => (
            <div key={filter.type} className="filter-settings__detail-row">
              <div className="filter-settings__detail-name">{filter.label}</div>
              <div className="filter-settings__detail-controls">
                <FilterThresholdInline filterType={filter.type} />
                <PatternBetDirectionSelect patternType={filter.type} size="sm" />
                <PatternBetStrategySelect patternType={filter.type} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="filter-settings__section">
        <h3 className="settings-section-title">고급 — 새 슈 전용 타이 자동 이동</h3>
        <p className="filter-settings__hint">
          위의 일반 타이 자동과 다름. 카지노 슈가 막 시작된 방만 골라 타이 마틴 → 결과에 따라 다른 새 슈 방으로 이동.
        </p>
        <FreshShoeToggle scope={freshShoeScope} />
      </section>

      <section className="filter-settings__section">
        <h3 className="settings-section-title">커스텀 패턴</h3>
        <button
          type="button"
          className="filter-settings__patterns-btn"
          onClick={onOpenPatternManager}
        >
          커스텀 패턴 추가/관리
        </button>
      </section>
    </SettingsDialogFrame>
  )
}
