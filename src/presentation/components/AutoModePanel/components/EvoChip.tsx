// EvoChip — 실제 카지노 칩 모양(액면별 색, 테두리 줄무늬). 마틴 단계만큼 뒤에 쌓인다.
import { memo } from 'react'
import { chipLabel, chipTone } from '../utils/cards'

interface EvoChipProps {
  amount: number
  /** 쌓인 칩 수(마틴 단계). 1이면 한 장 */
  stack?: number
  size?: number
  className?: string
}

export const EvoChip = memo(function EvoChip({ amount, stack = 1, size = 34, className = '' }: EvoChipProps) {
  const tone = chipTone(amount)
  const label = chipLabel(amount)
  const layers = Math.max(1, Math.min(stack, 4))
  const fontSize = label.length >= 4 ? 10 : label.length === 3 ? 11.5 : 13
  return (
    <span
      className={`evo-chip evo-chip--${tone} ${className}`.trim()}
      style={{ width: size, height: size + (layers - 1) * 3 }}
      aria-label={`${amount.toLocaleString()}원 칩${layers > 1 ? ` ${layers}장` : ''}`}
    >
      {Array.from({ length: layers }).map((_, i) => {
        const top = (layers - 1 - i) * 3
        const isTop = i === layers - 1
        return (
          <svg key={i} className={`evo-chip__layer ${isTop ? 'is-top' : ''}`} viewBox="0 0 40 40" width={size} height={size} style={{ top }} aria-hidden="true">
            <circle className="evo-chip__edge" cx="20" cy="20" r="19" />
            <circle className="evo-chip__stripes" cx="20" cy="20" r="17.5" fill="none" strokeWidth="3" strokeDasharray="5.5 5.5" />
            <circle className="evo-chip__inner" cx="20" cy="20" r="12.5" />
            {isTop && (
              <text className="evo-chip__label" x="20" y="24.5" textAnchor="middle" fontSize={fontSize} fontWeight="900">{label}</text>
            )}
          </svg>
        )
      })}
    </span>
  )
})

export default EvoChip
