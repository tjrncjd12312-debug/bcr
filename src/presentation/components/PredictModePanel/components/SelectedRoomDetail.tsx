import { memo, type RefObject } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import { BeadPlate } from '../../MainScreen/components/BeadPlate'
import { BigRoad } from '../../MainScreen/components/BigRoad'
import ThreeRowOXGrid from '../ThreeRowOXGrid'
import ShoeResetOverlay, { MIN_HISTORY_FOR_PREDICTION } from './ShoeResetOverlay'
import WinRateTrendChart from './WinRateTrendChart'
import { useRoadView } from '../hooks/useRoadView'
import './SelectedRoomDetail.css'

interface SelectedRoomDetailProps {
  room: Room
  state: RoomPredictionState | null
  lastResult?: boolean
  onEnterRoom: (roomId: string) => void
}

export const SelectedRoomDetail = memo(function SelectedRoomDetail({ room, state, lastResult, onEnterRoom }: SelectedRoomDetailProps) {
  const prediction = state?.lastPrediction?.prediction
  const rawConfidence = state?.lastPrediction?.confidence || 0
  const normalizedConfidence = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence
  const confidenceRatio = Math.min(Math.max(normalizedConfidence, 0), 1)
  const confidencePercent = Math.round(confidenceRatio * 100)

  const road = useRoadView({ room, state, lastResult, beadCols: 12 })

  return (
    <>
      {/* Immersive Hero Section */}
      <div className={`detail-hero ${prediction ? `predict-${prediction.toLowerCase()}` : ''}`}>
        <div className="detail-header">
          <div className="detail-header__left">
            <div className="detail-header__name">{room.koreanName || room.name}</div>
            <div className="detail-header__games">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{room.history.length} 게임 분석</span>
            </div>
          </div>
          <button className="detail-enter-btn top-action" onClick={() => onEnterRoom(room.id)}>
            <span>방입장</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        <div className="detail-prediction">
          <div className="detail-prediction__label">
            <span className="live-dot"></span>
            AI 실시간 예측
          </div>
          {prediction || state?.lastPrediction?.isSkip ? (
            <div className="detail-prediction__main-row">
              <div className="confidence-gauge">
                <svg className="gauge-svg" viewBox="0 0 100 100">
                  <circle className="gauge-bg" cx="50" cy="50" r="45" />
                  <circle
                    className="gauge-progress"
                    cx="50" cy="50" r="45"
                    style={{
                      strokeDasharray: 283,
                      strokeDashoffset: 283 - (283 * confidenceRatio)
                    }}
                  />
                </svg>
                <div className="gauge-text">
                  <span className="gauge-percent">{confidencePercent}%</span>
                  <span className="gauge-label">신뢰도</span>
                </div>
              </div>
              <div className="detail-prediction__value">
                <PredictionIcon prediction={prediction} size="lg" isSkip={state?.lastPrediction?.isSkip} />
              </div>
            </div>
          ) : (
            <div className="detail-prediction__value analyzing">분석 중...</div>
          )}

          {prediction && state && (
            <div className="detail-prediction__xai anim-fade-in">
              <div className="xai-chip" title="예측 누적 횟수">
                <span className="label">예측횟수</span>
                <span className="value">{state.stats.total}회</span>
              </div>
              <div className="xai-chip" title="해당 방 전체 승률">
                <span className="label">종합집계</span>
                <span className="value">{state.stats.winRate.toFixed(0)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="detail-scrollable-content">
        {/* Outcome Distribution */}
        <div className="detail-distribution">
          <div className="detail-history__title" style={{ marginBottom: '12px', padding: '0 4px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" />
            </svg>
            <span>실시간 승률 분포</span>
          </div>
          <div className="dist-labels">
            <span className="banker">B {road.stats.bPercent.toFixed(0)}%</span>
            <span className="tie">T {road.stats.tPercent.toFixed(0)}%</span>
            <span className="player">P {road.stats.pPercent.toFixed(0)}%</span>
          </div>
          <div className="dist-bar">
            <div className="dist-segment banker" style={{ width: `${road.stats.bPercent}%` }} />
            <div className="dist-segment tie" style={{ width: `${road.stats.tPercent}%` }} />
            <div className="dist-segment player" style={{ width: `${road.stats.pPercent}%` }} />
          </div>
        </div>

        {/* Strategic Analysis */}
        <div className="detail-history">
          <div className="detail-history__header">
            <div className="detail-history__title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              <span>{road.isOneRow ? '빅로드 (드래곤 테일)' : road.isThreeRow ? '전략 그리드 (3매 O/X)' : '데이터 그리드 (최근 6매)'}</span>
            </div>
            <div className="detail-history__actions">
              <div className="detail-history__toggle">
                <button className={road.roadView === 'six' ? 'active' : ''} onClick={() => road.toggleRoadView('six')}>6매</button>
                <button className={road.roadView === 'three' ? 'active' : ''} onClick={() => road.toggleRoadView('three')}>3매</button>
                <button className={road.roadView === 'one' ? 'active' : ''} onClick={() => road.toggleRoadView('one')}>원매</button>
              </div>
              {road.patternLabel && (
                <span className="room-card__martin-badge">{road.patternLabel}</span>
              )}
            </div>
          </div>

          <div className={`road-container ${road.isOneRow ? 'big-road' : ''} ${road.isThreeRow ? 'three-row' : ''}`} ref={road.historyPlateRef as RefObject<HTMLDivElement>} style={{ position: 'relative' }}>
            {(room.history.length < MIN_HISTORY_FOR_PREDICTION || state?.isShoeReset) && (
              <ShoeResetOverlay historyLength={room.history.length} />
            )}
            {road.isThreeRow ? (
              <ThreeRowOXGrid state={state} nextPrediction={state?.lastPrediction?.prediction as 'B' | 'P' | 'SKIP' | null} />
            ) : road.isOneRow ? (
              <BigRoad history={road.bigRoadHistory} predictionMap={road.predictionMap} rows={road.beadRows} cols={road.bigRoadCols} gap={2} minSize={16} maxSize={34} className="big-road--compact" />
            ) : (
              <BeadPlate history={road.beadHistory} predictionMap={road.predictionMap} rows={road.beadRows} cols={12} gap={2} minSize={16} maxSize={28} />
            )}
          </div>
        </div>

        {/* Prediction Stats Bar */}
        {state && state.stats.total > 0 && (
          <div className="detail-pred-stats">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-muted)' }}>AI 적중률</span>
              <span className={state.stats.winRate >= 50 ? 'positive' : 'negative'} style={{ fontWeight: 800 }}>
                {state.stats.winRate.toFixed(1)}% ({state.stats.correct}/{state.stats.total})
              </span>
            </div>
          </div>
        )}

        <WinRateTrendChart history={room.history} />
      </div>
    </>
  )
})
