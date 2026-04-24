// Top6Rankings - 추천 방 컴포넌트 (다음 예측 적중 가능성 높은 상위 6개 방 추천, 2x3 그리드)
import { useMemo, memo } from 'react'
import { Star, Crown, Flame, X, LogIn, EyeOff } from 'lucide-react'
import type { RoomPredictionState, Room } from '../../../domain/entities'
import './Top3Rankings.css'

interface Top3RankingsProps {
  roomStates: Map<string, RoomPredictionState>
  rooms: Map<string, Room>
  onRoomClick: (roomId: string) => void
  onEnterRoom?: (roomId: string) => void  // 입장 버튼 클릭 시
  selectedRoomId?: string | null          // 선택된 방 ID (미리보기 상태)
  minPredictions?: number
  compact?: boolean
}

interface RankedRoom {
  roomId: string
  roomName: string
  koreanName: string
  winRate: number
  total: number
  correct: number
  consecutiveWins: number
  consecutiveLosses: number
  recent5WinRate: number  // 최근 5게임 적중률
  score: number           // 복합 추천 점수
  isOutOfRank?: boolean   // 순위 밖 (미리보기 중이지만 추천에서 제외된 방)
}

// 최근 N게임 적중률 계산
function calcRecentWinRate(history: { result: string }[], n: number): number {
  if (!history || history.length === 0) return 0
  // history는 최신이 [0]이므로 앞에서 n개 추출
  const recent = history.slice(0, n).filter(h => h.result === 'WIN' || h.result === 'LOSS')
  if (recent.length === 0) return 0
  const wins = recent.filter(h => h.result === 'WIN').length
  return (wins / recent.length) * 100
}

// 추천 점수 계산 (높을수록 추천)
function calcRecommendScore(
  consecutiveWins: number,
  consecutiveLosses: number,
  recent5WinRate: number,
  totalWinRate: number,
  total: number
): number {
  // 연패 중이면 제외 (점수 -1000)
  if (consecutiveLosses >= 2) return -1000

  let score = 0

  // 1. 연승 보너스 (가중치 높음) - 흐름이 좋은 상태
  // 연승 1 = +20, 연승 2 = +45, 연승 3 = +75, 연승 4 = +110, 연승 5+ = +150
  if (consecutiveWins >= 1) {
    score += consecutiveWins * 20 + (consecutiveWins - 1) * 5
    if (consecutiveWins >= 5) score += 50 // 5연승 이상 추가 보너스
  }

  // 2. 최근 5게임 적중률 (0~100 -> 0~50점)
  score += recent5WinRate * 0.5

  // 3. 전체 적중률 보정 (0~100 -> 0~30점)
  score += totalWinRate * 0.3

  // 4. 샘플 사이즈 보정 (예측 수가 많을수록 신뢰도 높음)
  // 5~10게임: +0~10점, 10~20게임: +10~15점, 20+: +15점
  if (total >= 20) score += 15
  else if (total >= 10) score += 10 + (total - 10) * 0.5
  else if (total >= 5) score += (total - 5) * 2

  // 5. 최근 1패 직후면 약간 감점 (회복 중)
  if (consecutiveLosses === 1) score -= 10

  return score
}

