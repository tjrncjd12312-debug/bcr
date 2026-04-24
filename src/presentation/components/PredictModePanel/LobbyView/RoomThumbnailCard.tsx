import { memo, useState, useCallback, useRef, useEffect } from 'react'
import type { Room, RoomPredictionState } from '../../../../domain/entities'
import { BeadPlate } from '../../MainScreen/components/BeadPlate'
import { BigRoad } from '../../MainScreen/components/BigRoad'
import ThreeRowOXGrid from '../ThreeRowOXGrid'

// localStorage 키 - 사용자 설정 저장
const LOBBY_ROAD_TYPE_KEY = 'lobby_road_type'

interface RoomThumbnailCardProps {
  room: Room
  state: RoomPredictionState | null | undefined
  isSelected: boolean
  onSelect: (room: Room) => void
  onEnter: (roomId: string) => void
  martinLevel?: number
}

const RoomThumbnailCard = memo(function RoomThumbnailCard({
  room,
  state,
  isSelected,
  onSelect,
  onEnter,
  martinLevel
}: RoomThumbnailCardProps) {
  // 기본값 'big' (원매) + localStorage에서 사용자 설정 불러오기
  const [mainRoadType, setMainRoadType] = useState<'bead' | 'big'>(() => {
    try {
      const saved = localStorage.getItem(LOBBY_ROAD_TYPE_KEY)
      return saved === 'bead' ? 'bead' : 'big'  // 기본값 'big' (원매)
    } catch {
      return 'big'
    }
  })

  const handleToggleMap = useCallback((e: React.MouseEvent, type: 'bead' | 'big') => {
    e.stopPropagation()
    setMainRoadType(type)
    // 사용자 설정을 localStorage에 저장
    try {
      localStorage.setItem(LOBBY_ROAD_TYPE_KEY, type)
    } catch { /* ignore */ }
  }, [])

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(room); // 카드 클릭 시 선택(하이라이트)만 수행
  }, [onSelect, room]);

  const handleEnterClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEnter(room.id); // 버튼 클릭 시에만 실제 입장(이동) 수행
  }, [onEnter, room.id]);

  const winRateValue = state?.stats?.winRate ? Math.round(state.stats.winRate) : 0

  // 마틴 0단계일 땐 미표시, 1단계부터 표시
  const displayMartinLevel = martinLevel ?? (state?.stats?.consecutiveLosses ?? 0)

  // 예측 표시 (PASS/SKIP 처리 포함)
  const isSkip = state?.lastPrediction?.isSkip || state?.lastPrediction?.prediction === 'T'
  const prediction = state?.lastPrediction?.prediction
  const predictionLabel = isSkip ? 'PASS' : (prediction === 'B' || prediction === 'P') ? prediction : null
  const nextPrediction = isSkip ? 'SKIP' : (prediction === 'B' || prediction === 'P') ? prediction : null

  // 🔥 로드맵 스크롤 컨테이너 ref
  const roadContentRef = useRef<HTMLDivElement>(null)
  const threeLineRef = useRef<HTMLDivElement>(null)
  const prevHistoryLengthRef = useRef<number>(-1) // -1로 초기화하여 첫 로드 시 스크롤 트리거
  const isInitialMountRef = useRef<boolean>(true)

  // 🔥 히스토리 변경 시 자동으로 오른쪽(최신)으로 스크롤
  const historyLength = room.history?.length || 0

  useEffect(() => {
    // 첫 마운트 또는 새 결과가 추가되었는지 감지
    const isFirstMount = isInitialMountRef.current
    const isNewResult = historyLength > prevHistoryLengthRef.current

    isInitialMountRef.current = false
    prevHistoryLengthRef.current = historyLength

    // 첫 로드나 새 결과 시에만 스크롤
    if (!isFirstMount && !isNewResult) return

    // 약간의 지연 후 스크롤 (렌더링 완료 대기)
    const timer = setTimeout(() => {
      // 6매/원매 스크롤 - 최신으로 스크롤
      const roadContainer = roadContentRef.current
      if (roadContainer) {
        const { scrollWidth, clientWidth } = roadContainer
        if (scrollWidth > clientWidth) {
          roadContainer.scrollTo({ left: scrollWidth, behavior: isFirstMount ? 'auto' : 'smooth' })
        }
      }

      // 3매 스크롤은 ThreeRowOXGrid 내부에서 처리
    }, 100) // 초기 로드 시 렌더링 대기 시간 증가

    return () => clearTimeout(timer)
  }, [historyLength, mainRoadType])

  return (
    <div
      className={`lobby-v3-card ${isSelected ? 'is-selected' : ''}`}
      onClick={handleCardClick}
    >
      <div className="lobby-v3-card__header">
        <div className="lobby-v3-card__info">
          <div className="lobby-v3-card__name-row">
            <div className="lobby-v3-card__name">{room.koreanName || room.name}</div>
            {predictionLabel && (
              <span className={`v-badge prediction active ${predictionLabel.toLowerCase()}`}>
                {predictionLabel}
              </span>
            )}
          </div>
          <div className="lobby-v3-card__badges">
            <span className="v-badge win-rate">승률 {winRateValue}%</span>
            {displayMartinLevel > 0 && (
              <span className={`v-badge martin ${displayMartinLevel > 1 ? 'active' : ''}`}>
                {displayMartinLevel}단계
              </span>
            )}
          </div>
        </div>
        <div className="lobby-v3-card__actions">
          <button className="lobby-v3-card__enter-btn" onClick={handleEnterClick}>방입장</button>
        </div>
      </div>

      <div className="lobby-v3-card__main-road">
        <div className="lobby-v3-card__road-header">
          <div className="lobby-v3-card__road-title">
            {mainRoadType === 'bead' ? '6매 (주판로)' : '원매 (빅로드)'}
          </div>
          <div className="lobby-v3-card__road-toggle">
            <button
              className={mainRoadType === 'bead' ? 'active' : ''}
              onClick={(e) => handleToggleMap(e, 'bead')}
            >
              6매
            </button>
            <button
              className={mainRoadType === 'big' ? 'active' : ''}
              onClick={(e) => handleToggleMap(e, 'big')}
            >
              원매
            </button>
          </div>
        </div>
        <div className="lobby-v3-card__road-content" ref={roadContentRef}>
          {mainRoadType === 'bead' ? (
            <BeadPlate history={room.history} rows={6} cols={20} minSize={14} maxSize={14} gap={2} />
          ) : (
            <BigRoad history={room.history} rows={6} cols={20} minSize={14} maxSize={14} gap={2} />
          )}
        </div>
      </div>

      <div className="lobby-v3-card__fixed-3line" ref={threeLineRef}>
        <div className="lobby-v3-card__3line-title">3매 분석 (O/X 분석)</div>
        <ThreeRowOXGrid state={state} nextPrediction={nextPrediction} />
      </div>
    </div>
  );
});

export default RoomThumbnailCard;
