import React from 'react'
import type { RoomFilterType, RoomFilter } from '../../../../domain/entities'
import '../SemiAutoPanel.css'

interface HistoryLog {
    id: number
    time: string
    message: string
    type: 'prediction' | 'win' | 'loss' | 'move' | 'info'
}

interface SemiAutoSidebarProps {
    showSettings: boolean
    settings: any
    martin: number
    winCount: number
    totalWins: number
    totalLosses: number
    winRate: number
    historyLogs: HistoryLog[]
    onUpdateSettings: (settings: any) => void
    onResetStats: () => void
    // Pattern filter props
    availableFilters?: RoomFilter[]
    selectedPattern?: RoomFilterType | 'all'
    onPatternChange?: (pattern: RoomFilterType | 'all') => void
    onOpenPatternManager?: () => void
}

export const SemiAutoSidebar: React.FC<SemiAutoSidebarProps> = ({
    showSettings,
    settings,
    martin,
    winCount,
    totalWins,
    totalLosses,
    winRate,
    historyLogs,
    onUpdateSettings,
    onResetStats,
    availableFilters = [],
    selectedPattern = 'all',
    onPatternChange,
    onOpenPatternManager,
}) => {
    return (
        <div className="sa-fs-sidebar">
            {/* Settings Panel */}
            {showSettings ? (
                <div className="sa-fs-settings">
                    <div className="sa-fs-settings-title">설정</div>
                    {/* Pattern Filter Dropdown */}
                    {onPatternChange && (
                        <div className="sa-fs-setting-row">
                            <label>패턴찾기</label>
                            <select
                                className="sa-pattern-select"
                                value={selectedPattern}
                                onChange={(e) => onPatternChange(e.target.value as RoomFilterType | 'all')}
                            >
                                <option value="all">전체</option>
                                {availableFilters.map((filter) => (
                                    <option key={filter.type} value={filter.type}>
                                        {filter.label}
                                    </option>
                                ))}
                            </select>
                            {onOpenPatternManager && (
                                <button className="sa-pattern-manage" onClick={onOpenPatternManager}>
                                    커스텀 관리
                                </button>
                            )}
                        </div>
                    )}
                    <div className="sa-fs-setting-row checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={settings.skipFirstRound}
                                onChange={(e) => onUpdateSettings({ skipFirstRound: e.target.checked })}
                            />
                            첫 라운드 스킵
                        </label>
                    </div>
                    <div className="sa-fs-setting-row checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={settings.autoFindRoom}
                                onChange={(e) => onUpdateSettings({ autoFindRoom: e.target.checked })}
                            />
                            자동 방 탐색
                        </label>
                    </div>
                    <button className="sa-fs-btn danger" onClick={onResetStats}>
                        통계 초기화
                    </button>
                </div>
            ) : (
                <>
                    {/* Stats */}
                    <div className="sa-fs-stats">
                        <div className="sa-fs-stats-title">통계</div>
                        <div className="sa-fs-stats-grid">
                            <div className="sa-fs-stat">
                                <span className="sa-fs-stat-label">마틴</span>
                                <span className={`sa-fs-stat-value ${martin >= 3 ? 'danger' : martin > 0 ? 'warning' : ''}`}>
                                    {martin}
                                </span>
                            </div>
                            <div className="sa-fs-stat">
                                <span className="sa-fs-stat-label">연승</span>
                                <span className={`sa-fs-stat-value ${winCount > 0 ? 'success' : ''}`}>
                                    {winCount}
                                </span>
                            </div>
                            <div className="sa-fs-stat">
                                <span className="sa-fs-stat-label">승률</span>
                                <span className={`sa-fs-stat-value ${winRate >= 50 ? 'success' : winRate > 0 ? 'warning' : ''}`}>
                                    {winRate}%
                                </span>
                            </div>
                            <div className="sa-fs-stat">
                                <span className="sa-fs-stat-label">총 예측</span>
                                <span className="sa-fs-stat-value">
                                    {totalWins + totalLosses}
                                </span>
                            </div>
                            <div className="sa-fs-stat">
                                <span className="sa-fs-stat-label">적중</span>
                                <span className="sa-fs-stat-value success">{totalWins}</span>
                            </div>
                            <div className="sa-fs-stat">
                                <span className="sa-fs-stat-label">실패</span>
                                <span className="sa-fs-stat-value danger">{totalLosses}</span>
                            </div>
                        </div>
                    </div>

                    {/* History Log */}
                    <div className="sa-fs-history">
                        <div className="sa-fs-history-title">히스토리</div>
                        <div className="sa-fs-history-list">
                            {historyLogs.map(log => (
                                <div key={log.id} className={`sa-fs-log ${log.type}`}>
                                    <span className="sa-fs-log-time">{log.time}</span>
                                    <span className="sa-fs-log-msg">{log.message}</span>
                                </div>
                            ))}
                            {historyLogs.length === 0 && (
                                <div className="sa-fs-history-empty">기록이 없습니다</div>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}
