// HomeHub — Level 0 "무엇을 도와드릴까요?" 작업 중심 홈 허브
// 리디자인 1단계. 모드 선택을 대체하는 post-login 랜딩.
// 세 작업은 탭이 아니라 신뢰의 사다리(살펴보기 → 도움받기 → 자동맡기기).
// 순수 표현 컴포넌트 — 콜백만 받음(라이브 배선은 상위에서 결정).
import { AppShell } from '../ds/AppShell'
import { TaskCard } from '../ds/TaskCard'
import { SafetyStrip } from '../ds/SafetyStrip'
import './HomeHub.css'

export type HubTask = 'watch' | 'assist' | 'auto'

interface HomeHubProps {
  connection?: 'online' | 'offline'
  freshness?: string
  /** 자동 배팅 진행 중이면 안전 띠 노출 */
  autoRunning?: boolean
  autoRoomCount?: number
  /** 자동이 실제 돈이면 true → 카드/띠에 빨강 신호 */
  autoIsReal?: boolean
  onSelectTask: (task: HubTask) => void
  onEmergencyStop?: () => void
  /** 진행 중인 자동맡기기로 복귀 */
  onResumeAuto?: () => void
}

const TASKS: { key: HubTask; title: string; desc: string; tag: string }[] = [
  { key: 'watch', title: '예측 보기', desc: '방들의 다음 결과를 예측만 봐요. 배팅은 안 해요.', tag: '보기' },
  { key: 'assist', title: '추천 받기', desc: '방 하나를 골라서, 다음에 뭘 걸지 추천해드려요.', tag: '추천' },
  { key: 'auto', title: '자동 배팅', desc: '여러 방을 알아서 분석하고 자동으로 배팅해요.', tag: '자동' },
]

export function HomeHub({
  connection = 'online',
  freshness,
  autoRunning = false,
  autoRoomCount = 0,
  autoIsReal = false,
  onSelectTask,
  onEmergencyStop,
  onResumeAuto,
}: HomeHubProps) {
  const safety = autoRunning ? (
    <SafetyStrip
      tone={autoIsReal ? 'danger' : 'warning'}
      message={
        autoIsReal
          ? `실제 배팅 중입니다 · 진행 중 ${autoRoomCount}개`
          : `자동 배팅이 켜져 있어요 · 진행 중 ${autoRoomCount}개`
      }
      onStop={onEmergencyStop}
      resumeLabel="돌아가기"
      onResume={onResumeAuto}
    />
  ) : undefined

  return (
    <AppShell
      breadcrumb="무엇을 도와드릴까요?"
      connection={connection}
      freshness={freshness}
      safety={safety}
    >
      <div className="home-hub">
        <h1 className="home-hub__heading">무엇을 도와드릴까요?</h1>
        <p className="home-hub__sub">예측만 볼지, 추천을 받을지, 자동으로 할지 골라주세요.</p>

        <div className="home-hub__cards">
          {TASKS.map((t) => (
            <TaskCard
              key={t.key}
              title={t.title}
              description={t.desc}
              tag={t.tag}
              liveBadge={t.key === 'auto' && autoRunning && autoIsReal ? '실제 배팅 중' : undefined}
              onStart={() => onSelectTask(t.key)}
            />
          ))}
        </div>
      </div>
    </AppShell>
  )
}

export default HomeHub
