import React, { useMemo, useCallback } from 'react'
import type { Room, Prediction, RoomPredictionState, RoomFilterType, RoomSortType, SortDirection } from '../../../../domain/entities'
import type {
  AutoModeSettings,
  RoomBettingState
} from '../../../../application/services/AutoModeService'
import type { RoomBetLog } from './AutoModeRoomGrid'
import './AutoModeMosaic.css'
import { useRoomFilter } from '../hooks/useRoomFilter'

interface AutoModeMosaicProps {
  rooms: Room[]
  roomStates: Map<string, RoomPredictionState>
  bettingStates: Map<string, RoomBettingState>
  activePredictions: Map<string, Prediction>
  roomBetLogs: Map<string, RoomBetLog[]>
  settings: AutoModeSettings
  cumulativeProfit: number
  onToggleRoom: (roomId: string) => void
  onSelectRoom?: (roomId: string) => void
  selectedRoomId?: string
  roomDataVersion?: number
  roomTimers?: Map<string, number>
  enabledRoomIds?: Set<string>
  selectedPattern?: RoomFilterType | 'all'
  matchesFilter?: (room: Room, state: RoomPredictionState | null, pattern: RoomFilterType) => boolean
  sortType?: RoomSortType
  sortDirection?: SortDirection
}

export const AutoModeMosaic: React.FC<AutoModeMosaicProps> = ({
  rooms,
  roomStates,
  bettingStates,
  activePredictions,
  roomBetLogs,
  settings,
  onToggleRoom,
  onSelectRoom,
  selectedRoomId,
  roomDataVersion = 0,
  roomTimers,
  enabledRoomIds,
  selectedPattern = 'all',
  matchesFilter,
  sortType = 'martin',
  sortDirection = 'desc'
}) => {
  // Logic Separation: Use Custom Hook for Filtering & Sorting
  const filteredAndSortedRooms = useRoomFilter({
    rooms,
    roomStates,
    bettingStates,
    enabledRoomIds,
    selectedPattern,
    matchesFilter,
    sortType,
    sortDirection,
    roomDataVersion
  })

  const handleTileClick = useCallback((roomId: string) => {
    if (onSelectRoom) {
      onSelectRoom(roomId)
    } else {
      onToggleRoom(roomId)
    }
  }, [onSelectRoom, onToggleRoom])

  const maxMartin = settings.maxMartin ?? 10

  if (filteredAndSortedRooms.length === 0) {
    return (
      <div className="auto-mode__mosaic-container">
        <div className="auto-mode__room-empty auto-mode__room-empty--center">
          <p>표시할 방이 없습니다</p>
          <p className="auto-mode__room-empty-hint">필터 조건을 확인하세요</p>
        </div>
      </div>
    )
  }

  return (
    <div className="auto-mode__mosaic-container">
      {filteredAndSortedRooms.map(room => {
        const bettingState = bettingStates.get(room.id)
        const betLogs = roomBetLogs.get(room.id) ?? []
        const timer = roomTimers?.get(room.id) ?? 0
        // Fix: Key changed to stable room.id to prevent component remounting and state reset
        // The props (room, roomState, etc.) will trigger re-renders naturally
        const tileKey = room.id

        return (
          <MosaicTile
            key={tileKey}
            room={room}
            roomState={roomStates.get(room.id)}
            bettingState={bettingState}
            prediction={activePredictions.get(room.id)}
            lastLog={betLogs[0]}
            betLogs={betLogs}
            maxMartin={maxMartin}
            isSelected={selectedRoomId === room.id}
            onClick={() => handleTileClick(room.id)}
            timer={timer}
          />
        )
      })}
    </div>
  )
}

interface MosaicTileProps {
  room: Room
  roomState?: RoomPredictionState
  bettingState?: RoomBettingState
  prediction?: Prediction
  lastLog?: RoomBetLog
  betLogs: RoomBetLog[]
  maxMartin: number
  isSelected: boolean
  onClick: () => void
  timer?: number
}

