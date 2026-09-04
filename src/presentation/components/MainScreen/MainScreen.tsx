// MainScreen — 자동배팅 전용 진입(2026-09-05, 사용자 지시: "오토 기능만 남기고 나머지는 UI에서 안 보이게").
//   로그인 직후 곧바로 AutoModePanel. 살펴보기(WatchContainer)·도움받기(AssistContainer)·HomeHub는
//   코드로는 남겨 두되 화면 경로에서 뺐다. 데이터 계층은 항상 'auto'(CDP 모니터링·멀티소켓·실배팅).

import { GameProvider } from '../../context/GameContext'
import type { AppMode } from '../../../domain/entities'
import AutoModePanel from '../AutoModePanel'

interface MainScreenProps {
  user: { username: string; siteUrl: string }
  onLogout: () => void
  sessionWarning?: string
  isOnline?: boolean
  /** @deprecated 자동배팅 전용 화면에서는 무시 — 항상 'auto'. */
  appMode?: AppMode
}

export default function MainScreen({ user, onLogout, sessionWarning, isOnline = true }: MainScreenProps) {
  return (
    <GameProvider user={user} onLogout={onLogout} appMode="auto">
      <AutoModePanel
        onLogout={onLogout}
        sessionWarning={sessionWarning}
        isOnline={!!isOnline}
      />
    </GameProvider>
  )
}
