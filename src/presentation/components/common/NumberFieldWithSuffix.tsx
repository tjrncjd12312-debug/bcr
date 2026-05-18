// NumberFieldWithSuffix — labeled numeric input with a trailing unit suffix.
// Replaces the .ams-input-wrap / .sa-input-wrapper pattern across both
// settings dialogs.

interface NumberFieldWithSuffixProps {
  label: string
  value: number
  suffix: string
  min?: number
  max?: number
  step?: number
  onChange: (next: number) => void
}

export function NumberFieldWithSuffix({
  label,
  value,
  suffix,
  min,
  max,
  step,
  onChange,
}: NumberFieldWithSuffixProps) {
  return (
    <label className="settings-field">
      <span className="settings-field__label">{label}</span>
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
    </label>
  )
}
