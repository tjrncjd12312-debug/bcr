# PredictModePanel 구조 분리 + 성능 최적화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2,578-line PredictModePanel.tsx into focused components with React.memo(), extract shared hooks, optimize MultiRoomPredictionService state updates, and split 6,032-line CSS.

**Architecture:** Extract 8 sub-components into individual files under `components/`, create `useRoadView` custom hook to eliminate duplicated logic between SelectedRoomDetail and FocusedRoomView, add dirty-tracking to MultiRoomPredictionService to avoid full Map deep copies, and split CSS by component.

**Tech Stack:** React 18, TypeScript 5.4, Chart.js (lazy), Vite 5

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/presentation/components/PredictModePanel/components/ShoeResetOverlay.tsx` | Shoe reset progress overlay |
| `src/presentation/components/PredictModePanel/components/SparklineGraph.tsx` | SVG sparkline trend graph |
| `src/presentation/components/PredictModePanel/components/MiniRoadmap.tsx` | Mini bead dots row |
| `src/presentation/components/PredictModePanel/components/WinRateTrendChart.tsx` | Chart.js win rate trend (lazy loaded) |
| `src/presentation/components/PredictModePanel/components/WinRateTrendChart.css` | Chart styles |
| `src/presentation/components/PredictModePanel/components/RoomCard.tsx` | Room card with prediction, stats, sparkline |
| `src/presentation/components/PredictModePanel/components/RoomCard.css` | Room card styles |
| `src/presentation/components/PredictModePanel/components/SelectedRoomDetail.tsx` | Right panel detail view |
| `src/presentation/components/PredictModePanel/components/SelectedRoomDetail.css` | Detail panel styles |
| `src/presentation/components/PredictModePanel/components/CompactRoomRow.tsx` | Compact table row |
| `src/presentation/components/PredictModePanel/components/CompactRoomRow.css` | Compact row styles |
| `src/presentation/components/PredictModePanel/components/FocusedRoomView.tsx` | Full-screen focused room |
| `src/presentation/components/PredictModePanel/components/FocusedRoomView.css` | Focused view styles |
| `src/presentation/components/PredictModePanel/hooks/useRoadView.ts` | Shared roadView/scroll/stats logic |

### Modified Files
| File | Change |
|------|--------|
| `src/presentation/components/PredictModePanel/PredictModePanel.tsx` | Remove sub-components, import from `./components/`, add useRef for hot room monitoring |
| `src/presentation/components/PredictModePanel/PredictModePanel.css` | Remove component-specific styles, keep layout + header + shared animations |
| `src/application/services/MultiRoomPredictionService.ts` | Add dirtyRooms tracking, optimize getState() |

---

## Task 1: Create `components/` and `hooks/` directories

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/` (directory)
- Create: `src/presentation/components/PredictModePanel/hooks/` (directory)

- [ ] **Step 1: Create directories**

```bash
mkdir -p src/presentation/components/PredictModePanel/components
mkdir -p src/presentation/components/PredictModePanel/hooks
```

- [ ] **Step 2: Verify**

```bash
ls -la src/presentation/components/PredictModePanel/components/
ls -la src/presentation/components/PredictModePanel/hooks/
```

Expected: Empty directories exist.

---

## Task 2: Extract ShoeResetOverlay

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/ShoeResetOverlay.tsx`
- Source: `PredictModePanel.tsx` lines 62-91

- [ ] **Step 1: Create ShoeResetOverlay.tsx**

```tsx
import { memo } from 'react'

const MIN_HISTORY_FOR_PREDICTION = 5

interface ShoeResetOverlayProps {
  historyLength: number
}

export const ShoeResetOverlay = memo(function ShoeResetOverlay({ historyLength }: ShoeResetOverlayProps) {
  const progress = Math.min((historyLength / MIN_HISTORY_FOR_PREDICTION) * 100, 100)

  return (
    <div className="shoe-reset-overlay">
      <div className="shoe-reset-overlay__icon">🔄</div>
      <div className="shoe-reset-overlay__text">슈 초기화</div>
      <div className="shoe-reset-overlay__subtext">
        예측을 위해 최소 {MIN_HISTORY_FOR_PREDICTION}게임이 필요합니다
      </div>
      <div className="shoe-reset-overlay__progress">
        <div className="shoe-reset-overlay__progress-bar">
          <div
            className="shoe-reset-overlay__progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="shoe-reset-overlay__progress-text">
          {historyLength}/{MIN_HISTORY_FOR_PREDICTION}
        </span>
      </div>
    </div>
  )
})

export { MIN_HISTORY_FOR_PREDICTION }
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Compiles without errors (file not imported yet, just validates syntax).

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/ShoeResetOverlay.tsx
git commit -m "refactor: extract ShoeResetOverlay component with memo"
```

---

## Task 3: Extract SparklineGraph

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/SparklineGraph.tsx`
- Source: `PredictModePanel.tsx` lines 1168-1229

- [ ] **Step 1: Create SparklineGraph.tsx**

