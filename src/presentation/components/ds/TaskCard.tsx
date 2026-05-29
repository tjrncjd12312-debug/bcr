// TaskCard — 통합 디자인시스템: 홈 허브의 작업 카드(살펴보기/도움받기/자동맡기기)
// 리디자인 1단계. 큰 제목 + 한 문장 평이한 한국어 설명 + 큰 시작 버튼.
import './TaskCard.css'

interface TaskCardProps {
  title: string
  description: string
  /** 우상단 보조 태그(예: '보기' / '옆에서' / '연습 중') */
  tag?: string
  /** 실제 배팅 중일 때만 표시되는 빨강 배지 텍스트(예: '실제 배팅 중') */
  liveBadge?: string
  startLabel?: string
  onStart: () => void
  className?: string
}

export function TaskCard({
  title,
  description,
  tag,
  liveBadge,
  startLabel = '시작하기',
  onStart,
  className = '',
}: TaskCardProps) {
  return (
    <section className={`task-card ${className}`} aria-label={title}>
      <div className="task-card__head">
        <h2 className="task-card__title">{title}</h2>
        <div className="task-card__badges">
          {liveBadge && <span className="task-card__live">● {liveBadge}</span>}
          {tag && <span className="task-card__tag">〔{tag}〕</span>}
        </div>
      </div>
      <p className="task-card__desc">{description}</p>
      <button type="button" className="task-card__start" onClick={onStart}>
        {startLabel}
        <span className="task-card__start-arrow" aria-hidden="true">▶</span>
      </button>
    </section>
  )
}

export default TaskCard
