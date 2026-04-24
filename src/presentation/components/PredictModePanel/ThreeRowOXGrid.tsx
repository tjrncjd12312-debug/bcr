// ThreeRowOXGrid - 3매 O/X 그리드 컴포넌트
// 3행으로 예측 결과를 O/X/T 로 표시하고, 3개씩 묶어서 하단에 승/패 표시
// T(타이)는 승/패 계산에서 제외됨

import { useMemo, useEffect, useRef } from 'react'
import type { RoomPredictionState, PredictionHistoryItem } from '../../../domain/entities'
import './ThreeRowOXGrid.css'

interface ThreeRowOXGridProps {
  state: RoomPredictionState | null | undefined
  nextPrediction?: 'B' | 'P' | 'SKIP' | null
}

// 그룹 데이터 구조
interface OXGroup {
  cells: (OXCell | null)[] // 최대 3개
  result: '승' | '패' | '무' | null // 3개 완성시 결과 (무 = 동률)
}

interface OXCell {
  value: 'O' | 'X' | 'T' | null // O=적중, X=실패, T=타이, null=대기중(예측 진행중)
  prediction?: 'B' | 'P' | null // 예측값
  isNext?: boolean // 다음 예측 (깜빡임)
  isSkip?: boolean // SKIP 여부
  isTie?: boolean // 타이 여부
}

