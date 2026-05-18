// FreshShoeToggle — Fresh-Shoe Tie 마틴 preset card.
// Single source for the toggle previously duplicated in AutoModeSettingsDialog
// and SemiAutoSettingsDialog. Reads/writes the preset via the DI container.

import { useState, type ReactNode } from 'react'
import { getFreshShoePreset } from '../../../application/di/setupContainer'

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
    <div
      style={{
        border: '1px solid var(--color-border, #444)',
        borderRadius: 8,
        padding: 12,
        margin: '12px 0',
        background: 'var(--color-surface-2, #1c1c1c)',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => handleChange(e.target.checked)}
        />
        새 슈 타이 마틴
      </label>
      <div style={{ fontSize: 12, color: 'var(--color-text-dim, #999)', marginTop: 6, lineHeight: 1.5 }}>
        {preset.getDescription()}
        {warning && (
          <>
            {' '}
            <strong style={{ color: 'var(--color-warn, #d97706)' }}>{warning}</strong>
          </>
        )}
      </div>
    </div>
  )
}
