import { useMemo, useRef, useEffect } from 'react'
import type { RoomPredictionState, PredictionHistoryItem } from '../../../domain/entities'
import './StrategyAnalysisView.css'

// 전체 히스토리 아이템 (room.history)
interface GameHistoryItem {
    winner: 'B' | 'P' | 'T'
    pair?: { banker: boolean; player: boolean }
}

interface StrategyAnalysisViewProps {
    state: RoomPredictionState | null | undefined
    viewMode: 'single' | 'triple'
    nextPrediction?: 'B' | 'P' | 'SKIP' | null  // 다음 예측값 (깜빡임용, SKIP/PASS 포함)
    gameHistory?: GameHistoryItem[]    // 전체 게임 히스토리 (room.history)
}

// 3연속 모드용 행 데이터
interface TripleRowData {
    gameIndex: number           // 1, 2, 3, 4, 5...
    actualResult: 'P' | 'B' | 'T' | null
    jeongPrediction: 'P' | 'B' | null
    jeongOX: 'O' | 'X' | null
    yeockPrediction: 'P' | 'B' | null
    yeockOX: 'O' | 'X' | null
    // 3회차마다 표시 (rowspan용)
    jeongGroupResult?: '승' | '패' | null
    yeockGroupResult?: '승' | '패' | null
    groupPosition?: number      // 그룹 내 위치 (0, 1, 2) - 0이면 승패 표시
    groupSize?: number          // 그룹 크기 (rowspan에 사용)
    actualRowspan?: number      // 실제 rowspan (중간에 비예측 행 포함)
    coveredByRowspan?: boolean  // rowspan에 의해 덮인 행 (td 렌더링 안 함)
    isNextPrediction?: boolean  // 다음 예측 행 (깜빡임)
    hasPrediction?: boolean     // 이 행에 예측이 있는지
    isTie?: boolean             // 타이 여부
    isSkip?: boolean            // PASS(스킵) 예측 여부
}

// 단일 모드용 청크 데이터 (기존)
interface ChunkResult {
    round: number
    predictions: PredictionHistoryItem[]
    jeongWins: number
    jeongResult: 'WIN' | 'LOSS' | 'WAITING'
    yeockWins: number
    yeockResult: 'WIN' | 'LOSS' | 'WAITING'
}

// 통계 데이터
interface TripleStats {
    jeong: { wins: number; losses: number; rate: number }
    yeock: { wins: number; losses: number; rate: number }
}

// O/X 요약 그리드 데이터
interface OXSummaryItem {
    value: 'O' | 'X' | 'T'
    prediction?: 'B' | 'P' | null
}

interface OXSummary {
    jeongOX: OXSummaryItem[]
    yeockOX: OXSummaryItem[]
    groupResults: ('승' | '패' | '무')[]  // 3개씩 묶은 정방향 기준 승/패/무
}

export default function StrategyAnalysisView({ state, viewMode, nextPrediction, gameHistory }: StrategyAnalysisViewProps) {
    if (viewMode === 'single') {
        return <SingleModeView state={state} gameHistory={gameHistory} />
    }
    return <TripleModeView state={state} nextPrediction={nextPrediction} gameHistory={gameHistory} />
}

