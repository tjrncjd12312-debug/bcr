import { memo } from 'react'

export const MIN_HISTORY_FOR_PREDICTION = 5

interface ShoeResetOverlayProps {
  historyLength: number
}

function ShoeResetOverlay({ historyLength }: ShoeResetOverlayProps) {
  const progress = Math.min((historyLength / MIN_HISTORY_FOR_PREDICTION) * 100, 100)

  return (
    <div className="shoe-reset-overlay">
      <div className="shoe-reset-overlay__icon">🔄</div>
      <div className="shoe-reset-overlay__text">슈 초기화</div>
      <div className="shoe-reset-overlay__subtext">
        예측을 위해 최소 {MIN_HISTORY_FOR_PREDICTION}게임이 필요합니다
      </div>
      <div className="shoe-reset-overlay__progress">
        <div className="shoe-reset-overlay__progress-bar">
          <div
            className="shoe-reset-overlay__progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="shoe-reset-overlay__progress-text">
          {historyLength}/{MIN_HISTORY_FOR_PREDICTION}
        </span>
      </div>
    </div>
  )
}

export default memo(ShoeResetOverlay)
