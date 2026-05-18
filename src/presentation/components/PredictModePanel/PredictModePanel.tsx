// PredictModePanel - Redesigned for Better UX
// Focus: Room browsing + Clear prediction display
// Clean Architecture: Presentation Layer

import { useMemo, useCallback, useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useGame } from '../../context/GameContext'
import { useError } from '../../context'
import { useWindowControl, useMultiRoomPrediction, useAutoMode } from '../../hooks'
import type { Room, RoomPredictionState, RoomFilterType } from '../../../domain/entities'
import { SORT_OPTIONS } from '../../../domain/entities'
import PatternManagerModal from '../MainScreen/components/PatternManagerModal'
import SemiAutoPanel from '../SemiAutoPanel/SemiAutoPanel'
import { RoomSelectorModal } from '../shared'
import { Top3Rankings } from './Top3Rankings'
import RankingView from './RankingView/RankingView'
import PredictLobbyView from './LobbyView/PredictLobbyView'
import { RoomCard } from './components/RoomCard'
import { SelectedRoomDetail } from './components/SelectedRoomDetail'
import { FocusedRoomView } from './components/FocusedRoomView'
import { CompactRoomRow } from './components/CompactRoomRow'
import PatternBetDirectionSelect from '../AutoModePanel/components/PatternBetDirectionSelect'
import PatternBetStrategySelect from '../AutoModePanel/components/PatternBetStrategySelect'
import FilterThresholdInline from '../AutoModePanel/components/FilterThresholdInline'
import './PredictModePanel.css'

// LocalStorage key for selected rooms
const SELECTED_ROOMS_KEY = 'predict-mode:selected-rooms'

// LocalStorage key for view mode
const VIEW_MODE_KEY = 'predict-mode:view-mode'

interface PredictModePanelProps {
  onLogout: () => void
  sessionWarning?: string
  isOnline: boolean
}

