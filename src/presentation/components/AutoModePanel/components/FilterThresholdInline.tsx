// FilterThresholdInline - Per-row threshold input shown inside each filter
// dropdown item. Renders nothing for filter types that have no threshold.
// Backed by FilterThresholdsService (same store the old global FilterThresholdInputs used),
// so each filter row reads / writes only its own value.

import { useEffect, useState } from 'react'
import type { RoomFilterType } from '../../../../domain/entities'
import FilterThresholdsService, { type FilterThresholds } from '../../../../application/services/FilterThresholdsService'
import './FilterThresholdInline.css'

type ThresholdKey = keyof FilterThresholds

const FILTER_TO_KEY: Partial<Record<RoomFilterType, { key: ThresholdKey; suffix: string }>> = {
  tie_drought: { key: 'tieDroughtThreshold', suffix: '게임' },
  fresh_room: { key: 'freshRoomGames', suffix: '게임' },
  fresh_shoe: { key: 'freshShoeMaxGameNumber', suffix: '게임' },
}

interface FilterThresholdInlineProps {
  filterType: RoomFilterType
}

export default function FilterThresholdInline({ filterType }: FilterThresholdInlineProps) {
  const mapping = FILTER_TO_KEY[filterType]
  const [value, setValue] = useState<number>(() =>
    mapping ? FilterThresholdsService.get()[mapping.key] : 0
  )

  useEffect(() => {
    if (!mapping) return
    setValue(FilterThresholdsService.get()[mapping.key])
    return FilterThresholdsService.onChange((v) => setValue(v[mapping.key]))
  }, [mapping?.key])

  if (!mapping) return null

  const handleChange = (raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    FilterThresholdsService.set({ [mapping.key]: n } as Partial<FilterThresholds>)
  }

  return (
    <span
      className="filter-threshold-inline"
      onClick={(e) => e.stopPropagation()}
      title="이 필터의 임계값"
    >
      <input
        className="filter-threshold-inline__input"
        type="number"
        min={1}
        max={200}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        aria-label="필터 임계값"
      />
      <span className="filter-threshold-inline__suffix">{mapping.suffix}</span>
    </span>
  )
}
