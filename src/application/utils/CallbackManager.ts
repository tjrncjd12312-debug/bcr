/**
 * CallbackManager - Generic callback subscription utility
 * Clean Architecture: Application Layer Utility
 *
 * Replaces repetitive subscription/unsubscription patterns across services:
 * - SemiAutoService
 * - AutoModeService
 * - MultiRoomPredictionService
 * - VirtualBettingService
 */

export class CallbackManager<T extends (...args: any[]) => void> {
  private callbacks: T[] = []
  private readonly name: string

  constructor(name: string = 'CallbackManager') {
    this.name = name
  }

  /**
   * Subscribe a callback function
   * @returns Unsubscribe function
   */
  subscribe(callback: T): () => void {
    this.callbacks.push(callback)
    return () => {
      this.callbacks = this.callbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * Emit to all subscribed callbacks with error handling
   */
  emit(...args: Parameters<T>): void {
    this.callbacks.forEach(cb => {
      try {
        cb(...args)
      } catch (error) {
        console.error(`[${this.name}] Error in callback:`, error)
      }
    })
  }

  /**
   * Clear all subscriptions
   */
  clear(): void {
    this.callbacks = []
  }

  /**
   * Get current subscriber count
   */
  get size(): number {
    return this.callbacks.length
  }
}
