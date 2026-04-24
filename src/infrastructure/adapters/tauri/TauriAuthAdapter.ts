// TauriAuthAdapter - Authentication adapter implementation
// Implements IAuthPort interface (Single Responsibility)
// Includes session management for 정액 시간 (subscription time) and duplicate login detection

import { invoke } from '@tauri-apps/api/core'
import type { IAuthPort, AuthResult, UserInfo } from '../../../domain/interfaces'
import type { SessionStatus } from '../../../domain/entities'

// Tauri backend response types
interface TauriUserInfo {
  username: string
  token: string
  siteUrl?: string
}

/**
 * Type guard to validate UserInfo structure
 */
function isValidUserInfo(value: unknown): value is TauriUserInfo {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.username === 'string' && typeof obj.token === 'string'
}

/**
 * Safely parse user info from Tauri response
 */
function parseUserInfo(value: unknown): UserInfo | null {
  if (!isValidUserInfo(value)) return null
  return {
    username: value.username,
    token: value.token,
    siteUrl: value.siteUrl,
  }
}

class TauriAuthAdapterImpl implements IAuthPort {
  async login(username: string, password: string): Promise<AuthResult> {
    try {
      const result = await invoke<TauriUserInfo>('login', { username, password })
      const user = parseUserInfo(result)
      if (!user) {
        return {
          success: false,
          error: 'Invalid user data received from server',
        }
      }
      return {
        success: true,
        user,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async logout(): Promise<void> {
    await invoke('logout')
  }

  async restoreSession(): Promise<AuthResult | null> {
    try {
      const result = await invoke<TauriUserInfo | null>('restore_session')
      if (!result) return null

      const user = parseUserInfo(result)
      if (!user) return null

      return {
        success: true,
        user,
      }
    } catch {
      return null
    }
  }

  async isLoggedIn(): Promise<boolean> {
    return invoke<boolean>('is_logged_in')
  }

  async getCurrentUser(): Promise<UserInfo | null> {
    try {
      const result = await invoke<TauriUserInfo | null>('get_current_user')
      return parseUserInfo(result)
    } catch {
      return null
    }
  }

  // ==================== Session Management ====================

  /**
   * Validate current session
   * Called periodically (every 30 seconds) to check for:
   * - Session expiry (정액 시간 만료)
   * - Duplicate login (다른 기기에서 로그인)
   * - Network connectivity
   */
  async validateSession(): Promise<SessionStatus> {
    try {
      return await invoke<SessionStatus>('validate_session')
    } catch (error) {
      // Network error - return offline status
      console.warn('[TauriAuthAdapter] Session validation failed:', error)
      return {
        isValid: false,
        invalidationReason: 'offline',
      }
    }
  }

  /**
   * Get remaining session time in seconds
   */
  async getRemainingSeconds(): Promise<number | null> {
    try {
      return await invoke<number | null>('get_remaining_seconds')
    } catch {
      return null
    }
  }

  /**
   * Check if session is expired
   */
  async isSessionExpired(): Promise<boolean> {
    try {
      return await invoke<boolean>('is_session_expired')
    } catch {
      return true
    }
  }

  /**
   * Exit the application (called when session expires)
   */
  async exitApp(): Promise<void> {
    try {
      await invoke('exit_app')
    } catch (error) {
      console.error('[TauriAuthAdapter] Failed to exit app:', error)
    }
  }
}

export const TauriAuthAdapter = new TauriAuthAdapterImpl()
export default TauriAuthAdapter
