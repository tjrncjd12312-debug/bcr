// MiniBigRoad — 통합 디자인시스템: 카드 안 '큰길' 미니맵
// 리디자인 1~2단계. 비드플레이트가 아니라 '큰길'을 카드의 인지 앵커로 1줄 노출.
// 게임색 규약(뱅커=빨강/플레이어=파랑/타이=초록) 고정. 색 구분 가능한 최소 크기.
import './MiniBigRoad.css'

export type RoadResult = 'B' | 'P' | 'T'

interface MiniBigRoadProps {
  /** 최근 결과 배열(오래된 → 최신). 끝에서 max개만 표시 */
  results: RoadResult[]
  max?: number
  className?: string
}

const CLS: Record<RoadResult, string> = { B: 'banker', P: 'player', T: 'tie' }

export function MiniBigRoad({ results, max = 14, className = '' }: MiniBigRoadProps) {
  if (!results || results.length === 0) {
    return <span className={`mini-road mini-road--empty ${className}`}>기록 모으는 중</span>
  }
  const shown = results.slice(-max)
  return (
    <span className={`mini-road ${className}`} aria-label="큰길 미리보기">
      {shown.map((r, i) => (
        <span key={i} className={`mini-road__dot mini-road__dot--${CLS[r]}`} aria-hidden="true" />
      ))}
    </span>
  )
}

export default MiniBigRoad
