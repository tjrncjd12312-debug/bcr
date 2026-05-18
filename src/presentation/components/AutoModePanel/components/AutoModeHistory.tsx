import { useState, useMemo } from 'react'
import {
  CheckCircle,
  XCircle,
  Play,
  MinusCircle,
  Info,
  AlertTriangle,
  MoreHorizontal
} from 'lucide-react'
import '../AutoModePanel.css'

export interface HistoryLog {
  id: number
  time: string
  roomName: string
  message: string
  type: 'prediction' | 'bet' | 'win' | 'loss' | 'move' | 'info' | 'error' | 'skip'
  betAmount?: number
  profit?: number
  cumulativeProfit?: number
  playerScore?: number
  bankerScore?: number
  winner?: 'P' | 'B' | 'T'
}

interface AutoModeHistoryProps {
  logs: HistoryLog[]
}

const TYPE_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  prediction: { label: '예측', icon: <MoreHorizontal size={12} />, color: 'var(--text-muted)' },
  bet: { label: '배팅', icon: <Play size={12} fill="currentColor" />, color: 'var(--blue)' },
  win: { label: '승리', icon: <CheckCircle size={12} />, color: 'var(--green)' },
  loss: { label: '패배', icon: <XCircle size={12} />, color: 'var(--red)' },
  move: { label: '이동', icon: <MoreHorizontal size={12} />, color: 'var(--gold)' },
  info: { label: '정보', icon: <Info size={12} />, color: 'var(--text-muted)' },
  error: { label: '오류', icon: <AlertTriangle size={12} />, color: 'var(--red)' },
  skip: { label: '패스', icon: <MinusCircle size={12} />, color: 'var(--text-muted)' },
}

type FilterType = 'all' | 'win' | 'loss' | 'bet' | 'info'