export default function ThreeRowOXGrid({ state, nextPrediction }: ThreeRowOXGridProps) {
  const { groups, stats } = useMemo(() => {
    const resultGroups: OXGroup[] = []
    const statsData = { wins: 0, losses: 0 }

    if (!state?.history || state.history.length === 0) {
      // 히스토리가 없어도 다음 예측이 있으면 표시
      if (nextPrediction) {
        resultGroups.push({
          cells: [{
            value: null,
            prediction: nextPrediction as any,
            isNext: true,
            isSkip: nextPrediction === 'SKIP'
          }],
          result: null
        })
      }
      return { groups: resultGroups, stats: statsData }
    }

    // 히스토리를 시간순으로 정렬 (오래된 것 -> 최신)
    // TIE도 포함하여 표시 (T로 표시)
    const timeForwardHistory = [...state.history].reverse()
      .filter((item: PredictionHistoryItem) => 
        item.result === 'WIN' || item.result === 'LOSS' || item.result === 'TIE' || item.result === 'SKIP'
      )

    // 3개씩 그룹으로 묶기
    let currentGroup: OXCell[] = []

    timeForwardHistory.forEach((item: PredictionHistoryItem) => {
      const isSkip = item.result === 'SKIP'
      const isTie = item.result === 'TIE'
      
      let cellValue: 'O' | 'X' | 'T' | null = null
      if (isSkip) {
        cellValue = null
      } else if (isTie) {
        cellValue = 'T'
      } else {
        cellValue = item.result === 'WIN' ? 'O' : 'X'
      }
      
      const cell: OXCell = {
        value: cellValue,
        prediction: item.prediction as 'B' | 'P' | null,
        isNext: false,
        isSkip: isSkip,
        isTie: isTie
      }

      currentGroup.push(cell)

      if (currentGroup.length === 3) {
        // 3개가 모이면 그룹 완성
        // 타이와 스킵은 승/패 계산에서 제외
        const validCells = currentGroup.filter(c => !c.isSkip && !c.isTie)
        const wins = validCells.filter(c => c.value === 'O').length
        const losses = validCells.filter(c => c.value === 'X').length
        
        // 유효한 셀이 있을 때만 결과 계산
        let groupResult: '승' | '패' | '무' | null = null
        if (validCells.length > 0) {
          if (wins > losses) {
            groupResult = '승'
            statsData.wins++
          } else if (losses > wins) {
            groupResult = '패'
            statsData.losses++
          } else {
            // 동률 (1:1 등)
            groupResult = '무'
          }
        }

        resultGroups.push({
          cells: [...currentGroup],
          result: groupResult
        })

        currentGroup = []
      }
    })

    // 아직 3개가 안 된 그룹이 있으면 추가 (진행 중)
    if (currentGroup.length > 0) {
      // 다음 예측이 있으면 추가
      if (nextPrediction) {
        currentGroup.push({
          value: null,
          prediction: nextPrediction as any,
          isNext: true,
          isSkip: nextPrediction === 'SKIP'
        })
      }

      resultGroups.push({
        cells: currentGroup,
        result: null // 아직 미완성
      })
    } else if (nextPrediction) {
      // 이전 그룹이 모두 완성되었고, 새 예측이 있으면 새 그룹 시작
      resultGroups.push({
        cells: [{
          value: null,
          prediction: nextPrediction as any,
          isNext: true,
          isSkip: nextPrediction === 'SKIP'
        }],
        result: null
      })
    }

    return { groups: resultGroups, stats: statsData }
  }, [state?.history, nextPrediction])

  const totalGames = stats.wins + stats.losses
  const winRate = totalGames > 0 ? ((stats.wins / totalGames) * 100).toFixed(0) : '-'

  // 스크롤 컨테이너 ref
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const prevHistoryLengthRef = useRef<number>(-1) // -1로 초기화하여 첫 로드 시 스크롤 트리거
  const isInitialMountRef = useRef<boolean>(true)

  // 🔥 새 결과 추가 시 항상 오른쪽(최신)으로 스크롤
  const historyLength = state?.history?.length || 0

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return

    // 첫 마운트 또는 새 결과가 추가되었는지 감지
    const isFirstMount = isInitialMountRef.current
    const isNewResult = historyLength > prevHistoryLengthRef.current

    isInitialMountRef.current = false
    prevHistoryLengthRef.current = historyLength

    // 첫 로드나 새 결과 시에만 스크롤
    if (!isFirstMount && !isNewResult) return

    // 초기 로드 시 더 긴 지연, 새 결과 시 짧은 지연
    const delay = isFirstMount ? 150 : 50

    const timer = setTimeout(() => {
      const { clientWidth, scrollWidth } = scrollContainer

      // 스크롤 가능한 영역이 없으면 무시
      if (scrollWidth <= clientWidth || scrollWidth === 0) return

      scrollContainer.scrollTo({
        left: scrollWidth,
        behavior: isFirstMount ? 'auto' : 'smooth'
      })
    }, delay)

    return () => clearTimeout(timer)
  }, [historyLength, groups.length])

  return (
    <div className="three-row-ox-grid" ref={scrollContainerRef}>
      {/* 그리드 영역 */}
      <div className="three-row-ox-grid__content">
        {/* 1행: 각 그룹의 1번째 */}
        <div className="three-row-ox-grid__row">
          {groups.map((group, gIdx) => (
            <div key={gIdx} className="three-row-ox-grid__column">
              {renderCell(group.cells[0])}
            </div>
          ))}
        </div>

        {/* 2행: 각 그룹의 2번째 */}
        <div className="three-row-ox-grid__row">
          {groups.map((group, gIdx) => (
            <div key={gIdx} className="three-row-ox-grid__column">
              {renderCell(group.cells[1])}
            </div>
          ))}
        </div>

        {/* 3행: 각 그룹의 3번째 */}
        <div className="three-row-ox-grid__row">
          {groups.map((group, gIdx) => (
            <div key={gIdx} className="three-row-ox-grid__column">
              {renderCell(group.cells[2])}
            </div>
          ))}
        </div>

        {/* 4행: 승/패/무 결과 */}
        <div className="three-row-ox-grid__row three-row-ox-grid__row--result">
          {groups.map((group, gIdx) => (
            <div key={gIdx} className="three-row-ox-grid__column">
              {group.result ? (
                <span className={`three-row-ox-grid__result three-row-ox-grid__result--${group.result === '승' ? 'win' : group.result === '패' ? 'loss' : 'draw'}`}>
                  {group.result}
                </span>
              ) : (
                <span className="three-row-ox-grid__result three-row-ox-grid__result--pending">-</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 통계 영역 */}
      {totalGames > 0 && (
        <div className="three-row-ox-grid__stats">
          <span className="three-row-ox-grid__stat">
            <span className="label">적중률</span>
            <span className="value">{winRate}%</span>
          </span>
          <span className="three-row-ox-grid__stat">
            <span className="label">승</span>
            <span className="value win">{stats.wins}</span>
          </span>
          <span className="three-row-ox-grid__stat">
            <span className="label">패</span>
            <span className="value loss">{stats.losses}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// 셀 렌더링 함수
function renderCell(cell: OXCell | null | undefined) {
  if (!cell) {
    return <span className="three-row-ox-grid__cell three-row-ox-grid__cell--empty" />
  }

  if (cell.isSkip) {
    if (cell.isNext) {
      return <span className="three-row-ox-grid__cell three-row-ox-grid__cell--skip three-row-ox-grid__cell--blinking">PASS</span>
    }
    return <span className="three-row-ox-grid__cell three-row-ox-grid__cell--skip">-</span>
  }

  if (cell.isNext && cell.prediction) {
    // 다음 예측 - 깜빡임 효과
    return (
      <span className={`three-row-ox-grid__cell three-row-ox-grid__cell--prediction three-row-ox-grid__cell--${cell.prediction.toLowerCase()} three-row-ox-grid__cell--blinking`}>
        {cell.prediction}
      </span>
    )
  }

  // O/X에 예측값(B/P)에 따른 색상 적용
  // O(적중): 예측이 P면 파란색, B면 빨간색
  // X(실패): 회색 계열
  if (cell.value === 'O') {
    const colorClass = cell.prediction === 'P' ? 'win-p' : cell.prediction === 'B' ? 'win-b' : 'win'
    return <span className={`three-row-ox-grid__cell three-row-ox-grid__cell--${colorClass}`}>O</span>
  }

  if (cell.value === 'X') {
    return <span className="three-row-ox-grid__cell three-row-ox-grid__cell--loss">X</span>
  }

  // 타이 표시 (T) - 초록색
  if (cell.value === 'T' || cell.isTie) {
    return <span className="three-row-ox-grid__cell three-row-ox-grid__cell--tie">T</span>
  }

  // 대기 중 (빈 셀)
  return <span className="three-row-ox-grid__cell three-row-ox-grid__cell--empty" />
}