```tsx
import { memo, useMemo } from 'react'

interface SparklineGraphProps {
  history: Array<{ isCorrect?: boolean }>
  color?: string
}

export const SparklineGraph = memo(function SparklineGraph({ history, color = 'rgba(255, 255, 255, 0.4)' }: SparklineGraphProps) {
  const { points, areaPoints } = useMemo(() => {
    if (!history || history.length < 2) return { points: '', areaPoints: '' }

    const predictionHistory = history.filter(h => h.isCorrect !== undefined).slice(-20)
    if (predictionHistory.length < 2) return { points: '', areaPoints: '' }

    const width = 300
    const height = 100
    const step = width / (predictionHistory.length - 1)

    let currentScore = 50
    const pts = predictionHistory.map((h, i) => {
      if (h.isCorrect) currentScore = Math.min(currentScore + 15, 90)
      else currentScore = Math.max(currentScore - 15, 10)
      return `${i * step},${height - currentScore}`
    })

    const linePoints = pts.join(' ')
    const areaPts = `0,${height} ${linePoints} ${width},${height}`

    return { points: linePoints, areaPoints: areaPts }
  }, [history])

  if (!points) return null

  const gradientId = `sparkline-grad-${Math.random().toString(36).substr(2, 9)}`

  return (
    <div className="sparkline-container">
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" className="sparkline-svg">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
          style={{
            opacity: 0.6,
            filter: `drop-shadow(0 0 5px ${color})`
          }}
        />
      </svg>
    </div>
  )
})
```

- [ ] **Step 2: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/SparklineGraph.tsx
git commit -m "refactor: extract SparklineGraph component with memo"
```

---

## Task 4: Extract MiniRoadmap

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/MiniRoadmap.tsx`
- Source: `PredictModePanel.tsx` lines 1231-1252

- [ ] **Step 1: Create MiniRoadmap.tsx**

```tsx
import { memo, useMemo } from 'react'

interface MiniRoadmapProps {
  history: Array<{ winner: 'B' | 'P' | 'T' }>
  limit?: number
}

export const MiniRoadmap = memo(function MiniRoadmap({ history, limit = 24 }: MiniRoadmapProps) {
  const road = useMemo(() => {
    return history.slice(0, limit).reverse()
  }, [history, limit])

  return (
    <div className="mini-roadmap">
      {road.map((h, i) => (
        <div
          key={i}
          className={`mini-roadmap__dot ${h.winner.toLowerCase()}`}
          title={h.winner === 'B' ? 'Banker' : h.winner === 'P' ? 'Player' : 'Tie'}
        />
      ))}
    </div>
  )
})
```

- [ ] **Step 2: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/MiniRoadmap.tsx
git commit -m "refactor: extract MiniRoadmap component with memo"
```

---

## Task 5: Extract WinRateTrendChart with lazy Chart.js

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/WinRateTrendChart.tsx`
- Create: `src/presentation/components/PredictModePanel/components/WinRateTrendChart.css`
- Source: `PredictModePanel.tsx` lines 1254-1334

- [ ] **Step 1: Create WinRateTrendChart.tsx with lazy loading**

```tsx
import { memo, useMemo, useEffect, useRef, lazy, Suspense } from 'react'
import type { ChartOptions, ChartData } from 'chart.js'
import './WinRateTrendChart.css'

const LazyLine = lazy(() =>
  import('react-chartjs-2').then(m => ({ default: m.Line }))
)

let chartRegistered = false

function registerChartModules() {
  if (chartRegistered) return
  import('chart.js').then(({ Chart, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Filler, Legend }) => {
    Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Filler, Legend)
    chartRegistered = true
  })
}

interface WinRateTrendChartProps {
  history: Array<{ isCorrect?: boolean }>
}

export const WinRateTrendChart = memo(function WinRateTrendChart({ history }: WinRateTrendChartProps) {
  const registeredRef = useRef(false)

  useEffect(() => {
    if (!registeredRef.current) {
      registerChartModules()
      registeredRef.current = true
    }
  }, [])

  const chartData = useMemo(() => {
    const accuracyHistory = history
      .filter(h => h.isCorrect !== undefined)
      .slice(-30)

    if (accuracyHistory.length === 0) return null

    let correct = 0
    const dataPoints = accuracyHistory.map((h, i) => {
      if (h.isCorrect) correct++
      return (correct / (i + 1)) * 100
    })

    const labels = dataPoints.map((_, i) => i + 1)

    return {
      labels,
      datasets: [
        {
          label: '승률 추이',
          data: dataPoints,
          borderColor: 'rgba(212, 175, 55, 0.8)',
          backgroundColor: 'rgba(212, 175, 55, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2,
        }
      ]
    } as ChartData<'line'>
  }, [history])

  if (!chartData) return null

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(15, 15, 20, 0.9)',
        titleColor: '#fff',
        bodyColor: '#fff',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        padding: 10,
        displayColors: false,
        callbacks: {
          label: (context) => `승률: ${(context.parsed.y ?? 0).toFixed(1)}%`
        }
      }
    },
    scales: {
      x: { display: false },
      y: {
        min: 0,
        max: 100,
        ticks: {
          color: 'rgba(255,255,255,0.4)',
          font: { size: 10 },
          callback: (val) => `${val}%`,
          stepSize: 25
        },
        grid: {
          color: 'rgba(255,255,255,0.05)'
        }
      }
    }
  }

  return (
    <div className="room-detail__winrate-chart anim-fade-in">
      <div className="chart-label">실시간 예측 적중률 분석</div>
      <div className="chart-wrapper">
        <Suspense fallback={<div className="chart-loading">차트 로딩 중...</div>}>
          <LazyLine data={chartData} options={options} />
        </Suspense>
      </div>
    </div>
  )
})
```

- [ ] **Step 2: Extract WinRateTrendChart.css**

