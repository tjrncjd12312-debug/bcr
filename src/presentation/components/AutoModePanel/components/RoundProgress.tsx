// RoundProgress — 방의 라운드 진행을 한눈에 보여준다.
//   배팅 창: 서버가 BetsOpen 순간 준 마감 시각 기준 카운트다운 + 남은 비율 바
//   마감·딜링: 진행 중(흐르는 바) — "결과 대기" 방이 지금 어느 단계인지 보이게
//   결과 / 다음 판 대기: 정적 표시
// 데이터 근거: 2026-09-02 라이브 캡처(baccarat.gameState betting/dealing/timeRemaining/timeInitial).
import type { GamePhase } from '../../../../domain/entities'
import './RoundProgress.css'

export interface RoundProgressProps {
  /** 배팅 마감까지 남은 초(0이면 창 닫힘) */
  remainingSeconds: number
  /** 배팅 창 전체 길이(ms, 서버 timeInitial). 없으면 남은 초 기준 100%로 시작 */
  windowMs?: number
  phase?: GamePhase
  /** 자동배팅이 이 방의 결과를 기다리는 중 */
  waitingForResult?: boolean
  /** 좁은 자리(모자이크·카드)용 */
  compact?: boolean
  /** 글자 라벨 표시 여부(모자이크는 헤더 배지가 초를 이미 보여주면 숨긴다) */
  showLabel?: boolean
  className?: string
}

export function RoundProgress({
  remainingSeconds,
  windowMs,
  phase,
  waitingForResult = false,
  compact = false,
  showLabel = true,
  className = '',
}: RoundProgressProps) {
  const base = ['round-progress', compact ? 'round-progress--compact' : '', className].filter(Boolean).join(' ')

  if (remainingSeconds > 0) {
    const total = windowMs && windowMs > 0 ? windowMs : remainingSeconds * 1000
    const pct = Math.max(0, Math.min(100, ((remainingSeconds * 1000) / total) * 100))
    const tone = remainingSeconds <= 3 ? 'urgent' : remainingSeconds <= 6 ? 'warning' : 'open'
    return (
      <div className={`${base} is-betting ${tone}`} role="timer" aria-label={`배팅 마감까지 ${remainingSeconds}초`}>
        {showLabel && (
          <span className="round-progress__label">{compact ? `${remainingSeconds}초` : `배팅 ${remainingSeconds}초`}</span>
        )}
        <div className="round-progress__track">
          <div className="round-progress__fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  if (phase === 'dealing') {
    return (
      <div className={`${base} is-dealing`} aria-label={waitingForResult ? '배팅 마감, 결과 대기 중' : '배팅 마감, 딜링 중'}>
        {showLabel && <span className="round-progress__label">{waitingForResult ? '결과 대기' : '딜링 중'}</span>}
        <div className="round-progress__track round-progress__track--indeterminate">
          <div className="round-progress__fill" />
        </div>
      </div>
    )
  }

  if (phase === 'result') {
    return (
      <div className={`${base} is-result`} aria-label="결과 확정">
        {showLabel && <span className="round-progress__label">{waitingForResult ? '정산 중' : '결과'}</span>}
        <div className="round-progress__track">
          <div className="round-progress__fill" style={{ width: '100%' }} />
        </div>
      </div>
    )
  }

  return (
    <div className={`${base} is-idle`} aria-label="다음 라운드 대기">
      {showLabel && <span className="round-progress__label">{waitingForResult ? '결과 대기' : '다음 판 대기'}</span>}
      <div className="round-progress__track">
        <div className="round-progress__fill" style={{ width: '0%' }} />
      </div>
    </div>
  )
}

export default RoundProgress
