// AutoModePanel - SmartHelper 오토 배팅 메인 패널
// Clean Architecture: Presentation Layer
// Multi-room betting dashboard with real-time status
// Enhanced: PredictMode style features (patterns, filters, BeadPlate history)

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useGame } from '../../context/GameContext'
import { useError } from '../../context'
import { useAutoMode } from '../../hooks'
import { AutoModeSettingsDialog } from './components/AutoModeSettingsDialog'
import { AutoModeRoomGrid, type RoomBetLog } from './components/AutoModeRoomGrid'
import { AutoModeRoomList } from './components/AutoModeRoomList'
import { AutoModeMosaic } from './components/AutoModeMosaic' // Added
import { AutoModeHistory } from './components/AutoModeHistory'
import { RoomSelectorModal } from '../shared'
import { FilterSettingsDialog } from '../common/FilterSettingsDialog'
import { filterBaccaratRooms } from '../../utils'
import type { RoomBetConfig } from '../../../domain/entities'
import PatternManagerModal from '../MainScreen/components/PatternManagerModal'
import CustomPatternService from '../../../application/services/CustomPatternService'
import VirtualBettingService from '../../../application/services/VirtualBettingService'
import type { AutoModeBetLogEvent } from '../../../application/services/AutoModeService'
import type { RoomFilterType, RoomSortType, CustomPattern } from '../../../domain/entities'
import { SORT_OPTIONS } from '../../../domain/entities'
import './AutoModePanel.css'
import {
  LayoutGrid,
  List,
  LayoutTemplate,
  Flag,
  BarChart2,
  TrendingUp,
  TrendingDown,
  Clock,
  Workflow
} from 'lucide-react'

// LocalStorage key for view mode
const VIEW_MODE_KEY = 'auto-mode:view-mode'
import { useCountUp } from '../../hooks/useCountUp'

interface AutoModePanelProps {
  onLogout: () => void
  sessionWarning?: string
  isOnline: boolean
}

interface HistoryLog {
  id: number
  time: string
  roomName: string
  message: string
  type: 'prediction' | 'bet' | 'win' | 'loss' | 'move' | 'info' | 'error' | 'skip'
  betAmount?: number       // 배팅금액
  profit?: number          // 해당 건 손익
  cumulativeProfit?: number // 누적 손익 (해당 시점까지)
  playerScore?: number     // 플레이어 카드 합계 점수
  bankerScore?: number     // 뱅커 카드 합계 점수
  winner?: 'P' | 'B' | 'T' // 승자
}