export function AutoModeHistory({ logs }: AutoModeHistoryProps) {

  const [selectedRoom, setSelectedRoom] = useState<string>('all')
  const [selectedType, setSelectedType] = useState<FilterType>('all')
  const [showFilters, setShowFilters] = useState(false)

  // 고유 방 목록 추출
  const uniqueRooms = useMemo(() => {
    const rooms = new Set<string>()
    logs.forEach(log => {
      if (log.roomName && log.roomName !== '-') {
        rooms.add(log.roomName)
      }
    })
    return Array.from(rooms).sort()
  }, [logs])

  // 필터링된 로그
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // 방 필터
      if (selectedRoom !== 'all' && log.roomName !== selectedRoom) {
        return false
      }
      // 타입 필터
      if (selectedType !== 'all') {
        if (selectedType === 'win' && log.type !== 'win') return false
        if (selectedType === 'loss' && log.type !== 'loss') return false
        if (selectedType === 'bet' && log.type !== 'bet') return false
        if (selectedType === 'info' && !['info', 'move', 'error'].includes(log.type)) return false
      }
      return true
    })
  }, [logs, selectedRoom, selectedType])

  // 필터링된 통계
  const stats = useMemo(() => {
    let wins = 0, losses = 0, totalProfit = 0
    filteredLogs.forEach(log => {
      if (log.type === 'win') wins++
      if (log.type === 'loss') losses++
      if (log.profit !== undefined) totalProfit += log.profit
    })
    const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0
    return { wins, losses, totalProfit, winRate }
  }, [filteredLogs])

  const formatAmount = (amount: number | undefined | null) => {
    if (amount === undefined || amount === null || isNaN(amount)) return '-'
    if (amount === 0) return '0'
    return amount.toLocaleString()
  }

  const formatProfit = (profit: number | undefined) => {
    if (profit === undefined) return '-'
    const prefix = profit > 0 ? '+' : ''
    return `${prefix}${profit.toLocaleString()}`
  }

  const resetFilters = () => {
    setSelectedRoom('all')
    setSelectedType('all')
  }

  const hasActiveFilters = selectedRoom !== 'all' || selectedType !== 'all'

  return (
    <div className="auto-mode__history">
      <div className="auto-mode__history-header">
        <div className="auto-mode__history-header-left">
          <div className="history-header-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3>배팅 히스토리</h3>
          <span className="auto-mode__history-count">
            {hasActiveFilters ? `${filteredLogs.length}/${logs.length}` : `${logs.length}`}
          </span>
        </div>
        <div className="auto-mode__history-header-right">
          <button
            className={`auto-mode__history-filter-toggle ${showFilters ? 'active' : ''} ${hasActiveFilters ? 'has-filter' : ''}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
          </button>
        </div>
      </div>

      {/* 필터 패널 */}
      {showFilters && (
        <div className="auto-mode__history-filters">
          <div className="auto-mode__history-filter-group">
            <label>방</label>
            <select
              value={selectedRoom}
              onChange={(e) => setSelectedRoom(e.target.value)}
            >
              <option value="all">전체 ({uniqueRooms.length})</option>
              {uniqueRooms.map(room => (
                <option key={room} value={room}>{room}</option>
              ))}
            </select>
          </div>

          <div className="auto-mode__history-filter-group">
            <label>결과</label>
            <div className="auto-mode__history-filter-buttons">
              <button
                className={selectedType === 'all' ? 'active' : ''}
                onClick={() => setSelectedType('all')}
              >
                전체
              </button>
              <button
                className={`win ${selectedType === 'win' ? 'active' : ''}`}
                onClick={() => setSelectedType('win')}
              >
                승리
              </button>
              <button
                className={`loss ${selectedType === 'loss' ? 'active' : ''}`}
                onClick={() => setSelectedType('loss')}
              >
                패배
              </button>
              <button
                className={selectedType === 'bet' ? 'active' : ''}
                onClick={() => setSelectedType('bet')}
              >
                배팅
              </button>
              <button
                className={selectedType === 'info' ? 'active' : ''}
                onClick={() => setSelectedType('info')}
              >
                정보
              </button>
            </div>
          </div>

          {hasActiveFilters && (
            <button className="auto-mode__history-filter-reset" onClick={resetFilters}>
              필터 초기화
            </button>
          )}

          {/* 필터 적용 시 통계 표시 */}
          {hasActiveFilters && filteredLogs.length > 0 && (
            <div className="auto-mode__history-filter-stats">
              <span className="stat-item">
                승률: <strong className={stats.winRate >= 50 ? 'positive' : 'negative'}>{stats.winRate}%</strong>
              </span>
              <span className="stat-item">
                {stats.wins}승 / {stats.losses}패
              </span>
              <span className={`stat-item ${stats.totalProfit >= 0 ? 'positive' : 'negative'}`}>
                손익: {stats.totalProfit >= 0 ? '+' : ''}{stats.totalProfit.toLocaleString()}원
              </span>
            </div>
          )}
        </div>
      )}

      <div className="auto-mode__history-content">

        {/* 스크롤 가능한 바디 */}
        <div className="auto-mode__history-body">
          {filteredLogs.length === 0 ? (
            <div className="auto-mode__history-empty">
              <div className="empty-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
                  <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p>
                {hasActiveFilters ? (
                  <>필터 조건에 맞는 기록이 없습니다.<br />필터를 변경해보세요.</>
                ) : (
                  <>배팅 기록이 없습니다.<br />오토 배팅을 시작하면 표시됩니다.</>
                )}
              </p>
            </div>
          ) : (
            <div className="auto-mode__history-list">
              {filteredLogs.map(log => {
                const config = TYPE_CONFIG[log.type] || TYPE_CONFIG.info
                return (
                  <div
                    key={log.id}
                    className={`auto-mode__history-card ${log.type}`}
                  >
                    <div className="card-side-glow" style={{ background: config.color }} />
                    <div className="card-content">
                      <div className="card-header">
                        <div className="card-header-left">
                          <span className={`card-type-tag ${log.type}`} style={{ color: config.color, borderColor: config.color }}>
                            {config.icon}
                            <span className="type-label">{config.label}</span>
                          </span>
                          <span className="card-room-name">{log.roomName !== '-' ? log.roomName : '시스템'}</span>
                        </div>
                        <span className="card-time">{log.time}</span>
                      </div>

                      <div className="card-message">{log.message}</div>

                      {/* 카드 점수 표시 (승리/패배/타이 시) */}
                      {(log.type === 'win' || log.type === 'loss' || (log.type === 'info' && log.winner === 'T')) && (
                        <div className="card-score-display">
                          <div className={`score-badge player ${log.winner === 'P' ? 'winner' : ''}`}>
                            <span className="score-label">플레이어</span>
                            <span className="score-value">{log.playerScore ?? '-'}</span>
                          </div>
                          <div className="score-vs">
                            <span className="vs-text">대</span>
                          </div>
                          <div className={`score-badge banker ${log.winner === 'B' ? 'winner' : ''}`}>
                            <span className="score-label">뱅커</span>
                            <span className="score-value">{log.bankerScore ?? '-'}</span>
                          </div>
                          {log.winner === 'T' && (
                            <div className="score-tie-badge">무</div>
                          )}
                        </div>
                      )}

                      {(log.betAmount !== undefined || log.profit !== undefined) && (
                        <div className="card-stats">
                          {log.betAmount !== undefined && (
                            <div className="card-stat-item">
                              <span className="label">배팅</span>
                              <span className="value">{formatAmount(log.betAmount)}</span>
                            </div>
                          )}
                          {log.profit !== undefined && (
                            <div className={`card-stat-item profit ${log.profit > 0 ? 'win' : log.profit < 0 ? 'loss' : ''}`}>
                              <span className="label">손익</span>
                              <span className="value">{formatProfit(log.profit)}</span>
                            </div>
                          )}
                          {log.cumulativeProfit !== undefined && (
                            <div className="card-stat-item cumulative">
                              <span className="label">누적</span>
                              <span className={`value ${log.cumulativeProfit > 0 ? 'win' : log.cumulativeProfit < 0 ? 'loss' : ''}`}>
                                {formatProfit(log.cumulativeProfit)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