Extract the `.room-detail__winrate-chart`, `.chart-label`, `.chart-wrapper`, `.chart-loading` selectors from `PredictModePanel.css` into `WinRateTrendChart.css`. Search the CSS file for these selectors and move them.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/WinRateTrendChart.tsx
git add src/presentation/components/PredictModePanel/components/WinRateTrendChart.css
git commit -m "refactor: extract WinRateTrendChart with lazy Chart.js loading"
```

---

## Task 6: Create useRoadView hook

**Files:**
- Create: `src/presentation/components/PredictModePanel/hooks/useRoadView.ts`
- Source: Duplicated logic from `PredictModePanel.tsx` lines 1517-1627 (SelectedRoomDetail) and 2023-2144 (FocusedRoomView)

- [ ] **Step 1: Create useRoadView.ts**

```tsx
import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Room, RoomPredictionState, RoadResult } from '../../../../domain/entities'
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
  beadHistory: RoadResult[]
  bigRoadHistory: RoadResult[]
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
        won: lastResult
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
    roadView, toggleRoadView,
    isOneRow, isThreeRow, beadRows,
    historyPlateRef, bigRoadCols,
    beadHistory, bigRoadHistory, predictionMap,
    stats, currentStreak, patternLabel,
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/PredictModePanel/hooks/useRoadView.ts
git commit -m "refactor: extract useRoadView hook to eliminate duplicated logic"
```

---

## Task 7: Extract RoomCard

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/RoomCard.tsx`
- Create: `src/presentation/components/PredictModePanel/components/RoomCard.css`
- Source: `PredictModePanel.tsx` lines 1336-1500

- [ ] **Step 1: Create RoomCard.tsx**

```tsx
import { memo, useMemo } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import { SparklineGraph } from './SparklineGraph'
import { MiniRoadmap } from './MiniRoadmap'
import './RoomCard.css'

interface RoomCardProps {
  room: Room
  state: RoomPredictionState | null
  isSelected: boolean
  isHot?: boolean
  isFlashing: boolean
  isShoeChange?: boolean
  lastResult: boolean | undefined
  martingaleLevel?: number
  roomTimer?: number
  onClick: () => void
}

export const RoomCard = memo(function RoomCard({ room, state, isSelected, isHot, isFlashing, isShoeChange, lastResult, martingaleLevel, roomTimer, onClick }: RoomCardProps) {
  const prediction = state?.lastPrediction?.prediction
  const winRate = state?.stats.winRate
  const timerSeconds = typeof roomTimer === 'number' && roomTimer > 0 ? roomTimer : room.remainingSeconds
  const consecutiveWins = state?.stats.consecutiveWins || 0
  const consecutiveLosses = state?.stats.consecutiveLosses || 0
  const maxConsecutiveWins = state?.stats.maxConsecutiveWins || 0
  const maxConsecutiveLosses = state?.stats.maxConsecutiveLosses || 0

  const showPrediction = lastResult === undefined

  const predictionRecords = useMemo(() => {
    return room.history as any[]
  }, [room.history])

  const streakType = consecutiveWins >= 2 ? 'win' : consecutiveLosses >= 2 ? 'loss' : null
  const streakCount = streakType === 'win' ? consecutiveWins : consecutiveLosses

  const renderPrediction = () => {
    if (!showPrediction) return (
      <div className="room-card__prediction-large analyzing anim-pulse">
        <span className="dot"></span>
        분석 중...
      </div>
    )

    if (prediction || state?.lastPrediction?.isSkip) {
      return (
        <div className="room-card__prediction-large anim-fade-in">
          <PredictionIcon prediction={prediction} size="md" isSkip={state?.lastPrediction?.isSkip} />
        </div>
      )
    }

    return (
      <div className="room-card__prediction-large analyzing anim-pulse">
        <span className="dot"></span>
        분석 중...
      </div>
    )
  }

  return (
    <button
      className={`room-card ${isSelected ? 'selected' : ''} ${isFlashing ? 'flashing' : ''} ${isHot ? 'is-hot' : ''} ${prediction && showPrediction ? `predict-${prediction.toLowerCase()}` : ''}`}
      onClick={onClick}
    >
      <SparklineGraph history={predictionRecords} />
      <div className="room-card__left">
        <div className="room-card__name">
          <div className="live-indicator">
            <span className="live-dot"></span>
            라이브
          </div>
          <span className="room-name-text">{room.koreanName || room.name}</span>
          {martingaleLevel !== undefined && martingaleLevel > 0 && (
            <span className={`room-card__martin-badge ${martingaleLevel >= 3 ? 'danger' : ''}`}>
              {martingaleLevel}M
            </span>
          )}
          {typeof timerSeconds === 'number' && timerSeconds > 0 && (
            <span className="room-card__timer">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
              </svg>
              {timerSeconds}s
            </span>
          )}
          {isShoeChange && (
            <span className="room-card__shoe-badge">🔄 NEW</span>
          )}
        </div>
        <MiniRoadmap history={room.history} />
      </div>

      <div className="room-card__center">
        {renderPrediction()}
      </div>

      <div className="room-card__right">
        <div className="room-stat-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span>{room.history.length}</span>
        </div>
        <div className={`room-stat-item winrate ${winRate !== undefined && winRate >= 50 ? 'positive' : 'negative'}`} style={{ visibility: winRate !== undefined && state?.stats && state.stats.total > 0 ? 'visible' : 'hidden' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M22 12h-4" /><path d="M6 12H2" /><path d="M12 6V2" /><path d="M12 22v-4" />
          </svg>
          <span>{winRate !== undefined ? `${winRate.toFixed(0)}%` : '-'}</span>
        </div>
        <div className={`room-stat-item streak ${streakType || ''}`} style={{ visibility: streakType ? 'visible' : 'hidden' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.5 3.5 6.5 1 1.5 2 4.5-.5 7-2.5 2.5-6 1.5-7-1.5z" />
          </svg>
          <span>{streakCount}{streakType === 'win' ? '연승' : '연패'}</span>
        </div>
        <div className="room-stat-item max-streak" style={{ visibility: (maxConsecutiveWins > 0 || maxConsecutiveLosses > 0) ? 'visible' : 'hidden' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <span className="max-win">{maxConsecutiveWins}</span>
          <span className="max-sep">/</span>
          <span className="max-loss">{maxConsecutiveLosses}</span>
        </div>
      </div>

      {lastResult !== undefined && (
        <div className={`room-card__result ${lastResult ? 'correct' : 'incorrect'}`}>
          {lastResult ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          )}
        </div>
      )}
    </button>
  )
})
```

