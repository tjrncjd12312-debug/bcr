import { useMemo, useState, useEffect } from 'react'
import { Swords, ChevronRight, Flame, Circle, Ban } from 'lucide-react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import Top3Rankings from '../Top3Rankings'
import './RankingView.css'

interface RankingViewProps {
    filteredRooms: Room[]
    allRooms: Map<string, Room>
    roomStates: Map<string, RoomPredictionState>
    onRoomSelect: (room: Room) => void
    onEnterRoom: (roomId: string) => void
    getMartingaleLevel: (roomId: string) => number | undefined
}

export default function RankingView({ filteredRooms, allRooms, roomStates, onRoomSelect, onEnterRoom, getMartingaleLevel }: RankingViewProps) {
    const others = useMemo(() => {
        return filteredRooms.map(room => {
            const state = roomStates.get(room.id)
            const stats = state?.stats || { total: 0, winRate: 0, correct: 0, consecutiveWins: 0, consecutiveLosses: 0 }
            return { room, state, stats }
        })
    }, [filteredRooms, roomStates])

    const handleCardClick = (room: Room) => {
        onRoomSelect(room)
    }

    return (
        <div className="ranking-view">

            {/* --- Top 3 Section (Using Shared Component) --- */}
            <section className="ranking-section">
                <Top3Rankings
                    roomStates={roomStates}
                    rooms={allRooms}
                    onRoomClick={(roomId) => {
                        // 클릭 시 바로 입장
                        onEnterRoom(roomId)
                    }}
                    minPredictions={1}
                />
            </section>

            <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '1rem 0' }} />

            {/* --- All Rooms Section --- */}
            <section className="ranking-section">
                <div className="ranking-section__title">
                    <Swords className="ranking-section__icon" size={20} color="#94a3b8" />
                    <span>전체 방 목록</span>
                </div>

                <div className="ranking-list-grid">
                    {others.map((item) => (
                        <RankingCard
                            key={item.room.id}
                            rank={null}
                            room={item.room}
                            state={item.state}
                            stats={item.stats}
                            martingaleLevel={getMartingaleLevel(item.room.id) || 0}
                            isTop3={false}
                            onClick={() => handleCardClick(item.room)}
                            onEnter={() => onEnterRoom(item.room.id)}
                        />
                    ))}
                    {others.length === 0 && (
                        <div className="ranking-empty">표시할 추가 방이 없습니다.</div>
                    )}
                </div>
            </section>

        </div>
    )
}

// ------ Sub Component: Ranking Card ------

interface RankingCardProps {
    rank: number | null
    room: Room
    state: RoomPredictionState | undefined | null
    stats: { winRate: number, total: number, correct: number, consecutiveWins: number }
    martingaleLevel: number
    isTop3: boolean
    onClick: () => void
    onEnter: () => void
}

