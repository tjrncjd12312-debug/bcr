// AppShell — 통합 디자인시스템: 세 작업이 공유하는 영속 껍데기
// 리디자인 1단계. 상단바 56px(항상 같은 자리 [홈]/[← 뒤로] + 빵부스러기 + 연결·시각)
// + 자동 켜질 때만 뜨는 안전 띠 슬롯. 모드별 자체 헤더를 이걸로 대체(네비게이션 프랑켄슈타인 제거).
import type { ReactNode } from 'react'
import './AppShell.css'

interface AppShellProps {
  /** 좌상단 버튼 라벨(예: '홈' 또는 '← 방 목록'). 없으면 버튼 숨김 */
  backLabel?: string
  onBack?: () => void
  /** 빵부스러기(예: '살펴보기 › 방 목록' 또는 '자동맡기기 › 스피드 바카라 A › 자세히') */
  breadcrumb?: string
  connection?: 'online' | 'offline'
  /** 데이터 신선도(예: '오후 3:24' / '방금 받음'). offline이면 '마지막 갱신' 의미로 표시 */
  freshness?: string
  /** 상단바 아래 안전 띠(자동 배팅 켜질 때만 전달) */
  safety?: ReactNode
  children: ReactNode
  className?: string
}

export function AppShell({
  backLabel,
  onBack,
  breadcrumb,
  connection = 'online',
  freshness,
  safety,
  children,
  className = '',
}: AppShellProps) {
  return (
    <div className={`app-shell ${className}`}>
      <header className="app-shell__bar">
        <div className="app-shell__left">
          {backLabel && (
            <button type="button" className="app-shell__back" onClick={onBack}>
              {backLabel}
            </button>
          )}
        </div>
        <div className="app-shell__crumb" title={breadcrumb}>
          {breadcrumb}
        </div>
        <div className="app-shell__right" aria-live="polite">
          <span className={`app-shell__conn app-shell__conn--${connection}`}>
            <span className="app-shell__conn-dot" aria-hidden="true">●</span>
            {connection === 'online' ? '연결됨' : '연결 끊김'}
          </span>
          {freshness && (
            <span className="app-shell__fresh">
              {connection === 'online' ? freshness : `· 마지막 갱신 ${freshness}`}
            </span>
          )}
        </div>
      </header>

      {safety && <div className="app-shell__safety">{safety}</div>}

      <main className="app-shell__body">{children}</main>
    </div>
  )
}

export default AppShell
