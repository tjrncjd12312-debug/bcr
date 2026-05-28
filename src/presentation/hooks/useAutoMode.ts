// useAutoMode Hook - 오토모드 전용 React Hook
// Clean Architecture: Presentation Layer

import { useState, useEffect, useCallback } from 'react'
import AutoModeService, {
  type AutoModeState,
  type AutoModeSettings,
  type AutoModeBetLogEvent,
  type RoomBettingState,
} from '../../application/services/AutoModeService'
import type { RoomFilterType } from '../../domain/entities'

export interface UseAutoModeResult {
  // State
  enabled: boolean
  settings: AutoModeSettings
  // Stats
  totalWins: number
  totalLosses: number
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
  // Room states
  roomStates: Map<string, RoomBettingState>
  // Status
  statusMessage: string
  lastEventTime: number | null
  startTime: number | null
  startBalance: number
  // tie_frequent 자동 배팅에서 이 슈 동안 이미 적중한 방 ID 목록
  tieAutoCompletedRoomIds: string[]

  // Actions
  toggle: (realBalance?: number) => void
  start: (realBalance?: number) => void
  stop: () => void
  updateSettings: (settings: Partial<AutoModeSettings>) => void
  resetStats: () => void
  toggleRoom: (roomId: string) => void
  isRoomEnabled: (roomId: string) => boolean
  getRoomState: (roomId: string) => RoomBettingState | null
  setActiveBettingRooms: (roomIds: string[], patternFilter?: RoomFilterType | 'all') => void  // 패턴 필터링된 방 목록 설정

  // Subscriptions
  onBetLog: (callback: (event: AutoModeBetLogEvent) => void) => () => void
}

export function useAutoMode(): UseAutoModeResult {
  const [state, setState] = useState<AutoModeState>(AutoModeService.getState())

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = AutoModeService.onStateChange((newState) => {
      setState(newState)
    })
    return unsubscribe
  }, [])

  const toggle = useCallback((realBalance?: number) => {
    AutoModeService.toggle(realBalance)
  }, [])

  const start = useCallback((realBalance?: number) => {
    AutoModeService.start(realBalance)
  }, [])

  const stop = useCallback(() => {
    AutoModeService.stop()
  }, [])

  const updateSettings = useCallback((settings: Partial<AutoModeSettings>) => {
    AutoModeService.updateSettings(settings)
  }, [])

  const resetStats = useCallback(() => {
    AutoModeService.resetStats()
  }, [])

  const toggleRoom = useCallback((roomId: string) => {
    AutoModeService.toggleRoom(roomId)
  }, [])

  const isRoomEnabled = useCallback((roomId: string) => {
    return AutoModeService.isRoomEnabled(roomId)
  }, [])

  const getRoomState = useCallback((roomId: string) => {
    return AutoModeService.getRoomState(roomId)
  }, [])

  const setActiveBettingRooms = useCallback((roomIds: string[], patternFilter?: RoomFilterType | 'all') => {
    AutoModeService.setActiveBettingRooms(roomIds, patternFilter)
  }, [])

  const onBetLog = useCallback((callback: (event: AutoModeBetLogEvent) => void) => {
    return AutoModeService.onBetLog(callback)
  }, [])

  return {
    enabled: state.settings.enabled,
    settings: state.settings,
    totalWins: state.totalWins,
    totalLosses: state.totalLosses,
    totalBetAmount: state.totalBetAmount,
    cumulativeProfit: state.cumulativeProfit,
    maxProfit: state.maxProfit,
    maxLoss: state.maxLoss,
    roomStates: state.roomStates,
    statusMessage: state.statusMessage,
    lastEventTime: state.lastEventTime,
    startTime: state.startTime,
    startBalance: state.startBalance,
    tieAutoCompletedRoomIds: state.tieAutoCompletedRoomIds,
    // Actions
    toggle,
    start,
    stop,
    updateSettings,
    resetStats,
    toggleRoom,
    isRoomEnabled,
    getRoomState,
    setActiveBettingRooms,
    // Subscriptions
    onBetLog,
  }
}

export default useAutoMode