const MosaicTile: React.FC<MosaicTileProps> = ({
  room,
  roomState,
  bettingState,
  prediction,
  lastLog,
  betLogs,
  maxMartin,
  isSelected,
  onClick,
  timer
}) => {
  // === State Calculations ===
  const isBetting = bettingState?.waitingForResult ?? false
  const isResting = (bettingState?.restingUntil ?? 0) > Date.now()
  const martinLevel = bettingState?.martinLevel ?? 0

  const RESULT_DISPLAY_DURATION = 4000
  const PASS_DISPLAY_DURATION = 3000

  const recentResultLog = betLogs.slice(0, 2).find(log =>
    (log.status === 'win' || log.status === 'loss') && (Date.now() - log.timestamp < RESULT_DISPLAY_DURATION)
  )
  const recentPassLog = !recentResultLog && betLogs.length > 0 && betLogs[0].status === 'pass' && (Date.now() - betLogs[0].timestamp < PASS_DISPLAY_DURATION)
    ? betLogs[0]
    : null

  const lastStatus = recentResultLog?.status ?? (recentPassLog ? 'pass' : undefined)
  const winRate = roomState?.stats?.winRate ?? 0
  const recentProfit = recentResultLog?.profit ?? null
  const sessionProfit = betLogs.reduce((sum, log) => sum + (log.profit || 0), 0)

  const betResults = betLogs
    .filter(log => log.status === 'win' || log.status === 'loss')
    .slice(0, 6)
    .reverse()
    .map(log => log.status === 'win' ? 'O' : 'X')

  const timeLeft = timer ?? 0
  const timerClass = timeLeft <= 5 ? 'urgent' : timeLeft <= 10 ? 'warning' : ''
  // const isIdleState = !isResting && !isBetting && !recentResultLog && !recentPassLog

  // Logic Separation: Use Custom Hook for Visual State -> Removed as per user request (Eye strain)

  const statusDisplay = useMemo(() => {
    if (isResting) return { text: '휴식', class: 'rest' }
    if (isBetting) return { text: '배팅중', class: 'betting' }
    if (recentResultLog?.status === 'win') return { text: '승', class: 'win' }
    if (recentResultLog?.status === 'loss') return { text: '패', class: 'loss' }
    if (recentPassLog) return { text: '패스', class: 'pass' }

    // Default Idle
    return { text: '대기중', class: 'idle' }
  }, [isResting, isBetting, recentResultLog, recentPassLog])

  const tileClass = useMemo(() => {
    const classes = ['mosaic-tile']
    if (isBetting) classes.push('betting')
    else if (isResting) classes.push('resting')
    else if (recentResultLog?.status === 'win') classes.push('hot')
    else if (recentResultLog?.status === 'loss') classes.push('cold')
    else if (recentPassLog) classes.push('pass')
    // else if (thinkingState === 'thinking') classes.push('thinking') // Removed
    else classes.push('idle')

    if (martinLevel >= 4) classes.push('danger')
    if (isSelected) classes.push('selected')
    return classes.join(' ')
  }, [isBetting, isResting, recentResultLog, recentPassLog, martinLevel, isSelected])

  const martinWidth = Math.min(100, (martinLevel / maxMartin) * 100)
  const martinFillClass = `mosaic-martin-fill level-${Math.min(martinLevel, 10)}`
  const predictionBadge = isBetting
    ? (prediction?.prediction || bettingState?.lastPrediction?.prediction || null)
    : null
  const winRateClass = winRate >= 55 ? 'good' : winRate < 45 ? 'bad' : ''
  const martinLabelClass = martinLevel >= 4 ? 'danger' : martinLevel >= 2 ? 'warning' : ''
  const statusDotClass = useMemo(() => {
    if (isBetting) return 'betting'
    if (isResting) return 'resting'
    if (lastStatus === 'win') return 'hot'
    if (lastStatus === 'loss') return 'cold'
    return 'idle'
  }, [isBetting, isResting, lastStatus])
  const lastBetAmount = lastLog?.betAmount ?? 0

  return (
    <div className={tileClass} onClick={onClick}>
      {/* Scanning Effect Overlay Removed */}

      {/* Header Row */}
      <div className="mosaic-header">
        <div className={`mosaic-status-dot ${statusDotClass}`} />
        <span className="mosaic-name">{room.koreanName || room.name}</span>
        {timeLeft > 0 && (
          <span className={`mosaic-timer-badge ${timerClass}`}>{timeLeft}</span>
        )}
      </div>

      {/* Main Row */}
      <div className="mosaic-main">
        <div className={`mosaic-prediction-badge ${predictionBadge === 'B' ? 'banker' :
          predictionBadge === 'P' ? 'player' :
            predictionBadge === 'T' ? 'tie' : 'empty'
          }`}>
          {predictionBadge || '-'}
        </div>

        <div className="mosaic-center-info">
          <span className={`mosaic-status-text ${statusDisplay.class}`}>
            {statusDisplay.text}
          </span>
          {isBetting && lastBetAmount > 0 && (
            <span className="mosaic-bet-amount">{lastBetAmount.toLocaleString()}원</span>
          )}
          {!isBetting && recentProfit !== null && (
            <span className={`mosaic-result-profit ${recentProfit > 0 ? 'positive' : 'negative'}`}>
              {recentProfit > 0 ? '+' : ''}{recentProfit.toLocaleString()}원
            </span>
          )}
        </div>

        <div className={`mosaic-martin-badge ${martinLabelClass}`}>
          M{martinLevel + 1}
        </div>
      </div>

      {/* Info Row */}
      <div className="mosaic-info-row">
        <span className={`mosaic-session-profit ${sessionProfit > 0 ? 'positive' : sessionProfit < 0 ? 'negative' : ''}`}>
          {sessionProfit !== 0 ? (sessionProfit > 0 ? '+' : '') + sessionProfit.toLocaleString() : '-'}
        </span>
        <div className="mosaic-ox-results">
          {betResults.length > 0 ? betResults.map((r, i) => (
            <span key={i} className={`mosaic-ox ${r === 'O' ? 'win' : 'loss'}`}>{r}</span>
          )) : <span className="mosaic-ox-empty">-</span>}
        </div>
      </div>

      {/* Footer Row */}
      <div className="mosaic-footer">
        <div className="mosaic-martin-gauge">
          <div
            className={martinFillClass}
            style={{ width: `${martinWidth}%` }}
          />
        </div>
        <span className={`mosaic-footer-stats`}>
          <span className={`mosaic-win-rate ${winRateClass}`}>
            {winRate > 0 ? `${winRate.toFixed(0)}%` : '-'}
          </span>
          <span className="mosaic-game-count">({room.history.length}G)</span>
        </span>
      </div>

      {/* Tooltip */}
      <div className="mosaic-tooltip">
        <div className="mosaic-tooltip-row">
          <span className="mosaic-tooltip-label">배팅 횟수</span>
          <span className="mosaic-tooltip-value">{bettingState?.totalBets ?? 0}회</span>
        </div>
        <div className="mosaic-tooltip-row">
          <span className="mosaic-tooltip-label">연승</span>
          <span className="mosaic-tooltip-value positive">{roomState?.stats?.consecutiveWins ?? 0}</span>
        </div>
        <div className="mosaic-tooltip-row">
          <span className="mosaic-tooltip-label">연패</span>
          <span className="mosaic-tooltip-value negative">{roomState?.stats?.consecutiveLosses ?? 0}</span>
        </div>
        <div className="mosaic-tooltip-row">
          <span className="mosaic-tooltip-label">세션 손익</span>
          <span className={`mosaic-tooltip-value ${sessionProfit >= 0 ? 'positive' : 'negative'}`}>
            {sessionProfit > 0 ? '+' : ''}{sessionProfit.toLocaleString()}원
          </span>
        </div>
      </div>
    </div>
  )
}
