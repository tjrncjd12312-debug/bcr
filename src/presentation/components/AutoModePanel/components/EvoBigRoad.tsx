// EvoBigRoad — Evolution 멀티위젯 타일의 '큰길'을 SVG 하나로 그린다.
// 메모리/성능: 카드 수십 장 × 셀 수백 개를 DOM 노드로 만들지 않고, 채워진 셀만 <circle>로 그린다.
// 스타일 규약(Evolution): 빈 원(링) — 뱅커 빨강 / 플레이어 파랑, 타이는 초록 사선, 페어는 모서리 점.
import { memo, useMemo } from 'react'
import type { RoadResult } from '../../../../domain/entities'
import { buildBigRoad, layoutBigRoad, type BigRoadModel } from '../../../../domain/roads/bigRoad'

interface EvoBigRoadProps {
  /** 미리 계산된 모델이 있으면 재사용(카드가 파생로드 예측에도 같은 모델을 쓴다) */
  model?: BigRoadModel
  history?: RoadResult[]
  rows?: number
  /** 화면에 보이는 열 수(최신 열이 오른쪽 끝) */
  visibleCols?: number
  /** 셀 한 변(px, viewBox 단위) */
  cell?: number
  className?: string
}

export const EvoBigRoad = memo(function EvoBigRoad({
  model,
  history,
  rows = 6,
  visibleCols = 26,
  cell = 14,
  className = '',
}: EvoBigRoadProps) {
  const resolved = useMemo(() => model ?? buildBigRoad(history ?? []), [model, history])
  const layout = useMemo(() => layoutBigRoad(resolved, rows), [resolved, rows])

  const width = visibleCols * cell
  const height = rows * cell
  const startCol = Math.max(0, layout.colsUsed - visibleCols)
  const r = cell * 0.34
  const pr = Math.max(1.6, cell * 0.11)

  if (layout.cells.length === 0) {
    return (
      <div className={`evo-road evo-road--empty ${className}`.trim()} aria-label="게임 기록 없음">
        기록 수집 중
      </div>
    )
  }

  return (
    <svg
      className={`evo-road ${className}`.trim()}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMinYMid meet"
      role="img"
      aria-label={`큰길 ${layout.cells.length}판, 오른쪽이 최신`}
    >
      {/* 격자선 — 셀 경계를 은은하게 */}
      <g className="evo-road__grid">
        {Array.from({ length: rows + 1 }).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={i * cell} x2={width} y2={i * cell} />
        ))}
        {Array.from({ length: visibleCols + 1 }).map((_, i) => (
          <line key={`v${i}`} x1={i * cell} y1={0} x2={i * cell} y2={height} />
        ))}
      </g>
      {layout.cells.map((c) => {
        if (c.col < startCol) return null
        const cx = (c.col - startCol) * cell + cell / 2
        const cy = c.row * cell + cell / 2
        const isLatest = c.originalIndex === 0
        return (
          <g key={`${c.col}:${c.row}`} className={`evo-road__cell side-${c.winner.toLowerCase()} ${isLatest ? 'is-latest' : ''}`}>
            <circle cx={cx} cy={cy} r={r} />
            {c.ties > 0 && (
              <line className="evo-road__tie" x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} />
            )}
            {c.playerPair && <circle className="evo-road__pair-p" cx={cx - r * 0.85} cy={cy - r * 0.85} r={pr} />}
            {c.bankerPair && <circle className="evo-road__pair-b" cx={cx + r * 0.85} cy={cy + r * 0.85} r={pr} />}
          </g>
        )
      })}
    </svg>
  )
})

export default EvoBigRoad
