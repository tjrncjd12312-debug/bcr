// WatchContainer — 살펴보기(예측기) 라이브 배선
// 리디자인 2단계 배선. useGame() 실데이터를 WatchView(L1)·FocusedRoomView(L2)로 매핑.
// 도출 로직은 기존 PredictModePanel RoomCard와 동일한 출처(state.lastPrediction / state.stats / room.history).
import { useState, useMemo, useEffect, useCallback } from 'react'
import { useGame } from '../../context/GameContext'
import { useError } from '../../context'
import { WatchView } from './WatchView'
import type { RecommendItem } from './RecommendStrip'
import { FocusedRoomView } from '../ds/FocusedRoomView'
import type { RoomCardData } from '../ds/RoomCard'
import type { PredictionValue } from '../ds/PredictionChip'
import type { RoomStatus } from '../ds/StatusBadge'
import type { Density } from '../ds/DensityToggle'
import type { Room, RoadResult, RoomPredictionState } from '../../../domain/entities'
import BigRoad from '../MainScreen/components/BigRoad'
import BeadPlate from '../MainScreen/components/BeadPlate'

const WINNER_KO: Record<'B' | 'P' | 'T', string> = { B: '뱅커', P: '플레이어', T: '타이' }

function lastWinner(history: RoadResult[]): 'B' | 'P' | 'T' | null {
  return history.length ? history[history.length - 1].winner : null
}

function winnerCounts(history: RoadResult[]) {
  let banker = 0, player = 0, tie = 0
  for (const r of history) {
    if (r.winner === 'B') banker++
    else if (r.winner === 'P') player++
    else tie++
  }
  return { banker, player, tie }
}

function trailingStreak(history: RoadResult[]): { side: 'B' | 'P' | 'T' | null; count: number } {
  if (!history.length) return { side: null, count: 0 }
  const side = history[history.length - 1].winner
  let count = 0
  for (let i = history.length - 1; i >= 0 && history[i].winner === side; i--) count++
  return { side, count }
}

function toCardData(room: Room, state: RoomPredictionState | null): RoomCardData {
  const cw = state?.stats.consecutiveWins ?? 0
  const cl = state?.stats.consecutiveLosses ?? 0
  const total = state?.stats.total ?? 0
  const wr = state?.stats.winRate
  const pred = state?.lastPrediction

  let prediction: PredictionValue
  if (pred?.isSkip) prediction = 'pass'
  else if (pred?.prediction) prediction = pred.prediction
  else prediction = 'wait'

  let status: RoomStatus = 'idle'
  let statusLabel: string | undefined
  if (cl >= 2) {
    status = 'alert'
    statusLabel = `경보 · ${cl}연패`
  } else if (cw >= 2) {
    statusLabel = `흐름 좋음 · ${cw}연속`
  }

  return {
    id: room.id,
    name: room.koreanName || room.name,
    live: true,
    lastResult: lastWinner(room.history),
    hitRate: total > 0 && typeof wr === 'number' ? wr : null,
    bigRoad: room.history.map((r) => r.winner),
    prediction,
    status,
    statusLabel,
  }
}

interface WatchContainerProps {
  onHome: () => void
}

export function WatchContainer({ onHome }: WatchContainerProps) {
  const { rooms, roomStates, roomsReady, status, openCasino, reconnectLobby, user } = useGame()
  const { showInfo } = useError()
  const [density, setDensity] = useState<Density>('standard')
  const [focusedId, setFocusedId] = useState<string | null>(null)

  // 연결: 첫 진입(idle)이면 카지노 열기(기존 PredictModePanel handleConnect와 동일한 의도)
  useEffect(() => {
    if (status === 'idle' && user?.siteUrl) {
      openCasino(user.siteUrl).catch(() => { /* 연결 실패는 상태바에 반영 */ })
    }
    // 마운트 시 1회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const roomList = useMemo(() => Array.from(rooms.values()), [rooms])

  const cards = useMemo<RoomCardData[]>(
    () => roomList.map((room) => toCardData(room, roomStates.get(room.id) || null)),
    [roomList, roomStates],
  )

  const recommend = useMemo<RecommendItem[]>(() => {
    return roomList
      .map((room) => {
        const s = roomStates.get(room.id) || null
        const cw = s?.stats.consecutiveWins ?? 0
        const total = s?.stats.total ?? 0
        const wr = s?.stats.winRate ?? 0
        return { room, s, cw, total, wr, good: (total > 0 && wr >= 60) || cw >= 2 }
      })
      .filter((x) => x.good)
      .sort((a, b) => b.wr - a.wr)
      .slice(0, 3)
      .map((x, i) => ({
        id: x.room.id,
        rank: i + 1,
        name: x.room.koreanName || x.room.name,
        hits: x.s?.stats.correct ?? 0,
        total: x.total,
        note: x.cw >= 2 ? `▲ ${x.cw}연속 좋음` : undefined,
      }))
  }, [roomList, roomStates])

  const connection = roomsReady ? 'online' : 'offline'

  const handleOpenRoom = useCallback((id: string) => setFocusedId(id), [])
  const handleReconnect = useCallback(() => {
    reconnectLobby().catch(() => { /* ignore */ })
  }, [reconnectLobby])

  // L2 — 한 방 자세히
  const focusedRoom = focusedId ? rooms.get(focusedId) || null : null
  if (focusedRoom) {
    const state = roomStates.get(focusedRoom.id) || null
    const pred = state?.lastPrediction
    const prediction: PredictionValue = pred?.isSkip ? 'pass' : pred?.prediction ?? 'wait'
    const streak = trailingStreak(focusedRoom.history)
    const name = focusedRoom.koreanName || focusedRoom.name
    return (
      <FocusedRoomView
        roomName={name}
        breadcrumb={`예측 보기 › ${name} › 자세히`}
        connection={connection}
        prediction={prediction}
        counts={winnerCounts(focusedRoom.history)}
        patternLabel={
          streak.side && streak.count >= 2 ? `${WINNER_KO[streak.side]} ${streak.count}연속` : undefined
        }
        bigRoadSlot={<BigRoad history={focusedRoom.history} />}
        beadPlateSlot={<BeadPlate history={focusedRoom.history} />}
        primaryActionLabel="이 방에서 추천 받기"
        onPrimaryAction={() => showInfo('추천 받기는 다음 단계에서 연결됩니다.')}
        onBack={() => setFocusedId(null)}
      />
    )
  }

  // L1 — 방 목록
  return (
    <WatchView
      rooms={cards}
      recommend={recommend}
      density={density}
      onDensityChange={setDensity}
      connection={connection}
      onOpenRoom={handleOpenRoom}
      onHome={onHome}
      onReconnect={connection === 'offline' ? handleReconnect : undefined}
    />
  )
}

export default WatchContainer
