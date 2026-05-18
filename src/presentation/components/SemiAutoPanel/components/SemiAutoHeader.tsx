import React from 'react'
import '../SemiAutoPanel.css'

interface SemiAutoHeaderProps {
    enabled: boolean
    soundEnabled: boolean
    onToggleSettings: () => void
    onToggleSound: () => void
    onSwitchToPredict?: () => void
}

export const SemiAutoHeader: React.FC<SemiAutoHeaderProps> = ({
    enabled,
    soundEnabled,
    onToggleSettings,
    onToggleSound,
    onSwitchToPredict,
}) => {
    return (
        <div className="sa-fs-header">
            <div className="sa-fs-header-left">
                <span className="sa-fs-title">반자동 모드</span>
                <span className={`sa-fs-status ${enabled ? 'active' : ''}`}>
                    {enabled ? '작동중' : '정지'}
                </span>
            </div>
            <div className="sa-fs-header-right">
                {/* Sound Toggle */}
                <button
                    className={`sa-fs-btn sound-toggle ${soundEnabled ? 'on' : 'off'}`}
                    onClick={onToggleSound}
                    title={soundEnabled ? '사운드 끄기' : '사운드 켜기'}
                >
                    {soundEnabled ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                    ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                            <line x1="22" y1="9" x2="16" y2="15" />
                            <line x1="16" y1="9" x2="22" y2="15" />
                        </svg>
                    )}
                </button>
                <button className="sa-fs-btn" onClick={onToggleSettings}>
                    ⚙ 설정
                </button>
                {onSwitchToPredict && (
                    <button className="sa-fs-btn primary" onClick={onSwitchToPredict}>
                        예측모드
                    </button>
                )}
            </div>
        </div>
    )
}
