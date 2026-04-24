import { memo, useMemo } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import SparklineGraph from './SparklineGraph'
import MiniRoadmap from './MiniRoadmap'
import './RoomCard.css'

interface RoomCardProps {
  room: Room
  state: RoomPredictionState | null
  isSelected: boolean
  isHot?: boolean
  isFlashing: boolean
  isShoeChange?: boolean
  lastResult: boolean | undefined
  martingaleLevel?: number
  roomTimer?: number
  onClick: () => void
}

export const RoomCard = memo(function RoomCard({
  room,
  state,
  isSelected,
  isHot,
  isFlashing,
  isShoeChange,
  lastResult,
  martingaleLevel,
  roomTimer,
  onClick,
}: RoomCardProps) {
  const prediction = state?.lastPrediction?.prediction
  const winRate = state?.stats.winRate
  const timerSeconds = typeof roomTimer === 'number' && roomTimer > 0 ? roomTimer : room.remainingSeconds
  const consecutiveWins = state?.stats.consecutiveWins || 0
  const consecutiveLosses = state?.stats.consecutiveLosses || 0
  const maxConsecutiveWins = state?.stats.maxConsecutiveWins || 0
  const maxConsecutiveLosses = state?.stats.maxConsecutiveLosses || 0

  const showPrediction = lastResult === undefined

  const predictionRecords = useMemo(() => {
    return room.history as any[]
  }, [room.history])

  const streakType = consecutiveWins >= 2 ? 'win' : consecutiveLosses >= 2 ? 'loss' : null
  const streakCount = streakType === 'win' ? consecutiveWins : consecutiveLosses

  const renderPrediction = () => {
    if (!showPrediction) return (
      <div className="room-card__prediction-large analyzing anim-pulse">
        <span className="dot"></span>
        분석 중...
      </div>
    )

    if (prediction || state?.lastPrediction?.isSkip) {
      return (
        <div className="room-card__prediction-large anim-fade-in">
          <PredictionIcon prediction={prediction} size="md" isSkip={state?.lastPrediction?.isSkip} />
        </div>
      )
    }

    return (
      <div className="room-card__prediction-large analyzing anim-pulse">
        <span className="dot"></span>
        분석 중...
      </div>
    )
  }

  return (
    <button
      className={`room-card ${isSelected ? 'selected' : ''} ${isFlashing ? 'flashing' : ''} ${isHot ? 'is-hot' : ''} ${prediction && showPrediction ? `predict-${prediction.toLowerCase()}` : ''}`}
      onClick={onClick}
    >
      <SparklineGraph history={predictionRecords} />
      <div className="room-card__left">
        <div className="room-card__name">
          <div className="live-indicator">
            <span className="live-dot"></span>
            라이브
          </div>
          <span className="room-name-text">{room.koreanName || room.name}</span>
          {martingaleLevel !== undefined && martingaleLevel > 0 && (
            <span className={`room-card__martin-badge ${martingaleLevel >= 3 ? 'danger' : ''}`}>
              {martingaleLevel}M
            </span>
          )}
          {typeof timerSeconds === 'number' && timerSeconds > 0 && (
            <span className="room-card__timer">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
              </svg>
              {timerSeconds}s
            </span>
          )}
          {isShoeChange && (
            <span className="room-card__shoe-badge">🔄 NEW</span>
          )}
        </div>
        <MiniRoadmap history={room.history} />
      </div>

      <div className="room-card__center">
        {renderPrediction()}
      </div>

      <div className="room-card__right">
        <div className="room-stat-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span>{room.history.length}</span>
        </div>
        <div className={`room-stat-item winrate ${winRate !== undefined && winRate >= 50 ? 'positive' : 'negative'}`} style={{ visibility: winRate !== undefined && state?.stats && state.stats.total > 0 ? 'visible' : 'hidden' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M22 12h-4" /><path d="M6 12H2" /><path d="M12 6V2" /><path d="M12 22v-4" />
          </svg>
          <span>{winRate !== undefined ? `${winRate.toFixed(0)}%` : '-'}</span>
        </div>
        <div className={`room-stat-item streak ${streakType || ''}`} style={{ visibility: streakType ? 'visible' : 'hidden' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.5 3.5 6.5 1 1.5 2 4.5-.5 7-2.5 2.5-6 1.5-7-1.5z" />
          </svg>
          <span>{streakCount}{streakType === 'win' ? '연승' : '연패'}</span>
        </div>
        <div className="room-stat-item max-streak" style={{ visibility: (maxConsecutiveWins > 0 || maxConsecutiveLosses > 0) ? 'visible' : 'hidden' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <span className="max-win">{maxConsecutiveWins}</span>
          <span className="max-sep">/</span>
          <span className="max-loss">{maxConsecutiveLosses}</span>
        </div>
      </div>

      {lastResult !== undefined && (
        <div className={`room-card__result ${lastResult ? 'correct' : 'incorrect'}`}>
          {lastResult ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
        </div>
      )}
    </button>
  )
})
