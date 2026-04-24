import type { AppMode } from '../../../domain/entities'

interface StoredLoginData {
  username: string
  password: string
  siteUrl: string
  rememberPassword: boolean
  rememberProfile: boolean
  appMode: AppMode  // 🔥 선택한 모드 저장
}

const STORAGE_KEY = 'smart-helper:login'

const defaultLoginData: StoredLoginData = {
  username: '',
  password: '',
  siteUrl: '',
  rememberPassword: false,
  rememberProfile: true,
  appMode: 'predict',  // 🔥 기본값: 예측 모드
}

function isStorageAvailable(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false
  }

  try {
    const testKey = '__smart_helper_login__'
    window.localStorage.setItem(testKey, '1')
    window.localStorage.removeItem(testKey)
    return true
  } catch (error) {
    console.warn('Local storage unavailable:', error)
    return false
  }
}

export function loadStoredLogin(): StoredLoginData {
  if (!isStorageAvailable()) {
    return defaultLoginData
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return defaultLoginData
    }

    const parsed = JSON.parse(raw) as Partial<StoredLoginData>
    return {
      ...defaultLoginData,
      ...parsed,
    }
  } catch (error) {
    console.warn('Failed to load saved login info:', error)
    return defaultLoginData
  }
}

export function persistLogin(data: StoredLoginData): void {
  if (!isStorageAvailable()) {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (error) {
    console.warn('Failed to save login info:', error)
  }
}

export function clearSavedLogin(): void {
  if (!isStorageAvailable()) {
    return
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.warn('Failed to clear saved login info:', error)
  }
}

export type { StoredLoginData }
