// MartingaleManager - 마틴게일 레벨 및 배팅 금액 관리
// Clean Architecture: Application Layer
// 단일 책임: 마틴게일 전략 상태 관리 및 배팅 금액 계산

import type { BetStrategy, MartingaleState, RoomContext } from './types'

// ==================== Fibonacci Sequence ====================

// Pre-compute fibonacci multipliers up to 100 levels so that
// MartingaleManager.calculateBetAmount(level, base, 'fibonacci', ...) works
// for any martin level the UI allows (max input is 100).
const FIBONACCI_MULTIPLIERS: number[] = (() => {
  const arr: number[] = [1, 1]
  for (let i = 2; i < 100; i++) arr.push(arr[i - 1] + arr[i - 2])
  return arr
})()

// ==================== Interface ====================

export interface IMartingaleManager {
  // 레벨 조회
  getLevel(roomId: string): number
  getState(roomId: string): MartingaleState | undefined

  // 레벨 변경
  incrementLevel(roomId: string): number
  decrementLevel(roomId: string): number
  resetLevel(roomId: string): void

  // 연승/연패 관리
  recordWin(roomId: string): void
  recordLoss(roomId: string): void

  // 배팅 금액 계산 (Codex 피드백: 여기에 통합)
  calculateBetAmount(
    level: number,
    baseBet: number,
    strategy: BetStrategy,
    customAmounts?: number[]
  ): number

  // 설정
  getMaxLevel(): number
  setMaxLevel(level: number): void

  // 일괄 작업
  resetAllLevels(): void
  getAllStates(): Map<string, MartingaleState>
}

// ==================== Implementation ====================

export class MartingaleManager implements IMartingaleManager {
  private states: Map<string, MartingaleState> = new Map()
  private maxLevel: number = 5

  constructor(maxLevel: number = 5) {
    this.maxLevel = maxLevel
  }

  // ==================== 레벨 조회 ====================

  getLevel(roomId: string): number {
    return this.states.get(roomId)?.level ?? 0
  }

  getState(roomId: string): MartingaleState | undefined {
    return this.states.get(roomId)
  }

  getAllStates(): Map<string, MartingaleState> {
    return new Map(this.states)
  }

  // ==================== 레벨 변경 ====================

  private ensureState(roomId: string): MartingaleState {
    let state = this.states.get(roomId)
    if (!state) {
      state = {
        level: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
      }
      this.states.set(roomId, state)
    }
    return state
  }

  incrementLevel(roomId: string): number {
    const state = this.ensureState(roomId)
    state.level = Math.min(state.level + 1, this.maxLevel)
    return state.level
  }

  decrementLevel(roomId: string): number {
    const state = this.ensureState(roomId)
    state.level = Math.max(state.level - 1, 0)
    return state.level
  }

  resetLevel(roomId: string): void {
    const state = this.states.get(roomId)
    if (state) {
      state.level = 0
      state.consecutiveLosses = 0
      state.consecutiveWins = 0
    }
  }

  // ==================== 연승/연패 관리 ====================

  recordWin(roomId: string): void {
    const state = this.ensureState(roomId)
    state.consecutiveWins++
    state.consecutiveLosses = 0
    // 승리 시 마틴 레벨 리셋
    state.level = 0
  }

  recordLoss(roomId: string): void {
    const state = this.ensureState(roomId)
    state.consecutiveLosses++
    state.consecutiveWins = 0
    // 패배 시 마틴 레벨 증가 (최대 레벨까지)
    state.level = Math.min(state.level + 1, this.maxLevel)
  }

  // ==================== 배팅 금액 계산 ====================

  /**
   * 배팅 금액 계산 (전략별)
   * Codex 피드백: BettingDecisionService에서 중복되던 로직을 여기로 통합
   */
  calculateBetAmount(
    level: number,
    baseBet: number,
    strategy: BetStrategy,
    customAmounts?: number[]
  ): number {
    switch (strategy) {
      case 'martingale':
        // 2배 마틴게일: 1, 2, 4, 8, 16, ...
        return baseBet * Math.pow(2, level)

      case 'fibonacci':
        // 피보나치: 1, 1, 2, 3, 5, 8, 13, 21, ...
        const fibIndex = Math.min(level, FIBONACCI_MULTIPLIERS.length - 1)
        return baseBet * FIBONACCI_MULTIPLIERS[fibIndex]

      case 'paroli':
        // 파롤리 (역마틴): 승리 시 2배, 3연승 후 리셋
        // 여기서는 레벨 기반으로 단순화
        return baseBet * Math.pow(2, Math.min(level, 2))

      case 'flat':
        // 플랫 베팅: 항상 동일 금액
        return baseBet

      case 'custom':
        // 커스텀 배열
        if (customAmounts && customAmounts.length > 0) {
          const index = Math.min(level, customAmounts.length - 1)
          return customAmounts[index]
        }
        return baseBet

      default:
        return baseBet
    }
  }

  /**
   * 현재 마틴 레벨에서의 누적 손실액 계산
   * (마틴게일 전략 기준, 손절 판단용)
   */
  calculateCumulativeLoss(
    level: number,
    baseBet: number,
    strategy: BetStrategy,
    customAmounts?: number[]
  ): number {
    let total = 0
    for (let i = 0; i < level; i++) {
      total += this.calculateBetAmount(i, baseBet, strategy, customAmounts)
    }
    return total
  }

  /**
   * 최대 마틴까지의 예상 최대 손실액 계산
   */
  calculateMaxPossibleLoss(
    baseBet: number,
    strategy: BetStrategy,
    customAmounts?: number[]
  ): number {
    return this.calculateCumulativeLoss(this.maxLevel, baseBet, strategy, customAmounts)
      + this.calculateBetAmount(this.maxLevel, baseBet, strategy, customAmounts)
  }

  // ==================== 설정 ====================

  getMaxLevel(): number {
    return this.maxLevel
  }

  setMaxLevel(level: number): void {
    this.maxLevel = Math.max(1, level)
  }

  // ==================== 일괄 작업 ====================

  resetAllLevels(): void {
    this.states.forEach((state) => {
      state.level = 0
      state.consecutiveLosses = 0
      state.consecutiveWins = 0
    })
  }

  /**
   * 특정 방의 상태 삭제
   */
  removeRoom(roomId: string): void {
    this.states.delete(roomId)
  }

  /**
   * 모든 상태 초기화
   */
  clear(): void {
    this.states.clear()
  }

  // ==================== RoomContext 통합 ====================

  /**
   * RoomContext에서 마틴게일 상태 동기화
   */
  syncFromContext(ctx: RoomContext): void {
    this.states.set(ctx.roomId, { ...ctx.martingale })
  }

  /**
   * RoomContext에 마틴게일 상태 적용
   */
  applyToContext(roomId: string, ctx: RoomContext): void {
    const state = this.states.get(roomId)
    if (state) {
      ctx.martingale = { ...state }
    }
  }
}

// ==================== Singleton Export ====================

let instance: MartingaleManager | null = null

export function getMartingaleManager(maxLevel?: number): MartingaleManager {
  if (!instance) {
    instance = new MartingaleManager(maxLevel)
  } else if (maxLevel !== undefined) {
    instance.setMaxLevel(maxLevel)
  }
  return instance
}

export function resetMartingaleManager(): void {
  instance = null
}

export default MartingaleManager
