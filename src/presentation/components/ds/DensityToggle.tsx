// DensityToggle — 통합 디자인시스템: 목록 밀도 토글 [표준]/[촘촘]
// 리디자인 1단계. 현재의 4뷰 아이콘 토글 + 10개 정렬버튼 + 방향 토글을 이 하나로 대체.
import './DensityToggle.css'

export type Density = 'standard' | 'compact'

interface DensityToggleProps {
  value: Density
  onChange: (v: Density) => void
  className?: string
}

const OPTIONS: { value: Density; label: string }[] = [
  { value: 'standard', label: '표준' },
  { value: 'compact', label: '촘촘' },
]

export function DensityToggle({ value, onChange, className = '' }: DensityToggleProps) {
  return (
    <div className={`density-toggle ${className}`} role="group" aria-label="보기 밀도">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`density-toggle__btn ${value === o.value ? 'is-active' : ''}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default DensityToggle