export default function PredictModePanel({ onLogout, sessionWarning, isOnline }: PredictModePanelProps) {
  const {
    user,
    status,
    rooms,
    roomsReady,  // 방 데이터 수신 완료 여부
    selectedRoom,
    selectRoom,
    openCasino,
    reconnectLobby,
    evolutionBaseUrl,
    roomStates,
    globalStats,
    flashingRooms,
    customPatterns,
    patternManager,
    lastResults,
    roomTimers,
    shoeChanges,
    virtualBetStates,
    sortType,
    setSortType,
    sortDirection,
    toggleSortDirection,
    // Global Multi-Filters
    activeFilters,
    toggleFilter,
    clearFilters,
    availableFilters,
    matchesFilter,
  } = useGame()

  // AutoMode 상태 (martinLevel 표시를 위해)
  const { roomStates: autoModeRoomStates } = useAutoMode()

  // 방별 마틴레벨 가져오기 (VirtualBetting + AutoMode 둘 다 확인)
  const getMartinLevel = useCallback((roomId: string): number | undefined => {
    // 1. VirtualBettingService의 martingaleLevel 확인
    const virtualLevel = virtualBetStates.get(roomId)?.martingaleLevel
    if (virtualLevel !== undefined && virtualLevel > 0) return virtualLevel

    // 2. AutoModeService의 martinLevel 확인
    const autoModeLevel = autoModeRoomStates.get(roomId)?.martinLevel
    if (autoModeLevel !== undefined && autoModeLevel > 0) return autoModeLevel

    return undefined
  }, [virtualBetStates, autoModeRoomStates])

  // Toast notifications (replaces window.alert popups)
  const { showSuccess, showInfo } = useError()

  const [showFilterDropdown, setShowFilterDropdown] = useState(false)
  const [showPatternModal, setShowPatternModal] = useState(false)
  const [showSemiAutoPanel, setShowSemiAutoPanel] = useState(false)
  const [showRoomSelector, setShowRoomSelector] = useState(false)
  const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null)
  const [roomHistory, setRoomHistory] = useState<string[]>([])  // 방 이동 히스토리 (이전 방으로 돌아가기용)
  const [viewMode, setViewMode] = useState<'grid' | 'compact' | 'ranking' | 'lobby'>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY)
      if (saved && ['grid', 'compact', 'ranking', 'lobby'].includes(saved)) {
        return saved as 'grid' | 'compact' | 'ranking' | 'lobby'
      }
    } catch (e) {
    }
    return 'ranking'
  })
  const [alerts, setAlerts] = useState<Array<{ id: string, message: string, type: 'hot' | 'win' | 'risk' }>>([])

  // viewMode 변경 시 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode)
    } catch (e) {
    }
  }, [viewMode])

  // 선택된 방 ID 목록 (localStorage에 저장)
  const [selectedRoomIds, setSelectedRoomIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(SELECTED_ROOMS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        return new Set(Array.isArray(parsed) ? parsed : [])
      }
    } catch (e) {
    }
    return new Set()
  })

  // 선택된 방 변경 시 localStorage에 저장


  const handleRoomSelectionChange = useCallback((newSelection: Set<string>) => {
    setSelectedRoomIds(newSelection)
    try {
      localStorage.setItem(SELECTED_ROOMS_KEY, JSON.stringify(Array.from(newSelection)))
    } catch (e) {
    }
  }, [])

  // ✅ Alert Helper
  const addAlert = useCallback((message: string, type: 'hot' | 'win' | 'risk') => {
    const id = Math.random().toString(36).substring(2, 9)
    setAlerts(prev => [{ id, message, type }, ...prev].slice(0, 3)) // Keep last 3
    setTimeout(() => {
      setAlerts(prev => prev.filter(a => a.id !== id))
    }, 4000)
  }, [])

  // ✅ 예측 요청용 훅
  const { requestPrediction, setFocusedRoomId: setMultiRoomFocusedId, setPredictModeActive } = useMultiRoomPrediction()

  // 🔥 예측 모드: 패널 마운트 시 predictModeActive 활성화 (모든 방에 대해 예측 요청)
  // autoMode와 별개로 동작 - 실제 배팅 로직(AutoModeService)에 영향 없음
  useEffect(() => {
    setPredictModeActive(true)
    return () => {
      setPredictModeActive(false)
    }
  }, [setPredictModeActive])

  // 🔥 포커스 모드 동기화: focusedRoomId가 변경되면 MultiRoomPredictionService에 알림
  useEffect(() => {
    setMultiRoomFocusedId(focusedRoomId)
  }, [focusedRoomId, setMultiRoomFocusedId])

  // Session stats - globalStats 직접 사용 (로컬 상태 버그 수정됨)

  // Helper to determine if a room is "Hot"
  const isRoomHot = useCallback((room: Room) => {
    const s = roomStates.get(room.id)
    if (!s) return false

    const winRate = s.stats.total >= 5 ? s.stats.winRate : 0
    const consecutiveWins = s.stats.consecutiveWins || 0

    // Hot condition: 90%+ win rate (min 5 games) OR 5+ win streak
    return winRate >= 90 || consecutiveWins >= 5
  }, [roomStates])

  // Window size control
  const { setSemiAutoMode, setNormalMode, setFocusedMode } = useWindowControl()

  // 이전 모드 상태 추적 - 모드 전환 시에만 창 크기 변경, 방 이동 시에는 유지
  const prevFocusedRef = useRef<boolean>(false)
  const prevSemiAutoRef = useRef<boolean>(false)

  // Handle window size when switching between MODES (not rooms)
  useEffect(() => {
    const wasFocused = prevFocusedRef.current
    const isFocused = !!focusedRoomId
    const wasSemiAuto = prevSemiAutoRef.current
    const isSemiAuto = showSemiAutoPanel

    // 세미오토 모드로 진입
    if (!wasSemiAuto && isSemiAuto) {
      setSemiAutoMode()
    }
    // 세미오토 → 다른 모드로 전환
    else if (wasSemiAuto && !isSemiAuto) {
      if (isFocused) {
        setFocusedMode()
      } else {
        setNormalMode()
      }
    }
    // 로비 → 포커스 모드 전환 (방 최초 입장)
    else if (!wasFocused && isFocused && !isSemiAuto) {
      setFocusedMode()
    }
    // 포커스 → 로비 모드 전환 (방 나가기)
    else if (wasFocused && !isFocused && !isSemiAuto) {
      setNormalMode()
    }
    // 방 → 방 이동: 창 크기 유지 (아무것도 안함)

    prevFocusedRef.current = isFocused
    prevSemiAutoRef.current = isSemiAuto
  }, [showSemiAutoPanel, focusedRoomId, setSemiAutoMode, setNormalMode, setFocusedMode])



  // 선택된 방 기준 패턴 카운트 계산
  const selectedRoomPatternCounts = useMemo(() => {
    const allRooms = Array.from(rooms.values()).filter(room => {
      const name = (room.koreanName || room.name || '').toLowerCase()
      if (name.includes('살롱') || name.includes('salon')) return false
      if (name.includes('라이트닝') || name.includes('lightning')) return false
      if (!name.includes('바카라') && !name.includes('baccarat')) return false
      return true
    })

    // 선택된 방이 없으면 전체 방 기준
    const targetRooms = selectedRoomIds.size === 0
      ? allRooms
      : allRooms.filter(room => selectedRoomIds.has(room.id))

    const counts: Record<string, number> = { all: targetRooms.length }

    availableFilters.forEach(filter => {
      let count = 0
      targetRooms.forEach(room => {
        const state = roomStates.get(room.id) || null
        if (matchesFilter(room, state, filter.type)) count++
      })
      counts[filter.type] = count
    })

    return counts
  }, [rooms, selectedRoomIds, roomStates, availableFilters, matchesFilter])

  // Filter rooms based on selected pattern
  // Exclude: 살롱(Salon), 라이트닝(Lightning) - Only show Speed Baccarat
  const filteredRooms = useMemo(() => {
    // 1. 기본 필터링
    let roomList = Array.from(rooms.values()).filter(room => {
      const name = (room.koreanName || room.name || '').toLowerCase()
      // Exclude salon and lightning rooms
      if (name.includes('살롱') || name.includes('salon')) return false
      if (name.includes('라이트닝') || name.includes('lightning')) return false
      // Only include baccarat rooms (exclude other games)
      if (!name.includes('바카라') && !name.includes('baccarat')) return false
      return true
    })

    // 2. 선택된 방 필터링 (선택된 방이 있으면 해당 방만 표시)
    if (selectedRoomIds.size > 0) {
      roomList = roomList.filter(room => selectedRoomIds.has(room.id))
    }

    // 3. Multi-pattern filter application
    if (activeFilters.length > 0) {
      roomList = roomList.filter(room => {
        // 빈 히스토리 방은 필터에서 제외
        if (room.history.length === 0) return false
        const state = roomStates.get(room.id) || null
        // Show if matches ANY of the active filters
        return activeFilters.some(filterType => matchesFilter(room, state, filterType))
      })
    }

    // 3. 정렬 로직 적용
    const getMartin = (roomId: string) => roomStates.get(roomId)?.stats.consecutiveLosses || 0
    // 적중률 정렬: 예측 수가 많을수록 가중치 부여 (Bayesian-style smoothing)
    // 공식: winRate * (total / (total + K)) where K=5
    // 예: 3/3 (100%) → 100 * 0.375 = 37.5, 10/11 (90.9%) → 90.9 * 0.6875 = 62.5
    const getWinRate = (roomId: string) => {
      const state = roomStates.get(roomId)
      if (!state) return 0
      const { winRate, total } = state.stats
      const K = 5 // 최소 5판 이상이어야 신뢰도 높음
      return winRate * (total / (total + K))
    }
    const getStreak = (roomId: string) => {
      const state = roomStates.get(roomId)
      if (!state) return 0
      return Math.max(state.stats.consecutiveWins, state.stats.consecutiveLosses)
    }
    const getBankerDominance = (room: Room) => {
      const recent = room.history.slice(-10)
      const bCount = recent.filter(r => r.winner === 'B').length
      const pCount = recent.filter(r => r.winner === 'P').length
      return bCount - pCount
    }

    // 최적 방 점수 계산: score = (연승 수 * 10) + (최근20판 승률 * 100)
    const getOptimalScore = (roomId: string) => {
      const state = roomStates.get(roomId)
      if (!state) return 0
      const consecutiveWins = state.stats.consecutiveWins || 0
      const winRate = state.stats.winRate || 0
      return (consecutiveWins * 10) + winRate
    }

    // 최적 정렬 시 필터 조건: 2연패 이상 제외, 50% 미만 승률 제외
    if (sortType === 'optimal') {
      roomList = roomList.filter(room => {
        const state = roomStates.get(room.id)
        if (!state) return true // 상태 없으면 일단 포함
        // 2연패 이상 제외
        if (state.stats.consecutiveLosses >= 2) return false
        // 50% 미만 승률 제외 (예측 기록이 있을 때만)
        if (state.stats.total > 0 && state.stats.winRate < 50) return false
        return true
      })
    }

    // 정렬 방향 계수 (asc: 1, desc: -1)
    const dir = sortDirection === 'asc' ? 1 : -1

    switch (sortType) {
      case 'optimal':
        roomList.sort((a, b) => dir * (getOptimalScore(a.id) - getOptimalScore(b.id)))
        break
      case 'name':
        roomList.sort((a, b) => {
          const nameA = a.koreanName || a.name
          const nameB = b.koreanName || b.name
          return dir * nameA.localeCompare(nameB, 'ko')
        })
        break
      case 'games':
        roomList.sort((a, b) => dir * (a.history.length - b.history.length))
        break
      case 'martin':
        roomList.sort((a, b) => dir * (getMartin(a.id) - getMartin(b.id)))
        break
      case 'winRate':
        roomList.sort((a, b) => dir * (getWinRate(a.id) - getWinRate(b.id)))
        break
      case 'streak':
        roomList.sort((a, b) => dir * (getStreak(a.id) - getStreak(b.id)))
        break
      case 'recent':
        roomList.sort((a, b) => dir * ((a.lastResultTime || 0) - (b.lastResultTime || 0)))
        break
      case 'bankerDominant':
        roomList.sort((a, b) => dir * (getBankerDominance(a) - getBankerDominance(b)))
        break
      case 'playerDominant':
        roomList.sort((a, b) => dir * (getBankerDominance(b) - getBankerDominance(a)))
        break
    }

    // 4. 빈 히스토리 방을 맨 뒤로 이동 (Empty history rooms to the end)
    const roomsWithHistory = roomList.filter(r => r.history.length > 0)
    const roomsWithoutHistory = roomList.filter(r => r.history.length === 0)
    roomList = [...roomsWithHistory, ...roomsWithoutHistory]

    // 5. 선택된 방을 맨 앞으로 이동 (Sticky Selected Room)
    if (selectedRoom) {
      const selectedIndex = roomList.findIndex(r => r.id === selectedRoom.id)

      if (selectedIndex !== -1) {
        // 이미 리스트에 있으면 해당 위치에서 제거하고 맨 앞에 추가
        const [room] = roomList.splice(selectedIndex, 1)
        roomList.unshift(room)
      } else {
        // 리스트에 없지만(필터링됨) 선택된 상태라면 맨 앞에 강제로 추가
        // 단, 기본 제외 대상(Salon/Lightning)이 아닐 경우에만 추가하여 일관성 유지
        const fullRoom = rooms.get(selectedRoom.id)
        if (fullRoom) {
          const name = (fullRoom.koreanName || fullRoom.name || '').toLowerCase()
          const isBasicAllowed = !name.includes('살롱') && !name.includes('salon') &&
            !name.includes('라이트닝') && !name.includes('lightning') &&
            (name.includes('바카라') || name.includes('baccarat'))

          if (isBasicAllowed) {
            roomList.unshift(fullRoom)
          }
        }
      }
    }

    return roomList
  }, [rooms, activeFilters, roomStates, matchesFilter, sortType, sortDirection, selectedRoom])

  // Lobby mode prediction fetcher
  useEffect(() => {
    if (viewMode === 'lobby' && filteredRooms.length > 0) {
      filteredRooms.forEach(room => {
        const state = roomStates.get(room.id)
        if (!state?.lastPrediction || !state.lastPrediction.prediction) {
          requestPrediction(room)
        }
      })
    }
  }, [viewMode, filteredRooms, roomStates, requestPrediction])

  // ✅ Hot Room Monitoring Logic - useRef to avoid recreating interval on every render
  const roomStatesRef = useRef(roomStates)
  roomStatesRef.current = roomStates
  const roomsRef = useRef(rooms)
  roomsRef.current = rooms
  const getMartinLevelRef = useRef(getMartinLevel)
  getMartinLevelRef.current = getMartinLevel

  useEffect(() => {
    if (status !== 'connected') return

    const interval = setInterval(() => {
      roomStatesRef.current.forEach((state, roomId) => {
        const room = roomsRef.current.get(roomId)
        if (!room) return

        // 1. High Win Rate Alert (>85% with at least 5 games)
        if (state.stats.total >= 5 && state.stats.winRate >= 85) {
          addAlert(`${room.koreanName || room.name}: 85% 이상의 압도적 적중률!`, 'hot')
        }

        // 2. Win Streak Alert (>=3)
        if (state.stats.consecutiveWins >= 3) {
          addAlert(`${room.koreanName || room.name}: ${state.stats.consecutiveWins}연속 적중 중!`, 'win')
        }

        // 3. High Risk Alert (Martin >= 4)
        if ((getMartinLevelRef.current(roomId) || 0) >= 4) {
          addAlert(`${room.koreanName || room.name}: 마틴 4단계 진입 - 주의 요망`, 'risk')
        }
      })
    }, 20000) // 20s check

    return () => clearInterval(interval)
  }, [status, addAlert])

  // Get room prediction state
  const getRoomState = useCallback((roomId: string): RoomPredictionState | null => {
    return roomStates.get(roomId) || null
  }, [roomStates])

  // Selected room state
  const selectedRoomState = selectedRoom ? getRoomState(selectedRoom.id) : null

  // Handle room selection
  const handleRoomSelect = useCallback((room: Room) => {
    selectRoom(room)
  }, [selectRoom])

  // Handle connect / reconnect
  const handleConnect = useCallback(async () => {
    if (status === 'idle' || status === 'error') {
      // 첫 연결 또는 에러 상태 - 새로 연결 시작
      if (user?.siteUrl) {
        await openCasino(user.siteUrl)
      }
    } else {
      // 이미 연결됐다가 끊긴 경우 - 세션 갱신 포함 재연결
      // 브라우저 새로고침 → 새 세션 캡처 → 처음처럼 다시 연결
      try {
        await reconnectLobby()
      } catch (error: any) {
        // 브라우저가 없으면 새로 열기
        const errorMsg = error?.message || error || ''
        if (errorMsg.includes('브라우저가 실행되지 않') || errorMsg.includes('no_browser')) {
          if (user?.siteUrl) {
            await openCasino(user.siteUrl)
          }
        }
        // 그 외 에러는 reconnectLobby에서 이미 처리됨
      }
    }
  }, [status, user?.siteUrl, openCasino, reconnectLobby])

  // Open room in new tab (for predict mode)
  // Uses Evolution domain from WebSocket URL (wss -> https conversion)
  // Pragmatic rooms use navigate_pragmatic_room command
  const openRoomInNewTab = useCallback(async (roomId: string) => {
    // Pragmatic 방은 별도 명령 사용 (캡처된 로비 URL 기반)
    const room = rooms.get(roomId)

    if (room?.provider === 'pragmatic') {
      try {
        await invoke<string>('navigate_pragmatic_room', { roomId })
      } catch (error: any) {
        alert(`프라그마틱 방 입장 실패: ${error?.message || error}\n\n프라그마틱 로비를 먼저 열어주세요.`)
      }
      return
    }

    if (!room) {
      // Fallback: try to guess provider if ID has prefix
      if (roomId.startsWith('pragmatic:')) {
        try {
          await invoke('navigate_pragmatic_room', { roomId })
          return
        } catch (e) { }
      }
    }

    const baseUrl = evolutionBaseUrl || user?.siteUrl
    if (!baseUrl) {
      return
    }

    const launchId =
      (typeof crypto !== 'undefined' && (crypto as any).randomUUID?.()) ||
      Math.random().toString(36).slice(2).padEnd(32, '0')
    const roomUrl = `${baseUrl}/frontend/evo/r2/#category=baccarat&game=baccarat&table_id=${roomId}&lobby_launch_id=${launchId}`


    try {
      await invoke('open_new_tab_cdp', { url: roomUrl })
    } catch (error) {
      try {
        await invoke('open_in_chrome_normal', { url: roomUrl })
      } catch (fallbackError) {
      }
    }
  }, [evolutionBaseUrl, user?.siteUrl, rooms])

  // Status display
  const getStatusInfo = () => {
    switch (status) {
      case 'connected':
        return { label: '실시간', connected: true }
      case 'launching':
      case 'monitoring':
      case 'captured':
        return { label: '데이터 분석 중...', connected: false }
      case 'error':
        return { label: '오류 발생', connected: false }
      default:
        return { label: '연결 대기 중', connected: false }
    }
  }

  const statusInfo = getStatusInfo()

  // Get current filter label
  const getCurrentFilterLabel = () => {
    if (activeFilters.length === 0) return '전체'
    if (activeFilters.length === 1) {
      const filter = availableFilters.find(f => f.type === activeFilters[0])
      return filter?.label || activeFilters[0]
    }
    return `필터 (${activeFilters.length})`
  }

  // ✅ 포커싱 모드용 방 데이터 (실시간 업데이트)
  const focusedRoom = useMemo(() => {
    if (!focusedRoomId) return null
    return rooms.get(focusedRoomId) || null
  }, [focusedRoomId, rooms])

  const focusedRoomState = focusedRoom ? roomStates.get(focusedRoom.id) || null : null
  const focusedRoomTimer = focusedRoom ? roomTimers.get(focusedRoom.id) : undefined
  const focusedRoomMartingale = focusedRoom ? getMartinLevel(focusedRoom.id) : undefined

  // Add state for focused room view mode


  // 방 입장 및 포커싱 모드 진입
  const handleEnterAndFocus = useCallback(async (roomId: string) => {
    // ✅ 현재 실제 입장한 방이 있으면 히스토리에 추가 (이전 방으로 돌아가기용)
    // focusedRoomId를 직접 참조하여 실제 입장한 방만 히스토리에 추가
    if (focusedRoomId && focusedRoomId !== roomId) {
      setRoomHistory(history => [...history, focusedRoomId])
    }
    setFocusedRoomId(roomId)
    setViewMode('grid')

    // ✅ 포커싱 시 예측이 없으면 즉시 요청
    const room = rooms.get(roomId)
    const existingState = roomStates.get(roomId)
    if (room && (!existingState?.lastPrediction || !existingState.lastPrediction.prediction)) {
      await requestPrediction(room)
    }

    await openRoomInNewTab(roomId)
  }, [focusedRoomId, openRoomInNewTab, rooms, roomStates, requestPrediction])

  // ✅ 이전 방으로 돌아가기
  const handleBackToPrevious = useCallback(async () => {
    if (roomHistory.length === 0) return

    const prevRoomId = roomHistory[roomHistory.length - 1]
    setRoomHistory(history => history.slice(0, -1))
    setFocusedRoomId(prevRoomId)

    // 이전 방 탭으로 이동
    await openRoomInNewTab(prevRoomId)
  }, [roomHistory, openRoomInNewTab])

  // 반자동 모드 - 컴팩트 화면으로 전환
  if (showSemiAutoPanel) {
    return (
      <div className="semi-auto-screen">
        <SemiAutoPanel
          rooms={rooms}
          onEnterRoom={handleEnterAndFocus}
          fullScreen={false}
          onSwitchToPredict={() => setShowSemiAutoPanel(false)}
          availableFilters={availableFilters}
          selectedPattern={activeFilters[0] || 'all'}
          onPatternChange={(p) => p === 'all' ? clearFilters() : toggleFilter(p)}
          onOpenPatternManager={() => setShowPatternModal(true)}
          selectedRoomIds={selectedRoomIds}
        />
      </div>
    )
  }

  // ✅ 포커싱 모드 - 특정 방에 집중
  if (focusedRoom) {
    return (
      <FocusedRoomView
        room={focusedRoom}
        state={focusedRoomState}
        lastResult={lastResults.get(focusedRoom.id)}
        statusInfo={statusInfo}
        isOnline={isOnline}
        roomTimer={focusedRoomTimer}
        martingaleLevel={focusedRoomMartingale}
        onBackToLobby={async () => {
          setFocusedRoomId(null)
          setRoomHistory([])  // 로비로 가면 히스토리 초기화
          // 🏠 에볼루션 브라우저도 로비로 이동
          try {
            await invoke('navigate_to_evolution_lobby')
          } catch (_e) {
            // Silent - 로비 이동 실패해도 UI는 전환
          }
        }}
        onBackToPrevious={handleBackToPrevious}
        hasPreviousRoom={roomHistory.length > 0}
        roomStates={roomStates}
        rooms={rooms}
        onSelectRoom={(roomId) => {
          if (roomId !== focusedRoomId) {
            handleEnterAndFocus(roomId)
          }
        }}
      />
    )
  }

  return (
    <div className="predict-panel">
      {/* Header - Compact with integrated filter */}
      <header className="predict-header">
        <div className="predict-header__center">
          {/* Connection Status */}
          <div className={`predict-header__status ${statusInfo.connected ? 'connected' : ''}`}>
            <span className="predict-header__status-dot" />
            <span>{statusInfo.label}</span>
          </div>

          {/* Room Count with Filter Trigger */}
          {status === 'connected' && (
            <button
              className={`predict-header__rooms ${selectedRoomIds.size > 0 ? 'has-selection' : ''}`}
              onClick={() => setShowRoomSelector(true)}
              title="분석할 방 선택"
            >
              <span className="predict-header__rooms-count">{filteredRooms.length}</span>
              <span className="predict-header__rooms-total">
                / {selectedRoomIds.size > 0 ? `${selectedRoomIds.size} 선택` : `${rooms.size} 방`}
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: '4px', opacity: 0.6 }}>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          )}

          {/* Filter Dropdown */}
          <div className="predict-header__filter">
            <button
              className="predict-header__filter-btn"
              onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            >
              <span>필터: {getCurrentFilterLabel()}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {showFilterDropdown && (
              <div className="predict-header__filter-dropdown">
                <button
                  className={`predict-header__filter-item ${activeFilters.length === 0 ? 'active' : ''}`}
                  onClick={() => { clearFilters(); setShowFilterDropdown(false) }}
                >
                  <span>전체</span>
                  <span className="filter-count">{selectedRoomPatternCounts.all}</span>
                </button>
                {availableFilters.map(filter => {
                  const isActive = activeFilters.includes(filter.type)
                  return (
                    <div
                      key={filter.type}
                      className={`predict-header__filter-item ${isActive ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="predict-header__filter-item-toggle"
                        onClick={() => toggleFilter(filter.type)}
                      >
                        <span>{filter.label}</span>
                        <span className="filter-count">{selectedRoomPatternCounts[filter.type] || 0}</span>
                      </button>
                      <FilterThresholdInline filterType={filter.type} />
                      <PatternBetDirectionSelect patternType={filter.type} />
                      <PatternBetStrategySelect patternType={filter.type} />
                    </div>
                  )
                })}
                <div className="predict-header__filter-divider" />
                <button
                  type="button"
                  className="predict-header__filter-manage"
                  onClick={() => { setShowPatternModal(true); setShowFilterDropdown(false) }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>커스텀 패턴 추가/관리</span>
                </button>
              </div>
            )}
          </div>

          {/* Pattern Settings Button */}
          <button
            className="predict-header__pattern-btn"
            onClick={() => setShowPatternModal(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>패턴</span>
          </button>

          {/* Sort Buttons */}
          <div className="predict-header__sort">
            {SORT_OPTIONS.map(option => (
              <button
                key={option.type}
                className={`predict-header__sort-btn ${sortType === option.type ? 'active' : ''}`}
                onClick={() => setSortType(option.type)}
                title={option.label}
              >
                {option.shortLabel}
              </button>
            ))}
            {/* Sort Direction Toggle */}
            <button
              className={`predict-header__sort-direction ${sortDirection}`}
              onClick={toggleSortDirection}
              title={sortDirection === 'asc' ? '오름차순 (클릭하여 내림차순으로 변경)' : '내림차순 (클릭하여 오름차순으로 변경)'}
            >
              {sortDirection === 'asc' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 5v14M5 12l7 7 7-7" />
                </svg>
              )}
            </button>
          </div>

          {/* View Toggle */}
          <div className="predict-header__view-toggle">
            <button
              className={`view-toggle-btn ${viewMode === 'lobby' ? 'active' : ''}`}
              onClick={async () => {
                setViewMode('lobby')
                // 🏠 에볼루션 브라우저도 로비로 이동
                try {
                  await invoke('navigate_to_evolution_lobby')
                } catch (_e) {
                  // Silent - 로비 이동 실패해도 UI는 전환
                }
              }}
              title="스마트 로비 뷰"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18M9 21V9" />
              </svg>
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title="그리드 뷰"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
              </svg>
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'compact' ? 'active' : ''}`}
              onClick={() => setViewMode('compact')}
              title="컴팩트 뷰 (테이블)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'ranking' ? 'active' : ''}`}
              onClick={() => setViewMode('ranking')}
              title="랭킹 뷰 (대시보드)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M6 9l6 6 6-6" />
                <path d="M12 3v18" />
              </svg>
              {/* Or Trophy icon? */}
            </button>
          </div>

          {/* Unified Session Stats - Elegant Compact Display */}
          {globalStats.total > 0 && (
            <div className="predict-header__unified-stats">
              <span className="unified-stats__win">{globalStats.correct}W</span>
              <span className="unified-stats__separator">-</span>
              <span className="unified-stats__loss">{globalStats.total - globalStats.correct}L</span>
              <span className="unified-stats__divider" />
              <span className={`unified-stats__rate ${globalStats.winRate >= 50 ? 'positive' : 'negative'}`}>
                {globalStats.winRate.toFixed(0)}%
              </span>
            </div>
          )}
        </div>

        <div className="predict-header__actions">
          {sessionWarning && (
            <div className="predict-header__warning">{sessionWarning}</div>
          )}
          {!isOnline && (
            <div className="predict-header__warning predict-header__warning--offline">오프라인</div>
          )}
          {/* Semi-Auto Toggle Button */}
          {status === 'connected' && (
            <button
              className="predict-header__semi-auto"
              onClick={() => setShowSemiAutoPanel(true)}
            >
              반자동
            </button>
          )}
          {status === 'idle' ? (
            <button className="predict-header__btn predict-header__btn--primary" onClick={handleConnect}>
              연결 시작
            </button>
          ) : (
            <button className="predict-header__btn" onClick={handleConnect}>
              재연결
            </button>
          )}
          <button className="predict-header__btn predict-header__btn--logout" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className={`predict-content ${viewMode}`}>
        {viewMode === 'grid' ? (
          <>
            {/* Room List - Takes most space */}
            <main className="predict-rooms">
              {status === 'idle' ? (
                <div className="predict-empty">
                  <div className="predict-empty__icon">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="2" y="2" width="20" height="20" rx="3" />
                      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
                      <circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none" />
                      <circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none" />
                      <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
                      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                    </svg>
                  </div>
                  <div className="predict-empty__title">서비스 연결 대기 중</div>
                  <div className="predict-empty__desc">위의 "연결 시작" 버튼을 눌러 게임 분석을 시작하세요.</div>
                </div>
              ) : status === 'launching' || status === 'monitoring' ? (
                <div className="predict-loading">
                  <div className="predict-loading__spinner" />
                  <div className="predict-loading__text">연결 중...</div>
                </div>
              ) : !roomsReady ? (
                /* 로비소켓 연결됨, 방 데이터 수신 중 */
                <div className="predict-loading">
                  <div className="predict-loading__spinner" />
                  <div className="predict-loading__text">방 데이터 수신 중...</div>
                </div>
              ) : filteredRooms.length === 0 ? (
                <div className="predict-empty">
                  <div className="predict-empty__icon">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 3v18h18" />
                      <path d="M7 12l4-4 4 4 5-5" />
                    </svg>
                  </div>
                  <div className="predict-empty__title">조건에 맞는 방 없음</div>
                  <div className="predict-empty__desc">필터 조건을 변경해보세요.</div>
                </div>
              ) : (
                <>
                  {/* Top 3 Rankings */}
                  <Top3Rankings
                    roomStates={roomStates}
                    rooms={rooms}
                    onRoomClick={(roomId) => {
                      // 클릭 시 바로 입장
                      handleEnterAndFocus(roomId)
                    }}
                    minPredictions={1}
                  />
                  <div className="room-grid">
                    {filteredRooms.map(room => (
                      <RoomCard
                        key={room.id}
                        room={room}
                        state={getRoomState(room.id)}
                        isSelected={selectedRoom?.id === room.id}
                        isHot={isRoomHot(room)}
                        isFlashing={flashingRooms.has(room.id)}
                        isShoeChange={shoeChanges.has(room.id)}
                        lastResult={lastResults.get(room.id)}
                        martingaleLevel={getMartinLevel(room.id)}
                        roomTimer={roomTimers.get(room.id)}
                        onClick={() => handleRoomSelect(room)}
                      />
                    ))}
                  </div>
                </>
              )}
            </main>

            {/* Selected Room Detail - Right Panel */}
            <aside className="predict-detail">
              {selectedRoom ? (
                <SelectedRoomDetail room={selectedRoom} state={selectedRoomState} lastResult={lastResults.get(selectedRoom.id)} onEnterRoom={handleEnterAndFocus} />
              ) : (
                <div className="predict-detail__empty">
                  <div className="predict-detail__empty-icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </div>
                  <div className="predict-detail__empty-title">분석할 방을 선택하세요</div>
                  <div className="predict-detail__empty-desc">목록에서 방을 선택하면 AI 정밀 분석 정보를 확인할 수 있습니다.</div>
                </div>
              )}
            </aside>
          </>
        ) : viewMode === 'lobby' ? (
          <div className="predict-lobby-wrapper">
            <Top3Rankings
              roomStates={roomStates}
              rooms={rooms}
              onRoomClick={(roomId) => handleEnterAndFocus(roomId)}
              minPredictions={1}
            />
            <PredictLobbyView
              rooms={filteredRooms}
              roomStates={roomStates}
              selectedRoom={selectedRoom}
              onRoomSelect={handleRoomSelect}
              onEnterRoom={handleEnterAndFocus}
              getMartinLevel={getMartinLevel}
            />
          </div>
        ) : viewMode === 'ranking' ? (
          <RankingView
            filteredRooms={filteredRooms}
            allRooms={rooms}
            roomStates={roomStates}
            onRoomSelect={handleRoomSelect}
            onEnterRoom={handleEnterAndFocus}
            getMartingaleLevel={getMartinLevel}
          />
        ) : (
          /* Compact View - Table Style */
          <div className="predict-compact">
            {/* Top 3 Rankings */}
            <Top3Rankings
              roomStates={roomStates}
              rooms={rooms}
              onRoomClick={(roomId) => {
                // 클릭 시 바로 입장
                handleEnterAndFocus(roomId)
              }}
              minPredictions={1}
            />
            <div className="compact-header-row">
              <div className="col-name">방 이름</div>
              <div className="col-prediction">예측</div>
              <div className="col-result">결과</div>
              <div className="col-counts">B/P/T</div>
              <div className="col-streak">연승/패</div>
              <div className="col-max-streak">최대(연승/패)</div>
              <div className="col-winrate">승률(적중/전체)</div>
              <div className="col-games">게임</div>
              <div className="col-timer">시간</div>
              <div className="col-history">기록</div>
              <div className="col-action">방입장</div>
            </div>
            <div className="compact-list">
              {filteredRooms.map(room => (
                <CompactRoomRow
                  key={room.id}
                  room={room}
                  state={getRoomState(room.id)}
                  isSelected={selectedRoom?.id === room.id}
                  isHot={isRoomHot(room)}
                  martingaleLevel={getMartinLevel(room.id)}
                  lastResult={lastResults.get(room.id)}
                  roomTimer={roomTimers.get(room.id)}
                  onSelect={() => handleRoomSelect(room)}
                  onEnter={() => handleEnterAndFocus(room.id)}
                />
              ))}
            </div>
          </div>
        )
        }
      </div>

      {/* Pattern Manager Modal */}
      <PatternManagerModal
        isOpen={showPatternModal}
        onClose={() => setShowPatternModal(false)}
        patterns={customPatterns}
        selectedPattern={activeFilters[0] || 'all'}
        onCreate={(data) => {
          patternManager.add({
            name: data.name,
            sequence: data.sequence,
            enabled: data.enabled,
            description: data.description,
            betDirection: data.betDirection
          })
          showSuccess(`패턴 "${data.name}" 저장 완료`)
        }}
        onUpdate={(id, data) => {
          patternManager.update(id, {
            name: data.name,
            sequence: data.sequence,
            enabled: data.enabled,
            description: data.description,
            betDirection: data.betDirection
          })
          showSuccess(`패턴 "${data.name}" 수정 완료`)
        }}
        onDelete={(id) => {
          const target = customPatterns.find(p => p.id === id)
          patternManager.remove(id)
          showSuccess(`패턴 "${target?.name ?? ''}" 삭제됨`)
        }}
        onToggle={(id, enabled) => {
          patternManager.toggle(id, enabled)
          const target = customPatterns.find(p => p.id === id)
          showInfo(`패턴 "${target?.name ?? ''}" ${enabled ? '활성화' : '비활성화'}`)
        }}
        onApply={(pattern) => {
          if ((pattern as string) === 'all') clearFilters()
          else toggleFilter(pattern as RoomFilterType)
          setShowPatternModal(false)
        }}
      />

      {/* Room Selector Modal */}
      <RoomSelectorModal
        isOpen={showRoomSelector}
        onClose={() => setShowRoomSelector(false)}
        rooms={rooms}
        selectedRoomIds={selectedRoomIds}
        onSelectionChange={handleRoomSelectionChange}
        title="분석할 방 선택"
      />

      {/* Smart Alert Overlay */}
      <div className="predict-alerts">
        {alerts.map(alert => (
          <div key={alert.id} className={`alert-toast ${alert.type} anim-slide-in`}>
            <div className="alert-toast__icon">
              {alert.type === 'hot' ? '🔥' : alert.type === 'win' ? '✨' : '⚠'}
            </div>
            <div className="alert-toast__content">{alert.message}</div>
          </div>
        ))}
      </div>

      {/* Win Celebration Overlay */}
      <div className={`win-celebration ${selectedRoom && lastResults.get(selectedRoom.id) === true ? 'active' : ''}`}>
        <div className="particles">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="particle"
              style={{
                '--delay': `${Math.random() * 2}s`,
                '--left': `${Math.random() * 100}%`
              } as any}
            />
          ))}
        </div>
      </div>

      {/* Room Selector Modal */}
      <RoomSelectorModal
        isOpen={showRoomSelector}
        onClose={() => setShowRoomSelector(false)}
        rooms={rooms}
        selectedRoomIds={selectedRoomIds}
        onSelectionChange={handleRoomSelectionChange}
        title="분석 대상 방 선택"
      />
    </div>
  )
}