function RankingCard({ rank, room, state, stats, martingaleLevel, isTop3, onClick, onEnter }: RankingCardProps) {
    // Current Prediction
    const currentPred = state?.lastPrediction?.prediction

    // Animate dots for "분석중..."
    const [loadingText, setLoadingText] = useState('분석중')

    useEffect(() => {
        let dots = 0
        const interval = setInterval(() => {
            dots = (dots + 1) % 4
            setLoadingText(`분석중${'.'.repeat(dots)}`)
        }, 500)
        return () => clearInterval(interval)
    }, [])

    return (
        <div
            className={`ranking-card ${isTop3 ? 'ranking-card--top3' : ''} ${rank ? `ranking-card--rank-${rank}` : ''}`}
            onClick={onClick}
        >
            {/* Rank Badge */}
            {rank && (
                <div className={`ranking-badge ranking-badge--${rank}`}>
                    {rank}
                </div>
            )}

            {/* Header: Name & Tags */}
            <div className="ranking-card__header">
                <div className="ranking-card__name">{room.koreanName || room.name}</div>
                <div className="ranking-card__tags">
                    {martingaleLevel > 0 && (
                        <span className="algo-badge martin-badge">{martingaleLevel}단계</span>
                    )}
                    {stats.consecutiveWins >= 2 && (
                        <span className="algo-badge streak-badge">
                            <Flame size={11} strokeWidth={2.5} style={{ marginRight: '3px' }} />
                            {stats.consecutiveWins}연승
                        </span>
                    )}
                </div>
            </div>

            {/* Content Row: Prediction & Stats */}
            <div className={`ranking-card__content ${isTop3 ? 'content--top3' : ''}`}>

                {/* 1. Prediction Display (Prominent) */}
                <div className="ranking-card__pred-box">
                    <div className="pred-label">AI 예측</div>
                    {state?.lastPrediction?.isSkip ? (
                        <div className="pred-value pred-value--skip" style={{ border: '1px solid #475569', background: 'rgba(71, 85, 105, 0.1)' }}>
                            <span className="pred-icon"><Ban size={16} color="#94a3b8" /></span>
                            <span className="pred-text" style={{ color: '#94a3b8' }}>패스 (SKIP)</span>
                        </div>
                    ) : currentPred ? (
                        <div className={`pred-value pred-value--${currentPred}`}>
                            <span className="pred-icon">
                                <Circle
                                    size={16}
                                    fill={currentPred === 'B' ? '#ef4444' : currentPred === 'P' ? '#3b82f6' : '#22c55e'}
                                    color={currentPred === 'B' ? '#ef4444' : currentPred === 'P' ? '#3b82f6' : '#22c55e'}
                                />
                            </span>
                            <span className="pred-text">{currentPred === 'B' ? 'BANKER' : currentPred === 'P' ? 'PLAYER' : 'TIE'}</span>
                        </div>
                    ) : (
                        <div className="pred-value pred-value--waiting">
                            <span className="pred-text">{loadingText}</span>
                        </div>
                    )}
                </div>

                {/* 2. Win Rate (Only for Top 3 or High Stats) */}
                <div className="ranking-card__score-box">
                    <div className="score-label">적중률</div>
                    <div className={`score-value ${stats.winRate >= 80 ? 'high' : ''}`}>
                        {state?.stats.total && state.stats.total > 0 ? stats.winRate.toFixed(0) + '%' : '-'}
                    </div>
                </div>

            </div>

            {/* History Row: Prediction Accuracy (O/X) */}
            <div className="ranking-card__history-row">
                <div className="history-group">
                    <div className="history-label">
                        <span>최근 적중</span>
                        <span style={{ fontSize: '0.85em', opacity: 0.7, marginLeft: '6px' }}>({room.history.length}게임)</span>
                    </div>
                    <div className="history-pills">
                        {/* Use prediction history if available, else show empty placeholders */}
                        {state?.history && state.history.length > 0 ? (
                            state.history.slice(0, 6).reverse().map((h, i) => (
                                <div
                                    key={i}
                                    className={`history-item history-item--${h.actual}`} // Class based on ACTUAL winner
                                    title={`${h.result} (Pred: ${h.prediction}, Actual: ${h.actual})`}
                                >
                                    {/* Text based on Result */}
                                    {h.result === 'WIN' && '승'}
                                    {h.result === 'LOSS' && '패'}
                                    {h.result === 'TIE' && '무'}
                                    {h.result === 'SKIP' && <span style={{ fontSize: '0.7em', letterSpacing: '-1px' }}>패스</span>}
                                </div>
                            ))
                        ) : room.history && room.history.length > 0 ? (
                            room.history.slice(-6).reverse().map((h, i) => (
                                <div
                                    key={`raw-${i}`}
                                    className={`history-item history-item--${h.winner}`}
                                    title={`Result: ${h.winner}`}
                                >
                                    {h.winner === 'B' && '뱅'}
                                    {h.winner === 'P' && '플'}
                                    {h.winner === 'T' && '타'}
                                </div>
                            ))
                        ) : (
                            <div className="history-empty-text">기록 없음</div>
                        )}
                    </div>
                </div>

                {/* Link */}
                <div
                    className="ranking-card__link"
                    onClick={(e) => { e.stopPropagation(); onEnter(); }}
                >
                    방 입장 <ChevronRight size={14} />
                </div>
            </div>

        </div>
    )
}