- [ ] **Step 2: Extract RoomCard.css**

From `PredictModePanel.css`, extract all selectors matching: `.room-card`, `.room-card__*`, `.room-stat-item`, `.sparkline-*`, `.mini-roadmap`, `.shoe-reset-overlay`, `.live-indicator`, `.live-dot`, `.room-name-text`. Move them into `RoomCard.css`. Include any related `@keyframes` used by these selectors.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/RoomCard.tsx
git add src/presentation/components/PredictModePanel/components/RoomCard.css
git commit -m "refactor: extract RoomCard component with memo and CSS"
```

---

## Task 8: Extract SelectedRoomDetail (using useRoadView)

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/SelectedRoomDetail.tsx`
- Create: `src/presentation/components/PredictModePanel/components/SelectedRoomDetail.css`
- Source: `PredictModePanel.tsx` lines 1502-1814

- [ ] **Step 1: Create SelectedRoomDetail.tsx using useRoadView hook**

```tsx
import { memo } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import { BeadPlate } from '../../MainScreen/components/BeadPlate'
import { BigRoad } from '../../MainScreen/components/BigRoad'
import ThreeRowOXGrid from '../ThreeRowOXGrid'
import { ShoeResetOverlay, MIN_HISTORY_FOR_PREDICTION } from './ShoeResetOverlay'
import { WinRateTrendChart } from './WinRateTrendChart'
import { useRoadView } from '../hooks/useRoadView'
import './SelectedRoomDetail.css'

interface SelectedRoomDetailProps {
  room: Room
  state: RoomPredictionState | null
  lastResult?: boolean
  onEnterRoom: (roomId: string) => void
}

export const SelectedRoomDetail = memo(function SelectedRoomDetail({ room, state, lastResult, onEnterRoom }: SelectedRoomDetailProps) {
  const prediction = state?.lastPrediction?.prediction
  const rawConfidence = state?.lastPrediction?.confidence || 0
  const normalizedConfidence = rawConfidence > 1 ? rawConfidence / 100 : rawConfidence
  const confidenceRatio = Math.min(Math.max(normalizedConfidence, 0), 1)
  const confidencePercent = Math.round(confidenceRatio * 100)

  const road = useRoadView({ room, state, lastResult, beadCols: 12 })

  return (
    <>
      {/* Immersive Hero Section */}
      <div className={`detail-hero ${prediction ? `predict-${prediction.toLowerCase()}` : ''}`}>
        <div className="detail-header">
          <div className="detail-header__left">
            <div className="detail-header__name">{room.koreanName || room.name}</div>
            <div className="detail-header__games">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
              <span>{room.history.length} 게임 분석</span>
            </div>
          </div>
          <button className="detail-enter-btn top-action" onClick={() => onEnterRoom(room.id)}>
            <span>방입장</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        <div className="detail-prediction">
          <div className="detail-prediction__label">
            <span className="live-dot"></span>
            AI 실시간 예측
          </div>
          {prediction || state?.lastPrediction?.isSkip ? (
            <div className="detail-prediction__main-row">
              <div className="confidence-gauge">
                <svg className="gauge-svg" viewBox="0 0 100 100">
                  <circle className="gauge-bg" cx="50" cy="50" r="45" />
                  <circle
                    className="gauge-progress"
                    cx="50" cy="50" r="45"
                    style={{
                      strokeDasharray: 283,
                      strokeDashoffset: 283 - (283 * confidenceRatio)
                    }}
                  />
                </svg>
                <div className="gauge-text">
                  <span className="gauge-percent">{confidencePercent}%</span>
                  <span className="gauge-label">신뢰도</span>
                </div>
              </div>
              <div className="detail-prediction__value">
                <PredictionIcon prediction={prediction} size="lg" isSkip={state?.lastPrediction?.isSkip} />
              </div>
            </div>
          ) : (
            <div className="detail-prediction__value analyzing">분석 중...</div>
          )}

          {prediction && state && (
            <div className="detail-prediction__xai anim-fade-in">
              <div className="xai-chip" title="예측 누적 횟수">
                <span className="label">예측횟수</span>
                <span className="value">{state.stats.total}회</span>
              </div>
              <div className="xai-chip" title="해당 방 전체 승률">
                <span className="label">종합집계</span>
                <span className="value">{state.stats.winRate.toFixed(0)}%</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="detail-scrollable-content">
        {/* Outcome Distribution */}
        <div className="detail-distribution">
          <div className="detail-history__title" style={{ marginBottom: '12px', padding: '0 4px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" />
            </svg>
            <span>실시간 승률 분포</span>
          </div>
          <div className="dist-labels">
            <span className="banker">B {road.stats.bPercent.toFixed(0)}%</span>
            <span className="tie">T {road.stats.tPercent.toFixed(0)}%</span>
            <span className="player">P {road.stats.pPercent.toFixed(0)}%</span>
          </div>
          <div className="dist-bar">
            <div className="dist-segment banker" style={{ width: `${road.stats.bPercent}%` }} />
            <div className="dist-segment tie" style={{ width: `${road.stats.tPercent}%` }} />
            <div className="dist-segment player" style={{ width: `${road.stats.pPercent}%` }} />
          </div>
        </div>

        {/* Strategic Analysis */}
        <div className="detail-history">
          <div className="detail-history__header">
            <div className="detail-history__title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              <span>{road.isOneRow ? '빅로드 (드래곤 테일)' : road.isThreeRow ? '전략 그리드 (3매 O/X)' : '데이터 그리드 (최근 6매)'}</span>
            </div>
            <div className="detail-history__actions">
              <div className="detail-history__toggle">
                <button className={road.roadView === 'six' ? 'active' : ''} onClick={() => road.toggleRoadView('six')}>6매</button>
                <button className={road.roadView === 'three' ? 'active' : ''} onClick={() => road.toggleRoadView('three')}>3매</button>
                <button className={road.roadView === 'one' ? 'active' : ''} onClick={() => road.toggleRoadView('one')}>원매</button>
              </div>
              {road.patternLabel && (
                <span className="room-card__martin-badge">{road.patternLabel}</span>
              )}
            </div>
          </div>

          <div className={`road-container ${road.isOneRow ? 'big-road' : ''} ${road.isThreeRow ? 'three-row' : ''}`} ref={road.historyPlateRef} style={{ position: 'relative' }}>
            {(room.history.length < MIN_HISTORY_FOR_PREDICTION || state?.isShoeReset) && (
              <ShoeResetOverlay historyLength={room.history.length} />
            )}
            {road.isThreeRow ? (
              <ThreeRowOXGrid state={state} nextPrediction={state?.lastPrediction?.prediction as 'B' | 'P' | 'SKIP' | null} />
            ) : road.isOneRow ? (
              <BigRoad history={road.bigRoadHistory} predictionMap={road.predictionMap} rows={road.beadRows} cols={road.bigRoadCols} gap={2} minSize={16} maxSize={34} className="big-road--compact" />
            ) : (
              <BeadPlate history={road.beadHistory} predictionMap={road.predictionMap} rows={road.beadRows} cols={12} gap={2} minSize={16} maxSize={28} />
            )}
          </div>
        </div>

        {/* Prediction Stats Bar */}
        {state && state.stats.total > 0 && (
          <div className="detail-pred-stats">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-muted)' }}>AI 적중률</span>
              <span className={state.stats.winRate >= 50 ? 'positive' : 'negative'} style={{ fontWeight: 800 }}>
                {state.stats.winRate.toFixed(1)}% ({state.stats.correct}/{state.stats.total})
              </span>
            </div>
          </div>
        )}

        <WinRateTrendChart history={room.history} />
      </div>
    </>
  )
})
```

