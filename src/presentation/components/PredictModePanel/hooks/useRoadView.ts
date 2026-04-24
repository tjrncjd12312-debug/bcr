import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import type { PredictionInfo } from '../../MainScreen/components/BeadPlate'

const FOCUSED_ROAD_VIEW_KEY = 'predict-mode:focused-road-view'

export interface UseRoadViewOptions {
  room: Room
  state: RoomPredictionState | null
  lastResult?: boolean
  beadCols?: number
}

export interface UseRoadViewResult {
  roadView: 'six' | 'three' | 'one'
  toggleRoadView: (view: 'six' | 'three' | 'one') => void
  isOneRow: boolean
  isThreeRow: boolean
  beadRows: number
  historyPlateRef: React.RefObject<HTMLDivElement | null>
  bigRoadCols: number
  beadHistory: Room['history']
  bigRoadHistory: Room['history']
  predictionMap: Map<number, PredictionInfo>
  stats: {
    bankerCount: number
    playerCount: number
    tieCount: number
    totalGames: number
    bPercent: number
    pPercent: number
    tPercent: number
  }
  currentStreak: { winner: 'B' | 'P' | null; count: number }
  patternLabel: string | null
}

export function useRoadView({ room, state, lastResult, beadCols = 12 }: UseRoadViewOptions): UseRoadViewResult {
  // 1. roadView state + localStorage
  const [roadView, setRoadView] = useState<'six' | 'three' | 'one'>(() => {
    try {
      const saved = localStorage.getItem(FOCUSED_ROAD_VIEW_KEY)
      if (saved === 'one' || saved === 'three') return saved
      return 'six'
    } catch {
      return 'six'
    }
  })

  const toggleRoadView = useCallback((view: 'six' | 'three' | 'one') => {
    setRoadView(view)
    try {
      localStorage.setItem(FOCUSED_ROAD_VIEW_KEY, view)
    } catch { /* ignore */ }
  }, [])

  const isOneRow = roadView === 'one'
  const isThreeRow = roadView === 'three'
  const beadRows = isThreeRow ? 3 : 6

  // 2. BigRoad dynamic column calculation (ResizeObserver)
  const historyPlateRef = useRef<HTMLDivElement | null>(null)
  const [bigRoadCols, setBigRoadCols] = useState(beadCols)

  useLayoutEffect(() => {
    if (!isOneRow) return
    const el = historyPlateRef.current
    if (!el) return

    const gap = 2
    const minSize = 16

    const calculate = () => {
      const width = el.clientWidth || 0
      const usableWidth = Math.max(width - 8, minSize)
      const cols = Math.floor((usableWidth + gap) / (minSize + gap))
      setBigRoadCols(Math.max(cols, 6))
    }

    calculate()
    const observer = new ResizeObserver(calculate)
    observer.observe(el)
    return () => observer.disconnect()
  }, [isOneRow])

  // 3. Auto-scroll to latest on new results
  const prevHistoryLengthRef = useRef<number>(0)
  const prevRoomIdRef = useRef<string>('')
  const historyLength = room.history?.length || 0

  useEffect(() => {
    const isRoomChanged = room.id !== prevRoomIdRef.current
    if (isRoomChanged) {
      prevRoomIdRef.current = room.id
      prevHistoryLengthRef.current = 0
    }

    const isNewResult = historyLength > prevHistoryLengthRef.current
    prevHistoryLengthRef.current = historyLength

    if (!isNewResult && !isRoomChanged) return

    const timer = setTimeout(() => {
      const container = historyPlateRef.current
      if (container) {
        const { scrollWidth, clientWidth } = container
        if (scrollWidth > clientWidth) {
          container.scrollTo({ left: scrollWidth, behavior: 'smooth' })
        }
      }
    }, 50)

    return () => clearTimeout(timer)
  }, [historyLength, room.id])

  // 4. Memoized history slices
  const beadHistory = useMemo(() => {
    return room.history.slice(0, beadRows * beadCols)
  }, [room.history, beadRows, beadCols])

  const bigRoadHistory = useMemo(() => {
    return room.history
  }, [room.history])

  // 5. Prediction map
  const predictionMap = useMemo(() => {
    const map = new Map<number, PredictionInfo>()
    if (lastResult !== undefined && state?.lastPrediction?.prediction) {
      map.set(0, {
        predicted: state.lastPrediction.prediction as 'B' | 'P',
        won: lastResult,
      })
    }
    return map
  }, [lastResult, state?.lastPrediction?.prediction])

  // 6. B/P/T stats
  const stats = useMemo(() => {
    const bankerCount = room.history.filter(h => h.winner === 'B').length
    const playerCount = room.history.filter(h => h.winner === 'P').length
    const tieCount = room.history.filter(h => h.winner === 'T').length
    const totalGames = bankerCount + playerCount + tieCount
    const bPercent = totalGames > 0 ? (bankerCount / totalGames) * 100 : 0
    const pPercent = totalGames > 0 ? (playerCount / totalGames) * 100 : 0
    const tPercent = totalGames > 0 ? (tieCount / totalGames) * 100 : 0
    return { bankerCount, playerCount, tieCount, totalGames, bPercent, pPercent, tPercent }
  }, [room.history])

  // 7. Current streak
  const currentStreak = useMemo(() => {
    let winner: 'B' | 'P' | null = null
    let count = 0
    for (const item of room.history) {
      if (item.winner === 'T') continue
      if (!winner) {
        winner = item.winner
        count = 1
        continue
      }
      if (item.winner === winner) {
        count++
      } else {
        break
      }
    }
    return { winner, count }
  }, [room.history])

  // 8. Pattern label
  const patternLabel = useMemo(() => {
    const pattern = state?.pattern
    if (!pattern) return null
    const map: Record<string, string> = {
      alternating: '퐁당',
      streak: '장줄',
      mixed: '혼조',
    }
    const base = map[pattern.type] || pattern.type
    return `${base} ${pattern.length}`
  }, [state?.pattern])

  return {
    roadView,
    toggleRoadView,
    isOneRow,
    isThreeRow,
    beadRows,
    historyPlateRef,
    bigRoadCols,
    beadHistory,
    bigRoadHistory,
    predictionMap,
    stats,
    currentStreak,
    patternLabel,
  }
}
