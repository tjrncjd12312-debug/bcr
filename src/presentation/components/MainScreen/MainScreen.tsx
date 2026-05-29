// MainScreen - Main application screen (Composition Component)
// Clean Architecture: Presentation Layer - Routes to appropriate mode panel
// 리디자인 2단계 배선: 예측 모드 진입점을 작업 중심 홈 허브(HomeHub)로 교체.
//   - 살펴보기 → WatchContainer (신규, 라이브 배선)
//   - 도움받기/자동맡기기 → 기존 PredictModePanel 임시 패스스루(후속 단계에서 전용 화면)
// GameProvider는 그대로 한 번만 마운트 → 카지노/CDP 동작·appMode 불변(자동배팅 영향 없음).

import { useState } from 'react'
import { GameProvider, useGame } from '../../context/GameContext'
import type { AppMode } from '../../../domain/entities'

// Mode panels
import AutoModePanel from '../AutoModePanel'
import PredictModePanel from '../PredictModePanel'
import { HomeHub, type HubTask } from '../HomeHub'
import { WatchContainer } from '../WatchView/WatchContainer'

interface MainScreenProps {
  user: { username: string; siteUrl: string }
  onLogout: () => void
  sessionWarning?: string
  isOnline?: boolean
  appMode: AppMode
}

type ModeContentProps = Omit<MainScreenProps, 'user'>

// 예측 모드: 작업 중심 홈 허브로 진입
function PredictHub({ onLogout, sessionWarning, isOnline }: Omit<ModeContentProps, 'appMode'>) {
  const { roomsReady } = useGame()
  const [task, setTask] = useState<HubTask | null>(null)

  if (task === 'watch') {
    return <WatchContainer onHome={() => setTask(null)} />
  }

  if (task === 'assist' || task === 'auto') {
    // 임시 패스스루: 기존 예측 화면(세미오토 진입 포함). 도움받기/자동맡기기 전용 재설계는 후속 단계.
    return <PredictModePanel onLogout={onLogout} sessionWarning={sessionWarning} isOnline={!!isOnline} />
  }

  return <HomeHub connection={roomsReady ? 'online' : 'offline'} onSelectTask={setTask} />
}

// Inner Component that uses Context
function MainScreenContent({ onLogout, sessionWarning, isOnline, appMode }: ModeContentProps) {
  // Predict mode - 작업 중심 홈 허브
  if (appMode === 'predict') {
    return <PredictHub onLogout={onLogout} sessionWarning={sessionWarning} isOnline={isOnline} />
  }

  // Auto betting mode - show dedicated auto mode panel (default)
  return (
    <AutoModePanel
      onLogout={onLogout}
      sessionWarning={sessionWarning}
      isOnline={!!isOnline}
    />
  )
}

// Wrapper Component
export default function MainScreen({ user, onLogout, sessionWarning, isOnline = true, appMode }: MainScreenProps) {
  return (
    <GameProvider user={user} onLogout={onLogout} appMode={appMode}>
      <MainScreenContent onLogout={onLogout} sessionWarning={sessionWarning} isOnline={isOnline} appMode={appMode} />
    </GameProvider>
  )
}
