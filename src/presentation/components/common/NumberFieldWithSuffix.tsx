// NumberFieldWithSuffix — labeled numeric input with a trailing unit suffix.
// Replaces the .ams-input-wrap / .sa-input-wrapper pattern across both
// settings dialogs.
// 2026-09-05: 빠른 선택 칩(presets)과 천 단위 표기(formatted)를 추가 — 큰 금액을 타이핑 없이
//   한 번에 고르고, 입력값을 "1,000,000원"으로 바로 읽을 수 있게(고령 사용자 가독성).

export interface NumberPreset {
  label: string
  value: number
}

interface NumberFieldWithSuffixProps {
  label: string
  value: number
  suffix: string
  min?: number
  max?: number
  step?: number
  onChange: (next: number) => void
  /** 한 번에 고르는 값들 — 입력 아래 칩으로 표시 */
  presets?: NumberPreset[]
  /** 라벨 오른쪽에 천 단위 표기(기본: 값이 1,000 이상일 때 자동) */
  formatted?: boolean
  /** 0일 때 표기할 문구(예: '끄기') */
  zeroLabel?: string
}

export function NumberFieldWithSuffix({
  label,
  value,
  suffix,
  min,
  max,
  step,
  onChange,
  presets,
  formatted,
  zeroLabel,
}: NumberFieldWithSuffixProps) {
  const showFormatted = formatted ?? Math.abs(value) >= 1000
  const formattedText = value === 0 && zeroLabel ? zeroLabel : `${value.toLocaleString()}${suffix}`
  return (
    <label className="settings-field">
      <span className="settings-field__head">
        <span className="settings-field__label">{label}</span>
        {(showFormatted || (value === 0 && zeroLabel)) && (
          <span className={`settings-field__formatted ${value === 0 && zeroLabel ? 'is-off' : ''}`} aria-hidden="true">
            {formattedText}
          </span>
        )}
      </span>
      <span className="settings-field__input-wrap">
        <input
          className="settings-field__input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => {
            // <input type="number"> reports target.value === '' both when the
            // field is cleared and when the user types a non-numeric character
            // (the browser strips it). Treat both as "no parseable number" and
            // skip onChange to avoid silently emitting 0.
            const raw = e.target.value
            if (raw === '') return
            const n = Number(raw)
            if (!Number.isFinite(n)) return
            if (n === value) return
            onChange(n)
          }}
        />
        <span className="settings-field__suffix">{suffix}</span>
      </span>
      {presets && presets.length > 0 && (
        <span className="settings-field__presets" role="group" aria-label={`${label} 빠른 선택`}>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className={`settings-field__preset ${p.value === value ? 'is-active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                if (p.value !== value) onChange(p.value)
              }}
            >
              {p.label}
            </button>
          ))}
        </span>
      )}
    </label>
  )
}