// ==================== 단일 모드 (기존 로직) ====================
function SingleModeView({ state }: { state: RoomPredictionState | null | undefined; gameHistory?: GameHistoryItem[] }) {
    const tableContainerRef = useRef<HTMLDivElement>(null)

    const chunks = useMemo(() => {
        if (!state?.history || state.history.length === 0) return []

        const timeForwardHistory = [...state.history].reverse()
        const resultChunks: ChunkResult[] = []
        let currentChunk: PredictionHistoryItem[] = []

        timeForwardHistory.forEach((item, index) => {
            currentChunk.push(item)

            if (currentChunk.length === 3 || index === timeForwardHistory.length - 1) {
                const jeongWins = currentChunk.filter(i => i.result === 'WIN').length
                const jeongLosses = currentChunk.filter(i => i.result === 'LOSS').length
                const yeockWins = currentChunk.filter(i => i.result === 'LOSS').length
                const yeockLosses = currentChunk.filter(i => i.result === 'WIN').length

                let jeongStatus: 'WIN' | 'LOSS' | 'WAITING' = 'WAITING'
                if (jeongWins >= 2) jeongStatus = 'WIN'
                else if (jeongLosses >= 2) jeongStatus = 'LOSS'
                else if (currentChunk.length === 3) jeongStatus = 'LOSS'

                let yeockStatus: 'WIN' | 'LOSS' | 'WAITING' = 'WAITING'
                if (yeockWins >= 2) yeockStatus = 'WIN'
                else if (yeockLosses >= 2) yeockStatus = 'LOSS'
                else if (currentChunk.length === 3) yeockStatus = 'LOSS'

                resultChunks.push({
                    round: resultChunks.length + 1,
                    predictions: [...currentChunk],
                    jeongWins,
                    jeongResult: jeongStatus,
                    yeockWins,
                    yeockResult: yeockStatus
                })

                currentChunk = []
            }
        })

        // 이미 시간순 (오래된 것 -> 최신)이므로 reverse 하지 않음
        return resultChunks
    }, [state?.history])

    // 자동 스크롤 - 맨 아래로
    useEffect(() => {
        if (tableContainerRef.current) {
            tableContainerRef.current.scrollTop = tableContainerRef.current.scrollHeight
        }
    }, [chunks])

    return (
        <div className="strategy-analysis-view">
            <div className="strategy-header">
                <h3>전략 분석 (Best of 3)</h3>
                <div className="strategy-legend">
                    <span className="legend-item win">적중 (2승)</span>
                    <span className="legend-item loss">미적중</span>
                </div>
            </div>

            <div className="strategy-table-container" ref={tableContainerRef}>
                <table className="strategy-table">
                    <thead>
                        <tr>
                            <th>회차</th>
                            <th>정방향</th>
                            <th>역방향</th>
                        </tr>
                    </thead>
                    <tbody>
                        {chunks.map((chunk, idx) => (
                            <tr key={idx}>
                                <td className="round-cell">
                                    <div className="round-number">#{chunk.round}</div>
                                    <div className="round-details">
                                        {chunk.predictions.map((p, i) => (
                                            <span key={i} className={`mini-badge ${p.result}`}>
                                                {p.result === 'WIN' ? 'O' : p.result === 'LOSS' ? 'X' : '-'}
                                            </span>
                                        ))}
                                    </div>
                                </td>
                                <td className={`result-cell ${chunk.jeongResult.toLowerCase()}`}>
                                    {chunk.jeongResult === 'WIN' && <div className="win-block">승</div>}
                                    {chunk.jeongResult === 'LOSS' && <div className="loss-block">패</div>}
                                    {chunk.jeongResult === 'WAITING' && <span className="waiting">진행중 ({chunk.jeongWins}/2)</span>}
                                </td>
                                <td className={`result-cell ${chunk.yeockResult.toLowerCase()}`}>
                                    {chunk.yeockResult === 'WIN' && <div className="win-block">승</div>}
                                    {chunk.yeockResult === 'LOSS' && <div className="loss-block">패</div>}
                                    {chunk.yeockResult === 'WAITING' && <span className="waiting">진행중 ({chunk.yeockWins}/2)</span>}
                                </td>
                            </tr>
                        ))}
                        {chunks.length === 0 && (
                            <tr>
                                <td colSpan={3} className="empty-message">데이터 수집 중...</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

// ==================== 3연속 모드 (새로운 테이블 UI) ====================
function TripleModeView({ state, nextPrediction, gameHistory }: {
    state: RoomPredictionState | null | undefined
    nextPrediction?: 'B' | 'P' | 'SKIP' | null
    gameHistory?: GameHistoryItem[]
}) {
    const tableContainerRef = useRef<HTMLDivElement>(null)
    const isUserScrollingRef = useRef(false)
    const prevRowsLengthRef = useRef(0)

    // 히스토리 데이터를 테이블 행으로 변환
    const { rows, stats, oxSummary } = useMemo(() => {
        const resultRows: TripleRowData[] = []
        const statsData: TripleStats = {
            jeong: { wins: 0, losses: 0, rate: 0 },
            yeock: { wins: 0, losses: 0, rate: 0 }
        }
        const summaryData: OXSummary = {
            jeongOX: [],
            yeockOX: [],
            groupResults: []
        }

        // gameHistory가 있으면 전체 히스토리 기반으로 표시
        // 없으면 예측 히스토리만 표시 (기존 로직)
        if (gameHistory && gameHistory.length > 0) {
            // gameHistory는 최신이 [0]이므로 reverse해서 오래된 것부터 처리
            // 타이도 표시 (예측/승패 계산에서는 제외)
            const timeForwardHistory = [...gameHistory].reverse()

            // 예측 히스토리를 시간순으로 정렬 (오래된 것부터)
            // state.history는 최신이 [0]이므로 reverse
            // SKIP도 포함 (PASS로 표시)
            const predictionHistory = state?.history
                ? [...state.history].reverse().filter(p => p.result === 'WIN' || p.result === 'LOSS' || p.result === 'SKIP')
                : []

            // 예측 개수
            const totalPredictions = predictionHistory.length

            let predictionIdx = 0

            // 예측이 있는 행들만 따로 모아서 3개씩 그룹핑
            const predictionRows: TripleRowData[] = []
            const noPredictionRows: TripleRowData[] = []

            // 타이가 아닌 게임만 카운트하여 예측 매칭
            const nonTieGames = timeForwardHistory.filter(g => g.winner !== 'T')
            const totalNonTieGames = nonTieGames.length
            const startPredictionIndexForNonTie = totalNonTieGames - totalPredictions

            // 1단계: 모든 행 생성
            let nonTieIdx = 0 // 타이가 아닌 게임의 인덱스
            let predictionStarted = false // 예측이 시작되었는지 여부

            timeForwardHistory.forEach((game, gameIdx) => {
                const gameIndex = gameIdx + 1
                const isTie = game.winner === 'T'
                const gameResult = game.winner as 'B' | 'P' | 'T'

                // 타이는 예측 매칭하지 않음, B/P만 예측과 매칭
                const hasPrediction = !isTie && nonTieIdx >= startPredictionIndexForNonTie && predictionIdx < predictionHistory.length

                // 예측 시작 여부 체크
                if (hasPrediction && !predictionStarted) {
                    predictionStarted = true
                }

                let matchedPrediction: PredictionHistoryItem | null = null
                if (hasPrediction) {
                    matchedPrediction = predictionHistory[predictionIdx]
                    predictionIdx++
                }

                if (!isTie) {
                    nonTieIdx++
                }

                const isSkipPrediction = matchedPrediction?.result === 'SKIP'
                const prediction = matchedPrediction?.prediction as 'B' | 'P' | null
                // 예측이 있는 행은 predictionHistory의 actual 사용, 없으면 gameHistory의 winner 사용
                const actualResult = hasPrediction && matchedPrediction?.actual
                    ? matchedPrediction.actual as 'B' | 'P'
                    : gameResult

                let jeongOX: 'O' | 'X' | null = null
                let yeockOX: 'O' | 'X' | null = null
                let yeockPrediction: 'B' | 'P' | null = null

                // SKIP이 아닌 경우에만 O/X 계산
                if (hasPrediction && matchedPrediction && !isSkipPrediction) {
                    jeongOX = matchedPrediction.result === 'WIN' ? 'O' : 'X'
                    yeockOX = matchedPrediction.result === 'LOSS' ? 'O' : 'X'
                    yeockPrediction = prediction === 'B' ? 'P' : prediction === 'P' ? 'B' : null
                }

                // 타이는 승(O)으로 처리 (예측 시작 후의 타이만)
                if (isTie && predictionStarted) {
                    jeongOX = 'O'
                    yeockOX = 'O'
                }

                const row: TripleRowData = {
                    gameIndex,
                    actualResult,
                    jeongPrediction: isSkipPrediction ? null : prediction,
                    jeongOX,
                    yeockPrediction: isSkipPrediction ? null : yeockPrediction,
                    yeockOX,
                    jeongGroupResult: null,
                    yeockGroupResult: null,
                    groupPosition: undefined,
                    isNextPrediction: false,
                    hasPrediction: hasPrediction || (isTie && predictionStarted),  // 타이도 예측 그룹에 포함
                    isTie,
                    isSkip: isSkipPrediction
                }

                // 예측 시작 후의 타이도 predictionRows에 포함 (승으로 계산)
                if (isTie && predictionStarted) {
                    predictionRows.push(row)
                } else if (isTie) {
                    noPredictionRows.push(row)
                } else if (hasPrediction) {
                    predictionRows.push(row)
                } else {
                    noPredictionRows.push(row)
                }
            })

            // 2단계: 예측이 있는 행들의 승률 계산 (1개씩)
            // SKIP 제외
            predictionRows.forEach(row => {
                if (row.isSkip) return
                if (row.jeongOX === 'O') statsData.jeong.wins++
                else if (row.jeongOX === 'X') statsData.jeong.losses++

                if (row.yeockOX === 'O') statsData.yeock.wins++
                else if (row.yeockOX === 'X') statsData.yeock.losses++
            })

            // 3단계: 3개씩 그룹핑하여 groupPosition, groupSize 설정
            for (let i = 0; i < predictionRows.length; i += 3) {
                const group = predictionRows.slice(i, i + 3)

                // 각 행에 그룹 내 위치 설정 (0, 1, 2)
                group.forEach((row, posInGroup) => {
                    row.groupPosition = posInGroup
                })
                // 첫 번째 행에 그룹 크기 저장 (rowspan용)
                group[0].groupSize = group.length

                // 3개가 모인 경우 첫 번째 행에 승패 표시
                if (group.length === 3) {
                    // 스킵은 제외하고 유효한 예측만 카운트
                    const validRows = group.filter(r => !r.isSkip)
                    const skipCount = group.filter(r => r.isSkip).length

                    const jeongWins = validRows.filter(r => r.jeongOX === 'O').length
                    const yeockWins = validRows.filter(r => r.yeockOX === 'O').length

                    // 승리 조건: 유효한 예측 중 과반수가 맞으면 승
                    const requiredWins = Math.ceil((3 - skipCount) / 2)

                    group[0].jeongGroupResult = jeongWins >= requiredWins ? '승' : '패'
                    group[0].yeockGroupResult = yeockWins >= requiredWins ? '승' : '패'
                }
            }

            // 4단계: 예측 있는 행만 3개씩 그룹핑 (타이 포함, 타이=승)
            for (let i = 0; i < predictionRows.length; i += 3) {
                const group = predictionRows.slice(i, i + 3)
                if (group.length === 0) continue

                // 첫 번째 행에 rowspan 설정
                group[0].actualRowspan = group.length
                group[0].coveredByRowspan = false

                // 3개가 완성된 그룹만 승패 계산
                if (group.length === 3) {
                    const jeongWins = group.filter(r => r.isTie ? true : r.jeongOX === 'O').length
                    const yeockWins = group.filter(r => r.isTie ? true : r.yeockOX === 'O').length
                    group[0].jeongGroupResult = jeongWins >= 2 ? '승' : '패'
                    group[0].yeockGroupResult = yeockWins >= 2 ? '승' : '패'
                }

                // 2, 3번째 행은 rowspan에 의해 덮임
                for (let j = 1; j < group.length; j++) {
                    group[j].actualRowspan = 0
                    group[j].coveredByRowspan = true
                }
            }

            // 예측 없는 행들은 승패 열 비움
            noPredictionRows.forEach(row => {
                row.actualRowspan = 0
                row.coveredByRowspan = false
            })

            // 5단계: 모든 행을 gameIndex 순서대로 정렬 (1회차부터 전부 표시)
            const allRows = [...predictionRows, ...noPredictionRows]
                .sort((a, b) => a.gameIndex - b.gameIndex)

            resultRows.push(...allRows)
        } else if (state?.history && state.history.length > 0) {
            // 기존 로직: 예측 히스토리만 있는 경우
            // TIE, SKIP도 포함
            const timeForwardHistory = [...state.history].reverse()
            const validHistory = timeForwardHistory.filter(item =>
                item.result === 'WIN' || item.result === 'LOSS' || item.result === 'TIE' || item.result === 'SKIP'
            )

            let currentGroupRows: TripleRowData[] = []

            validHistory.forEach((item, index) => {
                const gameIndex = index + 1
                const isTie = item.result === 'TIE' || item.actual === 'T'
                const isSkip = item.result === 'SKIP'
                const prediction = item.prediction as 'B' | 'P' | null
                const actualResult = item.actual as 'B' | 'P' | 'T' | null

                let jeongOX: 'O' | 'X' | null = null
                let yeockOX: 'O' | 'X' | null = null
                let yeockPrediction: 'B' | 'P' | null = null

                if (!isTie && !isSkip) {
                    jeongOX = item.result === 'WIN' ? 'O' : 'X'
                    yeockOX = item.result === 'LOSS' ? 'O' : 'X'
                    yeockPrediction = prediction === 'B' ? 'P' : prediction === 'P' ? 'B' : null
                }

                const row: TripleRowData = {
                    gameIndex,
                    actualResult,
                    jeongPrediction: isSkip ? null : prediction,
                    jeongOX,
                    yeockPrediction: isSkip ? null : yeockPrediction,
                    yeockOX,
                    jeongGroupResult: null,
                    yeockGroupResult: null,
                    groupPosition: undefined,
                    isNextPrediction: false,
                    hasPrediction: true,
                    isTie,
                    isSkip
                }

                currentGroupRows.push(row)

                if (currentGroupRows.length === 3) {
                    // 그룹 내 위치 설정
                    currentGroupRows.forEach((r, pos) => { r.groupPosition = pos })

                    // 스킵은 제외하고 유효한 예측만 카운트
                    const validRows = currentGroupRows.filter(r => !r.isSkip)
                    const skipCount = currentGroupRows.filter(r => r.isSkip).length

                    const jeongWins = validRows.filter(r => r.jeongOX === 'O').length
                    const yeockWins = validRows.filter(r => r.yeockOX === 'O').length

                    // 승리 조건: 유효한 예측 중 과반수가 맞으면 승
                    const requiredWins = Math.ceil((3 - skipCount) / 2)

                    const jeongResult: '승' | '패' = jeongWins >= requiredWins ? '승' : '패'
                    const yeockResult: '승' | '패' = yeockWins >= requiredWins ? '승' : '패'

                    currentGroupRows[0].jeongGroupResult = jeongResult
                    currentGroupRows[0].yeockGroupResult = yeockResult

                    if (jeongResult === '승') statsData.jeong.wins++
                    else statsData.jeong.losses++
                    if (yeockResult === '승') statsData.yeock.wins++
                    else statsData.yeock.losses++

                    resultRows.push(...currentGroupRows)
                    currentGroupRows = []
                }
            })

            if (currentGroupRows.length > 0) {
                currentGroupRows.forEach((r, pos) => { r.groupPosition = pos })
                resultRows.push(...currentGroupRows)
            }
        }

        // 승률 계산
        const jeongTotal = statsData.jeong.wins + statsData.jeong.losses
        const yeockTotal = statsData.yeock.wins + statsData.yeock.losses
        statsData.jeong.rate = jeongTotal > 0 ? (statsData.jeong.wins / jeongTotal) * 100 : 0
        statsData.yeock.rate = yeockTotal > 0 ? (statsData.yeock.wins / yeockTotal) * 100 : 0

        // O/X 요약 데이터 생성 (예측 있는 행만, 타이 포함)
        const predRows = resultRows.filter(r => r.hasPrediction && !r.isNextPrediction && !r.isSkip)
        predRows.forEach(row => {
            if (row.isTie) {
                // 타이는 T로 표시
                summaryData.jeongOX.push({ value: 'T', prediction: null })
                summaryData.yeockOX.push({ value: 'T', prediction: null })
            } else {
                if (row.jeongOX) summaryData.jeongOX.push({ value: row.jeongOX, prediction: row.jeongPrediction })
                if (row.yeockOX) summaryData.yeockOX.push({ value: row.yeockOX, prediction: row.yeockPrediction })
            }
        })

        // 3개씩 묶어서 승/패/무 계산 (타이 제외)
        for (let i = 0; i < summaryData.jeongOX.length; i += 3) {
            const group = summaryData.jeongOX.slice(i, i + 3)
            if (group.length === 3) {
                const validItems = group.filter(r => r.value !== 'T')
                const wins = validItems.filter(r => r.value === 'O').length
                const losses = validItems.filter(r => r.value === 'X').length
                if (wins > losses) {
                    summaryData.groupResults.push('승')
                } else if (losses > wins) {
                    summaryData.groupResults.push('패')
                } else {
                    summaryData.groupResults.push('무')
                }
            }
        }

        // 다음 예측 미리 표시 (깜빡임)
        if (nextPrediction) {
            const lastGameIndex = resultRows.length > 0 ? resultRows[resultRows.length - 1].gameIndex : 0
            const isSkip = nextPrediction === 'SKIP'

            // 현재 예측 행 개수로 그룹 내 위치 계산
            const predictionCount = resultRows.filter(r => r.hasPrediction).length
            const positionInGroup = predictionCount % 3  // 0, 1, 2

            const nextRow: TripleRowData = {
                gameIndex: lastGameIndex + 1,
                actualResult: null,
                jeongPrediction: isSkip ? null : nextPrediction as 'B' | 'P',
                jeongOX: null,
                yeockPrediction: isSkip ? null : (nextPrediction === 'B' ? 'P' : 'B'),
                yeockOX: null,
                jeongGroupResult: null,
                yeockGroupResult: null,
                groupPosition: positionInGroup,
                actualRowspan: 0,  // 다음 예측은 항상 빈 td
                coveredByRowspan: false,  // 항상 빈 td 렌더링 (밀리지 않게)
                isNextPrediction: true,
                hasPrediction: true,
                isSkip: isSkip
            }
            resultRows.push(nextRow)
        }

        return { rows: resultRows, stats: statsData, oxSummary: summaryData }
    }, [state?.history, nextPrediction, gameHistory])

    // 자동 스크롤 - 새 결과가 왔을 때만, 사용자가 스크롤 중이면 고정
    useEffect(() => {
        const container = tableContainerRef.current
        if (!container) return

        // 새 데이터가 추가되었는지 확인
        const hasNewData = rows.length > prevRowsLengthRef.current
        prevRowsLengthRef.current = rows.length

        // 사용자가 스크롤 중이면 자동 스크롤 안 함
        if (isUserScrollingRef.current && !hasNewData) return

        // 새 데이터가 있거나, 맨 아래 근처에 있을 때만 스크롤
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100

        if (hasNewData || isNearBottom) {
            container.scrollTop = container.scrollHeight
            isUserScrollingRef.current = false
        }
    }, [rows])

    // 스크롤 이벤트 핸들러 - 사용자가 위로 스크롤하면 자동 스크롤 비활성화
    useEffect(() => {
        const container = tableContainerRef.current
        if (!container) return

        const handleScroll = () => {
            const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50
            isUserScrollingRef.current = !isAtBottom
        }

        container.addEventListener('scroll', handleScroll)
        return () => container.removeEventListener('scroll', handleScroll)
    }, [])

    // 게임 통계 계산 (P/B/T 갯수)
    const gameStats = useMemo(() => {
        if (!gameHistory || gameHistory.length === 0) {
            return { total: 0, player: 0, banker: 0, tie: 0 }
        }
        const player = gameHistory.filter(g => g.winner === 'P').length
        const banker = gameHistory.filter(g => g.winner === 'B').length
        const tie = gameHistory.filter(g => g.winner === 'T').length
        return { total: gameHistory.length, player, banker, tie }
    }, [gameHistory])

    return (
        <div className="strategy-analysis-view triple-mode">
            {/* 1. 타이틀 및 게임 통계 헤더 */}
            <div className="strategy-header-row">
                <h3>전략 분석</h3>
                <div className="game-stats-display">
                    <span className="game-stat"><span className="label p">P</span>{gameStats.player}</span>
                    <span className="game-stat"><span className="label b">B</span>{gameStats.banker}</span>
                    <span className="game-stat"><span className="label t">T</span>{gameStats.tie}</span>
                    <span className="game-stat total">총 {gameStats.total}</span>
                </div>
            </div>

            {/* 2. 정/역 승률 카드 (가로 배치) */}
            <div className="strategy-stats-cards">
                <div className="stat-card jeong">
                    <div className="stat-card-header">정 (Jeong)</div>
                    <div className="stat-card-content">
                        <span className="stat-rate">{stats.jeong.rate.toFixed(0)}%</span>
                        <span className="stat-value">({stats.jeong.wins}승{stats.jeong.losses}패)</span>
                    </div>
                </div>
                <div className="stat-card yeock">
                    <div className="stat-card-header">역 (Yeock)</div>
                    <div className="stat-card-content">
                        <span className="stat-rate">{stats.yeock.rate.toFixed(0)}%</span>
                        <span className="stat-value">({stats.yeock.wins}승{stats.yeock.losses}패)</span>
                    </div>
                </div>
            </div>

            {/* O/X 요약 그리드 */}
            {(oxSummary.jeongOX.length > 0 || nextPrediction) && (() => {
                // 3개씩 그룹으로 나누기 (OXSummaryItem 타입)
                const groups: (OXSummaryItem | null)[][] = []
                for (let i = 0; i < oxSummary.jeongOX.length; i += 3) {
                    groups.push(oxSummary.jeongOX.slice(i, i + 3))
                }

                // 다음 예측이 있으면 마지막 그룹에 추가 또는 새 그룹 생성
                const hasNextPrediction = nextPrediction && nextPrediction !== 'SKIP'
                if (hasNextPrediction) {
                    const lastGroup = groups[groups.length - 1]
                    if (!lastGroup || lastGroup.length >= 3) {
                        // 새 그룹 시작
                        groups.push([null]) // null = 다음 예측 자리
                    } else {
                        // 기존 그룹에 추가
                        lastGroup.push(null)
                    }
                }

                // 다음 예측 위치 계산
                const nextPredPosition = hasNextPrediction ? oxSummary.jeongOX.length % 3 : -1
                const nextPredGroupIdx = hasNextPrediction ? groups.length - 1 : -1

                // 셀 렌더링 헬퍼 함수
                const renderOXCell = (item: OXSummaryItem | null | undefined, isNextPred: boolean) => {
                    if (isNextPred) {
                        return (
                            <span className={`ox-cell ox-cell--prediction ox-cell--blinking ${nextPrediction === 'B' ? 'ox-cell--banker' : 'ox-cell--player'}`}>
                                {nextPrediction}
                            </span>
                        )
                    }
                    if (!item) {
                        return <span className="ox-cell ox-cell--empty" />
                    }
                    if (item.value === 'T') {
                        return <span className="ox-cell ox-cell--tie">T</span>
                    }
                    if (item.value === 'O') {
                        const colorClass = item.prediction === 'P' ? 'ox-cell--win-p' : item.prediction === 'B' ? 'ox-cell--win-b' : 'ox-cell--win'
                        return <span className={`ox-cell ${colorClass}`}>O</span>
                    }
                    if (item.value === 'X') {
                        return <span className="ox-cell ox-cell--loss">X</span>
                    }
                    return <span className="ox-cell ox-cell--empty" />
                }

                return (
                    <div className="ox-summary-grid ox-summary-grid--vertical">
                        {/* 1행: 각 그룹의 1번째 */}
                        <div className="ox-summary-row">
                            {groups.map((group, gIdx) => {
                                const isNextPred = gIdx === nextPredGroupIdx && nextPredPosition === 0
                                return (
                                    <div key={gIdx} className="ox-column">
                                        {renderOXCell(group[0], isNextPred)}
                                    </div>
                                )
                            })}
                        </div>
                        {/* 2행: 각 그룹의 2번째 */}
                        <div className="ox-summary-row">
                            {groups.map((group, gIdx) => {
                                const isNextPred = gIdx === nextPredGroupIdx && nextPredPosition === 1
                                return (
                                    <div key={gIdx} className="ox-column">
                                        {renderOXCell(group[1], isNextPred)}
                                    </div>
                                )
                            })}
                        </div>
                        {/* 3행: 각 그룹의 3번째 */}
                        <div className="ox-summary-row">
                            {groups.map((group, gIdx) => {
                                const isNextPred = gIdx === nextPredGroupIdx && nextPredPosition === 2
                                return (
                                    <div key={gIdx} className="ox-column">
                                        {renderOXCell(group[2], isNextPred)}
                                    </div>
                                )
                            })}
                        </div>
                        {/* 4행: 승/패/무 결과 */}
                        <div className="ox-summary-row">
                            {groups.map((group, gIdx) => {
                                const validCount = group.filter(v => v && (v.value === 'O' || v.value === 'X' || v.value === 'T')).length
                                const result = oxSummary.groupResults[gIdx]
                                return (
                                    <div key={gIdx} className="ox-column">
                                        {validCount === 3 && result ? (
                                            <span className={`ox-group-badge ${result === '승' ? 'ox-group-badge--win' : result === '패' ? 'ox-group-badge--loss' : 'ox-group-badge--draw'}`}>
                                                {result}
                                            </span>
                                        ) : <span className="ox-group-badge ox-group-badge--pending">-</span>}
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                )
            })()}

            {/* 3. 테이블 (colgroup 및 헤더 구조 변경) */}
            <div className="strategy-table-container" ref={tableContainerRef}>
                <table className="strategy-triple-table">
                    <colgroup>
                        <col style={{ width: '40px' }} /> {/* 회차 */}
                        <col style={{ width: '40px' }} /> {/* 결과 */}
                        <col style={{ width: 'calc(50% - 40px)' }} /> {/* 정방향 */}
                        <col style={{ width: 'calc(50% - 40px)' }} /> {/* 역방향 */}
                    </colgroup>
                    <thead>
                        <tr>
                            <th className="th-fixed">회차</th>
                            <th className="th-fixed">결과</th>
                            {/* Jeong Side */}
                            <th className="th-jeong">예측</th>
                            <th className="th-jeong">OX</th>
                            <th className="th-jeong">승패</th>
                            {/* Yeock Side */}
                            <th className="th-yeock">예측</th>
                            <th className="th-yeock">OX</th>
                            <th className="th-yeock">승패</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, idx) => {
                            return (
                                <tr key={idx} className={`${row.isNextPrediction ? 'next-prediction-row' : ''} ${!row.hasPrediction ? 'no-prediction-row' : ''} ${row.isTie ? 'tie-row' : ''} ${row.isSkip ? 'skip-row' : ''}`}>
                                    <td className="cell-index">{row.gameIndex}</td>
                                    <td className="cell-result">
                                        {row.actualResult && (
                                            <span className={`result-badge ${row.actualResult.toLowerCase()}`}>
                                                {row.actualResult}
                                            </span>
                                        )}
                                    </td>
                                    {/* Jeong Columns */}
                                    <td className="cell-prediction">
                                        {row.isSkip ? (
                                            <span className="skip-badge" title="PASS">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <circle cx="12" cy="12" r="10" />
                                                    <line x1="4" y1="4" x2="20" y2="20" />
                                                </svg>
                                            </span>
                                        ) : row.jeongPrediction && (
                                            <span className={`pred-badge ${row.jeongPrediction.toLowerCase()} ${row.isNextPrediction ? 'blinking' : ''}`}>
                                                {row.jeongPrediction}
                                            </span>
                                        )}
                                    </td>
                                    <td className="cell-ox">
                                        {row.isSkip ? (
                                            <span className="skip-text">-</span>
                                        ) : row.jeongOX && (
                                            <span className={`ox-text ${row.jeongOX === 'O' ? 'correct' : 'wrong'}`}>
                                                {row.jeongOX}
                                            </span>
                                        )}
                                    </td>
                                    {/* 정방향 승패 - rowspan으로 병합 */}
                                    {(row.actualRowspan ?? 0) > 0 ? (
                                        <td
                                            className={`cell-group-result ${row.jeongGroupResult === '승' ? 'win-cell' : row.jeongGroupResult === '패' ? 'loss-cell' : ''}`}
                                            rowSpan={row.actualRowspan}
                                        >
                                            {row.jeongGroupResult && (
                                                <span className={`group-result ${row.jeongGroupResult === '승' ? 'win' : 'loss'}`}>
                                                    {row.jeongGroupResult}
                                                </span>
                                            )}
                                        </td>
                                    ) : row.coveredByRowspan === true ? null : (
                                        <td className="cell-group-result"></td>
                                    )}

                                    {/* Yeock Columns */}
                                    <td className="cell-prediction">
                                        {row.isSkip ? (
                                            <span className="skip-badge" title="PASS">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <circle cx="12" cy="12" r="10" />
                                                    <line x1="4" y1="4" x2="20" y2="20" />
                                                </svg>
                                            </span>
                                        ) : row.yeockPrediction && (
                                            <span className={`pred-badge ${row.yeockPrediction.toLowerCase()} ${row.isNextPrediction ? 'blinking' : ''}`}>
                                                {row.yeockPrediction}
                                            </span>
                                        )}
                                    </td>
                                    <td className="cell-ox">
                                        {row.isSkip ? (
                                            <span className="skip-text">-</span>
                                        ) : row.yeockOX && (
                                            <span className={`ox-text ${row.yeockOX === 'O' ? 'correct' : 'wrong'}`}>
                                                {row.yeockOX}
                                            </span>
                                        )}
                                    </td>
                                    {/* 역방향 승패 - rowspan으로 병합 */}
                                    {(row.actualRowspan ?? 0) > 0 ? (
                                        <td
                                            className={`cell-group-result ${row.yeockGroupResult === '승' ? 'win-cell' : row.yeockGroupResult === '패' ? 'loss-cell' : ''}`}
                                            rowSpan={row.actualRowspan}
                                        >
                                            {row.yeockGroupResult && (
                                                <span className={`group-result ${row.yeockGroupResult === '승' ? 'win' : 'loss'}`}>
                                                    {row.yeockGroupResult}
                                                </span>
                                            )}
                                        </td>
                                    ) : row.coveredByRowspan === true ? null : (
                                        <td className="cell-group-result"></td>
                                    )}
                                </tr>
                            )
                        })}
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={8} className="empty-message">데이터 수집 중...</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
