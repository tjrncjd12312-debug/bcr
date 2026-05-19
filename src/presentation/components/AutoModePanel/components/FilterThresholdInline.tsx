// FilterThresholdInline - Per-row threshold input(s) shown inside each filter
// dropdown item. Renders nothing for filter types that have no threshold.
// Backed by FilterThresholdsService (same store the old global
// FilterThresholdInputs used), so each filter row reads / writes only its
// own value. Some filters (tie_frequent) need MORE than one input — the
// component renders each slot with optional prefix/suffix text.

import { useEffect, useState } from 'react'
import type { RoomFilterType } from '../../../../domain/entities'
import FilterThresholdsService, { type FilterThresholds } from '../../../../application/services/FilterThresholdsService'
import './FilterThresholdInline.css'

type ThresholdKey = keyof FilterThresholds

interface ThresholdSlot {
  key: ThresholdKey
  prefix?: string
  suffix: string
  min?: number
  max?: number
}

const FILTER_TO_SLOTS: Partial<Record<RoomFilterType, ThresholdSlot[]>> = {
  tie_drought: [
    { key: 'tieDroughtThreshold', suffix: '게임' },
  ],
  tie_frequent: [
    { key: 'tieFrequentStart', prefix: '시작', suffix: '번째부터', min: 1, max: 200 },
    { key: 'tieFrequentWindow', suffix: '판 안에 타이', min: 1, max: 200 },
    { key: 'tieFrequentMinCount', suffix: '번~', min: 0, max: 99 },
    { key: 'tieFrequentMaxCount', suffix: '번', min: 0, max: 99 },
  ],
  fresh_room: [
    { key: 'freshRoomGames', suffix: '게임' },
  ],
  fresh_shoe: [
    { key: 'freshShoeMaxGameNumber', suffix: '게임' },
  ],
}

interface FilterThresholdInlineProps {
  filterType: RoomFilterType
}

export default function FilterThresholdInline({ filterType }: FilterThresholdInlineProps) {
  const slots = FILTER_TO_SLOTS[filterType]
  const [values, setValues] = useState<FilterThresholds>(() => FilterThresholdsService.get())

  useEffect(() => {
    if (!slots) return
    setValues(FilterThresholdsService.get())
    return FilterThresholdsService.onChange(setValues)
  }, [slots])

  if (!slots) return null

  const handleChange = (key: ThresholdKey, raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    FilterThresholdsService.set({ [key]: n } as Partial<FilterThresholds>)
  }

  return (
    <span
      className="filter-threshold-inline"
      onClick={(e) => e.stopPropagation()}
      title="이 필터의 임계값"
    >
      {slots.map((slot, idx) => (
        <span key={slot.key} className="filter-threshold-inline__slot">
          {slot.prefix && (
            <span className="filter-threshold-inline__prefix">{slot.prefix}</span>
          )}
          <input
            className="filter-threshold-inline__input"
            type="number"
            min={slot.min ?? 1}
            max={slot.max ?? 200}
            value={values[slot.key]}
            onChange={(e) => handleChange(slot.key, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            aria-label={slots.length === 1 ? '필터 임계값' : `필터 임계값 ${idx + 1}`}
          />
          <span className="filter-threshold-inline__suffix">{slot.suffix}</span>
        </span>
      ))}
    </span>
  )
}
