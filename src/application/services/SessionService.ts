// SessionService - Session management use case
// Application Layer - Coordinates session validation and expiry logic
// Clean Architecture: Uses IAuthPort interface (Dependency Inversion)

import type { IAuthPort } from '../../domain/interfaces'
import type { SessionStatus, SessionInvalidReason } from '../../domain/entities'
import { 
  SESSION_WARNING_THRESHOLDS, 
  formatSessionTime, 
  isSessionWarning, 
  getWarningMinutes 
} from '../../domain/utils/converters'
import { container } from '../di'

// Re-export domain utilities for convenience
export { SESSION_WARNING_THRESHOLDS, formatSessionTime, isSessionWarning, getWarningMinutes }

// ==================== Service (Use Case) ====================

type SessionCallback = (status: SessionStatus) => void
type WarningCallback = (minutesLeft: number) => void
type ExpiredCallback = (reason: SessionInvalidReason) => void
type OfflineCallback = () => void

interface SessionServiceConfig {
  validationIntervalMs: number
}

const DEFAULT_CONFIG: SessionServiceConfig = {
  validationIntervalMs: 30000, // 30 seconds
}

/**
 * Session management service
 * Application Layer - Coordinates between UI and Infrastructure
 */
class SessionServiceImpl {
  private authPort: IAuthPort | null = null
  private config: SessionServiceConfig = DEFAULT_CONFIG

  private remainingSeconds: number = 0
  private isValid: boolean = false
  private isOnline: boolean = true

  private timerInterval: ReturnType<typeof setInterval> | null = null
  private validationInterval: ReturnType<typeof setInterval> | null = null

  private sessionCallbacks: SessionCallback[] = []
  private warningCallbacks: WarningCallback[] = []
  private expiredCallbacks: ExpiredCallback[] = []
  private offlineCallbacks: OfflineCallback[] = []

  // Track shown warnings
  private warning30Shown: boolean = false
  private warning10Shown: boolean = false
  private hasExpired: boolean = false

  /**
   * Get auth port from DI container (lazy initialization)
   */
  private getAuthPort(): IAuthPort {
    if (!this.authPort) {
      this.authPort = container.get('authPort')
    }
    return this.authPort
  }

  /**
   * Start session with initial seconds from server
   */
  startSession(initialSeconds: number, config?: Partial<SessionServiceConfig>): void {
    console.log(`[SessionService] Starting session with ${initialSeconds} seconds`)

    // Reset state
    this.remainingSeconds = initialSeconds
    this.isValid = initialSeconds > 0
    this.isOnline = true
    this.warning30Shown = false
    this.warning10Shown = false
    this.hasExpired = false

    // Apply config
    if (config) {
      this.config = { ...this.config, ...config }
    }

    // Stop existing timers
    this.stopTimers()

    if (initialSeconds > 0) {
      // Start countdown timer
      this.startTimer()
      // Start validation
      this.startValidation()
    }
  }

  /**
   * Stop session (logout or expiry)
   */
  stopSession(): void {
    console.log('[SessionService] Stopping session')
    this.stopTimers()
    this.remainingSeconds = 0
    this.isValid = false
  }

  /**
   * Force session expiry (e.g., when API returns 401 token-expired)
   * This triggers the onExpired callbacks which handle logout + app exit
   */
  forceExpire(reason: SessionInvalidReason): void {
    console.log(`[SessionService] Force expire: ${reason}`)
    if (this.hasExpired) {
      console.log('[SessionService] Already expired, skipping')
      return
    }
    this.hasExpired = true
    this.isValid = false
    this.stopTimers()
    this.emitExpired(reason)
  }

  /**
   * Get current state
   */
  getState(): { remainingSeconds: number; isValid: boolean; isOnline: boolean } {
    return {
      remainingSeconds: this.remainingSeconds,
      isValid: this.isValid,
      isOnline: this.isOnline,
    }
  }

  /**
   * Subscribe to session changes
   */
  onSessionChange(callback: SessionCallback): () => void {
    this.sessionCallbacks.push(callback)
    return () => {
      this.sessionCallbacks = this.sessionCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * Subscribe to warning events
   */
  onWarning(callback: WarningCallback): () => void {
    this.warningCallbacks.push(callback)
    return () => {
      this.warningCallbacks = this.warningCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * Subscribe to expiry events
   */
  onExpired(callback: ExpiredCallback): () => void {
    this.expiredCallbacks.push(callback)
    return () => {
      this.expiredCallbacks = this.expiredCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * Subscribe to offline events
   */
  onOffline(callback: OfflineCallback): () => void {
    this.offlineCallbacks.push(callback)
    return () => {
      this.offlineCallbacks = this.offlineCallbacks.filter(cb => cb !== callback)
    }
  }

  // ==================== Private Methods ====================

  private startTimer(): void {
    this.timerInterval = setInterval(() => {
      const previousSeconds = this.remainingSeconds
      this.remainingSeconds = Math.max(0, this.remainingSeconds - 1)

      // Check for warnings
      const warningMinutes = getWarningMinutes(this.remainingSeconds, previousSeconds)
      if (warningMinutes !== null) {
        if (warningMinutes === 30 && !this.warning30Shown) {
          this.warning30Shown = true
          this.emitWarning(30)
        } else if (warningMinutes === 10 && !this.warning10Shown) {
          this.warning10Shown = true
          this.emitWarning(10)
        }
      }

      // Check for expiry
      if (this.remainingSeconds <= 0 && !this.hasExpired) {
        this.hasExpired = true
        this.isValid = false
        this.stopTimers()
        this.emitExpired('expired')
      }
    }, 1000)
  }

  private startValidation(): void {
    const validate = async () => {
      try {
        const status = await this.getAuthPort().validateSession()

        if (!status.isValid && status.invalidationReason) {
          this.isValid = false
          this.stopTimers()

          if (status.invalidationReason === 'offline') {
            this.isOnline = false
            this.emitOffline()
          } else {
            this.emitExpired(status.invalidationReason)
          }
        } else {
          this.isOnline = true
        }
      } catch (error) {
        console.warn('[SessionService] Validation failed:', error)
        this.isOnline = false
        this.emitOffline()
      }
    }

    // Skip initial validation - wait for first interval
    // This prevents false duplicate_login detection right after login
    // Server needs time to register the new token
    console.log('[SessionService] Skipping initial validation, waiting for first interval')

    // Periodic validation (first validation after interval delay)
    this.validationInterval = setInterval(validate, this.config.validationIntervalMs)
  }

  private stopTimers(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval)
      this.timerInterval = null
    }
    if (this.validationInterval) {
      clearInterval(this.validationInterval)
      this.validationInterval = null
    }
  }

  private emitWarning(minutesLeft: number): void {
    this.warningCallbacks.forEach(cb => cb(minutesLeft))
  }

  private emitExpired(reason: SessionInvalidReason): void {
    this.expiredCallbacks.forEach(cb => cb(reason))
  }

  private emitOffline(): void {
    this.offlineCallbacks.forEach(cb => cb())
  }

  /**
   * Cleanup (call on unmount)
   */
  dispose(): void {
    this.stopTimers()
    this.sessionCallbacks = []
    this.warningCallbacks = []
    this.expiredCallbacks = []
    this.offlineCallbacks = []
  }
}

// Singleton instance
export const SessionService = new SessionServiceImpl()
export default SessionService
