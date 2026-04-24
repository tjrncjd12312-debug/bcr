import React from 'react'
import '../SemiAutoPanel.css'
import type { Room } from '../../../../domain/entities'

interface SemiAutoMainProps {
  enabled: boolean
  currentRoom: { name: string } | null
  waitingForResult: boolean
  waitingForPrediction: boolean
  lastPrediction: any
  isFirstRound: boolean
  isToggling: boolean
  sortedRooms: Room[]
  autoFindRoom: boolean
  onToggle: () => void
  onEnterRoom: (room: Room) => void
}

export const SemiAutoMain: React.FC<SemiAutoMainProps> = ({
  enabled,
  currentRoom,
  waitingForResult,
  waitingForPrediction,
  lastPrediction,
  isFirstRound,
  isToggling,
  sortedRooms,
  autoFindRoom,
  onToggle,
  onEnterRoom,
}) => {
  return (
    <div className="sa-fs-main">
      {/* Current Room */}
      <div className="sa-fs-room-section">
        <div className="sa-fs-room-header">
          <span className="sa-fs-section-title">현재 방</span>
          {currentRoom && (
            <span className="sa-fs-room-name">{currentRoom.name}</span>
          )}
        </div>
        {!currentRoom && (
          <div className="sa-fs-room-empty">
            {enabled && autoFindRoom
              ? '최적의 방을 찾는 중...'
              : '방을 선택하세요'}
          </div>
        )}
      </div>

      {/* Big Prediction Display */}
      <div className="sa-fs-prediction-section">
        {waitingForResult ? (
          <div className="sa-fs-pred-waiting">
            <div className={`sa-fs-pred-big ${lastPrediction?.prediction?.toLowerCase() || ''}`}>
              {lastPrediction?.prediction || '?'}
            </div>
            <div className="sa-fs-pred-status">결과 대기중...</div>
          </div>
        ) : lastPrediction?.isSkip || lastPrediction?.prediction === 'T' ? (
          <div className="sa-fs-pred-display">
            <div className="sa-fs-pred-big skip animate">
              ⏭
            </div>
            <div className="sa-fs-pred-conf">패스</div>
          </div>
        ) : lastPrediction && lastPrediction.prediction ? (
          <div className="sa-fs-pred-display">
            <div
              key={lastPrediction.prediction}
              className={`sa-fs-pred-big ${lastPrediction.prediction.toLowerCase()} animate`}
            >
              {lastPrediction.prediction}
            </div>
            <div className="sa-fs-pred-conf">
              신뢰도 {Math.round((lastPrediction.confidence || 0) * 100)}%
            </div>
          </div>
        ) : waitingForPrediction ? (
          <div className="sa-fs-pred-empty">
            <div className="sa-fs-pred-big empty loading">...</div>
            <div className="sa-fs-pred-status">예측 요청 중</div>
          </div>
        ) : isFirstRound && currentRoom ? (
          <div className="sa-fs-pred-first">
            <div className="sa-fs-pred-big empty">−</div>
            <div className="sa-fs-pred-status">첫 라운드 관찰 중</div>
          </div>
        ) : enabled && currentRoom ? (
          <div className="sa-fs-pred-empty">
            <div className="sa-fs-pred-big empty">−</div>
            <div className="sa-fs-pred-status">다음 라운드 대기</div>
          </div>
        ) : (
          <div className="sa-fs-pred-empty">
            <div className="sa-fs-pred-big empty">−</div>
            <div className="sa-fs-pred-status">예측 대기</div>
          </div>
        )}
      </div>

      {/* Toggle Button */}
      <button
        className={`sa-fs-toggle ${enabled ? 'active' : ''}`}
        onClick={() => {
          if (isToggling) return
          onToggle()
        }}
        disabled={isToggling}
      >
        {enabled ? '정지' : '시작'}
      </button>

      {/* Quick Room Selection */}
      {!currentRoom && sortedRooms.length > 0 && !autoFindRoom && (
        <div className="sa-fs-rooms">
          <div className="sa-fs-rooms-title">방 선택</div>
          <div className="sa-fs-rooms-grid">
            {sortedRooms.map((room) => (
              <button
                key={room.id}
                className="sa-fs-room-btn"
                onClick={() => {
                  console.log('[SemiAutoMain] 🎲 Room button clicked:', room.id, room.koreanName)
                  onEnterRoom(room)
                }}
              >
                <span className="sa-fs-room-btn-name">{room.koreanName}</span>
                <span className="sa-fs-room-btn-count">{room.history.length}게임</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
