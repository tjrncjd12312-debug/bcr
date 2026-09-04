// 바카라 빅로드(큰길)·파생로드(빅아이보이/스몰로드/바퀴벌레) 순수 계산.
// Evolution 멀티위젯 타일과 같은 정보를 그리기 위한 도메인 로직 — UI 프레임워크 무관, 부수효과 없음.
//
// 입력 history는 앱 규약대로 newest-first(history[0]이 최신)이다.
// 논리 컬럼(logical column) = 같은 승자(B/P)가 연속된 묶음. 타이는 직전 셀에 붙는다(자체 셀 없음).
// 드래곤 테일(6행 초과 시 오른쪽으로 꺾임)은 '그리기'에서만 다루고, 파생로드는 논리 컬럼 깊이로 계산한다
// (표준 규칙: 꼬리도 그 컬럼의 깊이에 포함).

import type { RoadResult, Winner } from '../entities'

export type Side = 'B' | 'P'
/** 파생로드 마크: R(빨강)=흐름 반복, B(파랑)=흐름 변화 */
export type DerivedMark = 'R' | 'B'

export interface BigRoadCell {
  winner: Side
  ties: number
  playerPair: boolean
  bankerPair: boolean
  /** history 배열(newest-first)에서의 원본 인덱스 */
  originalIndex: number
}

export interface BigRoadColumn {
  winner: Side
  cells: BigRoadCell[]
}

export interface BigRoadModel {
  columns: BigRoadColumn[]
  /** 첫 B/P 결과보다 앞서 나온 타이 수(그릴 셀이 없어 별도 보관) */
  leadingTies: number
  counts: { B: number; P: number; T: number }
}

export interface PlacedCell extends BigRoadCell {
  col: number
  row: number
}

export interface BigRoadLayout {
  cells: PlacedCell[]
  colsUsed: number
  rows: number
}

export interface DerivedPrediction {
  bigEye: DerivedMark | null
  small: DerivedMark | null
  cockroach: DerivedMark | null
}

/** history(newest-first) → 논리 컬럼 모델 */
export function buildBigRoad(history: RoadResult[]): BigRoadModel {
  const columns: BigRoadColumn[] = []
  const counts = { B: 0, P: 0, T: 0 }
  let leadingTies = 0

  // 오래된 → 최신 순으로 훑는다.
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]
    const w: Winner = r.winner
    if (w === 'T') {
      counts.T++
      const last = columns[columns.length - 1]
      if (last) last.cells[last.cells.length - 1].ties++
      else leadingTies++
      continue
    }
    counts[w]++
    const cell: BigRoadCell = {
      winner: w,
      ties: 0,
      playerPair: !!r.isPlayerPair,
      bankerPair: !!r.isBankerPair,
      originalIndex: i,
    }
    const last = columns[columns.length - 1]
    if (last && last.winner === w) last.cells.push(cell)
    else columns.push({ winner: w, cells: [cell] })
  }

  return { columns, leadingTies, counts }
}

/**
 * 논리 컬럼 → 6행 격자 배치(드래곤 테일). 같은 컬럼이 rows를 넘거나 아래 칸이 막히면 오른쪽으로 꺾인다.
 * 새 컬럼은 '직전 컬럼의 시작 열 + 1'부터 첫 빈 열에 시작한다(꼬리에 막히면 더 오른쪽).
 */
export function layoutBigRoad(model: BigRoadModel, rows = 6): BigRoadLayout {
  const occupied = new Set<string>()
  const key = (r: number, c: number) => `${r}:${c}`
  const cells: PlacedCell[] = []
  let colsUsed = 0
  let baseCol = -1

  for (const column of model.columns) {
    let startCol = baseCol + 1
    while (occupied.has(key(0, startCol))) startCol++
    baseCol = startCol

    let row = 0
    let col = startCol
    column.cells.forEach((cell, idx) => {
      if (idx > 0) {
        const nextRow = row + 1
        if (nextRow < rows && !occupied.has(key(nextRow, col))) {
          row = nextRow
        } else {
          let nextCol = col + 1
          while (occupied.has(key(row, nextCol))) nextCol++
          col = nextCol
        }
      }
      occupied.add(key(row, col))
      cells.push({ ...cell, row, col })
      colsUsed = Math.max(colsUsed, col + 1)
    })
  }

  return { cells, colsUsed, rows }
}

/** 컬럼 깊이(없으면 0) */
function depth(columns: BigRoadColumn[], c: number): number {
  return c >= 0 && c < columns.length ? columns[c].cells.length : 0
}

/**
 * 빅로드 (c,r)에 놓인 셀의 파생로드 마크. offset: 빅아이보이=1, 스몰로드=2, 바퀴벌레=3.
 * - r=0(새 컬럼): 직전 컬럼 깊이 == (직전−offset) 컬럼 깊이 → R, 아니면 B
 * - r≥1: offset 왼쪽 컬럼의 같은 행에 셀이 있으면 R; 없고 그 위(r−1)도 없으면 R; 위만 있으면 B
 * 평가 불가(초반)면 null.
 */
export function derivedMarkAt(columns: BigRoadColumn[], c: number, r: number, offset: 1 | 2 | 3): DerivedMark | null {
  if (r === 0) {
    if (c < offset + 1) return null
    return depth(columns, c - 1) === depth(columns, c - 1 - offset) ? 'R' : 'B'
  }
  if (c < offset) return null
  const left = c - offset
  const d = depth(columns, left)
  if (d >= r + 1) return 'R'
  if (d < r) return 'R' // 같은 행도, 바로 위도 비어 있음
  return 'B'
}

/** 파생로드 전체 시퀀스(오래된 → 최신) */
export function derivedRoad(columns: BigRoadColumn[], offset: 1 | 2 | 3): DerivedMark[] {
  const marks: DerivedMark[] = []
  columns.forEach((column, c) => {
    column.cells.forEach((_, r) => {
      const m = derivedMarkAt(columns, c, r, offset)
      if (m) marks.push(m)
    })
  })
  return marks
}

/** 다음 결과가 next일 때 세 파생로드에 찍힐 마크(Evolution 타일의 "P? / B?" 예측) */
export function predictDerived(columns: BigRoadColumn[], next: Side): DerivedPrediction {
  const last = columns[columns.length - 1]
  let c: number
  let r: number
  let cols = columns
  if (last && last.winner === next) {
    c = columns.length - 1
    r = last.cells.length
    // 같은 컬럼에 한 칸 추가한 상태로 깊이를 본다.
    cols = columns.map((col, i) => (i === c ? { ...col, cells: [...col.cells, col.cells[0]] } : col))
  } else {
    c = columns.length
    r = 0
    cols = [...columns, { winner: next, cells: [{ winner: next, ties: 0, playerPair: false, bankerPair: false, originalIndex: -1 }] }]
  }
  return {
    bigEye: derivedMarkAt(cols, c, r, 1),
    small: derivedMarkAt(cols, c, r, 2),
    cockroach: derivedMarkAt(cols, c, r, 3),
  }
}
