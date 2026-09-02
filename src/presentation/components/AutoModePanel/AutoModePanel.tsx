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
import type { Room, RoomBetConfig } from '../../../domain/entities'
import PatternManagerModal from '../MainScreen/components/PatternManagerModal'
import CustomStrategyManagerModal from '../MainScreen/components/CustomStrategyManagerModal'
import CustomPatternService from '../../../application/services/CustomPatternService'
import CustomStrategyService from '../../../application/services/CustomStrategyService'
import VirtualBettingService from '../../../application/services/VirtualBettingService'
import type { AutoModeBetLogEvent } from '../../../application/services/AutoModeService'
import type { RoomFilterType, RoomSortType, CustomPattern } from '../../../domain/entities'
import { SORT_OPTIONS, TIE_PAYOUT_MULTIPLIER } from '../../../domain/entities'
import './AutoModePanel.css'
import {
  LayoutGrid,
  List,
  LayoutTemplate,
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
  /** 통합 홈으로 복귀 (있으면 헤더에 [홈] 버튼 노출) */
  onHome?: () => void
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

export default function AutoModePanel({ onLogout, sessionWarning, isOnline, onHome }: AutoModePanelProps) {
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
  const { showSuccess, showInfo, showWarning } = useError()

  // State
  const [showSettings, setShowSettings] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'mosaic'>(() => {
    // 디폴트는 list — 30개 방을 한 번에 스캔하기 가장 쉽고 결과/마틴/다음배팅을 표로 정렬해 보여줌.
    // 기존 사용자는 localStorage 값이 그대로 살아남아 파괴적 변경 아님.
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY)
      if (saved && ['grid', 'list', 'mosaic'].includes(saved)) {
        return saved as 'grid' | 'list' | 'mosaic'
      }
    } catch (e) {
      console.warn('[AutoMode] Failed to load view mode:', e)
    }
    return 'list'
  })
  const [showPatternModal, setShowPatternModal] = useState(false)
  const [showStrategyModal, setShowStrategyModal] = useState(false)
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
  const autoFilterClearRef = useRef(0)

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
        const predType = state.lastPrediction?.prediction
        const profitRate = predType === 'B' ? 0.95 : predType === 'T' ? TIE_PAYOUT_MULTIPLIER : 1.0
        totalExpectedProfit += Math.floor(state.lastBetAmount * profitRate)
      }
    })

    return { totalCurrentBet, totalExpectedProfit, bettingRoomCount }
  }, [autoModeRoomStates])

  // ✅ 세션 손익은 항상 AutoModeService에서 가져옴 (승패 카운트와 동일 소스 사용)
  // 🆕 2026-07-08 실잔액 기준 통일(사용자: "실잔액 -6만인데 프로그램 -4만"): 실모드에서는
  // 자체추정(cumulativeProfit)이 정산 유실로 실제와 어긋나므로, '진짜 돈' 실잔액 기반 손익
  // (realNetProfit)을 우선 표시한다. 가상모드/실잔액 미수신 시 cumulativeProfit로 폴백.
  const sessionProfit = (!settings.isVirtualMode && autoMode.realNetProfit != null)
    ? autoMode.realNetProfit
    : cumulativeProfit

  // 헤더에 표시되는 손익·현재배팅·예상수익만 카운트업. 시작금액/전체배팅/최대수익/최대손실은 설정창의 통계 영역에서 정적으로 확인.
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

  const filterSettingsSignature = useMemo(() => {
    return availableFilters
      .map(filter => `${filter.type}:${filter.label}:${filter.description}`)
      .join('|')
  }, [availableFilters])

  const activeStructuredStrategy = useMemo(() => {
    const strategyFilter = activeFilters.find(filter => CustomStrategyService.isStrategyFilter(filter))
    return strategyFilter ? CustomStrategyService.getByFilterType(strategyFilter) : null
  }, [activeFilters, filterSettingsSignature])

  // 배팅 대상 방 필터링 로직:
  // 정책: 선택된 방이 있으면 그 범위만, 없으면 활성 필터가 있을 때 전체 바카라 방 중 매칭 방만 자동 배팅 대상.
  // - 선택 없음 + 필터 없음 → [] (안전 가드: 자동 배팅 안 함)
  // - 선택 없음 + 활성 필터 있음 → 전체 바카라 방 중 필터 매칭된 방
  // - 선택 있음 + 활성 필터 있음 → 선택된 방 중 필터 매칭된 방 (+ 선택된 방 중 마틴 회복/연승 방은 우선 포함)
  // - 선택 있음 + 필터 없음 → 선택된 방 전체
  // NOTE: roomDataVersion + filterSettingsSignature를 의존성에 추가하여 방 데이터/필터 설정 변경 후 실시간으로 재계산
  const filteredBettingRoomIds = useMemo(() => {
    // 0. 사용자 선택도 필터도 없으면 절대 배팅하지 않음
    if (selectedRoomIds.size === 0 && activeFilters.length === 0) {
      console.log(`[AutoMode] 🔒 선택된 방/필터 없음 → 자동 배팅 중단`)
      return []
    }

    // 1. 마틴 회복 ID 수집 — 마틴 진행 중(level>0)인 방은 패턴 매칭 여부와 무관하게
    //    승리할 때까지 유지(마틴 중도 포기 방지).
    // 🐞 로테이션(2026-07-07, 정확 모델): '연승(consecutiveWins>0)' 방을 매칭과 무관하게
    //    유지하던 로직 제거. 타이 적중(=승리) 직후 그 방은 필터('지금까지 타이 0개')에서
    //    빠지는데, 연승 유지가 그걸 무시하고 계속 배팅시켜 "이기고도 그 방에서 배팅"의
    //    원인이었다. 이제 승리한 방은 필터에서 빠지면 배팅 대상에서도 빠져 다른 방으로 회전한다.
    const martinRecoveryRoomIds = new Set<string>()
    autoModeRoomStates.forEach((state: any, roomId: string) => {
      if (selectedRoomIds.size > 0 && !selectedRoomIds.has(roomId)) return
      if (
        state.martinLevel > 0 ||
        state.customStrategyStatus === 'ready' ||
        state.customStrategyStatus === 'pending'
      ) martinRecoveryRoomIds.add(roomId)
    })

    // 2. 활성 필터가 있으면 대상 범위 중 매칭된 방만, 없으면 선택된 방 전체
    const targetRooms = selectedRoomIds.size > 0
      ? Array.from(rooms.values()).filter(r => selectedRoomIds.has(r.id))
      : baccaratRoomList

    let matchedIds: string[]
    if (activeFilters.length > 0) {
      matchedIds = targetRooms
        .filter(room => {
          const state = roomStates.get(room.id) || null
          return activeFilters.some(filterType => matchesFilter(room, state, filterType))
        })
        .map(r => r.id)
    } else {
      matchedIds = targetRooms.map(r => r.id)
    }

    // 3. 매칭 + 마틴 회복 방 합치기 (중복 제거)
    const result = Array.from(new Set([...matchedIds, ...martinRecoveryRoomIds]))

    console.log(`[AutoMode] 🔄 선택방 기반 배팅 대상 (v${roomDataVersion}): 선택=${selectedRoomIds.size}, 매칭=${matchedIds.length}, 마틴회복=${martinRecoveryRoomIds.size}, 총=${result.length}`)
    return result
  }, [rooms, roomStates, autoModeRoomStates, activeFilters, matchesFilter, selectedRoomIds, baccaratRoomList, roomDataVersion, filterSettingsSignature])

  // 필터된 방 목록과 현재 패턴 필터를 서비스에 전달
  useEffect(() => {
    setActiveBettingRooms(filteredBettingRoomIds, activeFilters.length > 0 ? activeFilters[0] : 'all')
  }, [filteredBettingRoomIds, activeFilters, setActiveBettingRooms])

  const roomsForAutoModeDisplay = useMemo(() => {
    const next = new Map<string, Room>(rooms)

    autoModeRoomStates.forEach((state: any, roomId: string) => {
      if (next.has(roomId)) return
      if (
        !state?.waitingForResult &&
        !(state?.martinLevel > 0) &&
        state?.customStrategyStatus !== 'ready' &&
        state?.customStrategyStatus !== 'pending'
      ) return

      const roomName = state.roomName || roomId
      next.set(roomId, {
        id: roomId,
        name: roomName,
        koreanName: roomName,
        history: [],
        gameCount: 0,
        phase: 'betting',
        gameState: {
          playerHand: { score: 0, cards: [] },
          bankerHand: { score: 0, cards: [] },
        },
      })
    })

    return next
  }, [rooms, autoModeRoomStates])

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
        const betLabel = betType === 'Banker' ? '뱅커' : betType === 'Player' ? '플레이어' : '타이'
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
          // 마틴 단계 표시 (0-indexed → 1-indexed, bet_placed와 동일하게 +1)
          const martinText = martinLevel > 0 && settings.betStrategy !== 'flat'
            ? ` (마틴 ${martinLevel + 1}단계)`
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
        // 마틴 단계 표시 (0-indexed → 1-indexed, bet_placed와 동일하게 +1)
        const martinText = martinLevel > 0 && settings.betStrategy !== 'flat'
          ? ` (마틴 ${martinLevel + 1}단계)`
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
            winner: winner as 'P' | 'B' | 'T',
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

  // 매 렌더마다 새 Set 생성을 막아 하위 리스트(Grid/List/Mosaic)의 filteredRooms useMemo가
  // 멤버십이 그대로일 때 불필요하게 재계산되지 않도록 한다. (selectedRoomIds와 동일 계산)
  const enabledRoomIds = useMemo(() => new Set<string>(
    settings.roomConfigs?.filter((c: any) => c.enabled).map((c: any) => c.roomId) || []
  ), [settings.roomConfigs])

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

  const clearAutoModeFilters = useCallback(() => {
    autoFilterClearRef.current = Date.now()
    clearFilters()
  }, [clearFilters])

  const toggleAutoModeFilter = useCallback((filterType: RoomFilterType) => {
    const followsDialogClear = Date.now() - autoFilterClearRef.current < 100
    autoFilterClearRef.current = 0

    if (followsDialogClear) {
      toggleFilter(filterType)
      return
    }

    const isOnlyActive = activeFilters.length === 1 && activeFilters[0] === filterType
    clearFilters()
    if (!isOnlyActive) {
      toggleFilter(filterType)
    }
  }, [activeFilters, clearFilters, toggleFilter])

  const handleToggle = useCallback(() => {
    // 시작하려는 경우 방 선택 확인
    if (!enabled) {
      console.log(`[AutoModePanel] 🎮 handleToggle - 시작 시도, selectedRooms: ${selectedRoomIds.size}개, filteredRooms: ${filteredBettingRoomIds.length}개, pattern: ${activeFilters.length > 0 ? activeFilters[0] : 'all'}`)
      if (filteredBettingRoomIds.length === 0) {
        // 네이티브 alert는 화면을 멈추고 글자도 작다 → 앱 토스트로 통일
        if (activeFilters.length === 0) {
          showWarning('배팅할 방을 먼저 선택하거나 필터를 골라 주세요.')
        } else {
          showWarning('현재 필터 조건에 맞는 방이 없습니다. 필터 기준을 조정하거나 방 선택 범위를 확인해 주세요.')
        }
        return
      }
      const filterLabel = activeFilters.length === 0 ? 'AI 자동' : getCurrentFilterLabel()
      addHistoryLog('-', `오토 시작 (${filteredBettingRoomIds.length}방, ${filterLabel})`, 'info')
    } else {
      console.log(`[AutoModePanel] 🎮 handleToggle - 정지`)
      addHistoryLog('-', '오토 배팅 정지', 'info')
    }
    toggle(realBalance ?? undefined)
  }, [toggle, enabled, addHistoryLog, selectedRoomIds.size, activeFilters, getCurrentFilterLabel, filteredBettingRoomIds.length, realBalance, showWarning])

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
                    <Clock size={14} />
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
              <span>방 {selectedRoomIds.size > 0 ? `(${selectedRoomIds.size})` : `(${baccaratRoomList.length})`}</span>
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
            className={`auto-mode__header-btn ${activeStructuredStrategy ? 'auto-mode__header-btn--structured' : ''}`}
            onClick={() => setShowSettings(true)}
            title={activeStructuredStrategy
              ? '조건 전략이 방향·단계·금액을 직접 관리합니다.'
              : '기본 배팅 전략 설정'}
          >
            <Workflow size={14} />
            <span>
              {activeStructuredStrategy
                ? `${activeStructuredStrategy.name} · 자체 단계`
                : `기본: ${settings.betStrategy === 'martingale' ? '마틴' :
                  settings.betStrategy === 'fibonacci' ? '피보나치' :
                    settings.betStrategy === 'paroli' ? '파롤리' :
                      settings.betStrategy === 'flat' ? '플랫' : '단계별 금액'}${settings.betStrategy !== 'flat' ? ` (${settings.maxMartin}단계)` : ''}`}
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
                : `${((autoMode.realDisplayBalance ?? realBalance) || 0).toLocaleString()}원`}
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

          {/* 헤더는 "지금 따고 있는가 / 지금 얼마 배팅 중인가 / 한도까지 얼마 남았는가"만 노출.
              시작금액/전체배팅/최대수익/최대손실은 히스토리 패널의 누적 손익 흐름으로 충분히 추적 가능. */}

          {/* Session Profit Pod with Glowing Sparkline */}
          <div className={`auto-mode__header-money-pod ${sessionProfit >= 0 ? 'positive' : 'negative'}`}>
            <div className="auto-mode__header-money-label">실시간 세션 손익</div>
            <div className="auto-mode__header-money-value">
              {sessionProfit >= 0 ? '+' : '-'}{animatedSessionProfit.toLocaleString()}원
            </div>

            {/* 보조 줄: 수익률(글자) + 스파크라인(그림). 값 위에 겹치지 않게 별도 행 */}
            <div className="auto-mode__header-money-sub">
              <span className={`auto-mode__header-money-percent ${autoMode.totalBetAmount > 0 ? (sessionProfit >= 0 ? 'positive' : 'negative') : ''}`}>
                수익률 {autoMode.totalBetAmount > 0
                  ? `${sessionProfit >= 0 ? '+' : ''}${((sessionProfit / autoMode.totalBetAmount) * 100).toFixed(1)}%`
                  : '0.0%'}
              </span>
              {settings.isVirtualMode && balanceHistory.length >= 2 && (
                <div className="auto-mode__header-sparkline" aria-hidden="true">
                  <svg width="120" height="18" viewBox="0 0 120 30" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
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

          {onHome && (
            <button className="auto-mode__header-btn" onClick={onHome}>
              홈
            </button>
          )}

          <button className="auto-mode__header-btn auto-mode__header-btn--logout" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </header >

      {/* Main Content */}
      {
        /* 방 데이터(rooms Map)가 있으면 Rust 소켓 상태/roomsReady와 무관하게 목록을 보인다.
           방·자동배팅 데이터는 CDP 브라우저 프레임이 공급하므로, Rust 멀티소켓이 ~10분에
           킥당해 isConnected=false/roomsReady=false가 돼도 배팅은 계속 돈다(라이브 확인 2026-05-31).
           그때 스피너로 목록을 가리면 "데이터/배팅은 멀쩡한데 UI만 뱅글뱅글"이 된다 → rooms.size로 게이팅. */
        (!isConnected && rooms.size === 0) ? (
          <main className="auto-mode__empty">
            <div className="auto-mode__empty-content">
              {(status === 'launching' || status === 'monitoring') ? (
                <>
                  <div className="auto-mode__empty-spinner" />
                  <p>{status === 'launching' ? '브라우저를 여는 중입니다…' : '카지노 연결을 기다리는 중입니다…'}</p>
                </>
              ) : status === 'error' ? (
                <p>연결에 실패했습니다. 오른쪽 위 <strong>재연결</strong>을 눌러 다시 시도하세요.</p>
              ) : (
                <p>아직 연결되지 않았습니다. 오른쪽 위 <strong>연결 시작</strong>을 누르면 방 목록을 불러옵니다.</p>
              )}
            </div>
          </main>
        ) : (!roomsReady && rooms.size === 0) ? (
          /* 방 데이터가 아직 0개일 때만 스피너 */
          <main className="auto-mode__empty">
            <div className="auto-mode__empty-content">
              <div className="auto-mode__empty-spinner" />
              <p>방 데이터 수신 중...</p>
            </div>
          </main>
        ) : (
          <div className="auto-mode__content">
            {/* 운영 바 — 한 줄: [보기 선택] [현황] [정렬]. 설명문은 버튼 title로 이동(가독성: 글자 수 줄이고 크기 키움) */}
            <section className="auto-mode__workspace-bar" aria-label="자동배팅 운영 화면">
              <div className="auto-mode__workspace-views" role="group" aria-label="화면 보기 선택">
                <button
                  className={viewMode === 'grid' ? 'active' : ''}
                  onClick={() => setViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  title="진행 중인 방의 배팅·단계·최근 결과를 크게 확인합니다."
                >
                  <LayoutGrid size={18} />
                  <span>집중 관제</span>
                </button>
                <button
                  className={viewMode === 'list' ? 'active' : ''}
                  onClick={() => setViewMode('list')}
                  aria-pressed={viewMode === 'list'}
                  title="모든 방의 상태·다음 배팅·손익을 한 줄로 비교합니다."
                >
                  <List size={18} />
                  <span>전체 비교</span>
                </button>
                <button
                  className={viewMode === 'mosaic' ? 'active' : ''}
                  onClick={() => setViewMode('mosaic')}
                  aria-pressed={viewMode === 'mosaic'}
                  title="많은 방의 이상 상태와 결과 대기를 한눈에 감시합니다."
                >
                  <LayoutTemplate size={18} />
                  <span>밀집 감시</span>
                </button>
              </div>

              <div className="auto-mode__workspace-counts" aria-label="운영 현황">
                <span>전체 <strong>{roomsForAutoModeDisplay.size}</strong></span>
                <span>대상 <strong>{filteredBettingRoomIds.length}</strong></span>
                <span className={currentBettingInfo.bettingRoomCount > 0 ? 'is-live' : ''}>
                  배팅 중 <strong>{currentBettingInfo.bettingRoomCount}</strong>
                </span>
              </div>

              <div className="auto-mode__header-sort" aria-label="방 정렬">
                <span className="auto-mode__header-sort-label">정렬</span>
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
                <button
                  className={`auto-mode__header-sort-btn auto-mode__sort-direction ${sortDirection}`}
                  onClick={toggleSortDirection}
                  title={sortDirection === 'asc' ? '오름차순' : '내림차순'}
                  aria-label={sortDirection === 'asc' ? '오름차순, 클릭하면 내림차순' : '내림차순, 클릭하면 오름차순'}
                >
                  {sortDirection === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </section>

            {/* Room Grid - 메인 영역 */}
            <main className="auto-mode__rooms">
              {viewMode === 'grid' ? (
                <AutoModeRoomGrid
                  rooms={roomsForAutoModeDisplay}
                  roomStates={roomStates}
                  autoModeRoomStates={autoModeRoomStates}
                  enabledRoomIds={enabledRoomIds}
                  settings={settings}
                  isAutoEnabled={enabled}
                  flashingRooms={flashingRooms}
                  roomBetLogs={roomBetLogs}
                  roomTimers={roomTimers}
                  selectedPattern={activeFilters.length > 0 ? activeFilters[0] : 'all'}
                  activeFilters={activeFilters}
                  matchesFilter={matchesFilter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                  roomDataVersion={roomDataVersion}
                  filterSettingsSignature={filterSettingsSignature}
                />
              ) : viewMode === 'list' ? (
                <AutoModeRoomList
                  rooms={roomsForAutoModeDisplay}
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
                  activeFilters={activeFilters}
                  matchesFilter={matchesFilter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                  setSortType={setSortType}
                  roomDataVersion={roomDataVersion}
                  filterSettingsSignature={filterSettingsSignature}
                />
              ) : (
                // mosaic view
                <AutoModeMosaic
                  rooms={Array.from(roomsForAutoModeDisplay.values())}
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
                  activeFilters={activeFilters}
                  matchesFilter={matchesFilter}
                  sortType={sortType}
                  sortDirection={sortDirection}
                  filterSettingsSignature={filterSettingsSignature}
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
        activeStructuredStrategy={activeStructuredStrategy}
        onOpenStrategyBuilder={() => {
          setShowSettings(false)
          setShowStrategyModal(true)
        }}
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
          else toggleAutoModeFilter(pattern as RoomFilterType)
          setShowPatternModal(false)
        }}
      />

      <CustomStrategyManagerModal
        isOpen={showStrategyModal}
        onClose={() => setShowStrategyModal(false)}
        activeFilter={activeFilters[0] || 'all'}
        onApply={(filter) => {
          const isOnlyActive = activeFilters.length === 1 && activeFilters[0] === filter
          if (!isOnlyActive) {
            clearAutoModeFilters()
            toggleAutoModeFilter(filter)
          }
          setShowStrategyModal(false)
          showSuccess('커스텀 전략을 저장하고 필터에 적용했습니다.')
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
        toggleFilter={toggleAutoModeFilter}
        clearFilters={clearAutoModeFilters}
        filterCounts={selectedRoomPatternCounts}
        onOpenPatternManager={() => {
          setShowPatternModal(true)
          setShowFilterDialog(false)
        }}
        onOpenStrategyManager={() => {
          setShowStrategyModal(true)
          setShowFilterDialog(false)
        }}
        freshShoeScope="auto"
      />
    </div >
  )
}
