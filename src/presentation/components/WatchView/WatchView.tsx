// WatchView — 살펴보기(예측기) Level 1 방 목록
// 리디자인 2단계. 네 개 뷰(로비/그리드/컴팩트/랭킹)+10개 정렬버튼을 공용 RoomCard 목록 +
// 표준/촘촘 토글 하나로 통합. 공용 AppShell 위에서 동작. 순수 표현 컴포넌트(콜백·데이터 props).
import { AppShell } from '../ds/AppShell'
import { RoomCard, type RoomCardData } from '../ds/RoomCard'
import { DensityToggle, type Density } from '../ds/DensityToggle'
import { RecommendStrip, type RecommendItem } from './RecommendStrip'
import './WatchView.css'

interface WatchViewProps {
  rooms: RoomCardData[]
  recommend?: RecommendItem[]
  goodCount?: number
  density: Density
  onDensityChange: (d: Density) => void
  connection?: 'online' | 'offline'
  freshness?: string
  /** 방 자세히 보기(L2 진입, 1탭) */
  onOpenRoom: (id: string) => void
  /** 홈 허브로 복귀 */
  onHome: () => void
  /** 연결 끊김 시 다시 연결(있으면 오프라인 상태에서 버튼 노출) */
  onReconnect?: () => void
  className?: string
}

export function WatchView({
  rooms,
  recommend = [],
  goodCount,
  density,
  onDensityChange,
  connection = 'online',
  freshness,
  onOpenRoom,
  onHome,
  onReconnect,
  className = '',
}: WatchViewProps) {
  const good = goodCount ?? recommend.length
  const offline = connection === 'offline'

  return (
    <AppShell
      backLabel="홈"
      onBack={onHome}
      breadcrumb="예측 보기 › 방 목록"
      connection={connection}
      freshness={freshness}
    >
      <div className={`watch-view ${className}`}>
        <div className="watch-view__statusline">
          <span className="watch-view__counts">
            보는 방 {rooms.length}개{good > 0 && <> · 흐름 좋은 방 {good}개</>}
          </span>
          <div className="watch-view__statusline-right">
            {offline && onReconnect && (
              <button type="button" className="watch-view__reconnect" onClick={onReconnect}>
                다시 연결
              </button>
            )}
            <DensityToggle value={density} onChange={onDensityChange} />
          </div>
        </div>

        {recommend.length > 0 && (
          <RecommendStrip items={recommend} onSelect={onOpenRoom} />
        )}

        {rooms.length === 0 ? (
          <div className="watch-view__empty">
            {offline ? (
              <>
                <p>연결이 끊겼어요.</p>
                {onReconnect && (
                  <button type="button" className="watch-view__reconnect" onClick={onReconnect}>
                    다시 연결
                  </button>
                )}
              </>
            ) : (
              '방을 불러오는 중이에요…'
            )}
          </div>
        ) : (
          <div className={`watch-view__grid watch-view__grid--${density}`}>
            {rooms.map((r) => (
              <RoomCard key={r.id} data={r} density={density} onOpen={onOpenRoom} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}

export default WatchView
