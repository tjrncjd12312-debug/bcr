// GuidanceCard — 통합 디자인시스템: 도움받기(세미오토)의 주인공, 매 판 뜨는 안내 카드
// 리디자인 3단계. 한 문장 평이한 한국어 + 한글 예측칩 + 추천 금액 30px + 동급 두 버튼.
// raw B/P/T·빨강→파랑 그라데이션 금지. 단일탭 즉시집행 금지(걸기는 상위에서 확인 한 단계).
import { PredictionChip, type PredictionValue } from './PredictionChip'
import './GuidanceCard.css'

const WINNER_KO: Record<string, string> = { B: '뱅커', P: '플레이어', T: '타이' }

interface GuidanceCardProps {
  /** bet=거세요 권고, skip=쉬는 게 좋아요 */
  mode: 'bet' | 'skip'
  prediction?: PredictionValue
  confidence?: number
  /** 추천 금액(원) */
  amount?: number
  /** 금액 보조 설명(예: '지금 1단계 · 졌을 때 대비해 조금') */
  amountNote?: string
  /** skip 사유(평이한 한국어) */
  skipReason?: string
  /** 남은 시간(초)과 전체(진행바용) */
  countdownSeconds?: number
  countdownTotal?: number
  formatCurrency?: (n: number) => string
  /** bet 모드 */
  onBet?: () => void
  onSkip?: () => void
  /** skip 모드 */
  onFollowSkip?: () => void
  onBetAnyway?: () => void
  className?: string
}

const defaultFormat = (n: number) => `₩ ${n.toLocaleString()}`

export function GuidanceCard({
  mode,
  prediction,
  confidence,
  amount,
  amountNote,
  skipReason,
  countdownSeconds,
  countdownTotal,
  formatCurrency = defaultFormat,
  onBet,
  onSkip,
  onFollowSkip,
  onBetAnyway,
  className = '',
}: GuidanceCardProps) {
  const predKo = prediction && WINNER_KO[prediction] ? WINNER_KO[prediction] : null
  const pct =
    countdownSeconds != null && countdownTotal && countdownTotal > 0
      ? Math.max(0, Math.min(100, (countdownSeconds / countdownTotal) * 100))
      : null

  if (mode === 'skip') {
    return (
      <section className={`guidance-card guidance-card--skip ${className}`} aria-label="이번 판 안내">
        <div className="guidance-card__headline">
          이번 판은 <span className="guidance-card__skip-mark" aria-hidden="true">⏸</span> 쉬는 게 좋아요
        </div>
        {skipReason && <p className="guidance-card__reason">{skipReason}</p>}
        <div className="guidance-card__actions">
          <button type="button" className="guidance-card__primary" onClick={onFollowSkip}>
            알겠어요, 쉴게요
          </button>
          <button type="button" className="guidance-card__secondary guidance-card__secondary--small" onClick={onBetAnyway}>
            그래도 직접 걸기
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className={`guidance-card guidance-card--bet ${className}`} aria-label="이번 판 안내">
      <div className="guidance-card__top">
        <div className="guidance-card__headline">
          이번 판은 {predKo ? <PredictionChip value={prediction!} /> : '준비 중'} 에 거세요
        </div>
        {countdownSeconds != null && (
          <div className="guidance-card__countdown">
            남은 시간 <strong>{countdownSeconds}초</strong>
            {pct != null && (
              <span className="guidance-card__bar" aria-hidden="true">
                <span className="guidance-card__bar-fill" style={{ width: `${pct}%` }} />
              </span>
            )}
          </div>
        )}
      </div>

      {typeof confidence === 'number' && (
        <div className="guidance-card__confidence">믿음 정도 {Math.round(confidence)}%</div>
      )}

      {typeof amount === 'number' && (
        <div className="guidance-card__amount">
          추천 금액 <strong>{formatCurrency(amount)}</strong>
          {amountNote && <span className="guidance-card__amount-note"> · {amountNote}</span>}
        </div>
      )}

      <div className="guidance-card__actions">
        <button type="button" className="guidance-card__primary" onClick={onBet}>
          이대로 걸기 ▶
        </button>
        <button type="button" className="guidance-card__secondary" onClick={onSkip}>
          이번 판 쉬기
        </button>
      </div>
    </section>
  )
}

export default GuidanceCard
