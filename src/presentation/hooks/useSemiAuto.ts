// useSemiAuto Hook - React hook for semi-automatic mode
// Clean Architecture: Presentation Layer hook that uses Application Layer services

import { useState, useEffect, useCallback } from 'react'
import type { Room, Prediction, BettingPhaseEvent } from '../../domain/entities'
import type { ISoundPort } from '../../domain/interfaces'
import SemiAutoService, { type SemiAutoState, type SemiAutoSettings, type BetLogEvent } from '../../application/services/SemiAutoService'
import { container } from '../../application/di'
import { EvolutionAdapter } from '../../infrastructure/adapters/EvolutionAdapter'

export interface UseSemiAutoResult {
  // State
  enabled: boolean
  settings: SemiAutoSettings
  currentRoom: { id: string; name: string; provider?: 'evolution' | 'pragmatic' } | null
  lastPrediction: Prediction | null
  waitingForResult: boolean
  waitingForPrediction: boolean
  isFirstRound: boolean
  predictionMadeForRound: boolean
  martin: number
  displayMartin: number
  winCount: number
  totalWins: number
  totalLosses: number
  // Virtual Betting Stats
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
  // Status
  statusMessage: string
  // Real balance (display only)
  realBalance: number | null
  // Navigation
  isNavigating: boolean
  // Betting timer (UI용)
  bettingTimer: number
  // ✅ DEBUG: 디버깅용 - ID 매칭 확인
  lastEventRoomId: string | null
  lastEventType: string | null
  roomHistoryLength: number  // 히스토리 길이
  bettingPhaseCount: number  // 베팅 페이즈 수신 카운트
  lastBlockReason: string | null  // 예측 차단 이유

  // Actions
  toggle: () => void
  updateSettings: (settings: Partial<SemiAutoSettings>) => void
  enterRoom: (room: Room) => void
  navigateToRoom: (room: Room) => Promise<void>
  exitRoom: () => void
  updateAvailableRooms: (rooms: Map<string, Room>) => void
  setSelectedRoomIds: (roomIds: Set<string>) => void  // 🔥 분석 대상 방 ID 목록 설정
  autoSelectBestRoom: () => void
  onBettingPhase: (event: BettingPhaseEvent) => Promise<void>
  onGameResult: (roomId: string, winner: 'B' | 'P' | 'T', history: ('B' | 'P' | 'T')[]) => void
  resetStats: () => void
  clearPreviousRooms: () => void

  // Sound (abstracted through ISoundPort)
  sound: {
    init: () => Promise<void>  // Must be called on user interaction
    preload: () => void
    playPrediction: (prediction: 'B' | 'P' | null) => void
    playMove: () => void
    playData: () => void
    playTie: () => void
  }

  // Subscriptions
  onPrediction: (callback: (prediction: Prediction) => void) => () => void
  onResult: (callback: (won: boolean, shouldMove: boolean, stats: { winCount: number; martin: number; totalWins: number; totalLosses: number }) => void) => () => void
  onRoomChange: (callback: (reason: string) => void) => () => void
  onAutoEnterRoom: (callback: (room: Room) => void) => () => void
  onNavigateRoom: (callback: (roomId: string, roomName: string, url: string) => void) => () => void
  onBetLog: (callback: (event: BetLogEvent) => void) => () => void
}

