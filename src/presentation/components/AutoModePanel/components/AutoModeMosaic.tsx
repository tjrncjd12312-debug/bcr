import React, { useMemo, useCallback } from 'react'
import type { Room, Prediction, RoomPredictionState, RoomFilterType, RoomSortType, SortDirection } from '../../../../domain/entities'
import type {
  AutoModeSettings,
  RoomBettingState
} from '../../../../application/services/AutoModeService'
import type { RoomBetLog } from './AutoModeRoomGrid'
import './AutoModeMosaic.css'
import '../AutoModePanel.css'
import { useRoomFilter } from '../hooks/useRoomFilter'
import { getRoomStatusChip, getFilterShortLabel, getNextBetAmount, compactAmount } from '../utils/autoModeStatus'

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
  activeFilters?: RoomFilterType[]
  matchesFilter?: (room: Room, state: RoomPredictionState | null, pattern: RoomFilterType) => boolean
  sortType?: RoomSortType
  sortDirection?: SortDirection
  filterSettingsSignature?: string
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
  activeFilters,
  matchesFilter,
  sortType = 'martin',
  sortDirection = 'desc',
  filterSettingsSignature
}) => {
  // Logic Separation: Use Custom Hook for Filtering & Sorting
  const filteredAndSortedRooms = useRoomFilter({
    rooms,
    roomStates,
    bettingStates,
    enabledRoomIds,
    selectedPattern,
    activeFilters,
    matchesFilter,
    sortType,
    sortDirection,
    roomDataVersion,
    filterSettingsSignature
  })

  const handleTileClick = useCallback((roomId: string) => {
    if (onSelectRoom) {
      onSelectRoom(roomId)
    } else {
      onToggleRoom(roomId)
    }
  }, [onSelectRoom, onToggleRoom])

  const maxMartin = settings.maxMartin ?? 10
  const filterLabel = useMemo(() => getFilterShortLabel(activeFilters), [activeFilters])
  const isAutoEnabled = settings.enabled ?? false

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
            settings={settings}
            filterLabel={filterLabel}
            isEnabled={enabledRoomIds?.has(room.id) ?? true}
            isAutoEnabled={isAutoEnabled}
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
  settings: AutoModeSettings
  filterLabel: string | null
  isEnabled: boolean
  isAutoEnabled: boolean
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
  timer,
  settings,
  filterLabel,
  isEnabled,
  isAutoEnabled,
}) => {
  // === State Calculations ===
  const isBetting = bettingState?.waitingForResult ?? false
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
  const roomHistory = room.history ?? []
  const recentHistory = roomHistory.slice(0, 12).reverse()

  const timeLeft = timer ?? 0
  const timerClass = timeLeft <= 5 ? 'urgent' : timeLeft <= 10 ? 'warning' : ''
  // const isIdleState = !isBetting && !recentResultLog && !recentPassLog

  // Logic Separation: Use Custom Hook for Visual State -> Removed as per user request (Eye strain)

  // 최근 결과(승/패/패스)는 일시적이라 별도로 표시하고,
  // 그 외는 공용 칩 헬퍼(getRoomStatusChip)로 통일한다. 모자이크는 brief=true로 짧게.
  const statusChip = useMemo(() => {
    if (recentResultLog?.status === 'win') return { text: '승', tone: 'observing' as const, isResult: true }
    if (recentResultLog?.status === 'loss') return { text: '패', tone: 'martin' as const, isResult: true }
    if (recentPassLog) return { text: '패스', tone: 'idle' as const, isResult: true }
    const chip = getRoomStatusChip(bettingState ?? null, settings, isEnabled, isAutoEnabled, { brief: true })
    return { ...chip, isResult: false }
  }, [recentResultLog, recentPassLog, bettingState, settings, isEnabled, isAutoEnabled])

  const nextBetAmount = useMemo(
    () => getNextBetAmount(settings, martinLevel, { isTieBet: filterLabel?.startsWith('Tie') ?? false }),
    [settings, martinLevel, filterLabel]
  )

  const tileClass = useMemo(() => {
    const classes = ['mosaic-tile']
    if (isBetting) classes.push('betting')
    else if (recentResultLog?.status === 'win') classes.push('hot')
    else if (recentResultLog?.status === 'loss') classes.push('cold')
    else if (recentPassLog) classes.push('pass')
    // else if (thinkingState === 'thinking') classes.push('thinking') // Removed
    else classes.push('idle')

    if (martinLevel >= 4) classes.push('danger')
    if (isSelected) classes.push('selected')
    return classes.join(' ')
  }, [isBetting, recentResultLog, recentPassLog, martinLevel, isSelected])

  const martinWidth = Math.min(100, (martinLevel / maxMartin) * 100)
  const martinFillClass = `mosaic-martin-fill level-${Math.min(martinLevel, 10)}`
  const predictionBadge = isBetting
    ? (prediction?.prediction || bettingState?.lastPrediction?.prediction || null)
    : null
  const winRateClass = winRate >= 55 ? 'good' : winRate < 45 ? 'bad' : ''
  const martinLabelClass = martinLevel >= 4 ? 'danger' : martinLevel >= 2 ? 'warning' : ''
  const statusDotClass = useMemo(() => {
    if (isBetting) return 'betting'
    if (lastStatus === 'win') return 'hot'
    if (lastStatus === 'loss') return 'cold'
    return 'idle'
  }, [isBetting, lastStatus])
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

      {/* Filter Reason — 왜 이 방이 풀에 들어왔는지 */}
      {filterLabel && (
        <div className="mosaic-filter-row">
          <span className={`auto-filter-reason ${filterLabel.startsWith('Tie') ? 'tie-tone' : ''}`}>{filterLabel}</span>
        </div>
      )}

      {/* Main Row */}
      <div className="mosaic-main">
        <div className={`mosaic-prediction-badge ${predictionBadge === 'B' ? 'banker' :
          predictionBadge === 'P' ? 'player' :
            predictionBadge === 'T' ? 'tie' : 'empty'
          }`}>
          {predictionBadge === 'B' ? '뱅' : predictionBadge === 'P' ? '플' : predictionBadge === 'T' ? '타' : '-'}
        </div>

        <div className="mosaic-center-info">
          <span className={`auto-status-chip compact ${statusChip.tone}`}>{statusChip.text}</span>
          {isBetting && lastBetAmount > 0 ? (
            <span className="mosaic-bet-amount">{compactAmount(lastBetAmount)}원</span>
          ) : recentProfit !== null ? (
            <span className={`mosaic-result-profit ${recentProfit > 0 ? 'positive' : 'negative'}`}>
              {recentProfit > 0 ? '+' : ''}{compactAmount(recentProfit)}원
            </span>
          ) : (
            <span className="mosaic-bet-amount">→ {compactAmount(nextBetAmount)}원</span>
          )}
        </div>

        <div className={`mosaic-martin-badge ${martinLabelClass}`}>
          {martinLevel + 1}단
        </div>
      </div>

      {/* Info Row */}
      <div className="mosaic-info-row">
        <span className={`mosaic-session-profit ${sessionProfit > 0 ? 'positive' : sessionProfit < 0 ? 'negative' : ''}`}>
          {sessionProfit !== 0 ? (sessionProfit > 0 ? '+' : '') + sessionProfit.toLocaleString() : '-'}
        </span>
        <div className="mosaic-history-strip" aria-label="Recent game history">
          {recentHistory.length > 0 ? recentHistory.map((h, i) => (
            <span
              key={`${i}-${h.winner}`}
              className={`mosaic-history-dot ${h.winner.toLowerCase()}`}
              title={h.winner}
            />
          )) : <span className="mosaic-history-empty">-</span>}
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
          <span className="mosaic-game-count">({roomHistory.length}G)</span>
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
