// AutoModeRoomGrid — Evolution 멀티위젯 타일 레이아웃(EvoRoomCard) 격자.
//   필터·정렬은 useRoomFilter(리스트·모자이크와 같은 규칙)로 통일, 카드는 memo로 방 데이터가 바뀐 카드만 다시 그린다.
import { useMemo } from 'react'
import type { Room, RoomPredictionState, RoomFilterType, RoomSortType, SortDirection } from '../../../../domain/entities'
import type { RoomBettingState, AutoModeSettings } from '../../../../application/services/AutoModeService'
import type { ManualRoomBet, ManualSide, ManualProgression } from '../../../../application/services/ManualBetService'
import { progressionAmount } from '../../../../application/services/ManualBetService'

/** 운영바 보기 필터: 전체 / 추천 방 / 연패 방 / 배팅 중 */
export type GridViewFilter = 'all' | 'recommended' | 'losing' | 'betting'
const RECOMMEND_CONFIDENCE = 0.65
import { useRoomFilter } from '../hooks/useRoomFilter'
import { EvoRoomCard } from './EvoRoomCard'
import { LazyMount } from './LazyMount'
import type { RoadView } from './EvoBigRoad'
import '../AutoModePanel.css'

type RoomBetStatus = 'pending' | 'win' | 'loss' | 'tie' | 'failed' | 'pass'

// 방별 배팅 로그 인터페이스
export interface RoomBetLog {
  betAmount: number
  status: RoomBetStatus
  profit: number
  martinLevel: number
  prediction?: 'B' | 'P' | 'T' | null
  winner?: 'B' | 'P' | 'T'
  message?: string
  historyIndex?: number
  timestamp: number
}

interface AutoModeRoomGridProps {
  rooms: Map<string, Room>
  roomStates: Map<string, RoomPredictionState>
  autoModeRoomStates: Map<string, RoomBettingState>
  enabledRoomIds: Set<string>
  settings: AutoModeSettings
  isAutoEnabled: boolean
  flashingRooms: Set<string>
  roomBetLogs: Map<string, RoomBetLog[]>
  roomTimers: Map<string, number>  // 실시간 타이머
  selectedPattern: RoomFilterType | 'all'
  activeFilters?: RoomFilterType[]
  matchesFilter: (room: Room, state: RoomPredictionState | null, pattern: RoomFilterType) => boolean
  sortType: RoomSortType
  sortDirection?: SortDirection  // 정렬 방향 (asc/desc)
  roomDataVersion: number  // 방 데이터 업데이트 시마다 증가 (실시간 업데이트 트리거)
  filterSettingsSignature?: string
  /** 수동(반자동) 칩 배팅 */
  manualActive?: boolean
  manualBets?: Map<string, ManualRoomBet>
  onManualSpot?: (room: Room, side: ManualSide) => void
  onManualUndo?: (room: Room) => void
  onManualClear?: (room: Room) => void
  roadView?: RoadView
  viewFilter?: GridViewFilter
  /** 수동 모드 마틴: 방별 단계·설정·따라가기 */
  manualMartinLevels?: Map<string, number>
  manualProgression?: ManualProgression
  manualFollowMartin?: boolean
  recommendConfidence?: number
}

const NO_LEVELS = new Map<string, number>()
const NO_MANUAL_BETS = new Map<string, ManualRoomBet>()