- [ ] **Step 2: Extract SelectedRoomDetail.css**

From `PredictModePanel.css`, extract all selectors matching: `.detail-hero`, `.detail-header`, `.detail-header__*`, `.detail-prediction`, `.detail-prediction__*`, `.confidence-gauge`, `.gauge-*`, `.detail-distribution`, `.dist-*`, `.detail-history`, `.detail-history__*`, `.road-container`, `.detail-pred-stats`, `.detail-scrollable-content`, `.xai-chip`, `.detail-enter-btn`. Move them to `SelectedRoomDetail.css`.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/SelectedRoomDetail.tsx
git add src/presentation/components/PredictModePanel/components/SelectedRoomDetail.css
git commit -m "refactor: extract SelectedRoomDetail with useRoadView hook and CSS"
```

---

## Task 9: Extract CompactRoomRow

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/CompactRoomRow.tsx`
- Create: `src/presentation/components/PredictModePanel/components/CompactRoomRow.css`
- Source: `PredictModePanel.tsx` lines 2456-2578

- [ ] **Step 1: Create CompactRoomRow.tsx**

```tsx
import { memo } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import './CompactRoomRow.css'

interface CompactRoomRowProps {
  room: Room
  state: RoomPredictionState | null
  isSelected: boolean
  isHot?: boolean
  martingaleLevel?: number
  lastResult?: boolean
  roomTimer?: number
  onSelect: () => void
  onEnter: () => void
}

export const CompactRoomRow = memo(function CompactRoomRow({ room, state, isSelected, isHot, martingaleLevel, lastResult, roomTimer, onSelect, onEnter }: CompactRoomRowProps) {
  const prediction = state?.lastPrediction?.prediction
  const timerSeconds = typeof roomTimer === 'number' && roomTimer > 0 ? roomTimer : room.remainingSeconds
  const winRate = state?.stats.winRate
  const totalPreds = state?.stats.total || 0
  const correctPreds = state?.stats.correct || 0

  const counts = room.history.reduce((acc, h) => {
    if (h.winner === 'B') acc.b++
    else if (h.winner === 'P') acc.p++
    else if (h.winner === 'T') acc.t++
    return acc
  }, { b: 0, p: 0, t: 0 })

  return (
    <div
      className={`compact-row ${isSelected ? 'selected' : ''} ${isHot ? 'is-hot' : ''} ${prediction ? `predict-${prediction.toLowerCase()}` : ''}`}
      onClick={onSelect}
    >
      <div className="col-name">
        <span className="name-text">{room.koreanName || room.name}</span>
        {martingaleLevel !== undefined && martingaleLevel > 0 && (
          <span className={`badge-martin ${martingaleLevel >= 3 ? 'danger' : ''}`}>{martingaleLevel}M</span>
        )}
      </div>
      <div className="col-prediction">
        {prediction || state?.lastPrediction?.isSkip ? (
          <PredictionIcon prediction={prediction} size="sm" isSkip={state?.lastPrediction?.isSkip} />
        ) : (
          <span className="analyzing-dots">...</span>
        )}
      </div>
      <div className="col-result">
        {lastResult !== undefined && (
          <span className={`result-tag ${lastResult ? 'win' : 'loss'}`}>
            {lastResult ? '적중' : '미적중'}
          </span>
        )}
      </div>
      <div className="col-counts">
        <span className="count-item b">B:{counts.b}</span>
        <span className="count-item p">P:{counts.p}</span>
        <span className="count-item t">T:{counts.t}</span>
      </div>
      <div className="col-streak">
        {state?.stats && (state.stats.consecutiveWins >= 2 || state.stats.consecutiveLosses >= 2) && (
          <span className={`streak-tag ${state.stats.consecutiveWins >= 2 ? 'win' : 'loss'}`}>
            {state.stats.consecutiveWins >= 2 ? `${state.stats.consecutiveWins}연승` : `${state.stats.consecutiveLosses}연패`}
          </span>
        )}
      </div>
      <div className="col-max-streak">
        {state?.stats && (state.stats.maxConsecutiveWins > 0 || state.stats.maxConsecutiveLosses > 0) && (
          <span className="max-streak-tag">
            <span className="max-win">{state.stats.maxConsecutiveWins}</span>
            <span className="max-sep">/</span>
            <span className="max-loss">{state.stats.maxConsecutiveLosses}</span>
          </span>
        )}
      </div>
      <div className="col-winrate">
        {winRate !== undefined && (
          <div className="winrate-box">
            <span className={winRate >= 50 ? 'text-win' : 'text-loss'}>{winRate.toFixed(0)}%</span>
            <span className="sub-text">({correctPreds}/{totalPreds})</span>
          </div>
        )}
      </div>
      <div className="col-games">{room.history.length}</div>
      <div className="col-timer">
        {typeof timerSeconds === 'number' && timerSeconds > 0 && (
          <span className="timer-tag">{timerSeconds}s</span>
        )}
      </div>
      <div className="col-history">
        <div className="mini-bead-row">
          {room.history.slice(-15).map((h, i) => (
            <span key={i} className={`dot ${h.winner.toLowerCase()}`} />
          ))}
        </div>
      </div>
      <div className="col-action">
        <button className="compact-enter-btn" onClick={(e) => { e.stopPropagation(); onEnter() }}>
          입장
        </button>
      </div>
    </div>
  )
})
```

