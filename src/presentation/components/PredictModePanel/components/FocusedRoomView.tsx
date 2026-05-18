import { memo, useState, useEffect, useCallback, useRef, type RefObject } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { BeadPlate } from '../../MainScreen/components/BeadPlate'
import { BigRoad } from '../../MainScreen/components/BigRoad'
import ThreeRowOXGrid from '../ThreeRowOXGrid'
import { Top3Rankings } from '../Top3Rankings'
import StrategyAnalysisView from '../StrategyAnalysisView'
import ShoeResetOverlay, { MIN_HISTORY_FOR_PREDICTION } from './ShoeResetOverlay'
import { SoundManager } from '../../../../infrastructure/utils/SoundManager'
import { useRoadView } from '../hooks/useRoadView'
import './FocusedRoomView.css'

const SOUND_ENABLED_KEY = 'predict-mode:sound-enabled'
const STRATEGY_VIEW_KEY = 'predict-mode:strategy-view'

interface FocusedRoomViewProps {
  room: Room
  state: RoomPredictionState | null
  lastResult?: boolean
  statusInfo: { label: string; connected: boolean }
  isOnline: boolean
  roomTimer?: number
  martingaleLevel?: number
  onBackToLobby: () => void
  onBackToPrevious?: () => void
  hasPreviousRoom?: boolean
  roomStates: Map<string, RoomPredictionState>
  rooms: Map<string, Room>
  onSelectRoom: (roomId: string) => void
}

