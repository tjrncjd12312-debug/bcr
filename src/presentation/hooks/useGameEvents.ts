// useGameEvents - Custom hook for game event subscriptions
// Extracts event listener logic from MainScreen for better separation of concerns

import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  Room,
  RoomPredictionState,
  VirtualBetLog,
  VirtualBetSettings,
  BettingPhaseEvent,
  Prediction,
  GameResultEvent,
} from '../../domain/entities'
import { TauriAdapter } from '../../infrastructure/adapters/TauriAdapter'

// Chart data point type (previously from StatsChart)
export interface TimeDataPoint {
  time: string
  timestamp: number
  winRate: number
  balance: number
  profitLoss: number
  totalBets: number
  wins: number
}

// Constants
const MARTIN_DANGER_THRESHOLD = 3
const MAX_LOG_ENTRIES = 200
const MAX_CHART_POINTS = 100
const RESULT_DISPLAY_DURATION = 2000
const FLASH_DURATION = 600
const DISPLAY_TIMER_CAP = 11  // 실제 12초 카운트 시작을 사용자에는 11초로 표시

// Log entry type
export interface LogEntry {
  id: number
  time: string
  message: string
  type: 'prediction' | 'result' | 'win' | 'loss' | 'info' | 'bet'
}

// Result overlay data
export interface ResultOverlayData {
  type: 'win' | 'loss'
  roomId: string
}

// Global stats type
interface GlobalStats {
  total: number
  correct: number
  winRate: number
}

// Hook options
interface UseGameEventsOptions {
  // Data sources
  rooms: Map<string, Room>
  selectedRoom: Room | null
  roomStates: Map<string, RoomPredictionState>
  globalStats: GlobalStats
  // Virtual betting
  virtualBettingEnabled: boolean
  globalBalance: number
  virtualSettings: VirtualBetSettings
  // Event handlers from parent hooks
  onMultiRoomBetting: (event: BettingPhaseEvent, rooms: Map<string, Room>) => void
  onMultiRoomResult: (event: { roomId: string; winner: 'B' | 'P' | 'T' }, room: Room) => void
  // Event subscriptions
  onBettingPhase: (callback: (event: BettingPhaseEvent) => void) => () => void
  onCasinoGameResult: (callback: (event: GameResultEvent) => void) => () => void
  onPrediction: (callback: (roomId: string, prediction: Prediction) => void) => () => void
  onResult: (callback: (roomId: string, winner: 'B' | 'P' | 'T', won: boolean, isReplay?: boolean) => void) => () => void
  onBetLog: (callback: (log: VirtualBetLog) => void) => () => void
  // Utility functions
  formatCurrency: (amount: number) => string
  getMartingaleLevelText: (level: number) => string
  showDanger: (message: string) => void
}

// Hook result
interface UseGameEventsResult {
  // State
  bettingTimer: number
  roomTimers: Map<string, number>
  flashingRooms: Set<string>
  lastResults: Map<string, boolean>
  chartData: TimeDataPoint[]
  resultOverlay: ResultOverlayData | null
  logs: LogEntry[]
  gameResultVersion: number  // 게임 결과가 올 때마다 증가하는 버전 (실시간 업데이트 트리거용)
  // Actions
  addLog: (message: string, type: LogEntry['type']) => void
  clearLogs: () => void
}

