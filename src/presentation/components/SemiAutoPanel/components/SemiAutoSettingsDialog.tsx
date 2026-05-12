import React, { useEffect, useState, useMemo } from 'react'
import type {
    Room,
    RoomBetConfig,
} from '../../../../domain/entities'
import type { SemiAutoSettings } from '../../../../application/services/SemiAutoService'
import { getFreshShoePreset } from '../../../../application/di/setupContainer'
import './SemiAutoSettingsDialog.css'

// Tab type for the dialog
type SettingsTab = 'general' | 'rooms'

interface SemiAutoSettingsDialogProps {
    isOpen: boolean
    onClose: () => void
    settings: SemiAutoSettings
    onUpdateSettings: (settings: Partial<SemiAutoSettings>) => void
    // Room list
    rooms?: Map<string, Room>
    // Actions
    onResetStats: () => void
    onClearHistory: () => void
    // Stats
    totalWins: number
    totalLosses: number
    // Balance (optional)
    realBalance?: number | null
    sessionProfit?: number
}

export const SemiAutoSettingsDialog: React.FC<SemiAutoSettingsDialogProps> = ({
    isOpen,
    onClose,
    settings,
    onUpdateSettings,
    rooms = new Map(),
    onResetStats,
    onClearHistory,
    totalWins,
    totalLosses,
    realBalance,
    sessionProfit = 0,
}) => {
    const [animateIn, setAnimateIn] = useState(false)
    const [activeTab, setActiveTab] = useState<SettingsTab>('general')

    // Fresh-Shoe Tie 마틴 프리셋 토글
    const [freshShoeOn, setFreshShoeOn] = useState(() => {
        const p = getFreshShoePreset()
        return p ? p.isEnabled('semiauto') : false
    })

    const handleFreshShoeToggle = (next: boolean) => {
        const p = getFreshShoePreset()
        if (!p) return
        if (next) p.enable('semiauto')
        else p.disable('semiauto')
        setFreshShoeOn(p.isEnabled('semiauto'))
    }

    useEffect(() => {
        if (isOpen) {
            setAnimateIn(true)
        } else {
            setAnimateIn(false)
        }
    }, [isOpen])

    // Convert rooms Map to array for rendering
    const roomList = useMemo(() => Array.from(rooms.values()), [rooms])

    // Get enabled room IDs from settings
    const enabledRoomIds = useMemo(() => {
        if (!settings.roomConfigs || settings.roomConfigs.length === 0) {
            return new Set(roomList.map(r => r.id))
        }
        return new Set(settings.roomConfigs.filter(c => c.enabled).map(c => c.roomId))
    }, [settings.roomConfigs, roomList])

    if (!isOpen) return null

    const handleOverlayClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose()
        }
    }

    // Room config helpers
    const handleRoomToggle = (roomId: string, enabled: boolean) => {
        const currentConfigs = settings.roomConfigs || []
        const existingIndex = currentConfigs.findIndex(c => c.roomId === roomId)

        let newConfigs: RoomBetConfig[]
        if (existingIndex >= 0) {
            newConfigs = [...currentConfigs]
            newConfigs[existingIndex] = { ...newConfigs[existingIndex], enabled }
        } else {
            newConfigs = [
                ...currentConfigs,
                {
                    roomId,
                    enabled,
                    maxConsecutiveLosses: settings.globalMaxConsecutiveLosses || 5,
                },
            ]
        }
        onUpdateSettings({ roomConfigs: newConfigs })
    }

    const handleSelectAllRooms = () => {
        const newConfigs: RoomBetConfig[] = roomList.map(room => ({
            roomId: room.id,
            enabled: true,
            maxConsecutiveLosses: settings.globalMaxConsecutiveLosses || 5,
        }))
        onUpdateSettings({ roomConfigs: newConfigs })
    }

    const handleDeselectAllRooms = () => {
        const newConfigs: RoomBetConfig[] = roomList.map(room => ({
            roomId: room.id,
            enabled: false,
            maxConsecutiveLosses: settings.globalMaxConsecutiveLosses || 5,
        }))
        onUpdateSettings({ roomConfigs: newConfigs })
    }

    return (
        <div className={`sa-dialog-overlay ${animateIn ? 'visible' : ''}`} onClick={handleOverlayClick}>
            <div className={`sa-dialog ${animateIn ? 'visible' : ''}`}>
                <div className="sa-dialog-header">
                    <h2>반자동 설정</h2>
                    <button className="sa-dialog-close" onClick={onClose}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>

                {/* Tabs */}
                <div className="sa-dialog-tabs">
                    <button
                        className={`sa-tab ${activeTab === 'general' ? 'active' : ''}`}
                        onClick={() => setActiveTab('general')}
                    >
                        일반
                    </button>
                    <button
                        className={`sa-tab ${activeTab === 'rooms' ? 'active' : ''}`}
                        onClick={() => setActiveTab('rooms')}
                    >
                        방 선택
                    </button>
                </div>

                <div className="sa-dialog-content">
                    {/* Tab 1: General Settings */}
                    {activeTab === 'general' && (
                        <>
                            {/* Fresh-Shoe Tie 마틴 프리셋 토글 */}
                            <div style={{
                                border: '1px solid var(--color-border, #444)',
                                borderRadius: 8,
                                padding: 12,
                                margin: '12px 0',
                                background: 'var(--color-surface-2, #1c1c1c)',
                            }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
                                    <input
                                        type="checkbox"
                                        checked={freshShoeOn}
                                        onChange={(e) => handleFreshShoeToggle(e.target.checked)}
                                    />
                                    Fresh-Shoe Tie 마틴
                                </label>
                                <div style={{ fontSize: 12, color: 'var(--color-text-dim, #999)', marginTop: 6, lineHeight: 1.5 }}>
                                    {getFreshShoePreset()?.getDescription() ?? '슈가 막 시작된 방에서만 Tie 마틴 베팅. 적중/관망 Tie/마틴 한도 시 다음 방으로.'}
                                </div>
                            </div>

                            {/* Section 1: Balance Display */}
                            <div className="sa-dialog-section">
                                <h3 className="sa-section-title">잔고 현황</h3>

                                <div className="sa-balance-display">
                                    <div className="sa-balance-item">
                                        <span className="sa-balance-label">현재 잔고</span>
                                        <span className="sa-balance-value">
                                            {realBalance !== null && realBalance !== undefined
                                                ? `${realBalance.toLocaleString()}원`
                                                : '-'}
                                        </span>
                                    </div>
                                    <div className={`sa-balance-item ${sessionProfit >= 0 ? 'positive' : 'negative'}`}>
                                        <span className="sa-balance-label">세션 손익</span>
                                        <span className="sa-balance-value">
                                            {sessionProfit >= 0 ? '+' : ''}{sessionProfit.toLocaleString()}원
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="sa-dialog-divider" />

                            {/* Section 2: Room Move Settings */}
                            <div className="sa-dialog-section">
                                <h3 className="sa-section-title">방 이동 설정</h3>
                                <p className="sa-setting-hint">
                                    연승 또는 연패 시 자동으로 다른 방으로 이동
                                </p>

                                <div className="sa-setting-grid">
                                    <div className="sa-setting-item">
                                        <label>연승 이동</label>
                                        <div className="sa-input-wrapper">
                                            <input
                                                type="number"
                                                min="0"
                                                max="20"
                                                value={settings.winThreshold ?? 0}
                                                onChange={(e) => onUpdateSettings({ winThreshold: Number(e.target.value) })}
                                                className="sa-dialog-input"
                                            />
                                            <span className="sa-input-suffix">승</span>
                                        </div>
                                    </div>

                                    <div className="sa-setting-item">
                                        <label>연패 이동</label>
                                        <div className="sa-input-wrapper">
                                            <input
                                                type="number"
                                                min="0"
                                                max="20"
                                                value={settings.lossThreshold ?? 0}
                                                onChange={(e) => onUpdateSettings({ lossThreshold: Number(e.target.value) })}
                                                className="sa-dialog-input"
                                            />
                                            <span className="sa-input-suffix">연패</span>
                                        </div>
                                    </div>
                                </div>
                                <p className="sa-setting-hint">
                                    0 = 무제한
                                </p>
                            </div>

                            <div className="sa-dialog-divider" />

                            {/* Section 3: Auto Room Settings */}
                            <div className="sa-dialog-section">
                                <h3 className="sa-section-title">자동 방 탐색</h3>

                                <div className="sa-setting-item checkbox">
                                    <label className="sa-checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={settings.autoFindRoom ?? false}
                                            onChange={(e) => onUpdateSettings({ autoFindRoom: e.target.checked })}
                                        />
                                        <span className="sa-checkbox-text">시작 시 자동으로 최적의 방 찾기</span>
                                    </label>
                                </div>
                                <p className="sa-setting-hint">
                                    활성화하면 시작 버튼을 누를 때 자동으로 방을 선택하고 이동합니다.
                                </p>
                            </div>

                            <div className="sa-dialog-divider" />

                            {/* Section 4: Display Settings */}
                            <div className="sa-dialog-section">
                                <h3 className="sa-section-title">표시 설정</h3>

                                <div className="sa-setting-item checkbox">
                                    <label className="sa-checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={settings.onlySelectedRooms ?? false}
                                            onChange={(e) => onUpdateSettings({ onlySelectedRooms: e.target.checked })}
                                        />
                                        <span className="sa-checkbox-text">선택된 방만 리스트에 표시</span>
                                    </label>
                                </div>
                            </div>

                            <div className="sa-dialog-divider" />

                            {/* Section 4: Stats & Actions */}
                            <div className="sa-dialog-section">
                                <h3 className="sa-section-title">통계 및 관리</h3>

                                <div className="sa-stats-summary">
                                    <div className="sa-stat-box">
                                        <span className="label">총 예측</span>
                                        <span className="value">{totalWins + totalLosses}</span>
                                    </div>
                                    <div className="sa-stat-box success">
                                        <span className="label">적중</span>
                                        <span className="value">{totalWins}</span>
                                    </div>
                                    <div className="sa-stat-box danger">
                                        <span className="label">실패</span>
                                        <span className="value">{totalLosses}</span>
                                    </div>
                                </div>

                                <div className="sa-action-buttons">
                                    <button className="sa-btn-secondary" onClick={onResetStats}>
                                        통계 초기화
                                    </button>
                                    <button className="sa-btn-secondary" onClick={onClearHistory}>
                                        방 기록 초기화
                                    </button>
                                </div>
                            </div>
                        </>
                    )}

                    {/* Tab 2: Room Selection */}
                    {activeTab === 'rooms' && (
                        <div className="sa-dialog-section">
                            <h3 className="sa-section-title">방 선택</h3>
                            <p className="sa-setting-hint">
                                체크된 방만 예측 대상이 됩니다.
                            </p>

                            <div className="sa-room-actions">
                                <button className="sa-btn-secondary small" onClick={handleSelectAllRooms}>
                                    전체 선택
                                </button>
                                <button className="sa-btn-secondary small" onClick={handleDeselectAllRooms}>
                                    전체 해제
                                </button>
                                <span className="sa-room-count">
                                    {enabledRoomIds.size}/{roomList.length} 방 선택
                                </span>
                            </div>

                            <div className="sa-room-list">
                                {roomList.length === 0 ? (
                                    <div className="sa-room-empty">
                                        연결된 방이 없습니다
                                    </div>
                                ) : (
                                    roomList.map((room) => (
                                        <label key={room.id} className="sa-room-item">
                                            <input
                                                type="checkbox"
                                                checked={enabledRoomIds.has(room.id)}
                                                onChange={(e) => handleRoomToggle(room.id, e.target.checked)}
                                            />
                                            <span className="sa-room-name">{room.koreanName || room.name}</span>
                                            <span className="sa-room-games">{room.gameCount || room.history.length}게임</span>
                                        </label>
                                    ))
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="sa-dialog-footer">
                    <button className="sa-btn-primary" onClick={onClose}>
                        설정 완료
                    </button>
                </div>
            </div>
        </div>
    )
}
