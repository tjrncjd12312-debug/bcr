// EvoBigRoad — Evolution 멀티위젯 타일의 로드맵을 SVG 하나로 그린다.
//   view: 'big'(원매·큰길) | 'bead'(6매·주판) | 'bigeye'(2매) | 'small'(3매) | 'cockroach'(4매)
// 메모리/성능: 카드 수십 장 × 셀 수백 개를 DOM 노드로 만들지 않고, 채워진 셀만 그린다.
// 스타일 규약(Evolution): 큰길=빈 원(링), 6매=속 찬 원+글자, 2매=링, 3매=점, 4매=사선. 뱅커 빨강/플레이어 파랑/타이 초록.
import { memo, useMemo } from 'react'
import type { RoadResult } from '../../../../domain/entities'
import {
  buildBigRoad, layoutBigRoad, layoutBeadPlate, layoutDerivedRoad, derivedRoad,
  type BigRoadModel,
} from '../../../../domain/roads/bigRoad'

export type RoadView = 'big' | 'bead' | 'bigeye' | 'small' | 'cockroach'

export const ROAD_VIEWS: Array<{ value: RoadView; label: string; title: string }> = [
  { value: 'bead', label: '6매', title: '6매(주판): 결과를 순서대로 6줄로' },
  { value: 'big', label: '원매', title: '원매(큰길): 같은 결과가 이어지면 아래로' },
  { value: 'bigeye', label: '2매', title: '2매(빅아이보이): 큰길 흐름 반복/변화' },
  { value: 'small', label: '3매', title: '3매(스몰로드)' },
  { value: 'cockroach', label: '4매', title: '4매(바퀴벌레)' },
]

interface EvoBigRoadProps {
  /** 미리 계산된 모델이 있으면 재사용(카드가 파생로드 예측에도 같은 모델을 쓴다) */
  model?: BigRoadModel
  history?: RoadResult[]
  view?: RoadView
  rows?: number
  /** 화면에 보이는 열 수(최신 열이 오른쪽 끝) */
  visibleCols?: number
  /** 셀 한 변(px, viewBox 단위) */
  cell?: number
  className?: string
}

const LETTER: Record<string, string> = { B: 'B', P: 'P', T: 'T' }

export const EvoBigRoad = memo(function EvoBigRoad({
  model,
  history,
  view = 'big',
  rows = 6,
  visibleCols = 26,
  cell = 14,
  className = '',
}: EvoBigRoadProps) {
  const hist = history ?? []
  const resolved = useMemo(() => model ?? buildBigRoad(hist), [model, hist])
  const layout = useMemo(() => layoutBigRoad(resolved, rows), [resolved, rows])
  const bead = useMemo(() => (view === 'bead' ? layoutBeadPlate(hist, rows) : null), [view, hist, rows])
  const derived = useMemo(() => {
    if (view !== 'bigeye' && view !== 'small' && view !== 'cockroach') return null
    const offset = view === 'bigeye' ? 1 : view === 'small' ? 2 : 3
    return layoutDerivedRoad(derivedRoad(resolved.columns, offset), rows)
  }, [view, resolved, rows])

  const width = visibleCols * cell
  const height = rows * cell
  const r = cell * 0.34
  const pr = Math.max(1.6, cell * 0.11)

  const colsUsed = bead ? bead.colsUsed : derived ? derived.colsUsed : layout.colsUsed
  const isEmpty = bead ? bead.cells.length === 0 : derived ? derived.cells.length === 0 : layout.cells.length === 0
  const startCol = Math.max(0, colsUsed - visibleCols)

  if (isEmpty) {
    return (
      <div className={`evo-road evo-road--empty ${className}`.trim()} aria-label="게임 기록 없음">
        {derived ? '아직 그릴 수 없음' : '기록 수집 중'}
      </div>
    )
  }

  const grid = (
    <g className="evo-road__grid">
      {Array.from({ length: rows + 1 }).map((_, i) => (
        <line key={`h${i}`} x1={0} y1={i * cell} x2={width} y2={i * cell} />
      ))}
      {Array.from({ length: visibleCols + 1 }).map((_, i) => (
        <line key={`v${i}`} x1={i * cell} y1={0} x2={i * cell} y2={height} />
      ))}
    </g>
  )

  return (
    <svg
      className={`evo-road evo-road--${view} ${className}`.trim()}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMinYMid meet"
      role="img"
      aria-label={`${ROAD_VIEWS.find(v => v.value === view)?.label ?? ''} ${colsUsed}열, 오른쪽이 최신`}
    >
      {grid}
      {bead && bead.cells.map((c) => {
        if (c.col < startCol) return null
        const cx = (c.col - startCol) * cell + cell / 2
        const cy = c.row * cell + cell / 2
        return (
          <g key={`${c.col}:${c.row}`} className={`evo-road__bead side-${c.winner.toLowerCase()} ${c.originalIndex === 0 ? 'is-latest' : ''}`}>
            <circle cx={cx} cy={cy} r={r + 0.6} />
            <text x={cx} y={cy + r * 0.55} textAnchor="middle" fontSize={cell * 0.62} fontWeight="900">{LETTER[c.winner]}</text>
            {c.playerPair && <circle className="evo-road__pair-p" cx={cx - r * 0.85} cy={cy - r * 0.85} r={pr} />}
            {c.bankerPair && <circle className="evo-road__pair-b" cx={cx + r * 0.85} cy={cy + r * 0.85} r={pr} />}
          </g>
        )
      })}
      {derived && derived.cells.map((c) => {
        if (c.col < startCol) return null
        const cx = (c.col - startCol) * cell + cell / 2
        const cy = c.row * cell + cell / 2
        const cls = `evo-road__mark mark-${c.mark.toLowerCase()}`
        if (view === 'bigeye') return <circle key={`${c.col}:${c.row}`} className={`${cls} is-ring`} cx={cx} cy={cy} r={r} />
        if (view === 'small') return <circle key={`${c.col}:${c.row}`} className={`${cls} is-dot`} cx={cx} cy={cy} r={r * 0.8} />
        return <line key={`${c.col}:${c.row}`} className={`${cls} is-slash`} x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} />
      })}
      {!bead && !derived && layout.cells.map((c) => {
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
