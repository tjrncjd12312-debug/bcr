import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './styles/global.css'
import LoginScreen from './presentation/components/LoginScreen'
import MainScreen from './presentation/components/MainScreen'
import { NoticePopup, shouldHideNotice } from './presentation/components/NoticePopup'
import { useError } from './presentation/context'
import { useSession } from './presentation/hooks'
import type { User, LoginResult, SessionInvalidReason, AppMode, NoticeData } from './domain/entities'

/**
 * ✅ Security: 에러 메시지에서 URL/IP 패턴 제거
 */
function sanitizeErrorMessage(message: string): string {
  const urlPattern = /https?:\/\/[^\s]+|[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}[^\s]*/gi
  const ipPattern = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g
  return message.replace(urlPattern, '[주소]').replace(ipPattern, '[서버]')
}
import { EvolutionAdapter } from './infrastructure/adapters/EvolutionAdapter'
import { SoundManager } from './infrastructure/utils/SoundManager'
import { SessionService } from './application/services/SessionService'
import { VirtualBettingService } from './application/services/VirtualBettingService'
import { AutoBettingService } from './application/services/AutoBettingService'
import { PatternBettingService } from './application/services/PatternBettingService'
import { CustomPatternService } from './application/services/CustomPatternService'
import { AutoModeService } from './application/services/AutoModeService'
import { ManualBetService } from './application/services/ManualBetService'
import { SemiAutoService } from './application/services/SemiAutoService'
import { RoomFilterService } from './application/services/RoomFilterService'
import { MultiRoomPredictionService } from './application/services/MultiRoomPredictionService'

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [sessionSeconds, setSessionSeconds] = useState<number>(0)
  const [appMode, setAppMode] = useState<AppMode>('auto')
  const [notice, setNotice] = useState<NoticeData | null>(null)
  const { showError, showWarning, showInfo } = useError()

  // Session management hook
  const { isWarning, formattedTime, isOnline } = useSession({
    initialSeconds: sessionSeconds,
    onWarning: (minutesLeft) => {
      showWarning(`세션 만료 ${minutesLeft}분 전입니다.`)
    },
    onExpired: async (reason: SessionInvalidReason) => {
      const messages: Record<SessionInvalidReason, string> = {
        expired: '세션이 만료되었습니다. 프로그램이 종료됩니다.',
        duplicate_login: '다른 기기에서 로그인되어 연결이 종료됩니다.',
        token_revoked: '세션이 종료되었습니다. 프로그램이 종료됩니다.',
        offline: '네트워크 연결이 없습니다. 온라인 상태에서만 사용 가능합니다.',
        server_error: '서버 오류로 연결이 종료됩니다.',
      }
      showError('AUTH_SESSION_EXPIRED', messages[reason])

      // 🔥 리소스 정리 (메모리 누수 방지)
      EvolutionAdapter.dispose()
      await SoundManager.dispose()
      SessionService.dispose()
      VirtualBettingService.dispose()
      AutoBettingService.dispose()
      PatternBettingService.dispose()
      CustomPatternService.dispose()
      AutoModeService.dispose()
      ManualBetService.dispose()
      SemiAutoService.dispose()
      RoomFilterService.dispose()
      MultiRoomPredictionService.dispose()

      // Logout and exit after 3 seconds
      try {
        await invoke('logout')
      } catch (e) {
        console.warn('Logout failed:', e)
      }
      setUser(null)
      setSessionSeconds(0)

      // Exit app after showing message (except for offline - just logout)
      if (reason !== 'offline') {
        setTimeout(() => {
          invoke('exit_app').catch(console.error)
        }, 3000)
      }
    },
    onOffline: async () => {
      showError('NETWORK_ERROR', '네트워크 연결이 없습니다. 온라인 상태에서만 사용 가능합니다.')

      // 🔥 리소스 정리 (메모리 누수 방지)
      EvolutionAdapter.dispose()
      await SoundManager.dispose()
      SessionService.dispose()
      VirtualBettingService.dispose()
      AutoBettingService.dispose()
      PatternBettingService.dispose()
      CustomPatternService.dispose()
      AutoModeService.dispose()
      ManualBetService.dispose()
      SemiAutoService.dispose()
      RoomFilterService.dispose()
      MultiRoomPredictionService.dispose()

      // Logout user when offline
      setUser(null)
      setSessionSeconds(0)
    },
  })

  // No session restore - always require new login
  // 정액 시간 관리를 위해 매번 새로 로그인하여 서버에서 남은 시간을 받아와야 함

  const handleLogin = useCallback(async (username: string, password: string, siteUrl: string, mode: AppMode) => {
    setIsLoading(true)
    setAppMode(mode)

    try {
      const result = await invoke<LoginResult>('login', {
        request: {
          username,
          password,
          siteUrl
        }
      })

      if (result.success && result.user) {
        // ✅ Security: 사용 시간 만료 체크 (프론트엔드 안전장치)
        const seconds = result.remainingSeconds || 0
        if (seconds < 1) {
          showError('AUTH_SESSION_EXPIRED', '요금제가 만료되었습니다. 관리자에게 문의하세요. 프로그램이 종료됩니다.')
          // 3초 후 앱 종료
          setTimeout(() => {
            invoke('exit_app').catch(console.error)
          }, 3000)
          throw new Error('요금제가 만료되었습니다.')
        }

        setUser(result.user)
        setSessionSeconds(seconds)

        const hours = Math.floor(seconds / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        const timeStr = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`
        showInfo(`${result.user.username}님 환영합니다. (남은 시간: ${timeStr})`)

        // Show notice popup if available and not hidden
        if (result.notice && !shouldHideNotice(result.notice.id)) {
          setNotice(result.notice)
        }
      } else {
        // ✅ Security: 에러 메시지에서 URL 제거
        const safeMessage = sanitizeErrorMessage(result.message || '로그인에 실패했습니다.')

        // 요금제 만료 시 앱 종료
        if (result.message?.includes('사용 시간이 만료') || result.message?.includes('요금제')) {
          showError('AUTH_SESSION_EXPIRED', '요금제가 만료되었습니다. 관리자에게 문의하세요. 프로그램이 종료됩니다.')
          setTimeout(() => {
            invoke('exit_app').catch(console.error)
          }, 3000)
          throw new Error('요금제가 만료되었습니다.')
        }

        showError('AUTH_FAILED', safeMessage)
        throw new Error(safeMessage)
      }
    } catch (error) {
      // ✅ Security: 에러 메시지에서 URL 제거
      const rawMessage = error instanceof Error ? error.message : '로그인에 실패했습니다.'
      const safeMessage = sanitizeErrorMessage(rawMessage)
      showError('AUTH_FAILED', safeMessage)
      throw error instanceof Error ? new Error(safeMessage) : new Error(safeMessage)
    } finally {
      setIsLoading(false)
    }
  }, [showError, showInfo])

  const handleLogout = useCallback(async () => {
    try {
      // 🔥 리소스 정리 (메모리 누수 방지)
      EvolutionAdapter.dispose()
      await SoundManager.dispose()
      SessionService.dispose()
      VirtualBettingService.dispose()
      AutoBettingService.dispose()
      PatternBettingService.dispose()
      CustomPatternService.dispose()
      AutoModeService.dispose()
      ManualBetService.dispose()
      SemiAutoService.dispose()
      RoomFilterService.dispose()
      MultiRoomPredictionService.dispose()

      await invoke('logout')
      setUser(null)
      setSessionSeconds(0)
      showInfo('로그아웃되었습니다.')
    } catch (error) {
      showWarning('로그아웃 중 오류가 발생했습니다.')
      console.warn('Logout failed:', error)
      // Still clear user state to allow re-login
      setUser(null)
      setSessionSeconds(0)
    }
  }, [showInfo, showWarning])

  return (
    <div className="app">
      {!user ? (
        <LoginScreen onLogin={handleLogin} isLoading={isLoading} />
      ) : (
        <MainScreen
          user={user}
          onLogout={handleLogout}
          sessionWarning={isWarning ? formattedTime : undefined}
          isOnline={isOnline}
          appMode={appMode}
        />
      )}

      {/* Notice Popup */}
      {notice && (
        <NoticePopup
          notice={notice}
          onClose={() => setNotice(null)}
        />
      )}
    </div>
  )
}

export default App
