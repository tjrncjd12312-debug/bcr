// useMultiRoomPrediction Hook - Multi-room prediction state management

import { useState, useEffect, useCallback } from 'react'
import type {
  MultiRoomPredictionState,
  RoomPredictionState,
  PredictionStats,
  Room,
  Prediction,
  Winner,
  GameResultEvent,
  BettingPhaseEvent,
} from '../../domain/entities'
import MultiRoomPredictionService from '../../application/services/MultiRoomPredictionService'

export interface UseMultiRoomPredictionResult {
  // State
  autoMode: boolean
  globalStats: PredictionStats
  roomStates: Map<string, RoomPredictionState>

  // Actions
  setAutoMode: (enabled: boolean) => void
  toggleAutoMode: () => void
  setFocusedRoomId: (roomId: string | null) => void  // 🔥 포커스 모드
  setPredictModeActive: (active: boolean) => void  // 🔥 예측 모드 (autoMode와 별개)
  requestPrediction: (room: Room) => Promise<Prediction | null>
  onGameResult: (event: GameResultEvent, room: Room) => Promise<void>
  onBettingPhase: (event: BettingPhaseEvent, rooms: Map<string, Room>) => Promise<void>
  resetStats: () => void
  clearAllHistories: () => void  // 재연결 시 히스토리만 초기화

  // Subscriptions
  onPrediction: (callback: (roomId: string, prediction: Prediction) => void) => () => void
  onResult: (callback: (roomId: string, winner: Winner, won: boolean) => void) => () => void
}

export function useMultiRoomPrediction(): UseMultiRoomPredictionResult {
  const [state, setState] = useState<MultiRoomPredictionState>(
    MultiRoomPredictionService.getState()
  )

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = MultiRoomPredictionService.onStateChange((newState) => {
      setState(newState)
    })
    return unsubscribe
  }, [])

  const setAutoMode = useCallback((enabled: boolean) => {
    MultiRoomPredictionService.setAutoMode(enabled)
  }, [])

  const toggleAutoMode = useCallback(() => {
    MultiRoomPredictionService.toggleAutoMode()
  }, [])

  const setFocusedRoomId = useCallback((roomId: string | null) => {
    MultiRoomPredictionService.setFocusedRoomId(roomId)
  }, [])

  const setPredictModeActive = useCallback((active: boolean) => {
    MultiRoomPredictionService.setPredictModeActive(active)
  }, [])

  const requestPrediction = useCallback(async (room: Room) => {
    return MultiRoomPredictionService.requestPrediction(room)
  }, [])

  const onGameResult = useCallback(async (event: GameResultEvent, room: Room) => {
    await MultiRoomPredictionService.onGameResult(event, room)
  }, [])

  const onBettingPhase = useCallback(async (event: BettingPhaseEvent, rooms: Map<string, Room>) => {
    await MultiRoomPredictionService.onBettingPhase(event, rooms)
  }, [])

  const resetStats = useCallback(() => {
    MultiRoomPredictionService.resetStats()
  }, [])

  const clearAllHistories = useCallback(() => {
    MultiRoomPredictionService.clearAllHistories()
  }, [])

  const onPrediction = useCallback((callback: (roomId: string, prediction: Prediction) => void) => {
    return MultiRoomPredictionService.onPrediction(callback)
  }, [])

  const onResult = useCallback((callback: (roomId: string, winner: Winner, won: boolean) => void) => {
    return MultiRoomPredictionService.onResult(callback)
  }, [])

  return {
    autoMode: state.autoMode,
    globalStats: state.globalStats,
    roomStates: state.roomStates,
    setAutoMode,
    toggleAutoMode,
    setFocusedRoomId,
    setPredictModeActive,
    requestPrediction,
    onGameResult,
    onBettingPhase,
    resetStats,
    clearAllHistories,
    onPrediction,
    onResult,
  }
}

export default useMultiRoomPrediction
