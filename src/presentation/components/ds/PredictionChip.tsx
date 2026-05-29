// PredictionChip — 통합 디자인시스템: 예측을 한글 전용 칩으로 표시
// 리디자인 1단계. 게임색(뱅커=빨강/플레이어=파랑/타이=초록)은 결과 표시에만 사용.
// raw B/P/T 절대 노출 금지 — 색 + 한글 텍스트 이중 코딩(텍스트가 비색 채널).
import './PredictionChip.css'

export type PredictionValue = 'B' | 'P' | 'T' | 'wait' | 'pass' | null

interface PredictionChipProps {
  value: PredictionValue
  /** md = 카드/목록용, hero = 한 방 자세히/안내카드용(30px) */
  size?: 'md' | 'hero'
  /** hero 크기에서만 노출되는 신뢰도(0~100) */
  confidence?: number
  className?: string
}

const LABEL: Record<string, { text: string; cls: string }> = {
  B: { text: '뱅커', cls: 'banker' },
  P: { text: '플레이어', cls: 'player' },
  T: { text: '타이', cls: 'tie' },
  wait: { text: '준비 중', cls: 'wait' },
  pass: { text: '패스', cls: 'pass' },
}

export function PredictionChip({ value, size = 'md', confidence, className = '' }: PredictionChipProps) {
  const meta = LABEL[value ?? 'wait'] ?? LABEL.wait
  return (
    <div
      className={`pred-chip pred-chip--${meta.cls} pred-chip--${size} ${className}`}
      role="status"
      aria-label={`예측 ${meta.text}`}
    >
      <span className="pred-chip__text">{meta.text}</span>
      {size === 'hero' && typeof confidence === 'number' && (
        <span className="pred-chip__conf">신뢰도 {Math.round(confidence)}%</span>
      )}
    </div>
  )
}

export default PredictionChip
