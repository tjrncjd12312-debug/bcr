// LocalStorage Adapter - Clean Architecture Infrastructure Layer
// Implements ILocalStoragePort for browser localStorage access

import type { ILocalStoragePort } from '../../domain/interfaces'

class LocalStorageAdapterImpl implements ILocalStoragePort {
  private _available: boolean | null = null

  isAvailable(): boolean {
    if (this._available !== null) return this._available

    try {
      if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
        this._available = false
        return false
      }
      if (typeof window.localStorage.setItem !== 'function') {
        this._available = false
        return false
      }
      const testKey = '__storage_test__'
      window.localStorage.setItem(testKey, '1')
      window.localStorage.removeItem(testKey)
      this._available = true
      return true
    } catch {
      this._available = false
      return false
    }
  }

  get<T>(key: string): T | null {
    if (!this.isAvailable()) return null

    try {
      const raw = window.localStorage.getItem(key)
      if (raw === null) return null
      return JSON.parse(raw) as T
    } catch (error) {
      console.warn(`[LocalStorage] Failed to get key "${key}":`, error)
      return null
    }
  }

  set<T>(key: string, value: T): void {
    if (!this.isAvailable()) return

    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.warn(`[LocalStorage] Failed to set key "${key}":`, error)
    }
  }

  remove(key: string): void {
    if (!this.isAvailable()) return

    try {
      window.localStorage.removeItem(key)
    } catch (error) {
      console.warn(`[LocalStorage] Failed to remove key "${key}":`, error)
    }
  }

  has(key: string): boolean {
    if (!this.isAvailable()) return false

    try {
      return window.localStorage.getItem(key) !== null
    } catch {
      return false
    }
  }
}

// Singleton export
export const LocalStorageAdapter = new LocalStorageAdapterImpl()
export default LocalStorageAdapter