export function useSemiAuto(): UseSemiAutoResult {
  const [state, setState] = useState<SemiAutoState>(SemiAutoService.getState())

  // Get sound port from DI container (lazy)
  const getSoundPort = useCallback((): ISoundPort => {
    return container.get('soundPort')
  }, [])

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = SemiAutoService.onStateChange((newState) => {
      setState(newState)
    })
    return unsubscribe
  }, [])

  // ✅ 게임 결과 이벤트 구독 - SemiAutoService.onGameResult() 자동 호출
  useEffect(() => {
    const unsubscribe = EvolutionAdapter.onGameResult((event) => {
      // 결과 이벤트 수신 시 SemiAutoService에 전달
      const history = event.history?.map(h => h.winner) || []
      console.log(`[useSemiAuto] 📥 Game result: room=${event.roomId}, winner=${event.winner}`)
      SemiAutoService.onGameResult(event.roomId, event.winner, history)
    })
    return unsubscribe
  }, [])

  const toggle = useCallback(() => {
    SemiAutoService.toggle()
  }, [])

  const updateSettings = useCallback((settings: Partial<SemiAutoSettings>) => {
    SemiAutoService.updateSettings(settings)
  }, [])

  const enterRoom = useCallback((room: Room) => {
    SemiAutoService.enterRoom(room)
  }, [])

  const navigateToRoom = useCallback(async (room: Room) => {
    await SemiAutoService.navigateToRoom(room)
  }, [])

  const exitRoom = useCallback(() => {
    SemiAutoService.exitRoom()
  }, [])

  const updateAvailableRooms = useCallback((rooms: Map<string, Room>) => {
    SemiAutoService.updateAvailableRooms(rooms)
  }, [])

  // 🔥 분석 대상 방 ID 목록 설정
  const setSelectedRoomIds = useCallback((roomIds: Set<string>) => {
    SemiAutoService.setSelectedRoomIds(roomIds)
  }, [])

  const autoSelectBestRoom = useCallback(() => {
    SemiAutoService.autoSelectBestRoom()
  }, [])

  const onBettingPhase = useCallback(async (event: BettingPhaseEvent) => {
    await SemiAutoService.onBettingPhase(event)
  }, [])

  const onGameResult = useCallback((roomId: string, winner: 'B' | 'P' | 'T', history: ('B' | 'P' | 'T')[]) => {
    SemiAutoService.onGameResult(roomId, winner, history)
  }, [])

  const resetStats = useCallback(() => {
    SemiAutoService.resetStats()
  }, [])

  const clearPreviousRooms = useCallback(() => {
    SemiAutoService.clearPreviousRooms()
  }, [])

  const onPrediction = useCallback((callback: (prediction: Prediction) => void) => {
    return SemiAutoService.onPrediction(callback)
  }, [])

  const onResult = useCallback((callback: (won: boolean, shouldMove: boolean, stats: { winCount: number; martin: number; totalWins: number; totalLosses: number }) => void) => {
    return SemiAutoService.onResult(callback)
  }, [])

  const onRoomChange = useCallback((callback: (reason: string) => void) => {
    return SemiAutoService.onRoomChange(callback)
  }, [])

  const onAutoEnterRoom = useCallback((callback: (room: Room) => void) => {
    return SemiAutoService.onAutoEnterRoom(callback)
  }, [])

  const onNavigateRoom = useCallback((callback: (roomId: string, roomName: string, url: string) => void) => {
    return SemiAutoService.onNavigateRoom(callback)
  }, [])

  const onBetLog = useCallback((callback: (event: BetLogEvent) => void) => {
    return SemiAutoService.onBetLog(callback)
  }, [])

  // Sound functions (abstracted through ISoundPort)
  const sound = {
    init: useCallback(async () => {
      await getSoundPort().init()
    }, [getSoundPort]),
    preload: useCallback(() => {
      getSoundPort().preload()
    }, [getSoundPort]),
    playPrediction: useCallback((prediction: 'B' | 'P' | null) => {
      getSoundPort().playPrediction(prediction)
    }, [getSoundPort]),
    playMove: useCallback(() => {
      getSoundPort().playMove()
    }, [getSoundPort]),
    playData: useCallback(() => {
      getSoundPort().playData()
    }, [getSoundPort]),
    playTie: useCallback(() => {
      getSoundPort().playTie()
    }, [getSoundPort]),
  }

  return {
    enabled: state.settings.enabled,
    settings: state.settings,
    currentRoom: state.currentRoomId && state.currentRoomName
      ? { id: state.currentRoomId, name: state.currentRoomName, provider: state.currentRoomProvider || undefined }
      : null,
    lastPrediction: state.lastPrediction,
    waitingForResult: state.waitingForResult,
    waitingForPrediction: state.waitingForPrediction,
    isFirstRound: state.isFirstRound,
    predictionMadeForRound: state.predictionMadeForRound,
    martin: state.martin,
    displayMartin: state.displayMartin,
    winCount: state.winCount,
    totalWins: state.totalWins,
    totalLosses: state.totalLosses,
    totalBetAmount: state.totalBetAmount,
    cumulativeProfit: state.cumulativeProfit,
    maxProfit: state.maxProfit,
    maxLoss: state.maxLoss,
    statusMessage: state.statusMessage,
    realBalance: state.realBalance,
    // Navigation
    isNavigating: state.isNavigating,
    // Betting timer
    bettingTimer: state.bettingTimer,
    // ✅ DEBUG: 디버깅용
    lastEventRoomId: state.lastEventRoomId,
    lastEventType: state.lastEventType,
    roomHistoryLength: state.roomHistory.length,
    bettingPhaseCount: state.bettingPhaseCount,
    lastBlockReason: state.lastBlockReason,
    // Actions
    toggle,
    updateSettings,
    enterRoom,
    navigateToRoom,
    exitRoom,
    updateAvailableRooms,
    setSelectedRoomIds,
    autoSelectBestRoom,
    onBettingPhase,
    onGameResult,
    resetStats,
    clearPreviousRooms,
    onPrediction,
    onResult,
    onRoomChange,
    onAutoEnterRoom,
    onNavigateRoom,
    onBetLog,
    // Sound
    sound,
  }
}

export default useSemiAuto
