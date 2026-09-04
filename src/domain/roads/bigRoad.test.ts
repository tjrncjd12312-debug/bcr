import { describe, expect, it } from 'vitest'
import type { RoadResult } from '../entities'
import { buildBigRoad, layoutBigRoad, derivedRoad, derivedMarkAt, predictDerived } from './bigRoad'

// 오래된 → 최신 순 문자열을 앱 규약(newest-first)으로 바꾼다.
function hist(seq: string): RoadResult[] {
  return seq.split('').reverse().map(ch => ({ winner: ch as 'B' | 'P' | 'T', isPlayerPair: false, isBankerPair: false }))
}

describe('buildBigRoad', () => {
  it('groups consecutive winners into columns and attaches ties to the previous cell', () => {
    const m = buildBigRoad(hist('BBTPTTBBBP'))
    expect(m.columns.map(c => `${c.winner}${c.cells.length}`)).toEqual(['B2', 'P1', 'B3', 'P1'])
    expect(m.columns[0].cells[1].ties).toBe(1)
    expect(m.columns[1].cells[0].ties).toBe(2)
    expect(m.counts).toEqual({ B: 5, P: 2, T: 3 })
    expect(m.leadingTies).toBe(0)
  })

  it('keeps ties that precede the first result as leadingTies', () => {
    const m = buildBigRoad(hist('TTB'))
    expect(m.leadingTies).toBe(2)
    expect(m.columns).toHaveLength(1)
  })

  it('records original newest-first indexes', () => {
    const m = buildBigRoad(hist('BP'))
    expect(m.columns[0].cells[0].originalIndex).toBe(1) // B는 오래된 쪽 = history[1]
    expect(m.columns[1].cells[0].originalIndex).toBe(0)
  })
})

describe('layoutBigRoad', () => {
  it('places a run longer than 6 as a dragon tail to the right', () => {
    const layout = layoutBigRoad(buildBigRoad(hist('BBBBBBBBP')), 6)
    const bs = layout.cells.filter(c => c.winner === 'B')
    expect(bs.map(c => [c.col, c.row])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 5], [2, 5]])
    // 다음 P 컬럼은 꼬리가 없는 1열에서 시작(꼬리는 5행에만 있음)
    const p = layout.cells.find(c => c.winner === 'P')!
    expect([p.col, p.row]).toEqual([1, 0])
    expect(layout.colsUsed).toBe(3)
  })

  it('shifts a new column right when the tail blocks its top cell', () => {
    // B×7 → 꼬리 (1,5); 그 다음 P×6이 1열을 차지하려면 (1,5)가 막혀 P의 6번째는 오른쪽으로 꺾인다
    const layout = layoutBigRoad(buildBigRoad(hist('BBBBBBBPPPPPP')), 6)
    const ps = layout.cells.filter(c => c.winner === 'P')
    expect(ps.map(c => [c.col, c.row])).toEqual([[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [2, 4]])
  })
})