- [ ] **Step 2: Extract CompactRoomRow.css**

From `PredictModePanel.css`, extract all selectors matching: `.compact-header-row`, `.compact-list`, `.compact-row`, `.compact-row__*`, `.col-*`, `.badge-martin`, `.analyzing-dots`, `.result-tag`, `.count-item`, `.streak-tag`, `.max-streak-tag`, `.winrate-box`, `.timer-tag`, `.mini-bead-row`, `.compact-enter-btn`, `.name-text` (compact context). Move to `CompactRoomRow.css`.

- [ ] **Step 3: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/CompactRoomRow.tsx
git add src/presentation/components/PredictModePanel/components/CompactRoomRow.css
git commit -m "refactor: extract CompactRoomRow component with memo and CSS"
```

---

## Task 10: Extract FocusedRoomView (using useRoadView)

**Files:**
- Create: `src/presentation/components/PredictModePanel/components/FocusedRoomView.tsx`
- Create: `src/presentation/components/PredictModePanel/components/FocusedRoomView.css`
- Source: `PredictModePanel.tsx` lines 1816-2454

This is the largest sub-component. It uses `useRoadView` for shared logic but retains its own unique features: preview mode, sound, prediction animation, strategy view.

- [ ] **Step 1: Create FocusedRoomView.tsx**

Copy lines 1816-2454 from `PredictModePanel.tsx` into this file with the following changes:

1. Add imports at top:
```tsx
import { memo, useState, useEffect, useCallback, useRef } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { PredictionIcon } from '../../shared'
import { BeadPlate } from '../../MainScreen/components/BeadPlate'
import { BigRoad } from '../../MainScreen/components/BigRoad'
import ThreeRowOXGrid from '../ThreeRowOXGrid'
import { Top3Rankings } from '../Top3Rankings'
import StrategyAnalysisView from '../StrategyAnalysisView'
import { ShoeResetOverlay, MIN_HISTORY_FOR_PREDICTION } from './ShoeResetOverlay'
import { SoundManager } from '../../../../infrastructure/utils/SoundManager'
import { useRoadView } from '../hooks/useRoadView'
import './FocusedRoomView.css'
```

2. Wrap with `memo`: `export const FocusedRoomView = memo(function FocusedRoomView(...) { ... })`

3. Replace all duplicated roadView/scroll/stats/streak/pattern logic with `useRoadView` hook call:
```tsx
const road = useRoadView({
  room: displayRoom,
  state: displayState,
  lastResult: previewRoomId ? undefined : lastResult,
  beadCols: 16
})
```

4. Replace direct variable references:
   - `roadView` → `road.roadView`
   - `toggleRoadView(...)` → `road.toggleRoadView(...)`
   - `isOneRow` → `road.isOneRow`
   - `isThreeRow` → `road.isThreeRow`
   - `beadRows` → `road.beadRows`
   - `historyPlateRef` → `road.historyPlateRef`
   - `bigRoadCols` → `road.bigRoadCols`
   - `beadHistory` → `road.beadHistory`
   - `bigRoadHistory` → `road.bigRoadHistory`
   - `predictionMap` → `road.predictionMap`
   - `bankerCount` → `road.stats.bankerCount`
   - `playerCount` → `road.stats.playerCount`
   - `tieCount` → `road.stats.tieCount`
   - `totalGames` → `road.stats.totalGames`
   - `bankerRatio` → `road.stats.bPercent`
   - `playerRatio` → `road.stats.pPercent`
   - `currentStreak` → `road.currentStreak`
   - `patternLabel` → `road.patternLabel`

5. Keep unique FocusedRoomView logic as-is:
   - `previewRoomId` state
   - Sound management (`soundEnabled`, `initSound`, `toggleSound`, SoundManager effects)
   - Prediction animation (`predictionKey`, `isNewPrediction`)
   - Strategy view toggle (`showStrategy`)
   - `beadCols` const = 16

6. Remove these localStorage key constants (already in useRoadView or local):
   - `FOCUSED_ROAD_VIEW_KEY` — handled by useRoadView
   - Keep `SOUND_ENABLED_KEY` and `STRATEGY_VIEW_KEY` local to this file

- [ ] **Step 2: Extract FocusedRoomView.css**

From `PredictModePanel.css`, extract all selectors matching: `.focused-room-v2`, `.focused-room-v2__*`, `.prediction-bar`, `.prediction-bar__*`, `.bead-area`, `.bead-area__*`, `.quick-pill`, `.preview-*`, `.stat-item`, `.stat-divider`, `.stat-label`, `.stat-value`, `.stat-percent`, `.offline-badge`, `.offline-dot`, `.secondary-label`, `.primary-label`, `.history-count` (focused context). Include related `@keyframes`.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/PredictModePanel/components/FocusedRoomView.tsx
git add src/presentation/components/PredictModePanel/components/FocusedRoomView.css
git commit -m "refactor: extract FocusedRoomView with useRoadView hook, memo, and CSS"
```

