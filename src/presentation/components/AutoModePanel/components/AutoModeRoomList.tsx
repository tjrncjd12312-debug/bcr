import { useMemo } from 'react'
import type { Room, RoomPredictionState, RoomFilterType, RoomSortType, SortDirection } from '../../../../domain/entities'
import type { RoomBettingState, AutoModeSettings } from '../../../../application/services/AutoModeService'
import type { RoomBetLog } from './AutoModeRoomGrid'
import '../AutoModePanel.css'
import './AutoModeList.css'

interface AutoModeRoomListProps {
    rooms: Map<string, Room>
    roomStates: Map<string, RoomPredictionState>
    autoModeRoomStates: Map<string, RoomBettingState>
    enabledRoomIds: Set<string>
    settings: AutoModeSettings
    isAutoEnabled: boolean
    flashingRooms: Set<string>
    roomBetLogs: Map<string, RoomBetLog[]>
    roomTimers: Map<string, number>
    selectedPattern: RoomFilterType | 'all'
    matchesFilter: (room: Room, state: RoomPredictionState | null, pattern: RoomFilterType) => boolean
    sortType: RoomSortType
    sortDirection?: SortDirection
    setSortType: (type: RoomSortType) => void
    roomDataVersion: number
}

export function AutoModeRoomList({
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
    matchesFilter,
    sortType,
    sortDirection = 'desc',
    setSortType,
    roomDataVersion,
}: AutoModeRoomListProps) {
    // Filter and sort logic (Duplicated from RoomGrid to ensure isolation)
    const filteredRooms = useMemo(() => {
        let roomList = Array.from(rooms.values())
            .filter(room => {
                const name = (room.koreanName || room.name || '').toLowerCase()
                if (name.includes('salon') || name.includes('lightning')) return false
                if (!name.includes('baccarat') && !name.includes('바카라')) return false
                return true
            })

        if (enabledRoomIds.size > 0) {
            roomList = roomList.filter(room => enabledRoomIds.has(room.id))
        }

        if (selectedPattern !== 'all') {
            roomList = roomList.filter(room => {
                const state = roomStates.get(room.id) || null
                return matchesFilter(room, state, selectedPattern as RoomFilterType)
            })
        }

        const getMartin = (roomId: string) => autoModeRoomStates.get(roomId)?.martinLevel || 0
        const getWinRate = (roomId: string) => roomStates.get(roomId)?.stats.winRate || 0
        const getProfit = (roomId: string) => autoModeRoomStates.get(roomId)?.totalProfit || 0
        const getStreak = (roomId: string) => {
            const state = roomStates.get(roomId)
            if (!state) return 0
            return Math.max(state.stats.consecutiveWins, state.stats.consecutiveLosses)
        }
        const getBankerDominance = (room: Room) => {
            const recent = room.history.slice(0, 10)
            const bCount = recent.filter(r => r.winner === 'B').length
            const pCount = recent.filter(r => r.winner === 'P').length
            return bCount - pCount
        }

        // 배팅 중인 방 우선 정렬 헬퍼
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
    }, [rooms, enabledRoomIds, selectedPattern, matchesFilter, roomStates, autoModeRoomStates, sortType, sortDirection, isAutoEnabled, roomDataVersion])

    if (filteredRooms.length === 0) {
        return (
            <div className="auto-mode__list-empty">
                <div className="auto-mode__room-empty auto-mode__room-empty--center">
                    <p>표시할 방이 없습니다</p>
                </div>
            </div>
        )
    }

    return (
        <div className="auto-mode__list-container">
            {/* Table Header */}
            <div className="auto-mode__list-header">
                <div className="col-room sortable" onClick={() => setSortType('name')}>방 이름</div>
                <div className="col-status">상태</div>
                <div className="col-timer sortable" onClick={() => setSortType('recent')}>타이머</div>
                <div className="col-game">게임</div>
                <div className="col-stats sortable" onClick={() => setSortType('winRate')}>승률</div>
                <div className="col-score">스코어 (P-B)</div>
                <div className="col-trend">최근 기록</div>
                <div className="col-strategy sortable" onClick={() => setSortType('martin')}>
                    전략 단계
                </div>
                <div className="col-predict">예측/배팅</div>
                <div className="col-profit">손익</div>
            </div>

            {/* Table Body */}
            <div className="auto-mode__list-body">
                {filteredRooms.map(room => (
                    <AutoModeListRow
                        key={room.id}
                        room={room}
                        autoState={autoModeRoomStates.get(room.id) || null}
                        predictionState={roomStates.get(room.id) || null}
                        isEnabled={enabledRoomIds.has(room.id)}
                        isAutoEnabled={isAutoEnabled}
                        isFlashing={flashingRooms.has(room.id)}
                        betLogs={roomBetLogs.get(room.id) || []}
                        timer={roomTimers.get(room.id) || 0}
                        maxMartin={settings.maxMartin || 5}
                    />
                ))}
            </div>
        </div>
    )
}

