// AutoModeRepository - 영속성 추상화
// Clean Architecture: Application Layer (Port)
// 단일 책임: AutoMode 설정의 저장/로드

import type { AutoModeSettings } from '../AutoModeService'

// ==================== Storage Keys ====================

const SETTINGS_STORAGE_KEY = 'smart-helper:auto-mode-settings'

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
