// SafetyStrip — 통합 디자인시스템: 자동 배팅 켜질 때 모든 화면에서 보이는 안전 띠
// 리디자인 1단계. 항상 도달 가능한 '즉시 정지' + 선택적 '돌아가기'.
// tone='danger'(실제 배팅, 빨강) / 'warning'(자동 켜짐 안내, 앰버).
import './SafetyStrip.css'

interface SafetyStripProps {
  tone?: 'warning' | 'danger'
  message: string
  stopLabel?: string
  onStop?: () => void
  resumeLabel?: string
  onResume?: () => void
  className?: string
}

export function SafetyStrip({
  tone = 'warning',
  message,
  stopLabel = '자동 배팅 즉시 정지',
  onStop,
  resumeLabel,
  onResume,
  className = '',
}: SafetyStripProps) {
  return (
    <div className={`safety-strip safety-strip--${tone} ${className}`} role="alert">
      <span className="safety-strip__msg">
        <span className="safety-strip__icon" aria-hidden="true">⚠</span>
        {message}
      </span>
      <div className="safety-strip__actions">
        {resumeLabel && onResume && (
          <button type="button" className="safety-strip__resume" onClick={onResume}>
            {resumeLabel}
          </button>
        )}
        {onStop && (
          <button type="button" className="safety-strip__stop" onClick={onStop}>
            {stopLabel}
          </button>
        )}
      </div>
    </div>
  )
}

export default SafetyStrip