---

## Task 11: Rewrite PredictModePanel.tsx to import extracted components

**Files:**
- Modify: `src/presentation/components/PredictModePanel/PredictModePanel.tsx`

- [ ] **Step 1: Replace entire file with orchestrator version**

The new `PredictModePanel.tsx` should:

1. **Remove** all Chart.js imports and `ChartJS.register(...)` (lines 6-59)
2. **Remove** `ShoeResetOverlay` component (lines 62-91)
3. **Remove** `SparklineGraph` component (lines 1168-1229)
4. **Remove** `MiniRoadmap` component (lines 1231-1252)
5. **Remove** `WinRateTrendChart` component (lines 1254-1334)
6. **Remove** `RoomCard` component (lines 1336-1500)
7. **Remove** `SelectedRoomDetail` component (lines 1502-1814)
8. **Remove** `FocusedRoomView` component (lines 1816-2454)
9. **Remove** `CompactRoomRow` component (lines 2456-2578)
10. **Remove** unused constants: `SOUND_ENABLED_KEY`, `FOCUSED_ROAD_VIEW_KEY`, `STRATEGY_VIEW_KEY`

**Add** imports at top:
```tsx
import { RoomCard } from './components/RoomCard'
import { SelectedRoomDetail } from './components/SelectedRoomDetail'
import { FocusedRoomView } from './components/FocusedRoomView'
import { CompactRoomRow } from './components/CompactRoomRow'
import { MIN_HISTORY_FOR_PREDICTION } from './components/ShoeResetOverlay'
```

**Keep** `SELECTED_ROOMS_KEY` and `VIEW_MODE_KEY` constants.

**Add** Hot Room monitoring useRef optimization (lines 467-493):
```tsx
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
      if (state.stats.total >= 5 && state.stats.winRate >= 85) {
        addAlert(`${room.koreanName || room.name}: 85% 이상의 압도적 적중률!`, 'hot')
      }
      if (state.stats.consecutiveWins >= 3) {
        addAlert(`${room.koreanName || room.name}: ${state.stats.consecutiveWins}연속 적중 중!`, 'win')
      }
      if ((getMartinLevelRef.current(roomId) || 0) >= 4) {
        addAlert(`${room.koreanName || room.name}: 마틴 4단계 진입 - 주의 요망`, 'risk')
      }
    })
  }, 20000)
  return () => clearInterval(interval)
}, [status, addAlert])
```

The JSX template stays the same — it already references `<RoomCard>`, `<SelectedRoomDetail>`, `<FocusedRoomView>`, `<CompactRoomRow>` by name.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Compiles without errors. All imports resolve.

- [ ] **Step 3: Run tests**

