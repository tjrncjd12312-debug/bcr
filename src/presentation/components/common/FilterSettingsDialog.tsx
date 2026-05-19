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

// "타이오토" 켜짐 조건 (엄격):
//   - tie_frequent 필터가 활성 필터의 유일한 항목
//   - 방향 = T
//   - 전략 = martingale
// 다른 필터가 같이 켜져 있거나 방향/전략이 다르면 OFF로 표시 — 사용자가
// "타이 전용"으로 동작하지 않는 상태임을 즉시 알 수 있게.
function useTieAutoState(activeFilters: RoomFilterType[]) {
  const isExclusiveTieFilter =
    activeFilters.length === 1 && activeFilters[0] === 'tie_frequent'
  const [direction, setDirection] = useState(() =>
    PatternBettingService.getBetDirection('tie_frequent')
  )
  const [strategy, setStrategy] = useState(() =>
    PatternBettingService.getBetStrategy('tie_frequent')
  )

  useEffect(() => {
    const sync = () => {
      setDirection(PatternBettingService.getBetDirection('tie_frequent'))
      setStrategy(PatternBettingService.getBetStrategy('tie_frequent'))
    }
    sync()
    return PatternBettingService.onChange(sync)
  }, [])

  return isExclusiveTieFilter && direction === 'T' && strategy === 'martingale'
}

// Easy 카드의 두 숫자(윈도우 + 출현 횟수)를 실시간으로 따라가는 훅.
// 출현 횟수는 min=max로 두어 "정확히 N번"으로 동작.
function useTieFrequentControls() {
  const [values, setValues] = useState(() => {
    const v = FilterThresholdsService.get()
    return { window: v.tieFrequentWindow, count: v.tieFrequentMinCount }
  })
  useEffect(() => {
    const sync = () => {
      const v = FilterThresholdsService.get()
      setValues({ window: v.tieFrequentWindow, count: v.tieFrequentMinCount })
    }
    sync()
    return FilterThresholdsService.onChange(sync)
  }, [])
  return values
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
  const isAllActive = activeFilters.length === 0
  const tieAutoOn = useTieAutoState(activeFilters)
  const { window: tieWindow, count: tieCount } = useTieFrequentControls()
  const tieMatchCount = filterCounts.tie_frequent ?? 0

  const handleTieAutoToggle = () => {
    if (tieAutoOn) {
      // 끄기: tie_frequent 필터만 끔. 사용자가 손댄 방향/전략/숫자는 그대로 보존.
      if (activeFilters.includes('tie_frequent')) toggleFilter('tie_frequent')
    } else {
      // 켜기: 다른 필터와 섞이지 않게 전부 클리어한 뒤 tie_frequent만 켠다.
      // 방향=T + 전략=martingale도 함께 적용해 "타이 전용 모드"로 진입.
      clearFilters()
      toggleFilter('tie_frequent')
      PatternBettingService.setBetDirection('tie_frequent', 'T')
      PatternBettingService.setBetStrategy('tie_frequent', 'martingale')
    }
  }

  const handleTieCountChange = (raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    // 어르신용 카드는 "정확히 N번"으로 동작 — min과 max를 같은 값으로 둔다.
    FilterThresholdsService.set({ tieFrequentMinCount: n, tieFrequentMaxCount: n })
  }

  const handleTieWindowChange = (raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    FilterThresholdsService.set({ tieFrequentWindow: n })
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
              아래 횟수만큼 <strong>타이가 나온 방</strong>에서 <strong>타이에 마틴</strong>을 겁니다.
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
          <span className="filter-settings__quick-row-label">최근</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={5}
            max={200}
            value={tieWindow}
            onChange={(e) => handleTieWindowChange(e.target.value)}
            aria-label="관측 윈도우 (판수)"
          />
          <span className="filter-settings__quick-row-label">판 안에 타이가</span>
          <input
            className="filter-settings__quick-count"
            type="number"
            min={1}
            max={30}
            value={tieCount}
            onChange={(e) => handleTieCountChange(e.target.value)}
            aria-label="타이 출현 횟수"
          />
          <span className="filter-settings__quick-row-label">번 나온 방만 배팅</span>
        </div>
        <div className="filter-settings__quick-status">
          {tieAutoOn
            ? `✓ 작동 중 · 지금 조건에 맞는 방 ${tieMatchCount}개 · 다른 필터와 섞이지 않음`
            : '꺼짐 — 위 숫자를 정한 뒤 켜기를 누르세요. 켜면 다른 필터는 모두 꺼집니다.'}
        </div>
      </section>

      <section className="filter-settings__section">
        <h3 className="settings-section-title">활성 필터</h3>
        <p className="filter-settings__hint">사용할 필터를 켜고 끄세요</p>
        <div className="filter-settings__filter-list">
          <label className="filter-settings__filter-row">
            <input
              type="checkbox"
              checked={isAllActive}
              onChange={() => {
                if (!isAllActive) clearFilters()
              }}
            />
            <span className="filter-settings__filter-label">전체 (AI 자동)</span>
            <span className="filter-settings__filter-count">{filterCounts.all ?? 0}</span>
          </label>
          {availableFilters.map(filter => {
            const isActive = activeFilters.includes(filter.type)
            return (
              <label key={filter.type} className="filter-settings__filter-row">
                <input
                  type="checkbox"
                  checked={isActive}
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
