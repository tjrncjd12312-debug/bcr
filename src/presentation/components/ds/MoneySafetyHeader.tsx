// MoneySafetyHeader — 통합 디자인시스템: 자동맡기기 돈 안전 헤더
// 리디자인 4단계. 가상/실제 큰 칩 + 세션 손익 30px(따면 초록/잃으면 빨강) + 목표까지/손절까지 진행바.
// 실제 돈은 항상 빨강+한글로 명시. 숫자는 tabular-nums.
import './MoneySafetyHeader.css'

interface Bound {
  current: number
  limit: number
}

interface MoneySafetyHeaderProps {
  isReal: boolean
  balance: number
  sessionProfit: number
  sessionProfitPct?: number
  /** 목표까지(이만큼 따면 멈춤) */
  target?: Bound
  /** 손절까지(이만큼 잃으면 멈춤) */
  stopLoss?: Bound
  formatCurrency?: (n: number) => string
  className?: string
}

const defaultFormat = (n: number) => `${n.toLocaleString()}원`

function signed(n: number, fmt: (n: number) => string) {
  return `${n >= 0 ? '＋' : '－'}${fmt(Math.abs(n))}`
}

export function MoneySafetyHeader({
  isReal,
  balance,
  sessionProfit,
  sessionProfitPct,
  target,
  stopLoss,
  formatCurrency = defaultFormat,
  className = '',
}: MoneySafetyHeaderProps) {
  const profitTone = sessionProfit > 0 ? 'up' : sessionProfit < 0 ? 'down' : 'flat'
  const targetPct = target && target.limit > 0
    ? Math.max(0, Math.min(100, (target.current / target.limit) * 100))
    : 0
  const lossPct = stopLoss && stopLoss.limit > 0
    ? Math.max(0, Math.min(100, (Math.abs(stopLoss.current) / Math.abs(stopLoss.limit)) * 100))
    : 0

  return (
    <header className={`money-header ${className}`}>
      <div className="money-header__row">
        <span className={`money-header__chip ${isReal ? 'is-real' : 'is-virtual'}`}>
          {isReal ? '실제 배팅' : '연습 중'}
        </span>
        <span className="money-header__balance">
          보유금 <strong>{formatCurrency(balance)}</strong>
        </span>
        <span className="money-header__profit-wrap">
          세션 손익
          <strong className={`money-header__profit money-header__profit--${profitTone}`}>
            {signed(sessionProfit, formatCurrency)}
            {typeof sessionProfitPct === 'number' && (
              <span className="money-header__pct"> ({signed(sessionProfitPct, (n) => `${n.toFixed(1)}%`)})</span>
            )}
          </strong>
        </span>
      </div>

      {(target || stopLoss) && (
        <div className="money-header__bars">
          {target && (
            <div className="money-header__bar-group">
              <span className="money-header__bar-label">
                목표까지 <strong>{formatCurrency(target.current)} / {formatCurrency(target.limit)}</strong>
              </span>
              <span className="money-header__bar" aria-hidden="true">
                <span className="money-header__bar-fill money-header__bar-fill--target" style={{ width: `${targetPct}%` }} />
              </span>
            </div>
          )}
          {stopLoss && (
            <div className="money-header__bar-group">
              <span className="money-header__bar-label">
                손절까지 <strong>{formatCurrency(stopLoss.current)} / {formatCurrency(stopLoss.limit)}</strong>
              </span>
              <span className="money-header__bar" aria-hidden="true">
                <span className="money-header__bar-fill money-header__bar-fill--loss" style={{ width: `${lossPct}%` }} />
              </span>
            </div>
          )}
        </div>
      )}
    </header>
  )
}

export default MoneySafetyHeader
