// StatusBadge — 통합 디자인시스템: 방/세션 상태를 색 + 모양 + 한글 3중 코딩으로 표시
// 리디자인 1단계. 게임색(빨/파)을 상태에 재사용하지 않음 — 상태는 중립/앰버/초록(success) 토큰.
import './StatusBadge.css'

export type RoomStatus =
  | 'loading'   // 불러오는 중
  | 'offline'   // 연결 끊김
  | 'betting'   // 배팅 중
  | 'idle'      // 대기
  | 'awaiting'  // 결과 대기
  | 'alert'     // 경보(연패/깊은 마틴 등)

interface StatusBadgeProps {
  status: RoomStatus
  /** 기본 한글 라벨 대체(예: '경보 · 4연패') */
  label?: string
  className?: string
}

const STATUS: Record<RoomStatus, { text: string; shape: string }> = {
  loading: { text: '불러오는 중', shape: '⏳' },
  offline: { text: '연결 끊김', shape: '⚠' },
  betting: { text: '배팅 중', shape: '◆' },
  idle: { text: '대기', shape: '◇' },
  awaiting: { text: '결과 대기', shape: '⏳' },
  alert: { text: '경보', shape: '▲' },
}

export function StatusBadge({ status, label, className = '' }: StatusBadgeProps) {
  const meta = STATUS[status]
  const text = label ?? meta.text
  return (
    <span
      className={`status-badge status-badge--${status} ${className}`}
      role="status"
      aria-label={text}
    >
      <span className="status-badge__shape" aria-hidden="true">{meta.shape}</span>
      <span className="status-badge__text">{text}</span>
    </span>
  )
}

export default StatusBadge
