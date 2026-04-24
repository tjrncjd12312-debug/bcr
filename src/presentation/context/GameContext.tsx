import { ReactNode, useState, useMemo, useEffect, useCallback } from 'react'
import {
  useCasino,
  useMultiRoomPrediction,
  useRoomFilters,
  useVirtualBetting,
  useGameEvents,
  useCustomPatterns,
} from '../hooks'
import type { Room, RoomFilterType, AppMode, RoomSortType, SortDirection } from '../../domain/entities'
import { SORT_OPTIONS } from '../../domain/entities'
import SemiAutoService from '../../application/services/SemiAutoService'
import { GameConfigProvider, useGameConfig, type GameConfigContextType } from './GameConfigContext'
import { GameDataProvider, useGameData, type GameDataContextType } from './GameDataContext'
import RoomFilterService from '../../application/services/RoomFilterService'

// Combined type for backward compatibility
export type GameContextType = GameConfigContextType & GameDataContextType

export function useGame(): GameContextType {
  const config = useGameConfig()
  const data = useGameData()
  return useMemo(() => ({
    ...config,
    ...data
  }), [config, data])
}

interface GameProviderProps {
  children: ReactNode
  user: { username: string; siteUrl: string }
  onLogout: () => void
  appMode: AppMode
}

export function GameProvider({ children, user, appMode }: GameProviderProps) {
  // ==================== Local UI State ====================
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [semiAutoMode, setSemiAutoMode] = useState(false)
  const [realBettingEnabled, setRealBettingEnabled] = useState(false)
  const [sortType, setSortType] = useState<RoomSortType>('games')
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    // localStorage에서 저장된 방향 불러오기
    try {
      const saved = localStorage.getItem('predict-mode:sort-direction')
      if (saved === 'asc' || saved === 'desc') return saved
    } catch { /* ignore */ }
    // 기본값: 현재 정렬 타입의 기본 방향
    const option = SORT_OPTIONS.find(o => o.type === 'games')
    return option?.defaultDirection || 'desc'
  })
  const [selectedPattern, setSelectedPattern] = useState<RoomFilterType | 'all'>('all')

  // ==================== Hooks ====================
  const casino = useCasino(user?.siteUrl, appMode)

  // Wrapper to name consistency
  const virtualBetting = useVirtualBetting()

  const roomFilters = useRoomFilters()

  const customPatterns = useCustomPatterns()

  const multiRoom = useMultiRoomPrediction()

  // Keep RoomFilterService in sync with the latest custom patterns
  useEffect(() => {
    RoomFilterService.setCustomPatterns(customPatterns.patterns)
  }, [customPatterns.patterns])

  // Force-refresh available filters on mount (handles stale localStorage)
  useEffect(() => {
    RoomFilterService.refreshFromCustomPatterns()
  }, [])

  // ✅ Derived selectedRoom from rooms Map (실시간 업데이트)
  const selectedRoom = useMemo(() => {
    if (!selectedRoomId) return null
    return casino.rooms.get(selectedRoomId) || null
  }, [selectedRoomId, casino.rooms])

  // Wrapper for setSelectedRoom (accepts Room object for backward compatibility)
  const selectRoom = useCallback((room: Room | null) => {
    setSelectedRoomId(room?.id || null)
  }, [])

  // Game Events
  const events = useGameEvents({
    rooms: casino.rooms,
    selectedRoom,
    roomStates: multiRoom.roomStates,
    globalStats: multiRoom.globalStats,
    virtualBettingEnabled: virtualBetting.enabled,
    globalBalance: virtualBetting.globalBalance,
    virtualSettings: virtualBetting.settings,
    onMultiRoomBetting: multiRoom.onBettingPhase,
    onMultiRoomResult: multiRoom.onGameResult,
    onBettingPhase: casino.onBettingPhase,
    onCasinoGameResult: casino.onGameResult,
    onPrediction: multiRoom.onPrediction,
    onResult: multiRoom.onResult,
    onBetLog: virtualBetting.onBetLog,
    formatCurrency: virtualBetting.formatCurrency,
    getMartingaleLevelText: (l: number) => `M${l}`,
    showDanger: console.warn
  })

  // Evolution direct room sockets (for fallback/state)
  // Auto-select first room with history when none selected
  useEffect(() => {
    const roomsSource = casino.rooms
    if (!selectedRoomId && roomsSource.size > 0) {
      const firstWithHistory =
        Array.from(roomsSource.values()).find(r => r.history.length > 0) ||
        Array.from(roomsSource.values())[0]
      if (firstWithHistory) {
        setSelectedRoomId(firstWithHistory.id)
      }
    }
  }, [casino.rooms, selectedRoomId])

  // ==================== Effects ====================

  // ✅ Initialize SemiAutoService baseUrl with user.siteUrl as fallback (Windows 브라우저 열기 버그 수정)
  // CDP가 evolutionBaseUrl을 캡처하기 전에도 반자동 모드가 작동하도록 함
  useEffect(() => {
    if (user?.siteUrl) {
      SemiAutoService.updateSettings({ baseUrl: user.siteUrl })
    }
  }, [user?.siteUrl])

  // Update SemiAutoService with evolutionBaseUrl when captured (더 정확한 URL)
  useEffect(() => {
    if (casino.evolutionBaseUrl) {
      SemiAutoService.updateSettings({ baseUrl: casino.evolutionBaseUrl })
    }
  }, [casino.evolutionBaseUrl])

  // ✅ Window Mode 제어는 PredictModePanel에서만 처리 (충돌 방지)
  // semiAutoMode 상태는 유지하되, 창 크기 제어는 제거

  // ==================== Derived Data ====================
  const patternCounts = useMemo(() => {
    const roomsSource = casino.rooms
    const counts: Record<string, number> = { all: roomsSource.size }
    roomFilters.availableFilters.forEach(f => counts[f.type] = 0)

    roomsSource.forEach(room => {
      const state = multiRoom.roomStates.get(room.id) || null
      roomFilters.availableFilters.forEach(f => {
        if (roomFilters.matchesFilter(room, state, f.type)) {
          counts[f.type]++
        }
      })
    })
    return counts
  }, [casino.rooms, roomFilters.availableFilters, multiRoom.roomStates, roomFilters.matchesFilter])


  // ==================== Context Values ====================

  const configValue: GameConfigContextType = useMemo(() => ({
    user,
    appMode,
    // Real Betting Config
    realBettingEnabled,
    toggleRealBetting: () => setRealBettingEnabled(prev => !prev),

    // Virtual Betting Config
    virtualBettingEnabled: virtualBetting.enabled,
    toggleVirtualBetting: virtualBetting.toggle,
    virtualSettings: virtualBetting.settings,
    updateVirtualSettings: virtualBetting.updateSettings,
    resetVirtualBetting: virtualBetting.reset,

    // Stats Control
    clearLogs: events.clearLogs,
    resetStats: multiRoom.resetStats,

    // UI Control
    semiAutoMode,
    toggleSemiAuto: () => setSemiAutoMode(prev => !prev),
    sortType,
    setSortType,
    sortDirection,
    toggleSortDirection: () => {
      setSortDirection(prev => {
        const newDir = prev === 'asc' ? 'desc' : 'asc'
        try {
          localStorage.setItem('predict-mode:sort-direction', newDir)
        } catch { /* ignore */ }
        return newDir
      })
    },

    // Filters
    availableFilters: roomFilters.availableFilters,
    activeFilters: roomFilters.activeFilters,
    toggleFilter: roomFilters.toggleFilter,
    clearFilters: roomFilters.clearFilters,
    selectedPattern,
    setPattern: setSelectedPattern,
    customPatterns: customPatterns.patterns,
    matchesFilter: roomFilters.matchesFilter,
    patternManager: {
      add: customPatterns.addPattern,
      update: customPatterns.updatePattern,
      remove: customPatterns.removePattern,
      toggle: customPatterns.togglePattern
    },

    formatCurrency: virtualBetting.formatCurrency
  }), [
    user, appMode, realBettingEnabled, virtualBetting.enabled, virtualBetting.settings,
    semiAutoMode, sortType, sortDirection, selectedPattern, customPatterns.patterns,
    // Functions that are stable or wrapped in useMemo/useCallback inside hooks
    virtualBetting.toggle, virtualBetting.updateSettings, virtualBetting.reset,
    events.clearLogs, multiRoom.resetStats, roomFilters.availableFilters,
    roomFilters.activeFilters, roomFilters.toggleFilter, roomFilters.clearFilters,
    roomFilters.matchesFilter, customPatterns.addPattern, customPatterns.updatePattern,
    customPatterns.removePattern, customPatterns.togglePattern, virtualBetting.formatCurrency
  ])

  const dataValue: GameDataContextType = useMemo(() => ({
    // Casino
    status: casino.status,
    provider: casino.provider,
    rooms: casino.rooms,
    roomDataVersion: casino.roomDataVersion,
    roomsReady: casino.roomsReady,
    selectedRoom,
    shoeChanges: casino.shoeChanges,
    realBalance: casino.realBalance,
    casinoUrl: casino.casinoUrl,
    evolutionBaseUrl: casino.evolutionBaseUrl,
    messageCount: casino.messageCount,
    openCasino: casino.openCasino,
    reconnectLobby: casino.reconnectLobby,
    selectRoom,
    enterRoom: casino.enterRoom,

    // Prediction
    roomStates: multiRoom.roomStates,
    flashingRooms: events.flashingRooms,
    lastResults: events.lastResults,
    roomTimers: events.roomTimers,
    bettingTimer: events.bettingTimer,
    resultOverlay: events.resultOverlay,
    gameResultVersion: events.gameResultVersion,

    // Real Betting
    placeBet: casino.placeBet,

    // Virtual Betting Data
    globalBalance: virtualBetting.globalBalance,
    virtualBetStates: virtualBetting.roomStates,
    totalNetProfit: virtualBetting.totalNetProfit,
    totalBetAmount: virtualBetting.totalBetAmount,
    totalBetCount: virtualBetting.totalBetCount,
    pendingBetAmount: virtualBetting.pendingBetAmount,
    pendingBetCount: virtualBetting.pendingBetCount,

    // Stats
    globalStats: multiRoom.globalStats,
    logs: events.logs,
    chartData: events.chartData,

    // Derived
    patternCounts,
  }), [
    casino.status, casino.provider, casino.rooms, casino.roomDataVersion, casino.roomsReady, selectedRoom, casino.shoeChanges,
    casino.realBalance, casino.casinoUrl, casino.evolutionBaseUrl, casino.messageCount, multiRoom.roomStates, events.flashingRooms,
    events.lastResults, events.roomTimers, events.bettingTimer, events.resultOverlay, events.gameResultVersion,
    virtualBetting.globalBalance, virtualBetting.roomStates, virtualBetting.totalNetProfit,
    virtualBetting.totalBetAmount, virtualBetting.totalBetCount,
    virtualBetting.pendingBetAmount, virtualBetting.pendingBetCount,
    multiRoom.globalStats, events.logs, events.chartData, patternCounts,
    // Stable functions
    casino.openCasino, casino.reconnectLobby, casino.enterRoom, casino.placeBet
  ])

  return (
    <GameConfigProvider value={configValue}>
      <GameDataProvider value={dataValue}>
        {children}
      </GameDataProvider>
    </GameConfigProvider>
  )
}
