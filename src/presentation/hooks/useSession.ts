// useSession - Session management hook
// Presentation Layer - React interface for SessionService
// Clean Architecture: Uses Application Layer service (not direct invoke)

import { useState, useEffect, useCallback } from 'react'
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
  validationIntervalMs = 30000,
}: UseSessionOptions): UseSessionReturn {
  const [remainingSeconds, setRemainingSeconds] = useState(initialSeconds)
  const [isValid, setIsValid] = useState(initialSeconds > 0)
  const [isOnline, setIsOnline] = useState(true)

  // Start session when initialSeconds changes
  useEffect(() => {
    if (initialSeconds <= 0) {
      setRemainingSeconds(0)
      setIsValid(false)
      return
    }

    // Start session service
    SessionService.startSession(initialSeconds, { validationIntervalMs })

    // Subscribe to events
    const unsubWarning = SessionService.onWarning(onWarning)
    const unsubExpired = SessionService.onExpired((reason) => {
      setIsValid(false)
      onExpired(reason)
    })
    const unsubOffline = SessionService.onOffline(() => {
      setIsOnline(false)
      onOffline()
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
  }, [initialSeconds, validationIntervalMs, onWarning, onExpired, onOffline])

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
