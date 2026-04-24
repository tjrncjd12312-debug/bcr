import { memo } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import './CompactRoomRow.css'

interface CompactRoomRowProps {
  room: Room
  state: RoomPredictionState | null
  isSelected: boolean
  isHot?: boolean
  martingaleLevel?: number
  lastResult?: boolean
  roomTimer?: number
  onSelect: () => void
  onEnter: () => void
}

export const CompactRoomRow = memo(function CompactRoomRow({
  room,
  state,
  isSelected,
  isHot,
  martingaleLevel,
  lastResult,
  roomTimer,
  onSelect,
  onEnter,
}: CompactRoomRowProps) {
  const prediction = state?.lastPrediction?.prediction
  const timerSeconds = typeof roomTimer === 'number' && roomTimer > 0 ? roomTimer : room.remainingSeconds
  const winRate = state?.stats.winRate
  const totalPreds = state?.stats.total || 0
  const correctPreds = state?.stats.correct || 0

  const counts = room.history.reduce((acc, h) => {
    if (h.winner === 'B') acc.b++
    else if (h.winner === 'P') acc.p++
    else if (h.winner === 'T') acc.t++
    return acc
  }, { b: 0, p: 0, t: 0 })

  return (
    <div
      className={`compact-row ${isSelected ? 'selected' : ''} ${isHot ? 'is-hot' : ''} ${prediction ? `predict-${prediction.toLowerCase()}` : ''}`}
      onClick={onSelect}
    >
      <div className="col-name">
        <span className="name-text">{room.koreanName || room.name}</span>
        {martingaleLevel !== undefined && martingaleLevel > 0 && (
          <span className={`badge-martin ${martingaleLevel >= 3 ? 'danger' : ''}`}>{martingaleLevel}M</span>
        )}
      </div>
      <div className="col-prediction">
        {prediction || state?.lastPrediction?.isSkip ? (
          <PredictionIcon prediction={prediction} size="sm" isSkip={state?.lastPrediction?.isSkip} />
        ) : (
          <span className="analyzing-dots">...</span>
        )}
      </div>
      <div className="col-result">
        {lastResult !== undefined && (
          <span className={`result-tag ${lastResult ? 'win' : 'loss'}`}>
            {lastResult ? '적중' : '미적중'}
          </span>
        )}
      </div>
      <div className="col-counts">
        <span className="count-item b">B:{counts.b}</span>
        <span className="count-item p">P:{counts.p}</span>
        <span className="count-item t">T:{counts.t}</span>
      </div>
      <div className="col-streak">
        {state?.stats && (state.stats.consecutiveWins >= 2 || state.stats.consecutiveLosses >= 2) && (
          <span className={`streak-tag ${state.stats.consecutiveWins >= 2 ? 'win' : 'loss'}`}>
            {state.stats.consecutiveWins >= 2 ? `${state.stats.consecutiveWins}연승` : `${state.stats.consecutiveLosses}연패`}
          </span>
        )}
      </div>
      <div className="col-max-streak">
        {state?.stats && (state.stats.maxConsecutiveWins > 0 || state.stats.maxConsecutiveLosses > 0) && (
          <span className="max-streak-tag">
            <span className="max-win">{state.stats.maxConsecutiveWins}</span>
            <span className="max-sep">/</span>
            <span className="max-loss">{state.stats.maxConsecutiveLosses}</span>
          </span>
        )}
      </div>
      <div className="col-winrate">
        {winRate !== undefined && (
          <div className="winrate-box">
            <span className={winRate >= 50 ? 'text-win' : 'text-loss'}>{winRate.toFixed(0)}%</span>
            <span className="sub-text">({correctPreds}/{totalPreds})</span>
          </div>
        )}
      </div>
      <div className="col-games">{room.history.length}</div>
      <div className="col-timer">
        {typeof timerSeconds === 'number' && timerSeconds > 0 && (
          <span className="timer-tag">{timerSeconds}s</span>
        )}
      </div>
      <div className="col-history">
        <div className="mini-bead-row">
          {room.history.slice(-15).map((h, i) => (
            <span key={i} className={`dot ${h.winner.toLowerCase()}`} />
          ))}
        </div>
      </div>
      <div className="col-action">
        <button className="compact-enter-btn" onClick={(e) => { e.stopPropagation(); onEnter() }}>
          입장
        </button>
      </div>
    </div>
  )
})
