// AutoModeRepository - 영속성 추상화
// Clean Architecture: Application Layer (Port)
// 단일 책임: AutoMode 설정 및 상태의 저장/로드

import type { AutoModeSettings } from '../AutoModeService'

// ==================== Storage Keys ====================

const SETTINGS_STORAGE_KEY = 'smart-helper:auto-mode-settings'
const REST_PERIODS_STORAGE_KEY = 'smart-helper:room-rest-periods'

// ==================== Interface ====================

export interface IAutoModeRepository {
  /**
   * AutoMode 설정 로드
   * @returns 저장된 설정 또는 null
   */
  loadSettings(): Partial<AutoModeSettings> | null

  /**
   * AutoMode 설정 저장
   * @param settings 저장할 설정 (enabled, autoBetting은 항상 false로 저장)
   */
  saveSettings(settings: AutoModeSettings): void

  /**
   * 방별 휴식 기간 로드
   * @returns roomId → restingUntil(timestamp) 맵
   */
  loadRestPeriods(): Map<string, number>

  /**
   * 방별 휴식 기간 저장
   * @param roomStates 방별 상태 맵 (restingUntil이 있는 방만 저장)
   */
  saveRestPeriods(roomStates: Map<string, { restingUntil: number | null }>): void

  /**
   * 휴식 기간 데이터 삭제
   */
  clearRestPeriods(): void
}

// ==================== LocalStorage Implementation ====================

export class LocalStorageAutoModeRepository implements IAutoModeRepository {
  loadSettings(): Partial<AutoModeSettings> | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return null
      }
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY)
      if (!stored) return null
      const parsed = JSON.parse(stored)
      console.log('[AutoModeRepository] Loaded settings from storage')
      return parsed
    } catch (e) {
      console.warn('[AutoModeRepository] Failed to load from storage:', e)
      return null
    }
  }

  saveSettings(settings: AutoModeSettings): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      // Don't save enabled state - always start disabled
      const toSave = { ...settings, enabled: false, autoBetting: false }
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(toSave))
    } catch (e) {
      console.warn('[AutoModeRepository] Failed to save to storage:', e)
    }
  }

  loadRestPeriods(): Map<string, number> {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return new Map()
      }
      const stored = localStorage.getItem(REST_PERIODS_STORAGE_KEY)
      if (!stored) return new Map()

      const parsed = JSON.parse(stored) as Record<string, number>
      const now = Date.now()
      const validPeriods = new Map<string, number>()

      // Only load non-expired rest periods
      for (const [roomId, restingUntil] of Object.entries(parsed)) {
        if (typeof restingUntil === 'number' && restingUntil > now) {
          validPeriods.set(roomId, restingUntil)
        }
      }

      if (validPeriods.size > 0) {
        console.log(`[AutoModeRepository] Loaded ${validPeriods.size} active rest periods from storage`)
      }
      return validPeriods
    } catch (e) {
      console.warn('[AutoModeRepository] Failed to load rest periods:', e)
      return new Map()
    }
  }

  saveRestPeriods(roomStates: Map<string, { restingUntil: number | null }>): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }

      const periods: Record<string, number> = {}
      const now = Date.now()

      // Only save non-expired rest periods
      roomStates.forEach((state, roomId) => {
        if (state.restingUntil && state.restingUntil > now) {
          periods[roomId] = state.restingUntil
        }
      })

      if (Object.keys(periods).length > 0) {
        localStorage.setItem(REST_PERIODS_STORAGE_KEY, JSON.stringify(periods))
      } else {
        localStorage.removeItem(REST_PERIODS_STORAGE_KEY)
      }
    } catch (e) {
      console.warn('[AutoModeRepository] Failed to save rest periods:', e)
    }
  }

  clearRestPeriods(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      localStorage.removeItem(REST_PERIODS_STORAGE_KEY)
    } catch (e) {
      console.warn('[AutoModeRepository] Failed to clear rest periods:', e)
    }
  }
}

// ==================== Factory ====================

let repositoryInstance: IAutoModeRepository | null = null

export function getAutoModeRepository(): IAutoModeRepository {
  if (!repositoryInstance) {
    repositoryInstance = new LocalStorageAutoModeRepository()
  }
  return repositoryInstance
}

/**
 * 테스트용: 리포지토리 인스턴스 교체
 * @param repo 사용할 리포지토리 (null이면 기본값으로 리셋)
 */
export function setAutoModeRepository(repo: IAutoModeRepository | null): void {
  repositoryInstance = repo
}

export function resetAutoModeRepository(): void {
  repositoryInstance = null
}

export default LocalStorageAutoModeRepository
