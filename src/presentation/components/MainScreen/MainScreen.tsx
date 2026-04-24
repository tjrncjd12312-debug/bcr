// MainScreen - Main application screen (Composition Component)
// Clean Architecture: Presentation Layer - Routes to appropriate mode panel
// Simplified: Only supports 'auto' and 'predict' modes

import { GameProvider } from '../../context/GameContext'
import type { AppMode } from '../../../domain/entities'

// Mode panels
import AutoModePanel from '../AutoModePanel'
import PredictModePanel from '../PredictModePanel'

interface MainScreenProps {
  user: { username: string; siteUrl: string }
  onLogout: () => void
  sessionWarning?: string
  isOnline?: boolean
  appMode: AppMode
}

// Inner Component that uses Context
function MainScreenContent({ onLogout, sessionWarning, isOnline, appMode }: Omit<MainScreenProps, 'user'>) {
  // Predict mode - show premium prediction panel
  if (appMode === 'predict') {
    return (
      <PredictModePanel
        onLogout={onLogout}
        sessionWarning={sessionWarning}
        isOnline={!!isOnline}
      />
    )
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