export const FocusedRoomView = memo(function FocusedRoomView({ room, state, lastResult, statusInfo, isOnline, roomTimer, martingaleLevel, onBackToLobby, onBackToPrevious, hasPreviousRoom, roomStates, rooms, onSelectRoom }: FocusedRoomViewProps) {
  // 🎯 TOP3 미리보기 상태
  const [previewRoomId, setPreviewRoomId] = useState<string | null>(null)

  useEffect(() => {
    setPreviewRoomId(null)
  }, [room.id])

  useEffect(() => {
    if (previewRoomId && !rooms.has(previewRoomId)) {
      setPreviewRoomId(null)
    }
  }, [previewRoomId, rooms])

  const displayRoom = previewRoomId ? rooms.get(previewRoomId) || room : room
  const displayState = previewRoomId ? roomStates.get(previewRoomId) || null : state

  const prediction = displayState?.lastPrediction?.prediction
  const rawConfidence = displayState?.lastPrediction?.confidence || 0
  const normalizedConfidence = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence
  const confidenceRatio = Math.min(Math.max(normalizedConfidence, 0), 1)
  const confidencePercent = Math.round(confidenceRatio * 100)
  const timerSeconds = typeof roomTimer === 'number' && roomTimer > 0 ? roomTimer : displayRoom.remainingSeconds

  // 🎯 Prediction animation state
  const [predictionKey, setPredictionKey] = useState(0)
  const [isNewPrediction, setIsNewPrediction] = useState(false)
  const prevPredForAnimRef = useRef<string | null | undefined>(null)

  // 🔊 Sound Control
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(SOUND_ENABLED_KEY)
      return saved !== null ? saved === 'true' : true
    } catch {
      return true
    }
  })
  const prevPredictionRef = useRef<string | null | undefined>(null)
  const prevLastResultRef = useRef<boolean | undefined>(undefined)
  const soundInitializedRef = useRef(false)

  // 🔊 FocusedRoomView 마운트 시 사운드 초기화 보장
  useEffect(() => {
    if (!soundEnabled) return

    SoundManager.preload()

    const initSoundOnFirstInteraction = async () => {
      if (!soundInitializedRef.current) {
        await SoundManager.init()
        soundInitializedRef.current = true
      }
    }

    document.addEventListener('click', initSoundOnFirstInteraction, { once: true })
    document.addEventListener('touchstart', initSoundOnFirstInteraction, { once: true })
    document.addEventListener('keydown', initSoundOnFirstInteraction, { once: true })

    return () => {
      document.removeEventListener('click', initSoundOnFirstInteraction)
      document.removeEventListener('touchstart', initSoundOnFirstInteraction)
      document.removeEventListener('keydown', initSoundOnFirstInteraction)
    }
  }, [soundEnabled])

  const [showStrategy, setShowStrategy] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STRATEGY_VIEW_KEY)
      return saved === 'true'
    } catch {
      return false
    }
  })

  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => {
      const newValue = !prev
      try {
        localStorage.setItem(SOUND_ENABLED_KEY, String(newValue))
      } catch { /* ignore */ }
      return newValue
    })
  }, [])

  const toggleStrategyView = useCallback((show: boolean) => {
    setShowStrategy(show)
    try {
      localStorage.setItem(STRATEGY_VIEW_KEY, String(show))
    } catch { /* ignore */ }
  }, [])

  const initSound = useCallback(() => {
    if (!soundInitializedRef.current) {
      SoundManager.init()
      SoundManager.preload()
      soundInitializedRef.current = true
    }
  }, [])

  // 예측 변경 시 사운드 재생
  useEffect(() => {
    if (!soundEnabled) return

    const currentPred = prediction
    const prevPred = prevPredictionRef.current

    if (currentPred !== prevPred && (currentPred === 'B' || currentPred === 'P')) {
      SoundManager.playPrediction(currentPred)
    }

    prevPredictionRef.current = currentPred
  }, [prediction, soundEnabled])

  // 🎯 새 예측 나타남 애니메이션
  useEffect(() => {
    const wasShowingResult = prevLastResultRef.current !== undefined
    const isShowingResult = lastResult !== undefined
    const prevPred = prevPredForAnimRef.current
    const currentPred = prediction

    if (wasShowingResult && !isShowingResult && currentPred && currentPred !== prevPred) {
      setIsNewPrediction(true)
      setPredictionKey(k => k + 1)
      const timer = setTimeout(() => setIsNewPrediction(false), 600)
      return () => clearTimeout(timer)
    }

    if (!isShowingResult && currentPred && currentPred !== prevPred && prevPred !== null) {
      setIsNewPrediction(true)
      setPredictionKey(k => k + 1)
      const timer = setTimeout(() => setIsNewPrediction(false), 600)
      return () => clearTimeout(timer)
    }

    prevLastResultRef.current = lastResult
    prevPredForAnimRef.current = currentPred
  }, [lastResult, prediction])

  const road = useRoadView({
    room: displayRoom,
    state: displayState,
    lastResult: previewRoomId ? undefined : lastResult,
    beadCols: 16,
  })

  return (
    <div className={`focused-room-v2 ${prediction ? `predict-${prediction.toLowerCase()}` : ''}`}>
      {/* Ambient Background */}
      <div className="focused-room-v2__ambient" />

      {/* Compact Header Bar */}
      <header className="focused-room-v2__header">
        <div className="focused-room-v2__nav-buttons">
          <button className="focused-room-v2__back" onClick={onBackToLobby}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span>로비</span>
          </button>
          {hasPreviousRoom && onBackToPrevious && (
            <button className="focused-room-v2__back focused-room-v2__back--prev" onClick={onBackToPrevious}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              <span>이전 방</span>
            </button>
          )}
        </div>

        <div className="focused-room-v2__room-info">
          {displayRoom.provider === 'pragmatic' && (
            <span className="focused-room-v2__provider">PRAGMATIC</span>
          )}
          <h1 className="focused-room-v2__room-name">
            {previewRoomId && (
              <span className="preview-info">
                <span className="preview-badge">미리보기</span>
                <button
                  className="preview-enter-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectRoom(previewRoomId)
                    setPreviewRoomId(null)
                  }}
                >
                  입장
                </button>
              </span>
            )}
            {displayRoom.koreanName || displayRoom.name}
          </h1>
        </div>

        <div className="focused-room-v2__header-status">
          <div className={`focused-room-v2__connection ${statusInfo.connected ? 'active' : ''}`}>
            <span className="status-dot" />
            <span>{statusInfo.connected ? '연결됨' : '대기'}</span>
          </div>
          {typeof timerSeconds === 'number' && timerSeconds > 0 && (
            <div className="focused-room-v2__timer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
              </svg>
              <span>{timerSeconds}s</span>
            </div>
          )}
          {/* 🔊 Sound Toggle Button */}
          <button
            className={`focused-room-v2__sound-toggle ${soundEnabled ? 'on' : 'off'}`}
            onClick={() => {
              initSound()
              toggleSound()
            }}
            title={soundEnabled ? '사운드 끄기' : '사운드 켜기'}
          >
            {soundEnabled ? (
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
          {/* 📊 Strategy View Toggle */}
          <div className="focused-room-v2__view-toggle">
            <button
              className={!showStrategy ? 'active' : ''}
              onClick={() => toggleStrategyView(false)}
              title="기본 뷰"
            >
              기본
            </button>
            <button
              className={showStrategy ? 'active' : ''}
              onClick={() => toggleStrategyView(true)}
              title="전략분석 뷰"
            >
              전략
            </button>
          </div>
        </div>
      </header>

      {/* TOP3 Rankings */}
      <div className="focused-room-v2__top3">
        <Top3Rankings
          roomStates={roomStates}
          rooms={rooms}
          onRoomClick={(roomId) => {
            if (roomId !== room.id) {
              setPreviewRoomId(prev => prev === roomId ? null : roomId)
            }
          }}
          onEnterRoom={(roomId) => {
            onSelectRoom(roomId)
            setPreviewRoomId(null)
          }}
          selectedRoomId={previewRoomId}
          minPredictions={1}
          compact={true}
        />
      </div>

      {/* 전략분석 모드일 때: 전체 화면이 전략분석으로 교체 */}
      {showStrategy ? (
        <main className="focused-room-v2__strategy-full">
          <StrategyAnalysisView
            state={displayState}
            viewMode="triple"
            nextPrediction={prediction as 'B' | 'P' | null}
            gameHistory={displayRoom.history}
          />
        </main>
      ) : (
        <main className="focused-room-v2__main focused-room-v2__main--compact">
          {/* Compact AI Prediction Bar */}
          <div className="focused-room-v2__prediction-bar">
            <div className="prediction-bar__left">
              <span className="prediction-bar__label">
                <span className="live-pulse" />
                AI 예측
              </span>
            </div>

            <div className="prediction-bar__center">
              {!previewRoomId && lastResult !== undefined ? (
                <div className={`prediction-bar__result ${lastResult ? 'win' : 'loss'}`}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    {lastResult ? <path d="M20 6L9 17l-5-5" /> : <path d="M18 6L6 18M6 6l12 12" />}
                  </svg>
                  <span>{lastResult ? '적중!' : '미적중'}</span>
                </div>
              ) : prediction || displayState?.lastPrediction?.isSkip ? (
                <div className={`prediction-bar__prediction ${isNewPrediction ? 'new-prediction' : ''}`} key={predictionKey}>
                  <span className={`prediction-bar__value ${prediction?.toLowerCase() || 'pass'}`}>
                    {displayState?.lastPrediction?.isSkip ? '패스' : prediction}
                  </span>
                  <div className="prediction-bar__confidence">
                    <span className="confidence-percent">{confidencePercent}%</span>
                    <span className="confidence-label">신뢰도</span>
                  </div>
                </div>
              ) : (
                <div className="prediction-bar__analyzing">
                  <span className="analyzing-dot" />
                  분석 중...
                </div>
              )}
            </div>

            <div className="prediction-bar__right">
              {road.currentStreak.winner && road.currentStreak.count > 1 && (
                <span className={`quick-pill streak ${road.currentStreak.winner.toLowerCase()}`}>
                  {road.currentStreak.winner === 'B' ? '뱅커' : '플레이어'} {road.currentStreak.count}연속
                </span>
              )}
              {martingaleLevel !== undefined && martingaleLevel > 0 && (
                <span className={`quick-pill martin ${martingaleLevel >= 3 ? 'danger' : ''}`}>
                  마틴 {martingaleLevel}단계
                </span>
              )}
              {road.patternLabel && (
                <span className="quick-pill pattern">{road.patternLabel}</span>
              )}
              {displayState && displayState.stats.total > 0 && (
                <span className={`quick-pill winrate ${displayState.stats.winRate >= 50 ? 'positive' : 'negative'}`}>
                  적중률 {displayState.stats.winRate.toFixed(0)}%
                </span>
              )}
            </div>
          </div>

          {/* Expanded Bead Plate Area */}
          <div className="focused-room-v2__bead-area">
            {/* Header with view toggle */}
            <div className="bead-area__header">
              <div className="bead-area__title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
                </svg>
                <span>비드 플레이트</span>
                <span className="history-count">{displayRoom.history.length}게임</span>
              </div>
              <div className="bead-area__toggle">
                <button
                  className={road.roadView === 'six' || road.roadView === 'three' ? 'active' : ''}
                  onClick={() => road.toggleRoadView('six')}
                >
                  6매
                </button>
                <button
                  className={road.roadView === 'one' ? 'active' : ''}
                  onClick={() => road.toggleRoadView('one')}
                >
                  원매
                </button>
              </div>
            </div>

            {/* 3매 (primary) + 6매/원매 (secondary) */}
            <div className="bead-area__main" ref={road.historyPlateRef as RefObject<HTMLDivElement>}>
              {/* 3매 O/X 그리드 - 항상 위(primary) */}
              <div className="bead-area__primary">
                <div className="primary-label">
                  <span>3매 O/X</span>
                  <span className="history-count">{displayState?.history?.length || 0}건</span>
                </div>
                <ThreeRowOXGrid
                  state={displayState}
                  nextPrediction={displayState?.lastPrediction?.prediction as 'B' | 'P' | 'SKIP' | null}
                />
              </div>

              {/* 6매 또는 원매 - 아래(secondary) */}
              <div className="bead-area__secondary" style={{ position: 'relative' }}>
                {(displayRoom.history.length < MIN_HISTORY_FOR_PREDICTION || displayState?.isShoeReset) && (
                  <ShoeResetOverlay historyLength={displayRoom.history.length} />
                )}
                <div className="secondary-label">
                  <span>{road.isOneRow ? '원매 (빅로드)' : '6매 비드'}</span>
                  <span className="history-count">{displayRoom.history.length}게임</span>
                </div>
                {road.isOneRow ? (
                  <BigRoad
                    history={road.bigRoadHistory}
                    predictionMap={road.predictionMap}
                    rows={road.beadRows}
                    cols={road.bigRoadCols}
                    gap={2}
                    minSize={18}
                    maxSize={28}
                    className="big-road--compact"
                  />
                ) : (
                  <BeadPlate
                    history={road.beadHistory}
                    predictionMap={road.predictionMap}
                    rows={road.beadRows}
                    cols={16}
                    gap={1}
                    minSize={13}
                    maxSize={20}
                  />
                )}
              </div>
            </div>

            {/* Compact Stats Bar */}
            <div className="bead-area__stats">
              <div className="stat-item banker">
                <span className="stat-label">B</span>
                <span className="stat-value">{road.stats.bankerCount}</span>
                <span className="stat-percent">{road.stats.bPercent.toFixed(0)}%</span>
              </div>
              <div className="stat-item player">
                <span className="stat-label">P</span>
                <span className="stat-value">{road.stats.playerCount}</span>
                <span className="stat-percent">{road.stats.pPercent.toFixed(0)}%</span>
              </div>
              <div className="stat-item tie">
                <span className="stat-label">T</span>
                <span className="stat-value">{road.stats.tieCount}</span>
              </div>
              <div className="stat-divider" />
              <div className="stat-item total">
                <span className="stat-label">총</span>
                <span className="stat-value">{road.stats.totalGames}</span>
              </div>
              {!isOnline && (
                <span className="offline-badge">
                  <span className="offline-dot" />
                  오프라인
                </span>
              )}
            </div>
          </div>
        </main>
      )}
    </div>
  )
})
