// SemiAutoPanel - KakaoTalk-style semi-automatic mode panel
// Full screen mode for focused semi-auto operation
// Clean Architecture: Presentation Layer - uses hooks for Application Layer access
//
// ✅ 이벤트 처리 원칙:
// - SemiAutoService가 casinoAdapter 이벤트를 직접 구독 (Single Source of Truth)
// - Panel은 서비스의 상태만 참조하여 UI 렌더링
// - 중복 구독 없음 → race condition 방지

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSemiAuto } from '../../hooks'
import type { Room, RoomFilterType, RoomFilter } from '../../../domain/entities'
import './SemiAutoPanel.css'
import { SemiAutoHeader } from './components/SemiAutoHeader'
import { SemiAutoSidebar } from './components/SemiAutoSidebar'
import { SemiAutoMain } from './components/SemiAutoMain'
import { SemiAutoSettingsDialog } from './components/SemiAutoSettingsDialog'

interface SemiAutoPanelProps {
  rooms: Map<string, Room>
  onEnterRoom: (roomId: string) => Promise<void>
  fullScreen?: boolean
  onSwitchToPredict?: () => void
  // Pattern filter props
  availableFilters?: RoomFilter[]
  selectedPattern?: RoomFilterType | 'all'
  onPatternChange?: (pattern: RoomFilterType | 'all') => void
  onOpenPatternManager?: () => void
  // 🔥 분석 대상 방 ID 목록
  selectedRoomIds?: Set<string>
}

interface HistoryLog {
  id: number
  time: string
  message: string
  type: 'prediction' | 'win' | 'loss' | 'move' | 'info'
}

