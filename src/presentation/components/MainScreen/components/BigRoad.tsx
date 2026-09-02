// BigRoad Component - Baccarat Big Road (드래곤 테일 로직)
import { memo, useMemo, useEffect, useRef } from 'react'
import { Check, X, Minus } from 'lucide-react'
import type { RoadResult, Winner } from '../../../../domain/entities'
import { useRoadLayout } from './useRoadLayout'
import type { PredictionInfo } from './BeadPlate'
import './RoadMap.css'

interface BigRoadCell {
  winner: Winner
  isPlayerPair: boolean
  isBankerPair: boolean
  ties: number
  originalIndex: number  // 원본 history 인덱스
}

type GridCell = BigRoadCell | null

interface BigRoadResult {
  grid: GridCell[][]
  colsUsed: number
}

interface BigRoadProps {
  history: RoadResult[]
  predictionMap?: Map<number, PredictionInfo>
  rows?: number
  cols?: number
  gap?: number
  minSize?: number
  maxSize?: number
  className?: string
}

function calculateBigRoad(history: RoadResult[], rows = 6): BigRoadResult {
  const grid: GridCell[][] = Array(rows).fill(null).map(() => [])

  if (history.length === 0) return { grid, colsUsed: 0 }

  const ensureCols = (targetCol: number) => {
    if (grid[0].length > targetCol) return
    const need = targetCol - grid[0].length + 1
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < need; i++) {
        grid[r].push(null)
      }
    }
  }

  const isEmpty = (r: number, c: number) => {
    ensureCols(c)
    return grid[r][c] === null
  }

  const orderedHistory = [...history].reverse()
  let col = 0
  let row = 0
  let baseCol = 0
  let lastWinner: Winner | null = null
  let lastCell: { row: number, col: number } | null = null
  let colsUsed = 0

  orderedHistory.forEach((result, idx) => {
    const originalIndex = history.length - 1 - idx

    if (result.winner === 'T') {
      if (lastCell) {
        const cell = grid[lastCell.row][lastCell.col]
        if (cell) cell.ties += 1
      }
      return
    }

    if (!lastWinner) {
      col = 0
      row = 0
      baseCol = 0
    } else if (result.winner === lastWinner) {
      const nextRow = row + 1
      if (nextRow < rows && isEmpty(nextRow, col)) {
        row = nextRow
      } else {
        let nextCol = col + 1
        while (!isEmpty(row, nextCol)) nextCol += 1
        col = nextCol
      }
    } else {
      let nextCol = baseCol + 1
      while (!isEmpty(0, nextCol)) nextCol += 1
      baseCol = nextCol
      col = baseCol
      row = 0
    }

    ensureCols(col)
    grid[row][col] = {
      winner: result.winner,
      isPlayerPair: result.isPlayerPair,
      isBankerPair: result.isBankerPair,
      ties: 0,
      originalIndex,
    }
    lastWinner = result.winner
    lastCell = { row, col }
    colsUsed = Math.max(colsUsed, col + 1)
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

export const BigRoad = memo(function BigRoad({
  history,
  predictionMap,
  rows = 6,
  cols = 30,
  gap = 4,
  minSize = 24,
  maxSize = 40,
  className = '',
}: BigRoadProps) {
  const bigRoadData = useMemo(() => {
    return calculateBigRoad(history, rows)
  }, [history, rows])

  // 전체 컬럼을 렌더링 (startCol = 0)
  // 최소 cols개, 실제 사용된 컬럼 + 여유 2개 중 큰 값
  const totalCols = Math.max(cols, bigRoadData.colsUsed + 2)
  const startCol = 0  // 전체 데이터 렌더링

  const { containerRef, style: gridStyle } = useRoadLayout({
    cols: totalCols,
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

      // 스크롤 가능한 영역이 없으면 무시 (첫 로딩 시 크기가 0일 수 있음)
      if (scrollWidth <= clientWidth || scrollWidth === 0) return

      // 🔥 NEW: 최신 결과가 변경되면 스크롤
      const isNewResult = latestResultKey !== prevLatestResultRef.current
      prevLatestResultRef.current = latestResultKey

      if (isNewResult && bigRoadData.colsUsed > 0) {
        // 🔥 FIX: 실제 데이터가 있는 마지막 열이 보이도록 스크롤
        // 셀 너비 = 전체 스크롤 너비 / 렌더링된 컬럼 수
        const cellWidth = scrollWidth / totalCols
        // 마지막 데이터 열이 화면 오른쪽에 오도록 스크롤 (약간 여유 두기)
        const targetScroll = Math.max(0, (bigRoadData.colsUsed - 1) * cellWidth - clientWidth + cellWidth * 2)

        scrollContainer.scrollTo({
          left: targetScroll,
          behavior: 'smooth'
        })
      }
    }, 50)

    return () => clearTimeout(timer)
  }, [latestResultKey, bigRoadData.colsUsed, totalCols])

  return (
    <div className={`road-card big-road ${className}`.trim()} ref={containerRef}>
      {history.length === 0 ? (
        <div className="road-empty">아직 게임 기록이 없습니다.</div>
      ) : (
        <div
          className="road-grid-container road-grid-container--scrollable"
          style={gridStyle}
          ref={scrollContainerRef}
          role="region"
          aria-label={`큰길 게임 기록 ${history.length}개, 오른쪽이 최신`}
          tabIndex={0}
        >
          <div className="road-grid">
          {Array(totalCols).fill(0).map((_, colIdx) => {
            const gridCol = startCol + colIdx
            return (
              <div key={gridCol} className="road-col">
                {Array(rows).fill(0).map((_, rowIdx) => {
                  const cell = bigRoadData.grid[rowIdx]?.[gridCol]
                  const prediction = cell && predictionMap?.get(cell.originalIndex)

                  return (
                    <div key={rowIdx} className="road-cell">
                      {cell && (
                        <div
                          className={`road-marker ${cell.winner.toLowerCase()} solid ${prediction?.won === true ? 'predicted-win' : ''}`}
                        >
                          <span className="road-marker__label">{cell.winner}</span>
                          {cell.ties > 0 && (
                            <span className="road-marker__tie">{cell.ties}</span>
                          )}
                          {cell.isPlayerPair && <div className="pair-dot player" />}
                          {cell.isBankerPair && <div className="pair-dot banker" />}
                          {prediction && <PredictionBadge prediction={prediction} />}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
})

export default BigRoad