// ═══════════════════════════════════════════════════════════════
// List Row Component
// ═══════════════════════════════════════════════════════════════
interface AutoModeListRowProps {
    room: Room
    autoState: RoomBettingState | null
    predictionState: RoomPredictionState | null
    isEnabled: boolean
    isAutoEnabled: boolean
    isFlashing: boolean
    betLogs: RoomBetLog[]
    timer: number
    maxMartin: number
}

function AutoModeListRow({
    room,
    autoState,
    predictionState,
    isEnabled,
    isAutoEnabled,
    isFlashing,
    betLogs,
    timer,
    maxMartin
}: AutoModeListRowProps) {
    const prediction = isAutoEnabled ? autoState?.lastPrediction?.prediction : null
    const martinLevel = autoState?.martinLevel || 0
    const isBetting = autoState?.waitingForResult || false
    const activePrediction = prediction || autoState?.lastPrediction?.prediction
    const lastPrediction = autoState?.lastPrediction
    const patternName = lastPrediction?.reasoning || ''
    const betAmount = autoState?.lastBetAmount || 0
    const winRate = predictionState?.stats?.winRate || 0

    // Score
    const playerScore = room.gameState?.playerHand?.score
    const bankerScore = room.gameState?.bankerHand?.score
    const hasScore = typeof playerScore === 'number' && typeof bankerScore === 'number'

    // Timer Color
    const timerClass = timer <= 5 ? 'urgent' : timer <= 10 ? 'warning' : 'normal';

    // Last Profit from logs
    const sessionProfit = betLogs.reduce((sum, log) => sum + log.profit, 0);

    // Trend (Right to Left)
    const recentHistory = room.history.slice(0, 10);



    return (
        <div className={`auto-mode__list-row ${isFlashing ? 'flashing' : ''} ${isBetting ? 'betting' : ''} ${!isEnabled ? 'disabled' : ''}`}>
            {/* 1. Room Name */}
            <div className="col-room">
                <span className="room-name">{room.koreanName || room.name}</span>
                <span className="room-id">#{room.id.slice(-4)}</span>
            </div>

            {/* 2. Status */}
            <div className="col-status">
                <div className={`status-dot ${isEnabled ? (isBetting ? 'betting' : 'active') : 'disabled'}`} />
                <span className="status-text">{isEnabled ? (isBetting ? '배팅중' : '대기중') : 'OFF'}</span>
            </div>

            {/* 3. Timer */}
            <div className="col-timer">
                {timer > 0 && <span className={`timer-value ${timerClass}`}>{timer}s</span>}
            </div>

            {/* 4. Game Count */}
            <div className="col-game">
                <span className="game-count">{room.history.length || 0}G</span>
            </div>

            {/* 5. Win Rate */}
            <div className="col-stats">
                <span className="win-rate">{winRate.toFixed(1)}%</span>
            </div>

            {/* 6. Score */}
            <div className="col-score">
                {hasScore ? (
                    <div className="score-box">
                        <span className={`score p ${playerScore > bankerScore ? 'win' : ''}`}>{playerScore}</span>
                        <span className="divider">-</span>
                        <span className={`score b ${bankerScore > playerScore ? 'win' : ''}`}>{bankerScore}</span>
                    </div>
                ) : (
                    <span className="no-score">-</span>
                )}
            </div>

            {/* 6. Trend (Bead Plate Mini) */}
            <div className="col-trend">
                <div className="mini-bead-plate">
                    {recentHistory.map((h, i) => (
                        <div key={i} className={`bead ${h.winner.toLowerCase()}`} />
                    ))}
                </div>
            </div>

            {/* 7. Strategy (Martin Progress) */}
            <div className="col-strategy">
                <div className="martin-bar-container">
                    <div className={`martin-bar w-${Math.min(100, (martinLevel / maxMartin) * 100)} ${martinLevel > 2 ? 'danger' : ''}`}></div>
                </div>
                <span className="martin-text">{martinLevel > 0 ? `${martinLevel}단계` : '-'}</span>
            </div>

            {/* 9. Prediction/Action - 배팅 중인 방만 표시 */}
            <div className="col-predict">
                {isBetting && activePrediction ? (
                    <div className="predict-group">
                        <div className={`predict-badge ${activePrediction === 'B' ? 'banker' : activePrediction === 'P' ? 'player' : 'tie'}`}>
                            {activePrediction === 'B' ? 'BANKER' : activePrediction === 'P' ? 'PLAYER' : 'TIE'}
                        </div>
                        <div className="predict-info">
                            {betAmount > 0 && <span className="bet-amt">{betAmount.toLocaleString()}</span>}
                            {patternName && <span className="pattern-tag">{patternName}</span>}
                        </div>
                    </div>
                ) : (
                    <span className="predict-none">-</span>
                )}
            </div>

            {/* 9. Profit */}
            <div className="col-profit">
                <span className={`profit-value ${sessionProfit > 0 ? 'plus' : sessionProfit < 0 ? 'minus' : ''}`}>
                    {sessionProfit.toLocaleString()}
                </span>
            </div>
        </div>
    )
}
