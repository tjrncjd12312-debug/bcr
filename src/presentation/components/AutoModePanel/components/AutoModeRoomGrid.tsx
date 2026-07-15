// AutoModeRoomGrid - 옵션 C: 배팅 중심 카드 (히스토리 제거)
// Features: 실시간 타이머, 배팅 정보, 마틴 레벨, 손익 표시
import { useMemo } from 'react'
import type { Room, RoomPredictionState, RoomFilterType, RoomSortType, SortDirection } from '../../../../domain/entities'
import type { RoomBettingState, AutoModeSettings } from '../../../../application/services/AutoModeService'
import { getRoomStatusChip, getFilterShortLabel, getRoomProgressionDisplay, isTieFilterLabel, compactAmount } from '../utils/autoModeStatus'
import '../AutoModePanel.css'

type RoomBetStatus = 'pending' | 'win' | 'loss' | 'tie' | 'failed' | 'pass'

// 방별 배팅 로그 인터페이스
export interface RoomBetLog {
  betAmount: number
  status: RoomBetStatus
  profit: number
  martinLevel: number
  prediction?: 'B' | 'P' | 'T' | null
  winner?: 'B' | 'P' | 'T'
  message?: string
  historyIndex?: number
  timestamp: number
}

interface AutoModeRoomGridProps {
  rooms: Map<string, Room>
  roomStates: Map<string, RoomPredictionState>
  autoModeRoomStates: Map<string, RoomBettingState>
  enabledRoomIds: Set<string>
  settings: AutoModeSettings
  isAutoEnabled: boolean
  flashingRooms: Set<string>
  roomBetLogs: Map<string, RoomBetLog[]>
  roomTimers: Map<string, number>  // 실시간 타이머
  selectedPattern: RoomFilterType | 'all'
  activeFilters?: RoomFilterType[]
  matchesFilter: (room: Room, state: RoomPredictionState | null, pattern: RoomFilterType) => boolean
  sortType: RoomSortType
  sortDirection?: SortDirection  // 정렬 방향 (asc/desc)
  roomDataVersion: number  // 방 데이터 업데이트 시마다 증가 (실시간 업데이트 트리거)
  filterSettingsSignature?: string
}

