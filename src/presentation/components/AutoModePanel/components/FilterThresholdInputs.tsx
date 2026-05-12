// FilterThresholdInputs - Inline UI for adjusting tie_drought / fresh_room / fresh_shoe N values
// Lives inside the filter dropdown of both AutoMode and PredictMode panels.

import { useEffect, useState } from 'react'
import FilterThresholdsService from '../../../../application/services/FilterThresholdsService'
import './FilterThresholdInputs.css'

type Key = 'tieDroughtThreshold' | 'freshRoomGames' | 'freshShoeMaxGameNumber'

export default function FilterThresholdInputs() {
  const [values, setValues] = useState(FilterThresholdsService.get())

  useEffect(() => FilterThresholdsService.onChange(setValues), [])

  const update = (key: Key, raw: string) => {
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    FilterThresholdsService.set({ [key]: n })
  }

  return (
    <div className="filter-threshold-inputs" onClick={(e) => e.stopPropagation()}>
      <div className="filter-threshold-inputs__title">필터 임계값 설정</div>
      <label className="filter-threshold-inputs__row">
        <span className="filter-threshold-inputs__label">Tie 미발생 임계</span>
        <input
          className="filter-threshold-inputs__input"
          type="number"
          min={1}
          max={200}
          value={values.tieDroughtThreshold}
          onChange={(e) => update('tieDroughtThreshold', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="filter-threshold-inputs__suffix">게임</span>
      </label>
      <label className="filter-threshold-inputs__row">
        <span className="filter-threshold-inputs__label">신규 방 기준</span>
        <input
          className="filter-threshold-inputs__input"
          type="number"
          min={1}
          max={200}
          value={values.freshRoomGames}
          onChange={(e) => update('freshRoomGames', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="filter-threshold-inputs__suffix">게임</span>
      </label>
      <label className="filter-threshold-inputs__row">
        <span className="filter-threshold-inputs__label">Fresh Shoe 기준</span>
        <input
          className="filter-threshold-inputs__input"
          type="number"
          min={1}
          max={200}
          value={values.freshShoeMaxGameNumber}
          onChange={(e) => update('freshShoeMaxGameNumber', e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="filter-threshold-inputs__suffix">게임</span>
      </label>
    </div>
  )
}
