// MainScreen — 통합 홈(단일 진입) + 신뢰 사다리 라우팅
// 리디자인: 모드 선택을 없애고 로그인 직후 항상 HomeHub로 진입.
//   - 살펴보기   → WatchContainer  (예측 데이터 모드)
//   - 도움받기   → AssistContainer (예측 데이터 모드)
//   - 자동맡기기 → AutoModePanel   (auto 데이터 모드)
//
// ⚠️ appMode는 화면뿐 아니라 데이터 계층(CDP 모니터링·멀티소켓·실배팅)을 가른다. 그래서 선택한
//    작업에서 dataMode를 파생해 GameProvider를 key={dataMode}로 감싼다 → 'predict↔auto'를 건널 때만
//    재마운트(=자동 진입/이탈 시 1회 재연결). 살펴보기↔도움받기는 같은 predict라 재마운트 없음.
//    (사용자 결정: "자동 진입 때만 전환"). 각 조합은 기존에 검증된 조합을 그대로 재현한다:
//    GameProvider('predict')+watch/assist, GameProvider('auto')+AutoModePanel.

import { useState } from 'react'
import { GameProvider, useGame } from '../../context/GameContext'
import type { AppMode } from '../../../domain/entities'

// Task screens
import AutoModePanel from '../AutoModePanel'
import { HomeHub, type HubTask } from '../HomeHub'
import { WatchContainer } from '../WatchView/WatchContainer'
import { AssistContainer } from '../AssistView/AssistContainer'

interface MainScreenProps {
  user: { username: string; siteUrl: string }
  onLogout: () => void
  sessionWarning?: string
  isOnline?: boolean
  /** @deprecated 통합 홈에서는 무시 — 데이터 모드는 선택한 작업에서 파생한다. */
  appMode?: AppMode
}

interface HubContentProps {
  onLogout: () => void
  sessionWarning?: string
  isOnline: boolean
  task: HubTask | null
  setTask: (task: HubTask | null) => void
}

// 공용 셸 안의 작업 라우팅 (GameProvider 내부라 useGame 사용 가능)
function HubContent({ onLogout, sessionWarning, isOnline, task, setTask }: HubContentProps) {
  const { roomsReady } = useGame()

  if (task === 'watch') {
    return <WatchContainer onHome={() => setTask(null)} />
  }

  if (task === 'assist') {
    // 도움받기 = 검증된 반자동(SemiAutoPanel)을 공용 셸에 배선. 가상 베팅 기본.
    return <AssistContainer onHome={() => setTask(null)} />
  }

  if (task === 'auto') {
    // 자동맡기기 = 실제 자동 배팅(AutoModePanel). dataMode='auto'로 GameProvider가 재마운트된 상태.
    return (
      <AutoModePanel
        onLogout={onLogout}
        sessionWarning={sessionWarning}
        isOnline={!!isOnline}
        onHome={() => setTask(null)}
      />
    )
  }

  return <HomeHub connection={roomsReady ? 'online' : 'offline'} onSelectTask={setTask} />
}

export default function MainScreen({ user, onLogout, sessionWarning, isOnline = true }: MainScreenProps) {
  const [task, setTask] = useState<HubTask | null>(null)

  // 자동맡기기만 'auto' 데이터 모드. 홈/살펴보기/도움받기는 'predict'.
  const dataMode: AppMode = task === 'auto' ? 'auto' : 'predict'

  return (
    // key={dataMode}: predict↔auto를 건널 때만 GameProvider 재마운트 = 자동 진입/이탈 시 1회 재연결.
    <GameProvider key={dataMode} user={user} onLogout={onLogout} appMode={dataMode}>
      <HubContent
        onLogout={onLogout}
        sessionWarning={sessionWarning}
        isOnline={isOnline}
        task={task}
        setTask={setTask}
      />
    </GameProvider>
  )
}