// memo 제거 - 실시간 업데이트 보장
export function AutoModeRoomGrid({
  rooms,
  roomStates,
  autoModeRoomStates,
  enabledRoomIds,
  settings,
  isAutoEnabled,
  flashingRooms,
  roomBetLogs,
  roomTimers,
  selectedPattern,
  activeFilters,
  matchesFilter,
  sortType,
  sortDirection = 'desc',
  roomDataVersion,
  filterSettingsSignature,
}: AutoModeRoomGridProps) {
  // Filter and sort rooms
  // 1. 설정에서 선택된 방이 있으면 → 그 방들만 표시
  // 2. 선택된 방이 없으면 → 모든 바카라 방 표시
  // 3. 패턴 필터가 'all'이 아니면 → 패턴 매칭되는 방만 표시
  const filteredRooms = useMemo(() => {
    const isLockedAutoModeRoom = (roomId: string) => {
      const state = autoModeRoomStates.get(roomId)
      return !!state && (state.waitingForResult || state.martinLevel > 0)
    }

    // 바카라 방 기본 필터
    let roomList = Array.from(rooms.values())
      .filter(room => {
        if (isLockedAutoModeRoom(room.id)) return true
        const name = (room.koreanName || room.name || '').toLowerCase()
        if (name.includes('salon') || name.includes('lightning')) return false
        if (!name.includes('baccarat') && !name.includes('바카라')) return false
        return true
      })

    // 설정에서 선택된 방이 있으면 해당 방만 필터링
    if (enabledRoomIds.size > 0) {
      roomList = roomList.filter(room => enabledRoomIds.has(room.id) || isLockedAutoModeRoom(room.id))
    }

    // 패턴 필터 적용 (선택된 방 중에서 패턴 매칭되는 방만)
    const effectiveFilters = activeFilters ?? (selectedPattern === 'all' ? [] : [selectedPattern])
    if (effectiveFilters.length > 0) {
      roomList = roomList.filter(room => {
        if (isLockedAutoModeRoom(room.id)) return true
        const state = roomStates.get(room.id) || null
        return effectiveFilters.some(filterType => matchesFilter(room, state, filterType))
      })
    }

    // Sort logic
    const getMartin = (roomId: string) => autoModeRoomStates.get(roomId)?.martinLevel || 0
    const getWinRate = (roomId: string) => roomStates.get(roomId)?.stats.winRate || 0
    const getProfit = (roomId: string) => autoModeRoomStates.get(roomId)?.totalProfit || 0
    const getStreak = (roomId: string) => {
      const state = roomStates.get(roomId)
      if (!state) return 0
      return Math.max(state.stats.consecutiveWins, state.stats.consecutiveLosses)
    }
    const getBankerDominance = (room: Room) => {
      // newest-first이므로 slice(0, 10)이 최신 10개
      const recent = room.history.slice(0, 10)
      const bCount = recent.filter(r => r.winner === 'B').length
      const pCount = recent.filter(r => r.winner === 'P').length
      return bCount - pCount
    }
    // 배팅 중인 방 우선 정렬용 헬퍼
    const isBetting = (roomId: string) => autoModeRoomStates.get(roomId)?.waitingForResult ? 1 : 0
    // 정렬 방향 계수 (asc: 1, desc: -1)
    const dir = sortDirection === 'asc' ? 1 : -1

    switch (sortType) {
      case 'name':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (a.koreanName || a.name).localeCompare(b.koreanName || b.name, 'ko')
        })
        break
      case 'games':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (b.history.length - a.history.length)
        })
        break
      case 'martin':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (getMartin(b.id) - getMartin(a.id))
        })
        break
      case 'winRate':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (getWinRate(b.id) - getWinRate(a.id))
        })
        break
      case 'streak':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (getStreak(b.id) - getStreak(a.id))
        })
        break
      case 'recent':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * ((b.lastResultTime || 0) - (a.lastResultTime || 0))
        })
        break
      case 'bankerDominant':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (getBankerDominance(b) - getBankerDominance(a))
        })
        break
      case 'playerDominant':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (getBankerDominance(a) - getBankerDominance(b))
        })
        break
      case 'profit':
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          return dir * (getProfit(b.id) - getProfit(a.id))
        })
        break
      default:
        // 마틴 레벨 높은 순으로 기본 정렬 (배팅 중인 방 우선)
        roomList.sort((a, b) => {
          const bettingDiff = isBetting(b.id) - isBetting(a.id)
          if (bettingDiff !== 0) return bettingDiff
          const martinA = getMartin(a.id)
          const martinB = getMartin(b.id)
          if (martinA !== martinB) return dir * (martinB - martinA)
          return dir * (b.history.length - a.history.length)
        })
    }

    return roomList
  }, [rooms, enabledRoomIds, selectedPattern, activeFilters, matchesFilter, roomStates, autoModeRoomStates, sortType, sortDirection, isAutoEnabled, roomDataVersion, filterSettingsSignature])

  if (filteredRooms.length === 0) {
    return (
      <div className="auto-mode__room-grid">
        <div className="auto-mode__room-empty auto-mode__room-empty--center">
          {isAutoEnabled ? (
            <>
              <p>배팅 중인 방이 없습니다</p>
              <p className="auto-mode__room-empty-hint">패턴에 맞는 방이 나타나면 자동 배팅됩니다</p>
            </>
          ) : (
            <>
              <p>오토 배팅이 꺼져있습니다</p>
              <p className="auto-mode__room-empty-hint">ON 버튼을 눌러 시작하세요</p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="auto-mode__room-grid">
      {filteredRooms.map(room => (
        <AutoModeRoomCard
          key={room.id}
          room={room}
          autoState={autoModeRoomStates.get(room.id) || null}
          isEnabled={enabledRoomIds.has(room.id)}
          isAutoEnabled={isAutoEnabled}
          isFlashing={flashingRooms.has(room.id)}
          betLogs={roomBetLogs.get(room.id) || []}
          timer={roomTimers.get(room.id) || 0}
          settings={settings}
          activeFilters={activeFilters}
        />
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// ROOM CARD - 옵션 C: 배팅 중심 카드
// ═══════════════════════════════════════════════════════════════

interface AutoModeRoomCardProps {
  room: Room
  autoState: RoomBettingState | null
  isEnabled: boolean
  isAutoEnabled: boolean
  isFlashing: boolean
  betLogs: RoomBetLog[]
  timer: number
  settings: AutoModeSettings
  activeFilters?: RoomFilterType[]
}

function AutoModeRoomCard({
  room,
  autoState,
  isEnabled,
  isAutoEnabled,
  isFlashing,
  betLogs,
  timer,
  settings,
  activeFilters,
}: AutoModeRoomCardProps) {
  // 오토 ON 상태일 때만 예측 표시
  const prediction = isAutoEnabled ? autoState?.lastPrediction?.prediction : null
  const isBetting = autoState?.waitingForResult || false

  // 상태 칩 + 필터 매칭 라벨 (공용 헬퍼)
  const statusChip = useMemo(
    () => getRoomStatusChip(autoState, settings, isEnabled, isAutoEnabled),
    [autoState, settings, isEnabled, isAutoEnabled]
  )
  const filterLabel = useMemo(() => getFilterShortLabel(activeFilters), [activeFilters])
  const isTieFilter = isTieFilterLabel(filterLabel)

  const progression = useMemo(
    () => getRoomProgressionDisplay(settings, autoState, { isTieBet: isTieFilter }),
    [settings, autoState, isTieFilter]
  )
  const currentBetAmount = isBetting && (autoState?.lastBetAmount ?? 0) > 0
    ? autoState!.lastBetAmount
    : progression.amount
  const progressionRisk = progression.stage >= Math.max(3, progression.maxStage - 1)
  const progressionWarning = progression.stage > 1

  // 방별 세션 손익 계산
  const sessionProfit = useMemo(() => {
    return betLogs.reduce((sum, log) => sum + (log.profit || 0), 0)
  }, [betLogs])

  // Timer Circle Calculation
  const radius = 10
  const circumference = 2 * Math.PI * radius
  const maxTime = 20 // 기준 시간 20초
  const progress = Math.min(1, Math.max(0, timer / maxTime))
  const dashoffset = circumference * (1 - progress)

  // Status Classes
  let statusClass = 'idle'

  if (!isEnabled) {
    statusClass = 'disabled'
  } else if (isBetting) {
    statusClass = 'betting'
  } else if (prediction) {
    statusClass = 'observing'
  }





  // 예측/배팅 배지 (B/P)
  const activePrediction = prediction || autoState?.lastPrediction?.prediction
  const betBadgeType = activePrediction === 'B' ? 'b' : activePrediction === 'P' ? 'p' : activePrediction === 'T' ? 't' : null

  // Score
  const playerScore = room.gameState?.playerHand?.score
  const bankerScore = room.gameState?.bankerHand?.score
  const hasScore = typeof playerScore === 'number' && typeof bankerScore === 'number'

  // Last Game Result (for icon)
  const lastGame = betLogs.length > 0 ? betLogs[0] : null
  const lastGameStatus = lastGame?.status
  const lastGameLabel = (() => {
    if (!lastGameStatus) return null
    switch (lastGameStatus) {
      case 'pending':
        return '배팅됨'
      case 'failed':
        return '미배팅'
      case 'win':
        return '승'
      case 'loss':
        return '패'
      case 'tie':
        return '무'
      case 'pass':
        return '패스'
      default:
        return (lastGameStatus as string).toUpperCase()
    }
  })()
  const lastGameClass = lastGameStatus === 'win'
    ? 'win'
    : lastGameStatus === 'loss'
      ? 'loss'
      : lastGameStatus === 'pending'
        ? 'pending'
        : lastGameStatus === 'failed'
          ? 'failed'
          : lastGameStatus === 'pass'
            ? 'pass'
            : ''

  return (
    <div className={`auto-mode__room-card ${statusClass} ${isFlashing ? 'flashing' : ''} ${isBetting ? 'betting' : ''}`}>

      {/* 1. Header */}
      <div className="auto-mode__room-header">
        <div className="auto-mode__room-header-left">
          <div className={`auto-mode__status-dot-indicator ${statusClass}`} />
          <div className="auto-mode__room-name">{room.koreanName || room.name}</div>
          <span className={`auto-status-chip ${statusChip.tone}`}>{statusChip.text}</span>
        </div>

        {/* Timer Ring */}
        {timer > 0 && (
          <div className="auto-mode__timer-ring-wrapper">
            <svg className="auto-mode__timer-svg" width="24" height="24">
              <circle
                className="auto-mode__timer-circle-bg"
                strokeWidth="2"
                fill="transparent"
                r={radius}
                cx="12"
                cy="12"
              />
              <circle
                className={`auto-mode__timer-circle ${timer <= 5 ? 'urgent' : ''}`}
                strokeWidth="2"
                fill="transparent"
                r={radius}
                cx="12"
                cy="12"
                strokeDasharray={circumference}
                strokeDashoffset={dashoffset}
              />
            </svg>
            <span className="auto-mode__timer-text">{timer}</span>
          </div>
        )}
      </div>

      {/* 1.5. Filter Reason — 왜 이 방이 풀에 들어왔는지 */}
      {filterLabel && (
        <div className="auto-mode__room-meta">
          <span className={`auto-filter-reason ${isTieFilter ? 'tie-tone' : ''}`}>{filterLabel}</span>
        </div>
      )}

      {/* 2. Main Game Area */}
      <div className="auto-mode__room-game-area">

        {/* Betting Overlay */}
        {isBetting && betBadgeType && (
          <div className="auto-mode__bet-action-overlay">
            <div className={`auto-mode__bet-action-badge ${betBadgeType}`}>
              배팅 {activePrediction === 'B' ? '뱅커' : activePrediction === 'P' ? '플레이어' : activePrediction}
            </div>
            <div className="auto-mode__bet-action-amount">
              {currentBetAmount.toLocaleString()}원
            </div>
          </div>
        )}

        {/* Pass Overlay (Recent) */}
        {!isBetting && betLogs.length > 0 && betLogs[0].status === 'pass' && (Date.now() - betLogs[0].timestamp < 3000) && (
          <div className="auto-mode__bet-action-overlay pass-overlay">
            <div className="auto-mode__bet-action-badge pass">
              패스
            </div>
            <div className="auto-mode__bet-action-amount">
              {betLogs[0].message || '패스'}
            </div>
          </div>
        )}

        {/* Result Overlay (Win/Loss) - Lasts 4 seconds */}
        {/* Result Overlay (Win/Loss) - Prioritized, lasts 4 seconds */}
        {(() => {
          // Check top 2 logs for recent result to handle race conditions where a new pending log pushes the result down
          const recentResultLog = betLogs.slice(0, 2).find(log =>
            (log.status === 'win' || log.status === 'loss') && (Date.now() - log.timestamp < 4000)
          )

          if (recentResultLog) {
            return (
              <div className={`auto-mode__bet-action-overlay ${recentResultLog.status === 'win' ? 'win-overlay' : 'loss-overlay'}`}>
                <div className={`auto-mode__bet-action-badge ${recentResultLog.status === 'win' ? 'win' : 'loss'}`}>
                  {recentResultLog.status === 'win' ? '승' : '패'}
                </div>
                <div className="auto-mode__bet-action-amount">
                  {recentResultLog.profit > 0 ? '+' : ''}{recentResultLog.profit.toLocaleString()}원
                </div>
              </div>
            )
          }
          return null
        })()}

        {/* Pro-UI Score Display */}
        <div className="auto-mode__score-display">
          <div className="auto-mode__score-item player">
            <span className="auto-mode__score-label">플레이어</span>
            <span className="auto-mode__score-value">{hasScore ? playerScore : '-'}</span>
          </div>
          <div className="auto-mode__score-divider" />
          <div className="auto-mode__score-item banker">
            <span className="auto-mode__score-value">{hasScore ? bankerScore : '-'}</span>
            <span className="auto-mode__score-label">뱅커</span>
          </div>
        </div>

        {/* Info Row: Bet & Profit / Martin */}
        <div className="auto-mode__info-row">
          {/* Left: Bet Amount */}
          <div className="auto-mode__bet-section">
            <span className="auto-mode__bet-label">배팅금액</span>
            <span className="auto-mode__bet-value">
              {currentBetAmount.toLocaleString()}원
            </span>
          </div>

          {/* Center: Session Profit (only if non-zero) */}
          {sessionProfit !== 0 ? (
            <div className={`auto-mode__profit-section ${sessionProfit > 0 ? 'positive' : 'negative'}`}>
              <span className="auto-mode__profit-value">
                {sessionProfit > 0 ? '+' : ''}{sessionProfit.toLocaleString()}원
              </span>
            </div>
          ) : (
            <div className="auto-mode__profit-section empty" />
          )}

          {/* Right: active progression */}
          <div className="auto-mode__martin-section">
            <span className={`auto-mode__martin-label ${progressionRisk ? 'danger' : progressionWarning ? 'warning' : ''}`}>
              진행 {progression.stepLabel}
            </span>
            <div className="auto-mode__martin-gauge">
              {Array.from({ length: progression.maxStage }).map((_, idx) => (
                <div
                  key={idx}
                  className={`auto-mode__martin-step ${idx < progression.stage ? 'active' : ''} ${progressionRisk ? 'danger' : progressionWarning ? 'warning' : ''}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 3. Footer: Bead Road + Info Bar */}
      <div className="auto-mode__room-footer">
        <div className="auto-mode__mini-history">
          {room.history.slice(0, 15).reverse().map((h, i) => (
            <div
              key={i}
              className={`auto-mode__history-bar ${h.winner.toLowerCase()}`}
              title={`${h.winner === 'B' ? '뱅커' : h.winner === 'P' ? '플레이어' : '타이'}`}
            />
          ))}
        </div>
        {lastGameLabel && (
          <div className={`auto-mode__last-game-result ${lastGameClass}`}>
            {lastGameLabel}
          </div>
        )}
      </div>

      {/* 4. 실행 요약: 방향·금액·진행·승패 */}
      <div className="auto-mode__room-card-footer">
        <div className="auto-mode__room-card-footer-left">
          {prediction ? (
            <span className={`auto-mode__room-card-footer-pred ${prediction === 'B' ? 'banker' : prediction === 'P' ? 'player' : 'tie'}`}>
            {prediction === 'B' ? '뱅커' : prediction === 'P' ? '플레이어' : '타이'} {compactAmount(currentBetAmount)}
            </span>
          ) : (
            <span className="auto-mode__room-card-footer-pred idle">대기</span>
          )}
        </div>
        <div className="auto-mode__room-card-footer-info">
          <span className={`auto-mode__room-card-footer-martin ${!progressionWarning ? 'safe' : progressionRisk ? 'danger' : 'warn'}`}>
            {progression.compactStepLabel}
          </span>
          <span className="auto-mode__room-card-footer-wl">
            {autoState?.totalWins || 0}승 {autoState?.totalLosses || 0}패
          </span>
        </div>
      </div>
    </div>
  )
}

export default AutoModeRoomGrid
