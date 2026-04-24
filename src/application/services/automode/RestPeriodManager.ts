// RestPeriodManager - 휴식 기간 관리
// Clean Architecture: Application Layer
// 단일 책임: 연패 후 휴식 기간 관리

import type { Clock, RestState, RoomContext } from './types'
import { SystemClock, STORAGE_KEYS } from './types'

// ==================== Interface ====================

export interface IRestPeriodManager {
  // 휴식 상태 조회
  isResting(roomId: string): boolean
  getRemainingTime(roomId: string): number
  getRestEndTime(roomId: string): number | null

  // 휴식 시작/종료
  startRest(roomId: string, durationMinutes: number): void
  clearRest(roomId: string): void

  // 일괄 작업
  clearAllRests(): void
  getRestingRooms(): string[]

  // 영속성
  saveToStorage(): void
  loadFromStorage(): void
}

// ==================== Implementation ====================

export class RestPeriodManager implements IRestPeriodManager {
  private restStates: Map<string, RestState> = new Map()
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private clock: Clock

  constructor(clock: Clock = SystemClock) {
    this.clock = clock
    this.loadFromStorage()
  }

  // ==================== 휴식 상태 조회 ====================

  isResting(roomId: string): boolean {
    const state = this.restStates.get(roomId)
    if (!state?.restingUntil) return false
    return this.clock.now() < state.restingUntil
  }

  getRemainingTime(roomId: string): number {
    const state = this.restStates.get(roomId)
    if (!state?.restingUntil) return 0
    const remaining = state.restingUntil - this.clock.now()
    return Math.max(0, remaining)
  }

  getRestEndTime(roomId: string): number | null {
    return this.restStates.get(roomId)?.restingUntil ?? null
  }

  // ==================== 휴식 시작/종료 ====================

  startRest(roomId: string, durationMinutes: number): void {
    // 기존 타이머 정리
    this.clearTimer(roomId)

    const now = this.clock.now()
    const restingUntil = now + durationMinutes * 60 * 1000

    this.restStates.set(roomId, {
      restingUntil,
      isResting: true,
      restStartTime: now,
      restEndTime: restingUntil,
    })

    // 자동 해제 타이머 설정
    const timer = this.clock.setTimeout(() => {
      this.clearRest(roomId)
      console.log(`[RestPeriodManager] Room ${roomId} rest period ended`)
    }, durationMinutes * 60 * 1000)

    this.timers.set(roomId, timer)

    // 스토리지에 저장
    this.saveToStorage()

    console.log(
      `[RestPeriodManager] Room ${roomId} started rest for ${durationMinutes} minutes`
    )
  }

  clearRest(roomId: string): void {
    this.clearTimer(roomId)
    this.restStates.delete(roomId)
    this.saveToStorage()
  }

  private clearTimer(roomId: string): void {
    const timer = this.timers.get(roomId)
    if (timer) {
      this.clock.clearTimeout(timer)
      this.timers.delete(roomId)
    }
  }

  // ==================== 일괄 작업 ====================

  clearAllRests(): void {
    // 모든 타이머 정리
    this.timers.forEach((timer) => this.clock.clearTimeout(timer))
    this.timers.clear()
    this.restStates.clear()
    this.saveToStorage()
  }

  getRestingRooms(): string[] {
    const now = this.clock.now()
    const restingRooms: string[] = []

    this.restStates.forEach((state, roomId) => {
      if (state.restingUntil && now < state.restingUntil) {
        restingRooms.push(roomId)
      }
    })

    return restingRooms
  }

  // ==================== 영속성 ====================

  saveToStorage(): void {
    try {
      const data: Record<string, number> = {}
      this.restStates.forEach((state, roomId) => {
        if (state.restingUntil) {
          data[roomId] = state.restingUntil
        }
      })
      localStorage.setItem(STORAGE_KEYS.REST_PERIODS, JSON.stringify(data))
    } catch (e) {
      console.warn('[RestPeriodManager] Failed to save to storage:', e)
    }
  }

  loadFromStorage(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.REST_PERIODS)
      if (!saved) return

      const data = JSON.parse(saved) as Record<string, number>
      const now = this.clock.now()

      Object.entries(data).forEach(([roomId, restingUntil]) => {
        if (restingUntil > now) {
          // 아직 유효한 휴식 기간
          this.restStates.set(roomId, {
            restingUntil,
            isResting: true,
            restStartTime: null,
            restEndTime: restingUntil,
          })

          // 남은 시간에 맞춰 타이머 설정
          const remaining = restingUntil - now
          const timer = this.clock.setTimeout(() => {
            this.clearRest(roomId)
            console.log(`[RestPeriodManager] Room ${roomId} rest period ended (restored)`)
          }, remaining)
          this.timers.set(roomId, timer)
        }
      })

      console.log(
        `[RestPeriodManager] Loaded ${this.restStates.size} rest periods from storage`
      )
    } catch (e) {
      console.warn('[RestPeriodManager] Failed to load from storage:', e)
    }
  }

  // ==================== RoomContext 통합 ====================

  /**
   * RoomContext에서 휴식 상태 동기화
   */
  syncFromContext(ctx: RoomContext): void {
    if (ctx.rest.restingUntil) {
      this.restStates.set(ctx.roomId, { ...ctx.rest })
    }
  }

  /**
   * RoomContext에 휴식 상태 적용
   */
  applyToContext(roomId: string, ctx: RoomContext): void {
    const state = this.restStates.get(roomId)
    if (state) {
      ctx.rest = { ...state }
    } else {
      ctx.rest = {
        restingUntil: null,
        isResting: false,
        restStartTime: null,
        restEndTime: null,
      }
    }
  }

  // ==================== Cleanup ====================

  /**
   * 리소스 정리 (컴포넌트 언마운트 시)
   */
  dispose(): void {
    this.timers.forEach((timer) => this.clock.clearTimeout(timer))
    this.timers.clear()
  }
}

// ==================== Singleton Export ====================

let instance: RestPeriodManager | null = null

export function getRestPeriodManager(clock?: Clock): RestPeriodManager {
  if (!instance) {
    instance = new RestPeriodManager(clock)
  }
  return instance
}

export function resetRestPeriodManager(): void {
  if (instance) {
    instance.dispose()
    instance = null
  }
}

export default RestPeriodManager
