// FreshShoeToggle — Fresh-Shoe Tie 마틴 preset card.
// Single source for the toggle previously duplicated in AutoModeSettingsDialog
// and SemiAutoSettingsDialog. Reads/writes the preset via the DI container.

import { useState, type ReactNode } from 'react'
import { getFreshShoePreset } from '../../../application/di/setupContainer'
import './FreshShoeToggle.css'

export type FreshShoeScope = 'auto' | 'semiauto'

interface FreshShoeToggleProps {
  scope: FreshShoeScope
  warning?: ReactNode
}

export function FreshShoeToggle({ scope, warning }: FreshShoeToggleProps) {
  const preset = getFreshShoePreset()
  const [on, setOn] = useState(() => (preset ? preset.isEnabled(scope) : false))

  if (!preset) return null

  const handleChange = (next: boolean) => {
    if (next) preset.enable(scope)
    else preset.disable(scope)
    setOn(preset.isEnabled(scope))
  }

  return (
    <div className="fresh-shoe-toggle">
      <label className="fresh-shoe-toggle__row">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => handleChange(e.target.checked)}
        />
        새 슈 타이 마틴
      </label>
      <div className="fresh-shoe-toggle__desc">
        {preset.getDescription()}
        {warning && (
          <>
            {' '}
            <strong className="fresh-shoe-toggle__warning">{warning}</strong>
          </>
        )}
      </div>
    </div>
  )
}
