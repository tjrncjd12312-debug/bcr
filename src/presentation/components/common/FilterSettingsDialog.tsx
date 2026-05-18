// FilterSettingsDialog — one place for all filter-related settings.
// Backing services are unchanged; this is UI consolidation only.

import { SettingsDialogFrame } from './SettingsDialogFrame'
import { FreshShoeToggle, type FreshShoeScope } from './FreshShoeToggle'
import FilterThresholdInline from '../AutoModePanel/components/FilterThresholdInline'
import PatternBetDirectionSelect from '../AutoModePanel/components/PatternBetDirectionSelect'
import PatternBetStrategySelect from '../AutoModePanel/components/PatternBetStrategySelect'
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
        <h3 className="settings-section-title">타이 프리셋</h3>
        <FreshShoeToggle scope={freshShoeScope} />
      </section>

      <section className="filter-settings__section">
        <h3 className="settings-section-title">필터별 세부 설정</h3>
        <p className="filter-settings__hint">필터마다 임계값과 배팅 방향/전략을 지정</p>
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