Run: `npm run test:run`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/PredictModePanel/PredictModePanel.tsx
git commit -m "refactor: slim PredictModePanel to orchestrator, import extracted components"
```

---

## Task 12: Trim PredictModePanel.css

**Files:**
- Modify: `src/presentation/components/PredictModePanel/PredictModePanel.css`

- [ ] **Step 1: Remove extracted selectors**

After Tasks 5, 7, 8, 9, 10 moved selectors to component CSS files, remove those same selectors from `PredictModePanel.css`. What remains should be:

- CSS custom properties in `.predict-panel` (lines 15-61)
- `.predict-panel` main container (lines 66-81)
- `.predict-header` and all `.predict-header__*` selectors
- `.predict-content` layout
- `.predict-rooms`, `.predict-empty`, `.predict-loading` states
- `.predict-detail__empty` (right panel empty state)
- `.room-grid` layout (grid definition only, not room-card styles)
- `.predict-compact` layout wrapper
- `.predict-lobby-wrapper` layout
- `.predict-alerts`, `.alert-toast` selectors
- `.win-celebration`, `.particles`, `.particle` selectors
- Shared `@keyframes`: `anim-fade-in`, `anim-pulse`, `anim-slide-in`, `flashing`
- `.predict-detail` (aside layout)

- [ ] **Step 2: Verify CSS line count**

```bash
wc -l src/presentation/components/PredictModePanel/PredictModePanel.css
wc -l src/presentation/components/PredictModePanel/components/*.css
```

The sum of all CSS files should approximately equal 6,032 (original line count).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Compiles without errors. Styles render correctly.

- [ ] **Step 4: Commit**

```bash
git add src/presentation/components/PredictModePanel/PredictModePanel.css
git commit -m "refactor: trim PredictModePanel.css, keep layout + header + shared animations"
```

---

## Task 13: Optimize MultiRoomPredictionService with dirtyRooms

**Files:**
- Modify: `src/application/services/MultiRoomPredictionService.ts` (lines 40-267, 792-811)

- [ ] **Step 1: Add dirtyRooms field**

After line 62 (the `clearTimers` field), add:

```typescript
// 🔥 Dirty tracking: only deep-copy rooms that actually changed
private dirtyRooms = new Set<string>()
```

- [ ] **Step 2: Replace getState() method**

Replace lines 253-267 with:

```typescript
getState(): MultiRoomPredictionState {
  if (this.dirtyRooms.size === 0 && this._lastEmittedState) {
    return this._lastEmittedState
  }

  const newRoomStates = new Map(this.state.roomStates)
  this.dirtyRooms.forEach(roomId => {
    const s = this.state.roomStates.get(roomId)
    if (s) {
      newRoomStates.set(roomId, {
        ...s,
        stats: { ...s.stats },
        lastPrediction: s.lastPrediction ? { ...s.lastPrediction } : null,
        history: [...s.history],
      })
    }
  })
  this.dirtyRooms.clear()

  const result = {
    ...this.state,
    roomStates: newRoomStates,
    globalStats: { ...this.state.globalStats },
  }
  this._lastEmittedState = result
  return result
}
```

Add field after `dirtyRooms`:
```typescript
private _lastEmittedState: MultiRoomPredictionState | null = null
```

- [ ] **Step 3: Add dirty marking to all room state mutations**

Find every place in the service where `roomState.xxx = ...` is written (grep output from earlier shows ~15 locations). Before each mutation block, add:

```typescript
this.dirtyRooms.add(roomId)
```

Key locations to mark dirty:
- `onShoeChange` (line 225) — add `this.dirtyRooms.add(roomId)` before mutations
- `setAutoMode` off branch (line 290) — add for each room: `this.state.roomStates.forEach((_, id) => this.dirtyRooms.add(id))`
- `onBettingPhase` room state init (line 329) — add `this.dirtyRooms.add(room.id)`
- `requestPrediction` success (line 422) — add `this.dirtyRooms.add(roomId)` 
- `onGameResult` (throughout lines 500-644) — add `this.dirtyRooms.add(roomId)`
- `resetStats` (line 734) — add for each room
- `clearAllHistories` (line 764) — add for each room

- [ ] **Step 4: Clear dirtyRooms in dispose()**

In `dispose()` method (line 833), add:
```typescript
this.dirtyRooms.clear()
this._lastEmittedState = null
```

- [ ] **Step 5: Run existing tests**

Run: `cd src-tauri && cargo test` (backend tests) and `npm run test:run` (frontend tests)
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/application/services/MultiRoomPredictionService.ts
git commit -m "perf: add dirtyRooms tracking to avoid full Map deep copy on every emit"
```

---

## Task 14: Final verification

**Files:** All modified files

- [ ] **Step 1: Full build**

```bash
npm run build
```

Expected: No TypeScript errors, bundle builds successfully.

- [ ] **Step 2: Run all tests**

```bash
npm run test:run
```

Expected: All tests pass.

- [ ] **Step 3: Verify CSS completeness**

```bash
# Count total CSS lines across all split files
cat src/presentation/components/PredictModePanel/PredictModePanel.css \
    src/presentation/components/PredictModePanel/components/*.css \
    | wc -l
```

Expected: Approximately 6,032 lines (matching original).

- [ ] **Step 4: Verify file structure**

```bash
find src/presentation/components/PredictModePanel -name '*.tsx' -o -name '*.ts' -o -name '*.css' | sort
```

Expected output:
```
src/presentation/components/PredictModePanel/PredictModePanel.css
src/presentation/components/PredictModePanel/PredictModePanel.tsx
src/presentation/components/PredictModePanel/components/CompactRoomRow.css
src/presentation/components/PredictModePanel/components/CompactRoomRow.tsx
src/presentation/components/PredictModePanel/components/FocusedRoomView.css
src/presentation/components/PredictModePanel/components/FocusedRoomView.tsx
src/presentation/components/PredictModePanel/components/MiniRoadmap.tsx
src/presentation/components/PredictModePanel/components/RoomCard.css
src/presentation/components/PredictModePanel/components/RoomCard.tsx
src/presentation/components/PredictModePanel/components/SelectedRoomDetail.css
src/presentation/components/PredictModePanel/components/SelectedRoomDetail.tsx
src/presentation/components/PredictModePanel/components/ShoeResetOverlay.tsx
src/presentation/components/PredictModePanel/components/SparklineGraph.tsx
src/presentation/components/PredictModePanel/components/WinRateTrendChart.css
src/presentation/components/PredictModePanel/components/WinRateTrendChart.tsx
src/presentation/components/PredictModePanel/hooks/useRoadView.ts
... (plus existing Top3Rankings, RankingView/, LobbyView/, etc.)
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "refactor: complete PredictModePanel optimization - component split, memo, CSS split, dirty tracking"
```