export function useGameEvents({
  rooms,
  selectedRoom,
  roomStates,
  globalStats,
  virtualBettingEnabled,
  globalBalance,
  virtualSettings,
  onMultiRoomBetting,
  onMultiRoomResult,
  onBettingPhase,
  onCasinoGameResult,
  onPrediction,
  onResult,
  onBetLog,
  formatCurrency,
  getMartingaleLevelText,
  showDanger,
}: UseGameEventsOptions): UseGameEventsResult {
  // State
  const [bettingTimer, setBettingTimer] = useState<number>(0)
  const [roomTimers, setRoomTimers] = useState<Map<string, number>>(new Map())
  const [flashingRooms, setFlashingRooms] = useState<Set<string>>(new Set())
  const [lastResults, setLastResults] = useState<Map<string, boolean>>(new Map())
  const [chartData, setChartData] = useState<TimeDataPoint[]>([])
  const [resultOverlay, setResultOverlay] = useState<ResultOverlayData | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [gameResultVersion, setGameResultVersion] = useState<number>(0)  // 게임 결과마다 증가

  // Refs
  const logIdRef = useRef(0)
  const roomsRef = useRef(rooms)
  const selectedRoomRef = useRef(selectedRoom)
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Keep rooms ref updated
  useEffect(() => {
    roomsRef.current = rooms
  }, [rooms])

  // Keep selectedRoom ref updated
  useEffect(() => {
    selectedRoomRef.current = selectedRoom
  }, [selectedRoom])

  // Cleanup pending timers on unmount
  useEffect(() => {
    return () => {
      pendingTimersRef.current.forEach(timer => clearTimeout(timer))
      pendingTimersRef.current.clear()
    }
  }, [])

  // Add log entry
  const addLog = useCallback((message: string, type: LogEntry['type']) => {
    const now = new Date()
    const time = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setLogs(prev => [{
      id: ++logIdRef.current,
      time,
      message,
      type
    }, ...prev].slice(0, MAX_LOG_ENTRIES))
  }, [])

  const handleEventError = useCallback((context: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[useGameEvents] ${context}:`, error)
    showDanger(`${context}: ${message}`)
    addLog(`[오류] ${context}: ${message}`, 'info')
  }, [addLog, showDanger])

  // Clear logs
  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  // Helper: Schedule timer cleanup
  const scheduleTimer = useCallback((callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(timer)
      callback()
    }, delay)
    pendingTimersRef.current.add(timer)
    return timer
  }, [])

  // Subscribe to betting phase events
  useEffect(() => {
    const unsubscribe = onBettingPhase((event) => {
      try {
        const displaySeconds = Math.min(event.remainingSeconds, DISPLAY_TIMER_CAP)
        setRoomTimers(prev => {
          const next = new Map(prev)
          next.set(event.roomId, displaySeconds)
          return next
        })
        if (selectedRoom && event.roomId === selectedRoom.id) {
          setBettingTimer(displaySeconds)
        }
        onMultiRoomBetting(event, roomsRef.current)
      } catch (error) {
        handleEventError('배팅 단계 처리', error)
      }
    })
    return unsubscribe
  }, [onBettingPhase, selectedRoom, onMultiRoomBetting, handleEventError])

  // Local timer countdown
  useEffect(() => {
    if (bettingTimer <= 0) return

    const timerId = setInterval(() => {
      setBettingTimer(prev => Math.max(0, prev - 1))
    }, 1000)

    return () => clearInterval(timerId)
  }, [bettingTimer])

  // Keep selected room timer in sync with list timers to avoid drift
  useEffect(() => {
    if (!selectedRoom) return
    const current = roomTimers.get(selectedRoom.id) || 0
    setBettingTimer(current)
  }, [roomTimers, selectedRoom])

  // Countdown timers for all rooms (list 표시용)
  useEffect(() => {
    const intervalId = setInterval(() => {
      setRoomTimers(prev => {
        let changed = false
        const next = new Map<string, number>()
        prev.forEach((value, key) => {
          const nextValue = Math.max(0, value - 1)
          if (nextValue > 0) {
            next.set(key, nextValue)
          }
          if (nextValue !== value) changed = true
        })
        return changed ? next : prev
      })
    }, 1000)

    return () => clearInterval(intervalId)
  }, [])

  // Subscribe to game results from Evolution
  useEffect(() => {
    console.log('[useGameEvents] 🔌 Subscribing to casino game results...')
    const unsubEvolution = onCasinoGameResult((event) => {
      console.log(`[useGameEvents] 📥 Casino game result received: roomId=${event.roomId}, winner=${event.winner}`)
      try {
        // 🔧 CRITICAL: 서버에 결과 보고 (연패 방지 시스템 업데이트)
        // 서버의 ConsecutiveLossTracker가 정확하게 동작하려면 반드시 필요
        TauriAdapter.reportResultV2(event.roomId, event.winner)
          .then(() => {
            console.log(`[useGameEvents] ✅ Result reported to server: ${event.roomId} = ${event.winner}`)
          })
          .catch((error) => {
            // 비필수 실패 - 로컬 처리는 계속 진행
            console.warn(`[useGameEvents] ⚠️ Failed to report result to server:`, error)
          })

        // 게임 결과 버전 증가 (실시간 패턴 업데이트 트리거)
        setGameResultVersion(v => v + 1)

        // Always call onMultiRoomResult - it will fetch latest room from adapter
        // roomsRef might be stale due to RAF batching, so we create a placeholder if needed
        const room = roomsRef.current.get(event.roomId) || {
          id: event.roomId,
          name: event.roomId,
          koreanName: event.roomId,
          history: [],
          gameCount: 0,
        }
        console.log(`[useGameEvents] 📤 Calling onMultiRoomResult for ${room.koreanName}...`)
        onMultiRoomResult(event, room)

        if (selectedRoom && event.roomId === selectedRoom.id) {
          const winner = event.winner === 'B' ? 'BANKER' : event.winner === 'P' ? 'PLAYER' : 'TIE'
          addLog(`결과: ${winner}`, 'result')
        }
      } catch (error) {
        handleEventError('게임 결과 처리', error)
      }
    })
    return unsubEvolution
  }, [onCasinoGameResult, selectedRoom, onMultiRoomResult, addLog, handleEventError])

  // Subscribe to predictions
  useEffect(() => {
    const unsubscribe = onPrediction((roomId, prediction) => {
      try {
        const room = roomsRef.current.get(roomId)
        if (room) {
          // ✅ FIX: SKIP 예측 시 즉시 lastResult 클리어
          // SKIP은 실제 예측이 아니므로 O/X 배지를 표시하면 안 됨
          // 이전: 2000ms 후 클리어 → SKIP 예측에도 이전 O/X가 표시됨
          // 수정: SKIP이면 즉시 클리어, 일반 예측이면 타이머 유지
          if (prediction.isSkip) {
            // SKIP 예측: 즉시 lastResult 클리어
            setLastResults(prev => {
              const next = new Map(prev)
              next.delete(roomId)
              return next
            })
          } else {
            // 일반 예측: 기존 타이머로 클리어
            scheduleTimer(() => {
              setLastResults(prev => {
                const next = new Map(prev)
                next.delete(roomId)
                return next
              })
            }, RESULT_DISPLAY_DURATION)
          }

          // Flash animation
          setFlashingRooms(prev => new Set(prev).add(roomId))
          scheduleTimer(() => {
            setFlashingRooms(prev => {
              const next = new Set(prev)
              next.delete(roomId)
              return next
            })
          }, FLASH_DURATION)

          // Log prediction
          if (prediction.isSkip) {
            addLog(`[${room.koreanName}] 패스: ${prediction.reasoning || '스킵'}`, 'info')
          } else if (prediction.prediction) {
            const pred = prediction.prediction === 'B' ? 'BANKER' : 'PLAYER'
            const conf = Math.round((prediction.confidence || 0) * 100)
            addLog(`[${room.koreanName}] 예측: ${pred} (${conf}%)`, 'prediction')
          }
        }
      } catch (error) {
        handleEventError('예측 처리', error)
      }
    })
    return unsubscribe
  }, [onPrediction, addLog, scheduleTimer, handleEventError])

  // Subscribe to results
  useEffect(() => {
    const unsubscribe = onResult((roomId, _winner, won, isReplay) => {
      try {
        const room = roomsRef.current.get(roomId)
        const roomState = roomStates.get(roomId)

        if (room) {
          // ✅ Skip visual notifications for replay events (batch updates)
          if (!isReplay) {
            addLog(`[${room.koreanName}] ${won ? '적중!' : '실패'}`, won ? 'win' : 'loss')
          }

          // Update last results
          setLastResults(prev => {
            const next = new Map(prev)
            next.set(roomId, won)
            return next
          })

          // Show result overlay for selected room (use ref for latest value)
          const currentSelectedRoom = selectedRoomRef.current
          if (!isReplay && currentSelectedRoom && currentSelectedRoom.id === roomId) {
            setResultOverlay({ type: won ? 'win' : 'loss', roomId })
            scheduleTimer(() => setResultOverlay(null), RESULT_DISPLAY_DURATION)
          }

          // Update chart data
          const now = new Date()
          const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          const newTotal = globalStats.total + 1
          const newCorrect = globalStats.correct + (won ? 1 : 0)
          const newWinRate = newTotal > 0 ? (newCorrect / newTotal) * 100 : 0

          setChartData(prev => {
            const newPoint: TimeDataPoint = {
              time: timeStr,
              timestamp: now.getTime(),
              winRate: newWinRate,
              balance: virtualBettingEnabled ? globalBalance : virtualSettings.initialBalance,
              profitLoss: virtualBettingEnabled ? globalBalance - virtualSettings.initialBalance : 0,
              totalBets: newTotal,
              wins: newCorrect
            }
            return [...prev, newPoint].slice(-MAX_CHART_POINTS)
          })

          // Check for martin danger - 로그만 기록, 알림 제거
          if (!won && roomState) {
            const newMartin = roomState.stats.consecutiveLosses
            if (newMartin >= MARTIN_DANGER_THRESHOLD) {
              addLog(`[${room.koreanName}] 위험! ${newMartin}연패`, 'loss')
            }
          }
        }
      } catch (error) {
        handleEventError('결과 처리', error)
      }
    })
    return unsubscribe
  }, [onResult, addLog, roomStates, globalStats, globalBalance, virtualSettings.initialBalance, virtualBettingEnabled, scheduleTimer, handleEventError])

  // Subscribe to virtual bet logs
  useEffect(() => {
    const unsubscribe = onBetLog((log: VirtualBetLog) => {
      try {
        const levelText = getMartingaleLevelText(log.martingaleLevel)

        if (log.type === 'placed') {
          // 배팅 시점 로그
          const predText = log.prediction === 'B' ? '뱅커' : '플레이어'
          addLog(
            `[${log.roomName}] 배팅: ${predText} ${levelText} ${formatCurrency(log.betAmount)}`,
            'bet'
          )
        } else {
          // 결과 로그
          const resultText = log.won ? '적중' : '실패'
          addLog(
            `[${log.roomName}] ${levelText} ${formatCurrency(log.betAmount)} → ${resultText}`,
            log.won ? 'win' : 'loss'
          )
        }
      } catch (error) {
        handleEventError('배팅 로그 처리', error)
      }
    })
    return unsubscribe
  }, [onBetLog, addLog, formatCurrency, getMartingaleLevelText, handleEventError])

  return {
    bettingTimer,
    roomTimers,
    flashingRooms,
    lastResults,
    chartData,
    resultOverlay,
    logs,
    gameResultVersion,
    addLog,
    clearLogs,
  }
}