export default function SemiAutoPanel({
  rooms,
  onEnterRoom,
  fullScreen = false,
  onSwitchToPredict,
  availableFilters = [],
  selectedPattern = 'all',
  onPatternChange,
  onOpenPatternManager,
  selectedRoomIds,
}: SemiAutoPanelProps) {
  const semiAuto = useSemiAuto()
  const {
    enabled,
    settings,
    currentRoom,
    lastPrediction,
    waitingForResult,
    waitingForPrediction,
    isFirstRound,
    displayMartin,
    winCount,
    totalWins,
    totalLosses,
    statusMessage,
    realBalance,
    // Navigation
    isNavigating,
    // Betting timer (서비스에서 관리)
    // Actions
    toggle,
    updateSettings,
    enterRoom,
    updateAvailableRooms,
    setSelectedRoomIds: setServiceSelectedRoomIds,
    // ✅ 이벤트 구독 콜백 (UI 반응용)
    onPrediction,
    onResult,
    onRoomChange,
    onAutoEnterRoom,
    onNavigateRoom,
    resetStats,
    clearPreviousRooms,
    // Sound (abstracted through ISoundPort - Clean Architecture)
    sound,
  } = semiAuto

  // Result overlay state with streak/martin info
  interface ResultOverlayData {
    type: 'win' | 'loss' | 'skip'
    streak?: number  // 2연승 이상일 때만
    martin?: number  // 2마틴 이상일 때만
  }

  const [showSettings, setShowSettings] = useState(false)
  const [notification, setNotification] = useState<{ message: string; type: 'win' | 'loss' | 'info' } | null>(null)
  // ✅ bettingTimer는 서비스에서 관리 (useSemiAuto에서 가져옴)
  const [historyLogs, setHistoryLogs] = useState<HistoryLog[]>([])
  const [animationState, setAnimationState] = useState<'win' | 'loss' | null>(null)
  const [resultOverlay, setResultOverlay] = useState<ResultOverlayData | null>(null)
  const [isNewPrediction, setIsNewPrediction] = useState(false)
  const [isToggling, setIsToggling] = useState(false)  // 버튼 디바운싱
  const roomsRef = useRef(rooms)
  const logIdRef = useRef(0)
  // Timer refs for cleanup (memory leak prevention)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Timer management helper for cleanup
  const safeTimeout = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      callback()
    }, delay)
    timersRef.current.add(timer)
    return timer
  }, [])

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach(timer => clearTimeout(timer))
      timersRef.current.clear()
    }
  }, [])

  // Add history log
  const addHistoryLog = useCallback((message: string, type: HistoryLog['type']) => {
    const now = new Date()
    const time = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setHistoryLogs(prev => [{
      id: ++logIdRef.current,
      time,
      message,
      type
    }, ...prev].slice(0, 50))
  }, [])

  // Keep rooms ref updated and notify SemiAutoService
  useEffect(() => {
    roomsRef.current = rooms
    updateAvailableRooms(rooms)
  }, [rooms, updateAvailableRooms])

  // 🔥 선택된 방 ID 목록 동기화 - SemiAutoService에 전달
  useEffect(() => {
    if (selectedRoomIds) {
      setServiceSelectedRoomIds(selectedRoomIds)
    }
  }, [selectedRoomIds, setServiceSelectedRoomIds])

  // Preload sounds on mount
  useEffect(() => {
    sound.preload()
  }, [sound])

  // ✅ 이벤트 구독 제거됨 - SemiAutoService가 직접 casinoAdapter 이벤트 구독
  // onBettingPhase, onGameResult 구독이 여기서 제거됨
  // 타이머는 서비스에서 bettingTimer 상태로 관리
  // 결과 처리는 서비스에서 직접 처리 후 onResult 콜백으로 UI에 알림

  // Subscribe to prediction events
  // ✅ FIX: info 알림 제거 - 히스토리 로그만 유지 (알림 너무 많음)
  useEffect(() => {
    const unsubscribe = onPrediction((prediction) => {
      if (prediction.isSkip) {
        // Skip mode - don't bet (server returned Tie after 3 consecutive losses)
        // showNotification 제거 - 히스토리만 기록
        addHistoryLog(`패스: ${prediction.reasoning || '연패 회복 중'}`, 'move')
        // Show skip overlay (2 seconds)
        setResultOverlay({ type: 'skip' })
        safeTimeout(() => setResultOverlay(null), 2000)
      } else {
        const pred = prediction.prediction === 'B' ? '뱅커' : prediction.prediction === 'P' ? '플레이어' : '타이'
        // showNotification 제거 - 히스토리만 기록
        addHistoryLog(`예측: ${pred} (${Math.round((prediction.confidence || 0) * 100)}%)`, 'prediction')
        // ✅ 소리는 SemiAutoService에서 처리 (중복 방지)

        // Trigger new prediction animation
        setIsNewPrediction(true)
        safeTimeout(() => setIsNewPrediction(false), 500)
      }
    })
    return unsubscribe
  }, [onPrediction, addHistoryLog, safeTimeout])

  // Subscribe to result events - 서비스에서 전달받은 stats 사용 (stale closure 방지)
  useEffect(() => {
    const unsubscribe = onResult((won, shouldMove, stats) => {
      // 즉시 UI 업데이트 (지연 없이)
      if (won) {
        // stats.winCount는 서비스에서 이미 증가된 현재 값
        const message = shouldMove
          ? `적중! ${stats.winCount}승 → 방 이동`
          : `적중! (${stats.winCount}승)`
        showNotification(message, 'win')
        addHistoryLog(message, 'win')
        // ✅ 소리는 SemiAutoService에서 처리 (중복 방지)
        setAnimationState('win')
        // Show streak only if 2 or more wins
        setResultOverlay({
          type: 'win',
          streak: stats.winCount >= 2 ? stats.winCount : undefined
        })
      } else {
        // stats.martin은 서비스에서 이미 증가된 현재 값
        const message = shouldMove
          ? `실패 (${stats.martin}마틴) → 방 이동`
          : `실패 (${stats.martin}마틴)`
        showNotification(message, 'loss')
        addHistoryLog(message, 'loss')
        setAnimationState('loss')
        // Show martin level only if 1 or more (마틴은 1부터 표시)
        setResultOverlay({
          type: 'loss',
          martin: stats.martin >= 1 ? stats.martin : undefined
        })
      }
      // 애니메이션 타이밍 최적화
      safeTimeout(() => setAnimationState(null), 800)
      safeTimeout(() => setResultOverlay(null), 1500)  // 1.5초로 단축
    })
    return unsubscribe
  }, [onResult, addHistoryLog, sound, safeTimeout])  // ✅ martin, winCount 의존성 제거 (stats로 전달받음)

  // Subscribe to room change recommendations
  // ✅ FIX: showNotification 제거 - 히스토리 로그만 유지
  // ✅ FIX: sound.playMove() 제거 - navigateToRoom()에서 이미 재생됨 (중복 방지)
  useEffect(() => {
    const unsubscribe = onRoomChange((reason) => {
      console.log(`[SemiAutoPanel] Room change triggered: ${reason}`)
      addHistoryLog(`방 이동: ${reason}`, 'move')
      // ❌ REMOVED: sound.playMove() - navigateToRoom()에서 이미 재생됨
    })
    return unsubscribe
  }, [onRoomChange, addHistoryLog])

  // Subscribe to auto room selection
  // ✅ FIX: SemiAutoService.navigateToRoom()가 이미 CDP 네비게이션 처리
  // onEnterRoom 중복 호출 제거 → double navigation 방지
  useEffect(() => {
    const unsubscribe = onAutoEnterRoom((room) => {
      console.log(`[SemiAutoPanel] Auto entering room: ${room.koreanName} (${room.id})`)
      // showNotification 제거 - 히스토리만 기록
      addHistoryLog(`자동 입장: ${room.koreanName}`, 'move')
      // ✅ Sound & log only - CDP navigation already done by SemiAutoService.navigateToRoom()
      // 이전: await onEnterRoom(room.id) → double CDP navigation 발생
    })
    return unsubscribe
  }, [onAutoEnterRoom, addHistoryLog])

  // Subscribe to CDP room navigation
  useEffect(() => {
    const unsubscribe = onNavigateRoom((roomId, roomName, url) => {
      console.log(`[SemiAutoPanel] Navigating to room: ${roomName} (${roomId})`)
      console.log(`[SemiAutoPanel] URL: ${url}`)
      addHistoryLog(`탭 이동: ${roomName}`, 'move')
    })
    return unsubscribe
  }, [onNavigateRoom, addHistoryLog])

  const showNotification = useCallback((message: string, type: 'win' | 'loss' | 'info') => {
    setNotification({ message, type })
    safeTimeout(() => setNotification(null), 2000)
  }, [safeTimeout])

  // Handle room entry from the panel
  const handleEnterRoom = useCallback(async (room: Room) => {
    console.log('[SemiAutoPanel] 🎲 handleEnterRoom triggered:', { id: room.id, name: room.koreanName, provider: room.provider })
    enterRoom(room)
    addHistoryLog(`방 선택: ${room.koreanName}`, 'info')
    if (onEnterRoom) {
      await onEnterRoom(room.id)
    } else {
      console.warn('[SemiAutoPanel] onEnterRoom prop is missing!')
    }
  }, [enterRoom, onEnterRoom, addHistoryLog])

  // Get sorted rooms for quick selection (memoized)
  const sortedRooms = useMemo(() =>
    Array.from(rooms.values())
      .filter(r => r.history.length >= 10)
      .sort((a, b) => b.history.length - a.history.length)
      .slice(0, 8),
    [rooms]
  )

  const winRate = totalWins + totalLosses > 0
    ? Math.round((totalWins / (totalWins + totalLosses)) * 100)
    : 0

  // Compact KakaoTalk-style panel (used as overlay)
  if (!fullScreen) {
    return (
      <div className={`sa-compact ${animationState ? `anim-${animationState}` : ''}`}>
        {/* Notification Toast */}
        {notification && (
          <div className={`sa-notification ${notification.type}`}>
            {notification.message}
          </div>
        )}

        {/* Header */}
        <div className="sa-compact-header">
          <span className="sa-compact-title">반자동 모드</span>
          {enabled && <span className="sa-compact-status active">작동중</span>}

          {/* Sound Toggle */}
          <button
            className={`sa-compact-btn sound-toggle ${settings.soundEnabled ? 'on' : 'off'}`}
            onClick={() => {
              sound.init()
              updateSettings({ soundEnabled: !settings.soundEnabled })
            }}
            title={settings.soundEnabled ? '사운드 끄기' : '사운드 켜기'}
          >
            {settings.soundEnabled ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
              </svg>
            )}
          </button>

          <button className="sa-compact-btn" onClick={() => setShowSettings(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          {onSwitchToPredict && (
            <button className="sa-compact-btn close" onClick={onSwitchToPredict}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Current Room & Status */}
        <div className="sa-compact-room">
          {isNavigating ? (
            <span className="sa-compact-room-name navigating">방 이동 중...</span>
          ) : currentRoom ? (
            <div className="sa-compact-room-name-wrapper" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {currentRoom.provider === 'pragmatic' && (
                <span className="room-card__provider pragmatic" style={{ margin: 0, padding: '1px 5px', fontSize: '10px' }}>P</span>
              )}
              <span className="sa-compact-room-name">{currentRoom.name}</span>
            </div>
          ) : (
            <span className="sa-compact-room-empty">
              {enabled && settings.autoFindRoom ? '방 찾는 중...' : '방 선택 필요'}
            </span>
          )}
          <span className="sa-compact-status-msg">
            {waitingForPrediction ? '예측 요청 중...' : statusMessage}
          </span>
        </div>

        {/* Big Prediction Display */}
        <div className="sa-compact-prediction">
          {waitingForResult ? (
            <div className="sa-compact-pred-waiting">
              <div className={`sa-compact-pred-circle ${lastPrediction?.prediction?.toLowerCase() || ''} ${resultOverlay ? 'has-overlay' : ''}`}>
                {lastPrediction?.prediction || '?'}
                {resultOverlay && (
                  <div className={`sa-compact-result-overlay ${resultOverlay.type}`}>
                    <span className="result-icon">
                      {resultOverlay.type === 'win' ? '✓' : resultOverlay.type === 'loss' ? '✗' : '⏸'}
                    </span>
                    <span className="result-text">
                      {resultOverlay.type === 'win' ? '적중!' : resultOverlay.type === 'loss' ? '실패' : '패스'}
                    </span>
                    {resultOverlay.streak && resultOverlay.streak >= 2 && (
                      <span className="result-sub">{resultOverlay.streak}연승</span>
                    )}
                    {resultOverlay.martin && resultOverlay.martin >= 2 && (
                      <span className="result-sub">{resultOverlay.martin}마틴</span>
                    )}
                    {resultOverlay.type === 'skip' && (
                      <span className="result-sub">회복 중</span>
                    )}
                  </div>
                )}
              </div>
              <span className="sa-compact-pred-label">결과 대기</span>
            </div>
          ) : lastPrediction?.isSkip ? (
            // SKIP/PASS mode (server explicitly returned a skip signal)
            <div className="sa-compact-pred-display">
              <div className={`sa-compact-pred-circle skip ${resultOverlay ? 'has-overlay' : ''}`}>
                ⏭
                {resultOverlay && resultOverlay.type === 'skip' && (
                  <div className={`sa-compact-result-overlay ${resultOverlay.type}`}>
                    <span className="result-icon">⏭</span>
                    <span className="result-text">패스</span>
                    <span className="result-sub">다음 라운드</span>
                  </div>
                )}
              </div>
              <span className="sa-compact-pred-conf">패스</span>
            </div>
          ) : lastPrediction && lastPrediction.prediction ? (
            <div className={`sa-compact-pred-display ${isNewPrediction ? 'anim-pop' : ''}`}>
              <div className={`sa-compact-pred-circle ${lastPrediction.prediction.toLowerCase()} ${resultOverlay ? 'has-overlay' : ''}`}>
                {lastPrediction.prediction}
                {resultOverlay && (
                  <div className={`sa-compact-result-overlay ${resultOverlay.type}`}>
                    <span className="result-icon">
                      {resultOverlay.type === 'win' ? '✓' : resultOverlay.type === 'loss' ? '✗' : '⏸'}
                    </span>
                    <span className="result-text">
                      {resultOverlay.type === 'win' ? '적중!' : resultOverlay.type === 'loss' ? '실패' : '패스'}
                    </span>
                    {resultOverlay.streak && resultOverlay.streak >= 2 && (
                      <span className="result-sub">{resultOverlay.streak}연승</span>
                    )}
                    {resultOverlay.martin && resultOverlay.martin >= 2 && (
                      <span className="result-sub">{resultOverlay.martin}마틴</span>
                    )}
                    {resultOverlay.type === 'skip' && (
                      <span className="result-sub">회복 중</span>
                    )}
                  </div>
                )}
              </div>
              <span className="sa-compact-pred-conf">
                {Math.round((lastPrediction.confidence || 0) * 100)}%
              </span>
            </div>
          ) : isFirstRound && currentRoom ? (
            <div className="sa-compact-pred-first">
              <div className="sa-compact-pred-circle empty">−</div>
              <span className="sa-compact-pred-label">첫 라운드</span>
            </div>
          ) : waitingForPrediction ? (
            <div className="sa-compact-pred-empty">
              <div className="sa-compact-pred-circle empty loading">...</div>
              <span className="sa-compact-pred-label">예측 요청 중</span>
            </div>
          ) : enabled && currentRoom ? (
            <div className="sa-compact-pred-empty">
              <div className="sa-compact-pred-circle empty">−</div>
              <span className="sa-compact-pred-label">다음 라운드 대기</span>
            </div>
          ) : enabled && !currentRoom ? (
            <div className="sa-compact-pred-empty">
              <div className="sa-compact-pred-circle empty">...</div>
              <span className="sa-compact-pred-label">방 탐색 중</span>
            </div>
          ) : (
            <div className="sa-compact-pred-empty">
              <div className="sa-compact-pred-circle empty">−</div>
              <span className="sa-compact-pred-label">대기</span>
            </div>
          )}
        </div>

        {/* Tactical Metadata Cards */}
        <div className="sa-compact-stats-bar">
          <div className="sa-compact-stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.5 3.5 6.5 1 1.5 2 4.5-.5 7-2.5 2.5-6 1.5-7-1.5z" />
            </svg>
            <div className="sa-compact-stat-content">
              <span className="label">마틴</span>
              <span className={`value ${displayMartin >= 3 ? 'danger' : displayMartin > 0 ? 'warning' : ''}`}>
                {displayMartin}단계
              </span>
            </div>
          </div>

          <div className="sa-compact-stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            <div className="sa-compact-stat-content">
              <span className="label">세션</span>
              <span className="value">{totalWins}승 / {totalLosses}패</span>
            </div>
          </div>

          <div className="sa-compact-stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
            <div className="sa-compact-stat-content">
              <span className="label">적중률</span>
              <span className={`value ${winRate >= 50 ? 'success' : ''}`}>{winRate}%</span>
            </div>
          </div>

          <div className="sa-compact-stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
            <div className="sa-compact-stat-content">
              <span className="label">잔액</span>
              <span className="value">{realBalance !== null ? `₩${(realBalance / 10000).toFixed(1)}M` : '---'}</span>
            </div>
          </div>
        </div>

        {/* Real balance (display only) */}
        <div className="sa-compact-balance-info">
          <div className="sa-balance-row">
            <span className="label">실제 잔액</span>
            <span className={`value ${realBalance === null ? 'pending' : ''}`}>
              {realBalance !== null ? `₩${realBalance.toLocaleString()}` : '연결 필요'}
            </span>
          </div>
        </div>

        {/* Toggle Button */}
        <button
          className={`sa-compact-toggle ${enabled ? 'active' : ''}`}
          onClick={async () => {
            if (isToggling) return
            setIsToggling(true)
            // 🔥 Initialize audio on user click - await to ensure it's ready before prediction
            await sound.init()
            toggle()
            safeTimeout(() => setIsToggling(false), 500)  // 500ms 디바운싱
          }}
          disabled={isToggling}
        >
          {enabled ? '정지' : '시작'}
        </button>

        {/* Settings Dialog */}
        <SemiAutoSettingsDialog
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          settings={settings}
          onUpdateSettings={updateSettings}
          rooms={rooms}
          onResetStats={resetStats}
          onClearHistory={clearPreviousRooms}
          totalWins={totalWins}
          totalLosses={totalLosses}
        />

        {/* Quick Room Selection (when not auto finding) */}
        {!currentRoom && sortedRooms.length > 0 && !settings.autoFindRoom && (
          <div className="sa-compact-rooms">
            {sortedRooms.slice(0, 4).map((room) => (
              <button
                key={room.id}
                className="sa-compact-room-btn"
                onClick={() => handleEnterRoom(room)}
              >
                {room.koreanName}
              </button>
            ))}
          </div>
        )}

        {/* History Log - Show more logs */}
        <div className="sa-compact-history">
          {historyLogs.slice(0, 15).map(log => (
            <div key={log.id} className={`sa-compact-log ${log.type}`}>
              <span className="sa-compact-log-time">{log.time}</span>
              <span className="sa-compact-log-msg">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Full screen mode
  return (
    <div className="sa-fullscreen">
      {/* Notification Toast */}
      {notification && (
        <div className={`sa-notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      <SemiAutoHeader
        enabled={enabled}
        soundEnabled={settings.soundEnabled}
        onToggleSettings={() => setShowSettings(!showSettings)}
        onToggleSound={() => {
          sound.init()
          updateSettings({ soundEnabled: !settings.soundEnabled })
        }}
        onSwitchToPredict={onSwitchToPredict}
      />

      <div className="sa-fs-body">
        <SemiAutoMain
          enabled={enabled}
          currentRoom={currentRoom || null}
          waitingForResult={waitingForResult}
          waitingForPrediction={waitingForPrediction}
          lastPrediction={lastPrediction}
          isFirstRound={isFirstRound}
          isToggling={isToggling}
          sortedRooms={sortedRooms}
          autoFindRoom={settings.autoFindRoom ?? false}
          onToggle={async () => {
            setIsToggling(true)
            // 🔥 Initialize audio on user click - await to ensure it's ready before prediction
            await sound.init()
            toggle()
            safeTimeout(() => setIsToggling(false), 500)
          }}
          onEnterRoom={handleEnterRoom}
        />

        <SemiAutoSidebar
          showSettings={showSettings}
          settings={settings}
          martin={displayMartin}
          winCount={winCount}
          totalWins={totalWins}
          totalLosses={totalLosses}
          winRate={winRate}
          historyLogs={historyLogs}
          onUpdateSettings={updateSettings}
          onResetStats={resetStats}
          availableFilters={availableFilters}
          selectedPattern={selectedPattern}
          onPatternChange={onPatternChange}
          onOpenPatternManager={onOpenPatternManager}
        />
      </div>
    </div>
  )
}