describe('derived roads', () => {
  it('big eye boy starts at the second entry of column 2 (or the first entry of column 3)', () => {
    // 컬럼 깊이 [1,1,...]: 3번째 컬럼 첫 셀 → 직전(1) == 직전-1(1) → R
    const cols = buildBigRoad(hist('BPB')).columns
    expect(derivedMarkAt(cols, 0, 0, 1)).toBeNull()
    expect(derivedMarkAt(cols, 1, 0, 1)).toBeNull()
    expect(derivedMarkAt(cols, 2, 0, 1)).toBe('R')
    // 2번째 컬럼 2번째 셀: 왼쪽 컬럼 같은 행 없음, 위(0행)는 있음 → B
    const cols2 = buildBigRoad(hist('BPP')).columns
    expect(derivedMarkAt(cols2, 1, 1, 1)).toBe('B')
  })

  it('marks R when the cell to the left exists and R when both it and the cell above are empty', () => {
    // BB PP → (1,1): 왼쪽 컬럼 깊이 2 ≥ 2 → R
    expect(derivedMarkAt(buildBigRoad(hist('BBPP')).columns, 1, 1, 1)).toBe('R')
    // B PPP → (1,2): 왼쪽 깊이 1 < 2 (같은 행도 위도 없음) → R
    expect(derivedMarkAt(buildBigRoad(hist('BPPP')).columns, 1, 2, 1)).toBe('R')
  })

  it('produces the textbook big eye boy sequence for a sample shoe', () => {
    // 표준 예제: B P B B P P P B → 컬럼 [B1,P1,B2,P3,B1]
    const cols = buildBigRoad(hist('BPBBPPPB')).columns
    // 평가 순서: (2,0)=R[1==1], (2,1)=B[왼쪽 P1: 같은 행 없음·위 있음], (3,0)=B[2!=1], (3,1)=R[B2 깊이2≥2],
    //            (3,2)=R[깊이2 < 2? 아니오 → 같은 행 없음, 위 있음 → B]… 검산: depth=2, r=2 → d>=3? no, d<2? no → B
    //            (4,0)= depth(3)=3 vs depth(2)=2 → B
    expect(derivedRoad(cols, 1)).toEqual(['R', 'B', 'B', 'R', 'B', 'B'])
  })

  it('small road and cockroach use offsets 2 and 3', () => {
    const cols = buildBigRoad(hist('BPBPBP')).columns // 깊이 전부 1
    expect(derivedRoad(cols, 2)).toEqual(['R', 'R', 'R']) // (3,0),(4,0),(5,0)
    expect(derivedRoad(cols, 3)).toEqual(['R', 'R'])      // (4,0),(5,0)
  })

  it('predicts the next marks for a hypothetical P or B', () => {
    const cols = buildBigRoad(hist('BPBBP')).columns // [B1,P1,B2,P1]
    // 다음 P → 컬럼3 깊이 2, (3,1): 왼쪽 B2 같은 행 있음 → R
    expect(predictDerived(cols, 'P').bigEye).toBe('R')
    // 다음 B → 새 컬럼4 (4,0): depth(3)=1 vs depth(2)=2 → B
    expect(predictDerived(cols, 'B').bigEye).toBe('B')
    expect(predictDerived(cols, 'B').small).toBe('R')      // depth(3)=1 vs depth(1)=1
    expect(predictDerived(cols, 'B').cockroach).toBe('R')  // depth(3)=1 vs depth(0)=1
    expect(predictDerived(buildBigRoad(hist('B')).columns, 'P').bigEye).toBeNull()
  })
})

import { layoutBeadPlate, layoutDerivedRoad } from './bigRoad'

describe('6매·파생로드 배치', () => {
  it('bead plate fills columns top-to-bottom including ties', () => {
    const { cells, colsUsed } = layoutBeadPlate(hist('BPTBBPBP'), 6)
    expect(cells.map(c => [c.col, c.row, c.winner])).toEqual([
      [0, 0, 'B'], [0, 1, 'P'], [0, 2, 'T'], [0, 3, 'B'], [0, 4, 'B'], [0, 5, 'P'], [1, 0, 'B'], [1, 1, 'P'],
    ])
    expect(colsUsed).toBe(2)
    expect(layoutBeadPlate([], 6)).toEqual({ cells: [], colsUsed: 0 })
  })

  it('derived road stacks same-colour marks in a column and breaks on change', () => {
    const { cells, colsUsed } = layoutDerivedRoad(['R', 'R', 'B', 'R', 'R', 'R'], 6)
    expect(cells.map(c => [c.col, c.row, c.mark])).toEqual([
      [0, 0, 'R'], [0, 1, 'R'], [1, 0, 'B'], [2, 0, 'R'], [2, 1, 'R'], [2, 2, 'R'],
    ])
    expect(colsUsed).toBe(3)
  })
})
