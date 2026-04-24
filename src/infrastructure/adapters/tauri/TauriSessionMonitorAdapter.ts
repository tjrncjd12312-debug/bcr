// TauriSessionMonitorAdapter - 세션 모니터링 관리
// Clean Architecture: Infrastructure Layer
// 단일 책임: 세션 유효성 검사, 중복 로그인 감지, 만료 경고

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ==================== Types ====================

/** 세션 유효 이벤트 */
export interface SessionValidEvent {
  type: 'session_valid'
  remaining_seconds: number
  expires_at: number
}

/** 세션 경고 이벤트 */
export interface SessionWarningEvent {
  type: 'session_expiry_warning' | 'session_expiry_soon'
  remaining_seconds: number
}

/** 세션 만료/중복로그인 이벤트 */
export interface SessionExpiredEvent {
  type: 'session_expired' | 'duplicate_login' | 'token_revoked'
  reason: string
}

/** 네트워크/서버 오류 이벤트 */
export interface SessionErrorEvent {
  type: 'network_error' | 'server_error'
  message: string
}

/** 강제 종료 이벤트 */
export interface ForceQuitEvent {
  reason: string
  timestamp: number
}

/** 세션 검증 결과 */
export interface SessionValidationResult {
  isValid: boolean
  remainingSeconds: number | null
  expiresAt: number | null
  event: SessionValidEvent | SessionWarningEvent | SessionExpiredEvent | SessionErrorEvent | null
  requiresForceQuit: boolean
}

/** 모니터링 시작 결과 */
export interface StartMonitoringResult {
  success: boolean
  message: string
  intervalSeconds: number
}

export type SessionEvent = SessionValidEvent | SessionWarningEvent | SessionExpiredEvent | SessionErrorEvent

// ==================== Interface ====================

export interface ISessionMonitorAdapter {
  // 모니터링 제어
  startSessionMonitoring(): Promise<StartMonitoringResult>
  stopSessionMonitoring(): Promise<void>
  checkSessionValidity(): Promise<SessionValidationResult>
  forceQuitApp(reason: string): Promise<void>

  // 이벤트 리스너
  onSessionEvent(callback: (event: SessionEvent) => void): Promise<UnlistenFn>
  onForceQuit(callback: (event: ForceQuitEvent) => void): Promise<UnlistenFn>
  onDuplicateLogin(callback: (event: SessionExpiredEvent) => void): Promise<UnlistenFn>
  onSessionExpired(callback: (event: SessionExpiredEvent) => void): Promise<UnlistenFn>
  onSessionExpiryWarning(callback: (event: SessionWarningEvent) => void): Promise<UnlistenFn>
  onSessionExpirySoon(callback: (event: SessionWarningEvent) => void): Promise<UnlistenFn>
}

// ==================== Implementation ====================

class TauriSessionMonitorAdapterImpl implements ISessionMonitorAdapter {
  // ==================== 모니터링 제어 ====================

  /**
   * 세션 모니터링 시작 (로그인 성공 후 호출)
   */
  async startSessionMonitoring(): Promise<StartMonitoringResult> {
    return invoke<StartMonitoringResult>('start_session_monitoring')
  }

  /**
   * 세션 모니터링 중지 (로그아웃 시 호출)
   */
  async stopSessionMonitoring(): Promise<void> {
    await invoke('stop_session_monitoring')
  }

  /**
   * 세션 유효성 검사 (수동 호출)
   */
  async checkSessionValidity(): Promise<SessionValidationResult> {
    return invoke<SessionValidationResult>('check_session_validity')
  }

  /**
   * 강제 종료 (세션 만료 또는 중복 로그인 시)
   */
  async forceQuitApp(reason: string): Promise<void> {
    await invoke('force_quit_app', { reason })
  }

  // ==================== 이벤트 리스너 ====================

  /**
   * 세션 이벤트 리스너 등록 (통합 채널)
   */
  async onSessionEvent(callback: (event: SessionEvent) => void): Promise<UnlistenFn> {
    return listen<SessionEvent>('session:event', (event) => callback(event.payload))
  }

  /**
   * 강제 종료 이벤트 리스너
   */
  async onForceQuit(callback: (event: ForceQuitEvent) => void): Promise<UnlistenFn> {
    return listen<ForceQuitEvent>('session:force_quit', (event) => callback(event.payload))
  }

  /**
   * 중복 로그인 이벤트 리스너
   */
  async onDuplicateLogin(callback: (event: SessionExpiredEvent) => void): Promise<UnlistenFn> {
    return listen<SessionExpiredEvent>('session:duplicate_login', (event) => callback(event.payload))
  }

  /**
   * 세션 만료 이벤트 리스너
   */
  async onSessionExpired(callback: (event: SessionExpiredEvent) => void): Promise<UnlistenFn> {
    return listen<SessionExpiredEvent>('session:expired', (event) => callback(event.payload))
  }

  /**
   * 세션 만료 경고 이벤트 리스너 (5분 전)
   */
  async onSessionExpiryWarning(callback: (event: SessionWarningEvent) => void): Promise<UnlistenFn> {
    return listen<SessionWarningEvent>('session:expiry_warning', (event) => callback(event.payload))
  }

  /**
   * 세션 만료 임박 경고 이벤트 리스너 (1분 전)
   */
  async onSessionExpirySoon(callback: (event: SessionWarningEvent) => void): Promise<UnlistenFn> {
    return listen<SessionWarningEvent>('session:expiry_soon', (event) => callback(event.payload))
  }
}

// ==================== Singleton Export ====================

export const TauriSessionMonitorAdapter = new TauriSessionMonitorAdapterImpl()
export default TauriSessionMonitorAdapter