export function AutoModeRoomGrid({
  rooms,
  roomStates,
  autoModeRoomStates,
  enabledRoomIds,
  settings,
  isAutoEnabled,
  flashingRooms,
  roomBetLogs,
  roomTimers,
  selectedPattern,
  activeFilters,
  matchesFilter,
  sortType,
  sortDirection = 'desc',
  roomDataVersion,
  filterSettingsSignature,
  manualActive = false,
  manualBets = NO_MANUAL_BETS,
  onManualSpot,
  onManualUndo,
  onManualClear,
  roadView = 'big',
  viewFilter = 'all',
  manualMartinLevels = NO_LEVELS,
  manualProgression,
  manualFollowMartin = false,
  recommendConfidence = RECOMMEND_CONFIDENCE,
}: AutoModeRoomGridProps) {
  const roomList = useMemo(() => Array.from(rooms.values()), [rooms])
  const filteredRooms = useRoomFilter({
    rooms: roomList,
    roomStates,
    bettingStates: autoModeRoomStates,
    enabledRoomIds,
    selectedPattern,
    activeFilters,
    matchesFilter,
    sortType,
    sortDirection,
    roomDataVersion,
    filterSettingsSignature,
    bettingFirst: !manualActive, // 자동: 배팅 중·마틴 진행 방을 위로(사용자 요청). 수동: 자리 고정(클릭 대상이 안 움직이게)
  })

  // 보기 필터(표시만 바꾼다 — 배팅 대상·정렬은 그대로)
  const viewRooms = useMemo(() => {
    if (viewFilter === 'all') return filteredRooms
    return filteredRooms.filter((room) => {
      const auto = autoModeRoomStates.get(room.id)
      const pred = roomStates.get(room.id)?.lastPrediction
      if (viewFilter === 'betting') return manualActive ? manualBets.has(room.id) : !!auto?.waitingForResult
      if (viewFilter === 'losing') return manualActive ? (manualMartinLevels.get(room.id) ?? 0) > 0 : ((auto?.martinLevel ?? 0) > 0 || (auto?.consecutiveLosses ?? 0) > 0)
      // recommended
      if (manualActive) return !!pred && !pred.isSkip && !!pred.prediction && (pred.confidence ?? 0) >= recommendConfidence
      return !!auto?.lastPrediction || !!auto?.waitingForResult || (auto?.martinLevel ?? 0) > 0
    })
  }, [filteredRooms, viewFilter, manualActive, manualBets, manualMartinLevels, autoModeRoomStates, roomStates, recommendConfidence])

  if (viewRooms.length === 0) {
    const emptyByFilter = viewFilter !== 'all' && filteredRooms.length > 0
    return (
      <div className="auto-mode__evo-grid">
        {emptyByFilter ? (
          <div className="auto-mode__room-empty auto-mode__room-empty--center">
            <p>{viewFilter === 'recommended' ? '지금 추천 방이 없습니다' : viewFilter === 'losing' ? '연패 중인 방이 없습니다' : '배팅 중인 방이 없습니다'}</p>
            <p className="auto-mode__room-empty-hint">보기 필터를 '전체'로 바꾸면 모든 방이 보입니다</p>
          </div>
        ) : null}
        {!emptyByFilter && (
          <EmptyGridMessage isAutoEnabled={isAutoEnabled} />
        )}
      </div>
    )
  }

  return (
    <div className="auto-mode__evo-grid">
      {viewRooms.map(room => (
        <LazyMount key={room.id} label={room.koreanName || room.name}>
        <EvoRoomCard
          room={room}
          autoState={autoModeRoomStates.get(room.id) || null}
          isEnabled={enabledRoomIds.has(room.id)}
          isAutoEnabled={isAutoEnabled}
          isFlashing={flashingRooms.has(room.id)}
          betLogs={roomBetLogs.get(room.id) || EMPTY_LOGS}
          timer={roomTimers.get(room.id) || 0}
          settings={settings}
          activeFilters={activeFilters}
          manualActive={manualActive}
          manualBet={manualBets.get(room.id) ?? null}
          prediction={manualActive ? (roomStates.get(room.id)?.lastPrediction ?? null) : null}
          onManualSpot={onManualSpot}
          onManualUndo={onManualUndo}
          onManualClear={onManualClear}
          roadView={roadView}
          recommendConfidence={recommendConfidence}
          manualMartin={manualActive && manualProgression
            ? {
                level: manualMartinLevels.get(room.id) ?? 0,
                maxStage: Math.max(1, manualProgression.maxMartin),
                nextAmount: progressionAmount(manualMartinLevels.get(room.id) ?? 0, manualProgression),
                follow: manualFollowMartin,
              }
            : null}
        />
        </LazyMount>
      ))}
    </div>
  )
}

// 빈 로그는 같은 참조를 넘겨 memo 카드가 불필요하게 재렌더되지 않게 한다.
const EMPTY_LOGS: RoomBetLog[] = []

function EmptyGridMessage({ isAutoEnabled }: { isAutoEnabled: boolean }) {
  return (
    <div className="auto-mode__room-empty auto-mode__room-empty--center">
      {isAutoEnabled ? (
        <>
          <p>배팅 중인 방이 없습니다</p>
          <p className="auto-mode__room-empty-hint">패턴에 맞는 방이 나타나면 자동 배팅됩니다</p>
        </>
      ) : (
        <>
          <p>오토 배팅이 꺼져있습니다</p>
          <p className="auto-mode__room-empty-hint">시작 버튼을 눌러 시작하세요</p>
        </>
      )}
    </div>
  )
}

export default AutoModeRoomGrid