export const Top3Rankings = memo(function Top3Rankings({
  roomStates,
  rooms,
  onRoomClick,
  onEnterRoom,
  selectedRoomId,
  minPredictions = 5,  // 기본값 5게임으로 변경
  compact = false
}: Top3RankingsProps) {

  // 추천 목록 계산 (상위 6개)
  const top6 = useMemo(() => {
    const ranked: RankedRoom[] = []

    roomStates.forEach((state, roomId) => {
      const room = rooms.get(roomId)
      if (!room) return
      
      // 최소 5게임 이상 예측해야 함
      if (state.stats.total < Math.max(5, minPredictions)) return
      
      // 연패 2 이상이면 제외
      if (state.stats.consecutiveLosses >= 2) return

      // 최근 5게임 적중률 계산
      const recent5WinRate = calcRecentWinRate(state.history, 5)

      // 추천 점수 계산
      const score = calcRecommendScore(
        state.stats.consecutiveWins,
        state.stats.consecutiveLosses,
        recent5WinRate,
        state.stats.winRate,
        state.stats.total
      )

      ranked.push({
        roomId,
        roomName: room.name,
        koreanName: room.koreanName,
        winRate: state.stats.winRate,
        total: state.stats.total,
        correct: state.stats.correct,
        consecutiveWins: state.stats.consecutiveWins,
        consecutiveLosses: state.stats.consecutiveLosses,
        recent5WinRate,
        score,
        isOutOfRank: false
      })
    })

    return ranked
      .sort((a, b) => {
        // 추천 점수로 정렬 (높을수록 좋음)
        if (b.score !== a.score) return b.score - a.score
        // 점수 같으면 연승 > 최근5게임 > 전체적중률 순
        if (b.consecutiveWins !== a.consecutiveWins) return b.consecutiveWins - a.consecutiveWins
        if (b.recent5WinRate !== a.recent5WinRate) return b.recent5WinRate - a.recent5WinRate
        return b.winRate - a.winRate
      })
      .slice(0, 6)
  }, [roomStates, rooms, minPredictions])

  // 미리보기 중인 방이 목록에 없으면 추가
  const displayRooms = useMemo(() => {
    // 미리보기 방이 없거나 이미 목록에 있으면 그대로 반환
    if (!selectedRoomId || top6.some(r => r.roomId === selectedRoomId)) {
      return top6
    }

    // 미리보기 방이 목록에서 빠졌으면 추가
    const previewRoom = rooms.get(selectedRoomId)
    const previewState = roomStates.get(selectedRoomId)
    
    if (!previewRoom) {
      return top6
    }

    // 미리보기 방 정보 구성 (상태가 없어도 방 정보만으로 입장 가능)
    const recent5WinRate = previewState ? calcRecentWinRate(previewState.history, 5) : 0
    
    const previewRanked: RankedRoom = {
      roomId: selectedRoomId,
      roomName: previewRoom.name,
      koreanName: previewRoom.koreanName,
      winRate: previewState?.stats.winRate ?? 0,
      total: previewState?.stats.total ?? 0,
      correct: previewState?.stats.correct ?? 0,
      consecutiveWins: previewState?.stats.consecutiveWins ?? 0,
      consecutiveLosses: previewState?.stats.consecutiveLosses ?? 0,
      recent5WinRate,
      score: -999,  // 순위 밖 표시용
      isOutOfRank: true
    }

    // 목록 맨 앞에 추가 (미리보기 중인 방은 항상 첫 번째에 표시)
    return [previewRanked, ...top6]
  }, [top6, selectedRoomId, rooms, roomStates])

  // 추천할 방이 없으면 안내 메시지 표시
  if (displayRooms.length === 0) {
    return (
      <div className={`top3-rankings top3-rankings--empty ${compact ? 'top3-rankings--compact' : ''}`}>
        <div className="top3-rankings__header">
          <Star size={18} className="top3-rankings__icon" />
          <span>추천</span>
        </div>
        <div className="top3-rankings__empty-msg">
          5게임 이상 예측 데이터가 쌓이면 추천 방이 표시됩니다
        </div>
      </div>
    )
  }

  return (
    <div className={`top3-rankings ${compact ? 'top3-rankings--compact' : ''}`}>
      <div className="top3-rankings__header">
        <Star size={18} className="top3-rankings__icon" />
        <span>추천</span>
      </div>

      <div className="top3-rankings__list">
        {displayRooms.map((room, index) => {
          const isSelected = selectedRoomId === room.roomId
          const isOutOfRank = room.isOutOfRank
          
          // 순위 밖 방이 앞에 있으면 실제 순위 계산 필요
          // 순위 밖 방은 rank 클래스 대신 out-of-rank 클래스 사용
          let actualRank = 0
          let rankClass: string
          if (isOutOfRank) {
            rankClass = 'top3-card--out-of-rank'
          } else {
            // 현재 index까지 순위 밖 방 개수를 빼서 실제 순위 계산
            actualRank = index - displayRooms.slice(0, index).filter(r => r.isOutOfRank).length + 1
            rankClass = `top3-card--rank${actualRank}`
          }
          
          return (
            <div
              key={room.roomId}
              className={`top3-card ${rankClass} ${isSelected ? 'top3-card--selected' : ''}`}
            >
              {/* 카드 메인 버튼 */}
              <button
                className="top3-card__main"
                onClick={() => {
                  console.log('[추천방] Room clicked:', room.roomId, room.koreanName, 'score:', room.score.toFixed(1), isOutOfRank ? '(순위 밖)' : `(${actualRank}위)`)
                  onRoomClick(room.roomId)
                }}
              >
                {/* 순위 뱃지 - 순위 밖은 EyeOff 아이콘 */}
                <div className="top3-card__rank">
                  {isOutOfRank ? (
                    <EyeOff size={14} />
                  ) : actualRank === 1 ? (
                    <Crown size={14} />
                  ) : (
                    <span>{actualRank}</span>
                  )}
                </div>

                {/* 방 정보 */}
                <div className="top3-card__info">
                  <div className="top3-card__name-row">
                    <span className="top3-card__name" title={room.koreanName}>{room.koreanName}</span>
                    {isOutOfRank && <span className="top3-card__out-badge">미리보기</span>}
                  </div>
                  <div className="top3-card__stats">
                    <span className="top3-card__recent" title="최근 5게임 적중률">
                      {room.recent5WinRate.toFixed(0)}%
                    </span>
                    <span className="top3-card__total" title="전체 적중률">
                      ({room.correct}/{room.total})
                    </span>
                  </div>
                </div>

                {/* 연승 뱃지 */}
                {room.consecutiveWins >= 2 && (
                  <div className={`top3-card__streak ${room.consecutiveWins >= 3 ? 'hot' : ''}`}>
                    <Flame size={12} />
                    <span>{room.consecutiveWins}연승</span>
                  </div>
                )}
              </button>

              {/* 선택 시 취소/입장 버튼 표시 */}
              {isSelected && onEnterRoom && (
                <div className="top3-card__actions">
                  <button
                    className="top3-card__cancel"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRoomClick(room.roomId)  // 토글하여 선택 해제
                    }}
                    title="취소"
                  >
                    <X size={12} />
                  </button>
                  <button
                    className="top3-card__enter"
                    onClick={(e) => {
                      e.stopPropagation()
                      onEnterRoom(room.roomId)
                    }}
                    title="입장"
                  >
                    <LogIn size={14} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default Top3Rankings
