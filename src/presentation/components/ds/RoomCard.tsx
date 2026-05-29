// RoomCard — 통합 디자인시스템: 네 메타포(casino/dashboard/spreadsheet/roadmap)를 통합한 유일한 방 카드
// 리디자인 2단계. 데이터 정확히 6개 + 하단 단일 액션(1탭 입장). 세 작업 공용.
import { PredictionChip, type PredictionValue } from './PredictionChip'
import { StatusBadge, type RoomStatus } from './StatusBadge'
import { MiniBigRoad, type RoadResult } from './MiniBigRoad'
import type { Density } from './DensityToggle'
import './RoomCard.css'

export interface RoomCardData {
  id: string
  /** 방 이름 (한글) */
  name: string
  /** 라이브/대기 */
  live: boolean
  /** 마지막 결과 */
  lastResult: 'B' | 'P' | 'T' | null
  /** 적중률 0~100, 데이터 없으면 null → '—' */
  hitRate: number | null
  /** 큰길 미니맵용 최근 결과 */
  bigRoad: RoadResult[]
  /** 다음 예측 */
  prediction: PredictionValue
  /** 방 상태 */
  status: RoomStatus
  /** 상태 보조 라벨(예: '경보 · 4연패' / '흐름 좋음(3연속)') */
  statusLabel?: string
}

interface RoomCardProps {
  data: RoomCardData
  density?: Density
  onOpen: (id: string) => void
  openLabel?: string
  className?: string
}

export function RoomCard({
  data,
  density = 'standard',
  onOpen,
  openLabel = '이 방 자세히 보기',
  className = '',
}: RoomCardProps) {
  const compact = density === 'compact'
  return (
    <section className={`room-card room-card--${density} ${className}`} aria-label={data.name}>
      <header className="room-card__head">
        <h3 className="room-card__name">{data.name}</h3>
        <span className={`room-card__live ${data.live ? 'is-live' : ''}`}>
          {data.live ? '● 라이브' : '○ 대기중'}
        </span>
      </header>

      <div className="room-card__row">
        <span className="room-card__label">마지막 결과</span>
        {data.lastResult ? (
          <PredictionChip value={data.lastResult} kind="result" />
        ) : (
          <span className="room-card__dash">—</span>
        )}
      </div>

      <div className="room-card__row">
        <span className="room-card__label">적중률</span>
        <span className="room-card__num">{data.hitRate == null ? '—' : `${Math.round(data.hitRate)}%`}</span>
      </div>

      {!compact && (
        <div className="room-card__row room-card__row--road">
          <span className="room-card__label">큰길</span>
          <MiniBigRoad results={data.bigRoad} />
        </div>
      )}

      <div className="room-card__row">
        <span className="room-card__label">다음 예측</span>
        <PredictionChip value={data.prediction} />
      </div>

      {!compact && (
        <div className="room-card__status">
          <StatusBadge status={data.status} label={data.statusLabel} />
        </div>
      )}

      <button type="button" className="room-card__open" onClick={() => onOpen(data.id)}>
        {openLabel}
        <span aria-hidden="true"> →</span>
      </button>
    </section>
  )
}

export default RoomCard
