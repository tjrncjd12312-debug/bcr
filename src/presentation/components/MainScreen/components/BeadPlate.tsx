// BeadPlate Component - Baccarat Bead Plate (6매) visualization
import { memo, useMemo, useEffect, useRef } from 'react'
import { Check, X, Minus } from 'lucide-react'
import type { RoadResult } from '../../../../domain/entities'
import { useRoadLayout } from './useRoadLayout'
import './RoadMap.css'

// 예측 정보 타입
export interface PredictionInfo {
  predicted: 'B' | 'P'
  won: boolean | null  // true=적중, false=실패, null=Tie(push)
}

// 그리드 셀에 원본 인덱스 추가
interface GridCellWithIndex {
  result: RoadResult
  originalIndex: number
}

type GridCell = GridCellWithIndex | null

interface BeadPlateResult {
  grid: GridCell[][]
  colsUsed: number
}

interface BeadPlateProps {
  history: RoadResult[]
  predictionMap?: Map<number, PredictionInfo>
  rows?: number
  cols?: number
  gap?: number
  minSize?: number
  maxSize?: number
  className?: string
}

/**
 * Calculate Bead Plate (6매/주판로) grid
 * Shows actual results in column-by-column, top-to-bottom order
 */
function calculateBeadPlate(history: RoadResult[], rows = 6, cols = 30): BeadPlateResult {
  const grid: GridCell[][] = Array(rows).fill(null).map(() => Array(cols).fill(null))

  if (history.length === 0) return { grid, colsUsed: 0 }

  const ensureCols = (targetCol: number) => {
    if (targetCol < grid[0].length) return
    const need = targetCol - grid[0].length + 1
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < need; i++) {
        grid[r].push(null)
      }
    }
  }

  // Fill from oldest to newest, column by column (좌→우, 상→하)
  const orderedHistory = [...history].reverse()
  let col = 0
  let row = 0
  let colsUsed = 0

  orderedHistory.forEach((result, idx) => {
    const originalIndex = history.length - 1 - idx
    ensureCols(col)
    grid[row][col] = { result, originalIndex }
    colsUsed = Math.max(colsUsed, col + 1)
    row++
    if (row >= rows) {
      row = 0
      col++
    }
  })

  return { grid, colsUsed }
}

// 예측 뱃지 컴포넌트
const PredictionBadge = memo(function PredictionBadge({
  prediction
}: {
  prediction: PredictionInfo
}) {
  const badgeClass = prediction.won === null
    ? 'push'
    : prediction.won
      ? 'win'
      : 'loss'

  return (
    <div className={`prediction-badge prediction-badge--${badgeClass}`}>
      {prediction.won === null ? (
        <Minus size={7} strokeWidth={3} />
      ) : prediction.won ? (
        <Check size={7} strokeWidth={3} />
      ) : (
        <X size={7} strokeWidth={3} />
      )}
    </div>
  )
})

export const BeadPlate = memo(function BeadPlate({
  history,
  predictionMap,
  rows = 6,
  cols = 30,
  gap = 4,
  minSize = 24,
  maxSize = 40,
  className = '',
}: BeadPlateProps) {
  const beadPlateData = useMemo(() => {
    return calculateBeadPlate(history, rows, cols)
  }, [history, rows, cols])

  const colCount = Math.min(
    Math.max(cols, beadPlateData.colsUsed),
    beadPlateData.colsUsed + 6
  )
  const { containerRef, style: gridStyle } = useRoadLayout({
    cols: colCount,
    rows,
    gap,
    minSize,
    maxSize,
  })

  // 스크롤 컨테이너 ref
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevLatestResultRef = useRef<string>('')

  // 🔥 최신 결과의 고유 키 생성 (winner + length)
  const latestResultKey = useMemo(() => {
    if (history.length === 0) return ''
    const latest = history[0]
    return `${latest.winner}-${history.length}`
  }, [history])

  // 🔥 히스토리 변경 시 자동으로 최신 결과가 보이도록 스크롤
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    const timer = setTimeout(() => {
      const { clientWidth, scrollWidth } = scrollContainer

      // 스크롤 가능한 영역이 없으면 무시
      if (scrollWidth <= clientWidth || scrollWidth === 0) return

      // 🔥 NEW: 최신 결과가 변경되면 스크롤
      const isNewResult = latestResultKey !== prevLatestResultRef.current
      prevLatestResultRef.current = latestResultKey

      if (isNewResult && beadPlateData.colsUsed > 0) {
        // 🔥 FIX: 실제 데이터가 있는 마지막 열이 보이도록 스크롤
        // 셀 너비 = 전체 스크롤 너비 / 렌더링된 컬럼 수
        const cellWidth = scrollWidth / colCount
        // 마지막 데이터 열이 화면 오른쪽에 오도록 스크롤 (약간 여유 두기)
        const targetScroll = Math.max(0, (beadPlateData.colsUsed - 1) * cellWidth - clientWidth + cellWidth * 2)

        scrollContainer.scrollTo({
          left: targetScroll,
          behavior: 'smooth'
        })
      }
    }, 50)

    return () => clearTimeout(timer)
  }, [latestResultKey, beadPlateData.colsUsed, colCount])

  return (
    <div className={`road-card bead-plate ${className}`.trim()} ref={containerRef}>
      {history.length === 0 ? (
        <div className="road-empty">아직 게임 기록이 없습니다.</div>
      ) : (
        <div
          className="road-grid-container road-grid-container--scrollable"
          style={gridStyle}
          ref={scrollContainerRef}
          role="region"
          aria-label={`비드플레이트 게임 기록 ${history.length}개, 오른쪽이 최신`}
          tabIndex={0}
        >
          <div className="road-grid">
          {Array(colCount).fill(0).map((_, colIdx) => (
            <div key={colIdx} className="road-col">
              {Array(rows).fill(0).map((_, rowIdx) => {
                const cell = beadPlateData.grid[rowIdx]?.[colIdx]
                const prediction = cell && predictionMap?.get(cell.originalIndex)

                return (
                  <div key={rowIdx} className="road-cell">
                    {cell && (
                      <div
                        className={`road-marker ${cell.result.winner.toLowerCase()} solid ${prediction?.won === true ? 'predicted-win' : ''}`}
                      >
                        <span className="road-marker__label">{cell.result.winner}</span>
                        {cell.result.isPlayerPair && <div className="pair-dot player" />}
                        {cell.result.isBankerPair && <div className="pair-dot banker" />}
                        {prediction && <PredictionBadge prediction={prediction} />}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          </div>
        </div>
      )}
    </div>
  )
})

export default BeadPlate
