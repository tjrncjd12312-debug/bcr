// useSession - Session management hook
// Presentation Layer - React interface for SessionService
// Clean Architecture: Uses Application Layer service (not direct invoke)

import { useState, useEffect, useCallback, useRef } from 'react'
import { SessionService, formatSessionTime, isSessionWarning } from '../../application/services/SessionService'
import type { SessionInvalidReason } from '../../domain/entities'

interface UseSessionOptions {
  /** Initial session time in seconds (from login response) */
  initialSeconds: number
  /** Called when session has 30 or 10 minutes remaining */
  onWarning: (minutesLeft: number) => void
  /** Called when session expires or is invalidated */
  onExpired: (reason: SessionInvalidReason) => void
  /** Called when offline state is detected */
  onOffline: () => void
  /** Validation interval in milliseconds (default: 30000) */
  validationIntervalMs?: number
}

interface UseSessionReturn {
  /** Remaining session time in seconds */
  remainingSeconds: number
  /** True if remaining time is 30 minutes or less */
  isWarning: boolean
  /** Formatted time string (e.g., "2시간 30분" or "10:30") */
  formattedTime: string
  /** True if session is valid */
  isValid: boolean
  /** Current online/offline status */
  isOnline: boolean
  /** Stop session manually */
  stopSession: () => void
}

/**
 * Session management hook
 * Presentation Layer wrapper for SessionService
 */
export function useSession({
  initialSeconds,
  onWarning,
  onExpired,
  onOffline,
  validationIntervalMs = 10000, // 한 계정 1인 접속 — 다른 기기 로그인을 10초 안에 감지
}: UseSessionOptions): UseSessionReturn {
  const [remainingSeconds, setRemainingSeconds] = useState(initialSeconds)
  const [isValid, setIsValid] = useState(initialSeconds > 0)
  const [isOnline, setIsOnline] = useState(true)

  // 🐞 2026-09-05: App이 인라인 콜백을 넘기고 이 훅이 1초마다 remainingSeconds를 갱신해 App을 재렌더하므로,
  //   콜백을 effect 의존성에 두면 세션이 매초 stop→start를 반복해 검증 타이머(10초)가 영영 안 울렸다
  //   (= 중복 로그인·만료가 실제로 감지되지 않음). 최신 콜백은 ref로 들고 effect는 세션 자체에만 의존한다.
  const onWarningRef = useRef(onWarning)
  const onExpiredRef = useRef(onExpired)
  const onOfflineRef = useRef(onOffline)
  onWarningRef.current = onWarning
  onExpiredRef.current = onExpired
  onOfflineRef.current = onOffline

  // Start session when initialSeconds changes
  useEffect(() => {
    if (initialSeconds <= 0) {
      setRemainingSeconds(0)
      setIsValid(false)
      return
    }

    // Start session service
    SessionService.startSession(initialSeconds, { validationIntervalMs })

    // Subscribe to events (항상 최신 콜백으로)
    const unsubWarning = SessionService.onWarning((minutes) => onWarningRef.current(minutes))
    const unsubExpired = SessionService.onExpired((reason) => {
      setIsValid(false)
      onExpiredRef.current(reason)
    })
    const unsubOffline = SessionService.onOffline(() => {
      setIsOnline(false)
      onOfflineRef.current()
    })

    // Poll state for UI updates (every second)
    const stateInterval = setInterval(() => {
      const state = SessionService.getState()
      setRemainingSeconds(state.remainingSeconds)
      setIsValid(state.isValid)
      setIsOnline(state.isOnline)
    }, 1000)

    // Cleanup
    return () => {
      unsubWarning()
      unsubExpired()
      unsubOffline()
      clearInterval(stateInterval)
      SessionService.stopSession()
    }
  }, [initialSeconds, validationIntervalMs])

  // Stop session callback
  const stopSession = useCallback(() => {
    SessionService.stopSession()
    setRemainingSeconds(0)
    setIsValid(false)
  }, [])

  // Computed values
  const isWarningState = isSessionWarning(remainingSeconds)
  const formattedTime = formatSessionTime(remainingSeconds)

  return {
    remainingSeconds,
    isWarning: isWarningState,
    formattedTime,
    isValid,
    isOnline,
    stopSession,
  }
}

export default useSession
