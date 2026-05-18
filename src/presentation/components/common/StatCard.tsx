// StatCard — labeled stat tile for settings dialogs.
// Used by AutoMode/SemiAuto settings to display balance, win rate,
// session totals, etc.

import type { ReactNode } from 'react'

type Tone = 'neutral' | 'positive' | 'negative'

interface StatCardProps {
  label: string
  value: ReactNode
  tone?: Tone
}

export function StatCard({ label, value, tone = 'neutral' }: StatCardProps) {
  return (
    <div className={`settings-stat-card ${tone}`}>
      <span className="settings-stat-card__label">{label}</span>
      <span className="settings-stat-card__value">{value}</span>
    </div>
  )
}
