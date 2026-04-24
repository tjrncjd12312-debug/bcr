/**
 * StorageManager - Generic localStorage utility with type safety
 * Clean Architecture: Application Layer Utility
 *
 * Replaces repetitive localStorage patterns across services:
 * - SemiAutoSettingsManager
 * - CustomPatternService
 * - RoomFilterService
 */

export class StorageManager<T> {
  private readonly key: string
  private readonly name: string

  constructor(key: string, name: string = 'StorageManager') {
    this.key = key
    this.name = name
  }

  /**
   * Load data from localStorage
   */
  load(): Partial<T> | null {
    try {
      const stored = localStorage.getItem(this.key)
      if (!stored) return null
      const parsed = JSON.parse(stored)
      console.log(`[${this.name}] Loaded from storage:`, Object.keys(parsed))
      return parsed
    } catch (error) {
      console.warn(`[${this.name}] Failed to load from storage:`, error)
      return null
    }
  }

  /**
   * Save data to localStorage
   */
  save(data: T): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(data))
    } catch (error) {
      console.warn(`[${this.name}] Failed to save to storage:`, error)
    }
  }

  /**
   * Remove data from localStorage
   */
  remove(): void {
    try {
      localStorage.removeItem(this.key)
    } catch (error) {
      console.warn(`[${this.name}] Failed to remove from storage:`, error)
    }
  }

  /**
   * Check if data exists in localStorage
   */
  exists(): boolean {
    return localStorage.getItem(this.key) !== null
  }
}