export default function AutoModePanel({ onLogout, sessionWarning, isOnline }: AutoModePanelProps) {
  const {
    user,
    rooms,
    roomsReady,  // 멀티소켓 방 구독 완료 여부
    status,
    realBalance,
    roomStates: gameRoomStates,
    openCasino,
    availableFilters,
    activeFilters,
    toggleFilter,
    clearFilters,
    matchesFilter,
    flashingRooms,
    patternManager,
    roomTimers,
    roomDataVersion,
    sortDirection,
    toggleSortDirection,
  } = useGame()

  // CustomPatternService에서 직접 패턴 로드 (Context 동기화 문제 우회)
  const [customPatterns, setCustomPatterns] = useState<CustomPattern[]>(() => CustomPatternService.getPatterns())

  useEffect(() => {
    const unsubscribe = CustomPatternService.onChange(setCustomPatterns)
    return unsubscribe
  }, [])

  const autoMode = useAutoMode()
  const {
    enabled,
    settings,
    totalWins,
    totalLosses,
    cumulativeProfit,
    roomStates: autoModeRoomStates,
    toggle,
    updateSettings,
    resetStats,
    onBetLog,
    setActiveBettingRooms,
  } = autoMode

  const roomStates = gameRoomStates

  // Toast notifications (replaces window.alert popups)
  const { showSuccess, showInfo } = useError()

  // State
  const [showSettings, setShowSettings] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'mosaic'>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY)
      if (saved && ['grid', 'list', 'mosaic'].includes(saved)) {
        return saved as 'grid' | 'list' | 'mosaic'
      }
    } catch (e) {
      console.warn('[AutoMode] Failed to load view mode:', e)
    }
    return 'grid'
  })
  const [showPatternModal, setShowPatternModal] = useState(false)
  const [showFilterDialog, setShowFilterDialog] = useState(false)
  const [showRoomSelector, setShowRoomSelector] = useState(false)
  const [sortType, setSortType] = useState<RoomSortType>('games')
  const [historyLogs, setHistoryLogs] = useState<HistoryLog[]>([])
  const [isConnecting, setIsConnecting] = useState(false)
  const [lastBetTime, setLastBetTime] = useState<Date | null>(null)
  const [lastBetResult, setLastBetResult] = useState<'win' | 'loss' | null>(null)
  const [timeSinceLastBet, setTimeSinceLastBet] = useState<string>('')
  const [roomBetLogs, setRoomBetLogs] = useState<Map<string, RoomBetLog[]>>(new Map())
  const logIdRef = useRef(0)

  // viewMode 변경 시 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode)
    } catch (e) {
      console.warn('[AutoMode] Failed to save view mode:', e)
    }
  }, [viewMode])

  // ✅ FIX: 가상 초기 잔액만 VirtualBettingService에서 가져옴 (globalBalance 대신 cumulativeProfit 기준으로 계산)
  const [virtualInitialBalance, setVirtualInitialBalance] = useState(() => VirtualBettingService.getSettings().initialBalance)

  // 스파크라인용 잔액 히스토리 (AutoModeService의 cumulativeProfit 기반)
  const [balanceHistory, setBalanceHistory] = useState<number[]>([])

  // VirtualBettingService 초기잔액 동기화 (설정 변경 시 업데이트)
  useEffect(() => {
    if (!settings.isVirtualMode || !enabled) return

    setVirtualInitialBalance(VirtualBettingService.getSettings().initialBalance)

    const unsubscribe = VirtualBettingService.onStateChange((nextState) => {
      setVirtualInitialBalance(nextState.settings.initialBalance)
    })
    return unsubscribe
  }, [settings.isVirtualMode, enabled])

  // ✅ FIX: 스파크라인용 잔액 히스토리를 AutoModeService.cumulativeProfit 기반으로 업데이트
  // VirtualBettingService.globalBalance 대신 일관된 소스 사용
  useEffect(() => {
    if (!settings.isVirtualMode || !enabled) return

    // 세션 손익(cumulativeProfit) 변경 시 히스토리 업데이트
    // 가상 잔고 = 초기잔액 + 세션손익 (스파크라인에서는 pending 제외한 확정 잔고)
    const effectiveBalance = virtualInitialBalance + cumulativeProfit
    setBalanceHistory(prev => {
      const next = [...prev, effectiveBalance]
      return next.slice(-30)
    })
  }, [settings.isVirtualMode, enabled, virtualInitialBalance, cumulativeProfit])

  // 마지막 베팅 시간 업데이트
  useEffect(() => {
    if (!lastBetTime) return
    const interval = setInterval(() => {
      const diff = Math.floor((Date.now() - lastBetTime.getTime()) / 1000)
      if (diff < 60) {
        setTimeSinceLastBet(`${diff}초 전`)
      } else if (diff < 3600) {
        setTimeSinceLastBet(`${Math.floor(diff / 60)}분 전`)
      } else {
        setTimeSinceLastBet(`${Math.floor(diff / 3600)}시간 전`)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [lastBetTime])

  // 연패 경고 계산
  const consecutiveLosses = useMemo(() => {
    let maxLosses = 0
    autoModeRoomStates.forEach((state: any) => {
      if (state.martinLevel > maxLosses) {
        maxLosses = state.martinLevel
      }
    })
    return maxLosses
  }, [autoModeRoomStates])


  // 현재 배팅 중인 금액 및 예상 수익 계산
  const currentBettingInfo = useMemo(() => {
    let totalCurrentBet = 0
    let totalExpectedProfit = 0
    let bettingRoomCount = 0

    autoModeRoomStates.forEach((state: any) => {
      if (state.waitingForResult && state.lastBetAmount > 0) {
        bettingRoomCount++
        totalCurrentBet += state.lastBetAmount
        // 예상 수익 계산: 뱅커 5% 커미션, 플레이어 0%
        const predType = state.lastPrediction?.prediction
        const profitRate = predType === 'B' ? 0.95 : 1.0
        totalExpectedProfit += Math.floor(state.lastBetAmount * profitRate)
      }
    })

    return { totalCurrentBet, totalExpectedProfit, bettingRoomCount }
  }, [autoModeRoomStates])

  // ✅ 세션 손익은 항상 AutoModeService에서 가져옴 (승패 카운트와 동일 소스 사용)
  // VirtualBettingService의 totalNetProfit 대신 AutoModeService의 cumulativeProfit 사용
  const sessionProfit = cumulativeProfit

  // 🌟 Alive Numbers Animation (Hooks)
  const animatedStartBalance = useCountUp(autoMode.startBalance || virtualInitialBalance, 1500)
  const animatedTotalBet = useCountUp(autoMode.totalBetAmount, 1000)
  const animatedMaxProfit = useCountUp(Math.abs(autoMode.maxProfit), 1000)
  // New JSX: -{animatedMaxLoss} -> So animatedMaxLossMagnitude should be positive magnitude.
  const animatedMaxLossMagnitude = useCountUp(Math.abs(autoMode.maxLoss), 1000)
  const animatedSessionProfit = useCountUp(Math.abs(sessionProfit), 800)
  const animatedCurrentBet = useCountUp(currentBettingInfo.totalCurrentBet, 500)
  const animatedExpected = useCountUp(currentBettingInfo.totalExpectedProfit, 500)



  // 설정에서 선택된 방 ID 목록
  const selectedRoomIds = useMemo(() => {
    return new Set<string>(
      settings.roomConfigs?.filter((c: any) => c.enabled).map((c: any) => c.roomId) || []
    )
  }, [settings.roomConfigs])

  // 바카라 방 목록 (필터링용)
  const baccaratRoomList = useMemo(() => filterBaccaratRooms(rooms), [rooms])

  // RoomSelectorModal 어댑터: Set<string> → roomConfigs 변환
  const handleRoomSelectionChange = useCallback((newIds: Set<string>) => {
    const newConfigs: RoomBetConfig[] = baccaratRoomList.map(room => ({
      roomId: room.id,
      enabled: newIds.has(room.id),
      maxConsecutiveLosses: settings.globalMaxConsecutiveLosses || 5,
    }))
    updateSettings({ roomConfigs: newConfigs })
  }, [baccaratRoomList, settings.globalMaxConsecutiveLosses, updateSettings])

  // 선택된 방 기준 패턴 카운트 계산
  // NOTE: roomDataVersion을 의존성에 추가하여 방 데이터 업데이트 후 실시간으로 카운트가 업데이트되도록 함
  const selectedRoomPatternCounts = useMemo(() => {
    const counts: Record<string, number> = { all: selectedRoomIds.size }

    // 등록된 모든 customPatterns 사용 (enabled 필터링 제거)
    // 선택된 방이 없으면 전체 방 기준
    if (selectedRoomIds.size === 0) {
      counts.all = rooms.size
      availableFilters.forEach(filter => {
        let count = 0
        rooms.forEach(room => {
          const state = roomStates.get(room.id) || null
          if (matchesFilter(room, state, filter.type)) count++
        })
        counts[filter.type] = count
      })
      return counts
    }

    // 선택된 방 기준으로 필터 카운트
    availableFilters.forEach(filter => {
      let count = 0
      rooms.forEach(room => {
        if (!selectedRoomIds.has(room.id)) return
        const state = roomStates.get(room.id) || null
        if (matchesFilter(room, state, filter.type)) count++
      })
      counts[filter.type] = count
    })

    return counts
  }, [selectedRoomIds, rooms, roomStates, availableFilters, matchesFilter, roomDataVersion])

  // 배팅 대상 방 필터링 로직:
  // 정책: 사용자가 헤더에서 선택한 방(selectedRoomIds)만 자동 배팅 대상.
  // - 선택 없음 → [] (안전 가드: 자동 배팅 안 함)
  // - 선택 있음 + 활성 필터 있음 → 선택된 방 중 필터 매칭된 방 (+ 선택된 방 중 마틴 회복/연승 방은 우선 포함)
  // - 선택 있음 + 필터 없음 → 선택된 방 전체
  // NOTE: roomDataVersion을 의존성에 추가하여 방 데이터 업데이트 후 실시간으로 재계산
  const filteredBettingRoomIds = useMemo(() => {
    // 0. 사용자 선택이 없으면 절대 배팅하지 않음
    if (selectedRoomIds.size === 0) {
      console.log(`[AutoMode] 🔒 선택된 방 없음 → 자동 배팅 중단`)
      return []
    }

    // 1. 선택된 방 중 마틴 회복/연승 ID 수집 (선택 외 방은 제외)
    const martinRecoveryRoomIds = new Set<string>()
    const winStreakRoomIds = new Set<string>()
    autoModeRoomStates.forEach((state: any, roomId: string) => {
      if (!selectedRoomIds.has(roomId)) return
      if (state.martinLevel > 0) martinRecoveryRoomIds.add(roomId)
      if (state.consecutiveWins > 0) winStreakRoomIds.add(roomId)
    })

    // 2. 활성 필터가 있으면 선택된 방 중 매칭된 방만, 없으면 선택된 방 전체
    const selectedRooms = Array.from(rooms.values()).filter(r => selectedRoomIds.has(r.id))

    let matchedIds: string[]
    if (activeFilters.length > 0) {
      matchedIds = selectedRooms
        .filter(room => {
          const state = roomStates.get(room.id) || null
          return activeFilters.some(filterType => matchesFilter(room, state, filterType))
        })
        .map(r => r.id)
    } else {
      matchedIds = selectedRooms.map(r => r.id)
    }

    // 3. 매칭 + 마틴 회복 + 연승 방 합치기 (중복 제거)
    const result = Array.from(new Set([...winStreakRoomIds, ...matchedIds, ...martinRecoveryRoomIds]))

    console.log(`[AutoMode] 🔄 선택방 기반 배팅 대상 (v${roomDataVersion}): 선택=${selectedRoomIds.size}, 매칭=${matchedIds.length}, 마틴회복=${martinRecoveryRoomIds.size}, 연승=${winStreakRoomIds.size}, 총=${result.length}`)
    return result
  }, [rooms, roomStates, autoModeRoomStates, activeFilters, matchesFilter, selectedRoomIds, roomDataVersion])

  // 필터된 방 목록과 현재 패턴 필터를 서비스에 전달
  useEffect(() => {
    setActiveBettingRooms(filteredBettingRoomIds, activeFilters.length > 0 ? activeFilters[0] : 'all')
  }, [filteredBettingRoomIds, activeFilters, setActiveBettingRooms])

  const addHistoryLog = useCallback((
    roomName: string,
    message: string,
    type: HistoryLog['type'],
    options?: { 
      betAmount?: number
      profit?: number
      cumulativeProfit?: number
      playerScore?: number
      bankerScore?: number
      winner?: 'P' | 'B' | 'T'
    }
  ) => {
    const now = new Date()
    const time = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setHistoryLogs(prev => [{
      id: ++logIdRef.current,
      time,
      roomName,
      message,
      type,
      betAmount: options?.betAmount,
      profit: options?.profit,
      cumulativeProfit: options?.cumulativeProfit,
      playerScore: options?.playerScore,
      bankerScore: options?.bankerScore,
      winner: options?.winner,
    }, ...prev].slice(0, 100))
  }, [])

  // 배팅 로그 이벤트 구독
  useEffect(() => {
    const unsubscribe = onBetLog((event: AutoModeBetLogEvent) => {
      const {
        type,
        roomName,
        roomId,
        martinLevel,
        won,
        profit,
        betAmount,
        betType,
        reasoning,
        prediction,
        winner,
        status,
        level,
        historyIndex,
        cumulativeProfit: logCumulativeProfit,
        playerScore,
        bankerScore,
      } = event

      // 오토모드에서는 prediction 타입은 표시하지 않음 (bet_placed에서 표시)
      // 예측이 아니라 배팅이므로

      if (type === 'bet_placed') {
        // 배팅 실행 로그 (가상/실제 구분 없이 내용만)
        const placedLabel = settings.isVirtualMode ? '배팅' : '주문'
        const betLabel = betType === 'Banker' ? '뱅커' : '플레이어'
        // 마틴 단계 표시 (플랫은 단계 표시 안함)
        const martinText = martinLevel > 0 && settings.betStrategy !== 'flat'
          ? ` [마틴 ${martinLevel + 1}단계]`
          : ''
        const reasonText = reasoning ? ` (${reasoning})` : ''
        // Ensure betAmount is a valid number
        const validBetAmount = typeof betAmount === 'number' && !isNaN(betAmount) ? betAmount : 0
        console.log(`[AutoModePanel] bet_placed - betAmount from event: ${betAmount}, validBetAmount: ${validBetAmount}`)
        // ✅ FIX: bet_placed에도 현재 cumulativeProfit 전달 (배팅 시점의 누적 손익)
        addHistoryLog(roomName, `${betLabel} ${validBetAmount.toLocaleString()}원${martinText}${reasonText}`, 'bet', { betAmount: validBetAmount, cumulativeProfit })

        // 방별 배팅 로그에 pending 추가 (카드 하단 O/X 스트립에 표시)
        setRoomBetLogs(prev => {
          const newMap = new Map(prev)
          const logs = newMap.get(roomId) || []
          const newLog: RoomBetLog = {
            betAmount: validBetAmount,
            status: 'pending',
            profit: 0,
            martinLevel,
            prediction: prediction ?? null,
            message: `${placedLabel}: ${betLabel} ${validBetAmount.toLocaleString()}원${martinText}${reasonText}`,
            timestamp: Date.now()
          }
          newMap.set(roomId, [newLog, ...logs].slice(0, 10))
          return newMap
        })
      }

      if (type === 'bet_result') {
        // won이 없으면(=undefined) 결과가 아닌 상태/정보 로그로 처리 (휴식 시작/종료 등)
        if (won === undefined) {
          // PASS 처리 (SKIP)
          if (status === 'pass') {
            // 방별 배팅 로그에 PASS 추가
            setRoomBetLogs(prev => {
              const newMap = new Map(prev)
              const logs = newMap.get(roomId) || []
              const passLog: RoomBetLog = {
                betAmount: 0,
                status: 'pass',
                profit: 0,
                martinLevel: martinLevel,
                prediction: prediction ?? null,
                winner: undefined,
                historyIndex,
                message: reasoning || '패스',
                timestamp: Date.now()
              }
              newMap.set(roomId, [passLog, ...logs].slice(0, 10))
              return newMap
            })
            // 히스토리 로그에도 추가 (SKIP 타입 사용)
            addHistoryLog(roomName, reasoning || '패스', 'skip')
            return
          }

          const isError = level === 'error' || status === 'failed'
          const failedMessage = status === 'failed'
            ? `배팅 실패${reasoning ? `: ${reasoning}` : ''}`
            : (reasoning || '상태 업데이트')
          // 배팅금액이 있는 경우 options에 포함
          addHistoryLog(roomName, failedMessage, isError ? 'error' : 'info',
            betAmount ? { betAmount } : undefined
          )

          // 배팅 실패는 방별 로그에도 남겨서 카드에서 바로 확인 가능하게
          if (status === 'failed') {
            setRoomBetLogs(prev => {
              const newMap = new Map(prev)
              const logs = newMap.get(roomId) || []
              const failed: RoomBetLog = {
                betAmount: betAmount ?? 0,
                status: 'failed',
                profit: 0,
                martinLevel,
                prediction: prediction ?? null,
                winner,
                historyIndex,
                message: failedMessage,
                timestamp: Date.now()
              }

              const idx = logs.findIndex(l => l.status === 'pending')
              if (idx >= 0) {
                const nextLogs = [...logs]
                nextLogs[idx] = failed
                newMap.set(roomId, nextLogs.slice(0, 10))
                return newMap
              }

              newMap.set(roomId, [failed, ...logs].slice(0, 10))
              return newMap
            })
          }
          return
        }

        setLastBetTime(new Date())
        setLastBetResult(won === null ? null : (won ? 'win' : 'loss'))

        // Validate betAmount for result logs
        const resultBetAmount = typeof betAmount === 'number' && !isNaN(betAmount) ? betAmount : 0
        const predText = prediction ? (prediction === 'B' ? '뱅커' : prediction === 'P' ? '플레이어' : '타이') : '-'
        const winText = winner ? (winner === 'B' ? '뱅커' : winner === 'P' ? '플레이어' : '타이') : '-'

        // 방별 배팅 로그 업데이트 (pending → 결과로 치환)
        setRoomBetLogs(prev => {
          const newMap = new Map(prev)
          const logs = newMap.get(roomId) || []
          const resolvedStatus = won === null ? 'tie' : (won ? 'win' : 'loss')
          const profitText = (profit ?? 0) > 0 ? `+${(profit ?? 0).toLocaleString()}` : `${(profit ?? 0).toLocaleString()}`
          // 마틴 단계 표시 (플랫은 단계 표시 안함)
          const martinText = martinLevel > 0 && settings.betStrategy !== 'flat'
            ? ` (마틴 ${martinLevel}단계)`
            : ''

          const message = won === null
            ? `타이 환불 (${resultBetAmount.toLocaleString()}원)`
            : won
              ? `적중 (+${profitText}원)${martinText}`
              : `미적중 (${profitText}원)${martinText}`
          const resolved: RoomBetLog = {
            betAmount: resultBetAmount,
            status: resolvedStatus,
            profit: profit ?? 0,
            martinLevel,
            prediction: prediction ?? null,
            winner,
            historyIndex,
            message,
            timestamp: Date.now()
          }

          const idx = logs.findIndex(l => l.status === 'pending')
          if (idx >= 0) {
            const nextLogs = [...logs]
            nextLogs[idx] = resolved
            newMap.set(roomId, nextLogs.slice(0, 10))
            return newMap
          }

          newMap.set(roomId, [resolved, ...logs].slice(0, 10))
          return newMap
        })

        // 상세 결과 로그
        const profitText = (profit ?? 0) > 0 ? `+${(profit ?? 0).toLocaleString()}` : `${(profit ?? 0).toLocaleString()}`
        // 마틴 단계 표시 (플랫은 단계 표시 안함)
        const martinText = martinLevel > 0 && settings.betStrategy !== 'flat'
          ? ` (마틴 ${martinLevel}단계)`
          : ''

        // 로그에서 직접 cumulativeProfit 가져옴 (AutoModeService에서 계산된 정확한 값)
        const effectiveCumulativeProfit = logCumulativeProfit ?? cumulativeProfit

        if (won === null) {
          addHistoryLog(roomName, `타이 - 환불 (예측: ${predText}, ${resultBetAmount.toLocaleString()}원)`, 'info', { 
            betAmount: resultBetAmount, 
            profit: 0, 
            cumulativeProfit: effectiveCumulativeProfit,
            playerScore,
            bankerScore,
            winner: 'T',
          })
          return
        }

        if (won) {
          addHistoryLog(roomName, `적중! 예측: ${predText} / 결과: ${winText} → ${profitText}원${martinText}`, 'win', { 
            betAmount: resultBetAmount, 
            profit: profit ?? 0, 
            cumulativeProfit: effectiveCumulativeProfit,
            playerScore,
            bankerScore,
            winner: winner as 'P' | 'B',
          })
          return
        }

        addHistoryLog(roomName, `실패 예측: ${predText} / 결과: ${winText} → ${profitText}원${martinText}`, 'loss', { 
          betAmount: resultBetAmount, 
          profit: profit ?? 0, 
          cumulativeProfit: effectiveCumulativeProfit,
          playerScore,
          bankerScore,
          winner: winner as 'P' | 'B',
        })
      }
    })
    return unsubscribe
  }, [onBetLog, addHistoryLog, settings.isVirtualMode, settings.betStrategy, cumulativeProfit])

  const handleConnect = useCallback(async () => {
    if (!user?.siteUrl) return
    setIsConnecting(true)
    try {
      await openCasino(user.siteUrl)
    } catch (error) {
      addHistoryLog('-', '연결 실패', 'info')
    } finally {
      setIsConnecting(false)
    }
  }, [user?.siteUrl, openCasino, addHistoryLog])

  const enabledRoomIds = new Set<string>(
    settings.roomConfigs?.filter((c: any) => c.enabled).map((c: any) => c.roomId) || []
  )

  const isConnected = status === 'connected'

  // 가동 시간 타이머
  const [duration, setDuration] = useState('00:00:00')

  useEffect(() => {
    if (!enabled || !autoMode.startTime) {
      setDuration('00:00:00')
      return
    }

    const updateTimer = () => {
      const now = Date.now()
      const diff = now - (autoMode.startTime || now)
      const hours = Math.floor(diff / 3600000)
      const minutes = Math.floor((diff % 3600000) / 60000)
      const seconds = Math.floor((diff % 60000) / 1000)
      setDuration(
        `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      )
    }

    updateTimer()
    const timer = setInterval(updateTimer, 1000)
    return () => clearInterval(timer)
  }, [enabled, autoMode.startTime])

  // Get current filter label
  const getCurrentFilterLabel = useCallback(() => {
    if (activeFilters.length === 0) return '전체'
    if (activeFilters.length === 1) {
      const filterType = activeFilters[0]
      if (typeof filterType === 'string' && filterType.startsWith('custom:')) {
        const patternId = filterType.replace('custom:', '')
        const pattern = customPatterns.find(p => p.id === patternId)
        if (pattern) return pattern.name
      }
      const filter = availableFilters.find(f => f.type === filterType)
      return filter?.label || filterType
    }
    return `필터 (${activeFilters.length})`
  }, [activeFilters, availableFilters, customPatterns])

  const handleToggle = useCallback(() => {
    // 시작하려는 경우 방 선택 확인
    if (!enabled) {
      console.log(`[AutoModePanel] 🎮 handleToggle - 시작 시도, selectedRooms: ${selectedRoomIds.size}개, filteredRooms: ${filteredBettingRoomIds.length}개, pattern: ${activeFilters.length > 0 ? activeFilters[0] : 'all'}`)
      if (activeFilters.length === 0 && selectedRoomIds.size === 0) {
        alert('배팅할 방을 먼저 선택해주세요.\n\n헤더의 [방] 버튼을 눌러 방을 선택하거나, 패턴을 선택하세요.')
        return
      }
      const filterLabel = activeFilters.length === 0 ? 'AI 자동' : getCurrentFilterLabel()
      addHistoryLog('-', `오토 시작 (${selectedRoomIds.size}방, ${filterLabel})`, 'info')
    } else {
      console.log(`[AutoModePanel] 🎮 handleToggle - 정지`)
      addHistoryLog('-', '오토 배팅 정지', 'info')
    }
    toggle(realBalance ?? undefined)
  }, [toggle, enabled, addHistoryLog, selectedRoomIds.size, activeFilters, getCurrentFilterLabel, filteredBettingRoomIds.length, realBalance])

  // 전역 상태 스트립 정보
  const getGlobalStatusInfo = () => {
    if (!isOnline) return { label: '오프라인', className: 'offline', message: '인터넷 연결을 확인하세요' }
    if (status === 'error') return { label: '연결 오류', className: 'error', message: 'CDP 연결 끊김, 재연결 필요' }
    if (status === 'launching') return { label: '실행 중', className: 'launching', message: '크롬 브라우저 시작 중...' }
    if (status === 'monitoring') return { label: '대기 중', className: 'monitoring', message: 'Evolution 연결 대기...' }
    if (!isConnected) return { label: '연결 대기', className: 'idle', message: '연결 시작 버튼을 클릭하세요' }

    // 실행 중 상태일 때 (HTML 반환을 위해 별도 처리)
    if (enabled) {
      return {
        label: '', // Type safety
        isHtml: true,
        className: settings.isVirtualMode ? 'running' : 'running-real',
        message: settings.isVirtualMode ? '가상 배팅 중' : '⚠️ 실제 배팅 중'
      }
    }

    return { label: '대기', className: 'standby', message: '준비 완료' }
  }

  const globalStatus = getGlobalStatusInfo()

  // 스파크라인 SVG 경로 생성
  const sparklinePath = useMemo(() => {
    if (balanceHistory.length < 2) return ''
    const width = 120
    const height = 30
    const min = Math.min(...balanceHistory)
    const max = Math.max(...balanceHistory)
    const range = max - min || 1

    return balanceHistory.map((val, i) => {
      const x = (i / (balanceHistory.length - 1)) * width
      const y = height - ((val - min) / range) * height
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
    }).join(' ')
  }, [balanceHistory])

  // 전역 리스크 감지 (마틴 4단계 이상 방이 하나라도 있으면)
  const isGlobalRiskCritical = useMemo(() => {
    return Array.from(autoModeRoomStates.values()).some((s: any) => s.martinLevel >= 3)
  }, [autoModeRoomStates])

  return (
    <div className={`auto-mode ${isGlobalRiskCritical ? 'risk-critical' : ''}`}>
      {/* 전역 상태 스트립 - "THE PULSE" */}
      <div className={`auto-mode__status-strip ${globalStatus.className}`}>
        <div className="auto-mode__status-strip-left">
          <span className="auto-mode__status-strip-indicator" />

          {globalStatus.isHtml ? (
            <div className="auto-mode__status-strip-content">
              <span>자동 배팅</span>
              <span className="status-divider">·</span>
              <span>{settings.isVirtualMode ? '가상' : '실제'}</span>
              <span className="status-divider">·</span>
              <div className="status-score">
                <span className="win">{totalWins}승</span>
                <span className="divider">/</span>
                <span className="loss">{totalLosses}패</span>
              </div>
              {autoMode.startTime && (
                <>
                  <span className="status-divider">·</span>
                  <div className="status-timer">
                    <Clock size={9} />
                    <span>{duration}</span>
                  </div>
                </>
              )}
            </div>
          ) : (
            <span className="auto-mode__status-strip-label">{globalStatus.label}</span>
          )}

          {globalStatus.message && (
            <span className="auto-mode__status-strip-message"> | {globalStatus.message}</span>
          )}
        </div>

        <div className="auto-mode__status-strip-right">
          {isConnected && enabled && (
            <>
              {timeSinceLastBet && (
                <>
                  <span className="strip-dot">·</span>
                  <span>최근 {timeSinceLastBet}</span>
                </>
              )}
              {lastBetResult && (
                <>
                  <span className="strip-dot">·</span>
                  <span className={`auto-mode__last-result ${lastBetResult}`}>
                    {lastBetResult === 'win' ? '승' : '패'}
                  </span>
                </>
              )}
              {consecutiveLosses >= 2 && (
                <>
                  <span className="strip-dot">·</span>
                  <span className={`auto-mode__loss-warning ${consecutiveLosses >= 3 ? 'danger' : ''}`}>
                    {consecutiveLosses}연패
                  </span>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Header */}
      <header className="auto-mode__header">

        <div className="auto-mode__header-center">
          {/* 가상/실제 배팅 토글 */}
          {isConnected && (
            <button
              className={`auto-mode__mode-toggle ${settings.isVirtualMode ? 'virtual' : 'real'}`}
              onClick={() => updateSettings({ isVirtualMode: !settings.isVirtualMode })}
              disabled={enabled}
              title={enabled ? '배팅 중에는 변경할 수 없습니다' : ''}
            >
              <span className="auto-mode__mode-toggle-indicator" />
              <span className="auto-mode__mode-toggle-label">
                {settings.isVirtualMode ? '가상' : '실제'}
              </span>
            </button>
          )}

          {/* 오토 배팅 ON/OFF 토글 */}
          {isConnected && (
            <button
              className={`auto-mode__toggle ${enabled ? 'active' : ''}`}
              onClick={handleToggle}
            >
              <span className="auto-mode__toggle-indicator" />
              <span className="auto-mode__toggle-label">{enabled ? '정지' : '시작'}</span>
            </button>
          )}

          {/* 방 선택 버튼 */}
          {isConnected && (
            <button
              className="auto-mode__header-room-btn"
              onClick={() => setShowRoomSelector(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span>방 {selectedRoomIds.size > 0 ? `(${selectedRoomIds.size})` : `(${rooms.size})`}</span>
            </button>
          )}

          {/* Filter Settings Button - opens consolidated FilterSettingsDialog */}
          <button
            className="auto-mode__header-filter-btn"
            onClick={() => setShowFilterDialog(true)}
            title="필터 설정 열기"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            <span>필터: {getCurrentFilterLabel()}</span>
          </button>

          {/* Strategy Display Badge (New) */}
          <button
            className="auto-mode__header-btn"
            onClick={() => setShowSettings(true)}
            title="배팅 전략 설정"
          >
            <Workflow size={14} />
            <span>
              {settings.betStrategy === 'martingale' ? '마틴' :
                settings.betStrategy === 'fibonacci' ? '피보나치' :
                  settings.betStrategy === 'paroli' ? '파롤리' :
                    settings.betStrategy === 'flat' ? '플랫' : '커스텀'}
              {settings.betStrategy !== 'flat' && ` (${settings.maxMartin}단계)`}
            </span>
          </button>
        </div>


        {/* Tactical Financial Dashboard */}
        <div className="auto-mode__financial-pods">
          {/* Balance Pod */}
          <div className="auto-mode__pod">
            <span className="auto-mode__pod-label">
              {settings.isVirtualMode ? '가상 잔고' : '실제 보유금'}
            </span>
            <span className="auto-mode__pod-value">
              {settings.isVirtualMode
                ? (() => {
                  const effectiveBalance = virtualInitialBalance + sessionProfit - currentBettingInfo.totalCurrentBet
                  return `${effectiveBalance.toLocaleString()}원`
                })()
                : `${(realBalance || 0).toLocaleString()}원`}
            </span>
            {settings.isVirtualMode && (
              (() => {
                const balanceChange = sessionProfit - currentBettingInfo.totalCurrentBet
                return (
                  <span className={`auto-mode__header-money-expected ${balanceChange >= 0 ? '' : 'loss'}`}>
                    {balanceChange >= 0 ? '+' : ''}{balanceChange.toLocaleString()}
                  </span>
                )
              })()
            )}
          </div>

          {/* Session Stats Grid (2x2) */}
          <div className="auto-mode__pod auto-mode__stat-grid">
            <div className="auto-mode__stat-row">
              <div className="auto-mode__stat-item">
                <span className="auto-mode__stat-label">
                  <Flag size={9} strokeWidth={2.5} /> 시작금액
                </span>
                <span className="auto-mode__stat-value neutral">
                  {Math.floor(animatedStartBalance / 10000)}만
                </span>
              </div>
              <div className="auto-mode__stat-item">
                <span className="auto-mode__stat-label">
                  <BarChart2 size={9} strokeWidth={2.5} /> 전체배팅
                </span>
                <span className="auto-mode__stat-value volume">
                  {Math.floor(animatedTotalBet / 10000)}만
                </span>
              </div>
            </div>
            <div className="auto-mode__stat-row">
              <div className="auto-mode__stat-item">
                <span className="auto-mode__stat-label">
                  <TrendingUp size={9} strokeWidth={2.5} /> 최대수익
                </span>
                <span className="auto-mode__stat-value positive">
                  {autoMode.maxProfit > 0 ? '+' : ''}{Math.floor(animatedMaxProfit / 10000)}만
                </span>
              </div>
              <div className="auto-mode__stat-item">
                <span className="auto-mode__stat-label">
                  <TrendingDown size={9} strokeWidth={2.5} /> 최대손실
                </span>
                <span className="auto-mode__stat-value negative">
                  -{Math.floor(animatedMaxLossMagnitude / 10000)}만
                </span>
              </div>
            </div>
          </div>

          {/* Session Profit Pod with Glowing Sparkline */}
          <div className={`auto-mode__header-money-pod ${sessionProfit >= 0 ? 'positive' : 'negative'}`}>
            <div className="auto-mode__header-money-label">실시간 세션 손익</div>
            <div className="auto-mode__header-money-value">
              {sessionProfit >= 0 ? '+' : '-'}{animatedSessionProfit.toLocaleString()}원
              <span className={`auto-mode__header-money-percent ${autoMode.totalBetAmount > 0 ? (sessionProfit >= 0 ? 'positive' : 'negative') : ''}`}>
                수익률 {autoMode.totalBetAmount > 0
                  ? `${sessionProfit >= 0 ? '+' : ''}${((sessionProfit / autoMode.totalBetAmount) * 100).toFixed(1)}%`
                  : '0.0%'}
              </span>
            </div>

            {/* Sparkline Visual - Simple */}
            {settings.isVirtualMode && balanceHistory.length >= 2 && (
              <div className="auto-mode__header-sparkline">
                <svg width="120" height="30" viewBox="0 0 120 30" style={{ overflow: 'visible' }}>
                  <path
                    d={sparklinePath}
                    fill="none"
                    stroke={sessionProfit >= 0 ? '#4ade80' : '#ff4b4b'}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="sparkline-path"
                  />
                </svg>
              </div>
            )}
          </div>

          {/* Active Bet Pod */}
          {currentBettingInfo.totalCurrentBet > 0 && (
            <div className="auto-mode__pod active-bet">
              <span className="auto-mode__pod-label">현재 배팅 중 ({currentBettingInfo.bettingRoomCount}방)</span>
              <span className="auto-mode__pod-value">
                {animatedCurrentBet.toLocaleString()}원
              </span>
              <span className="auto-mode__header-money-expected">
                예상 +{animatedExpected.toLocaleString()}
              </span>
            </div>
          )}

          {/* Limits Pod */}
          {(settings.winCutAmount > 0 || settings.lossCutAmount > 0) && (
            <div className="auto-mode__pod limits">
              <span className="auto-mode__pod-label">목표/손절 한도</span>
              <div className="auto-mode__header-config-summary">
                {settings.winCutAmount > 0 && <span className="win">+{settings.winCutAmount.toLocaleString()}</span>}
                {settings.lossCutAmount > 0 && <span className="loss"> -{settings.lossCutAmount.toLocaleString()}</span>}
              </div>
            </div>
          )}
        </div>


        <div className="auto-mode__header-actions">
          {/* Pattern Settings Button - Moved here for better layout */}
          {isConnected && (
            <button
              className="auto-mode__header-pattern-btn"
              onClick={() => setShowPatternModal(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>패턴</span>
            </button>
          )}

          {/* View Mode Toggle & Sort Buttons */}
          {isConnected && (
            <div className="auto-mode__header-view-toggle" style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
              <button
                className={`auto-mode__header-btn ${viewMode === 'grid' ? 'active' : ''}`}
                onClick={() => setViewMode('grid')}
                title="그리드 뷰 (상세)"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                className={`auto-mode__header-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
                title="리스트 뷰 (분석)"
              >
                <List size={14} />
              </button>
              <button
                className={`auto-mode__header-btn ${viewMode === 'mosaic' ? 'active' : ''}`}
                onClick={() => setViewMode('mosaic')}
                title="모자이크 뷰"
              >
                <LayoutTemplate size={14} />
              </button>
            </div>
          )}

          {/* Sort Buttons - 정렬 버튼들 (4개만 표시) + 방향 토글 */}
          {isConnected && (
            <div className="auto-mode__header-sort">
              {SORT_OPTIONS.filter(opt =>
                ['name', 'games', 'martin', 'winRate', 'profit'].includes(opt.type)
              ).map(option => (
                <button
                  key={option.type}
                  className={`auto-mode__header-sort-btn ${sortType === option.type ? 'active' : ''}`}
                  onClick={() => setSortType(option.type)}
                  title={option.label}
                >
                  {option.shortLabel}
                </button>
              ))}
              {/* Sort Direction Toggle */}
              <button
                className={`auto-mode__header-sort-btn auto-mode__sort-direction ${sortDirection}`}
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
          )}

          {sessionWarning && (
            <div className="auto-mode__header-warning">{sessionWarning}</div>
          )}

          {/* 설정 버튼 */}
          <button
            className="auto-mode__header-btn auto-mode__header-btn--settings"
            onClick={() => setShowSettings(true)}
          >
            설정
          </button>

          {/* 연결 버튼 */}
          {status === 'idle' ? (
            <button
              className="auto-mode__header-btn auto-mode__header-btn--primary"
              onClick={handleConnect}
              disabled={isConnecting}
            >
              연결 시작
            </button>
          ) : !isConnected && (
            <button
              className="auto-mode__header-btn"
              onClick={handleConnect}
              disabled={isConnecting || status === 'launching'}
            >
              재연결
            </button>
          )}

          <button className="auto-mode__header-btn auto-mode__header-btn--logout" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </header >

      {/* Main Content */}
      {
        !isConnected ? (
          <main className="auto-mode__empty">
            <div className="auto-mode__empty-content">
              {(status === 'launching' || status === 'monitoring') && (
                <div className="auto-mode__empty-spinner" />
              )}
            </div>
          </main>
        ) : !roomsReady ? (
          /* 멀티소켓 연결됨, 방 구독 진행 중 */
          <main className="auto-mode__empty">
            <div className="auto-mode__empty-content">
              <div className="auto-mode__empty-spinner" />
              <p>방 데이터 수신 중...</p>
            </div>
          </main>
        ) : (
          <div className="auto-mode__content">
            {/* Room Grid - 메인 영역 */}
            <main className="auto-mode__rooms">
              {viewMode === 'grid' ? (
                <AutoModeRoomGrid
                  rooms={rooms}
                  roomStates={roomStates}
                  autoModeRoomStates={autoModeRoomStates}
                  enabledRoomIds={enabledRoomIds}
                  settings={settings}
                  isAutoEnabled={enabled}
                  flashingRooms={flashingRooms}
                  roomBetLogs={roomBetLogs}
                  roomTimers={roomTimers}
                  selectedPattern={activeFilters.length > 0 ? activeFilters[0] : 'all'}
                  matchesFilter={matchesFilter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                  roomDataVersion={roomDataVersion}
                />
              ) : viewMode === 'list' ? (
                <AutoModeRoomList
                  rooms={rooms}
                  roomStates={roomStates}
                  autoModeRoomStates={autoModeRoomStates}
                  enabledRoomIds={enabledRoomIds}
                  settings={settings}
                  isAutoEnabled={enabled}
                  flashingRooms={flashingRooms}
                  // lastResults & roomTimers removed from updated list component
                  roomBetLogs={roomBetLogs}
                  roomTimers={roomTimers}
                  selectedPattern={activeFilters.length > 0 ? activeFilters[0] : 'all'}
                  matchesFilter={matchesFilter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                  setSortType={setSortType}
                  roomDataVersion={roomDataVersion}
                />
              ) : (
                // mosaic view
                <AutoModeMosaic
                  rooms={Array.from(rooms.values())}
                  roomStates={roomStates}
                  bettingStates={autoModeRoomStates}
                  activePredictions={new Map()}
                  roomBetLogs={roomBetLogs}
                  settings={settings}
                  cumulativeProfit={sessionProfit}
                  onToggleRoom={() => { }}
                  roomDataVersion={roomDataVersion}
                  roomTimers={roomTimers}
                  enabledRoomIds={enabledRoomIds}
                  selectedPattern={activeFilters.length > 0 ? activeFilters[0] : 'all'}
                  matchesFilter={matchesFilter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                />
              )}
            </main>

            {/* History - 사이드바 */}
            <aside className="auto-mode__sidebar">
              <AutoModeHistory logs={historyLogs} />

              {/* 긴급 정지 버튼 */}
              {enabled && (
                <div className="auto-mode__emergency">
                  <button
                    className="auto-mode__emergency-btn"
                    onClick={handleToggle}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    긴급 정지
                  </button>
                </div>
              )}
            </aside>

          </div>
        )
      }

      <AutoModeSettingsDialog
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onUpdateSettings={updateSettings}
        onResetStats={resetStats}
        totalWins={totalWins}
        totalLosses={totalLosses}
        cumulativeProfit={sessionProfit}
        realBalance={realBalance}
      />

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
        title="배팅할 방 선택"
        showOnlySelectedOption={true}
        onlySelectedValue={settings.onlySelectedRooms || false}
        onOnlySelectedChange={(value) => updateSettings({ onlySelectedRooms: value })}
        emptyHint="방을 선택해야 배팅이 진행됩니다"
      />

      {/* Consolidated Filter Settings Dialog */}
      <FilterSettingsDialog
        isOpen={showFilterDialog}
        onClose={() => setShowFilterDialog(false)}
        availableFilters={availableFilters}
        activeFilters={activeFilters}
        toggleFilter={toggleFilter}
        clearFilters={clearFilters}
        filterCounts={selectedRoomPatternCounts}
        onOpenPatternManager={() => {
          setShowPatternModal(true)
          setShowFilterDialog(false)
        }}
        freshShoeScope="auto"
      />
    </div >
  )
}
