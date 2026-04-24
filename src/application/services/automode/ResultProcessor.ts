// ResultProcessor - 결과 처리 및 통계 관리
// Clean Architecture: Application Layer
// 단일 책임: 게임 결과 처리, 통계 업데이트, 마틴/휴식 상태 전이

import type { Winner, BetType } from '../../../domain/entities'
import type {
  RoomContext,
  AutoModeSettings,
  BetResult,
  SessionStats,
} from './types'
import type { IMartingaleManager } from './MartingaleManager'
import type { IRestPeriodManager } from './RestPeriodManager'

// ==================== Interface ====================

export interface IResultProcessor {
  /**
   * 결과 처리 및 상태 업데이트
   * @returns 업데이트된 RoomContext
   */
  processResult(
    roomId: string,
    result: Winner,
    betType: BetType,
    betAmount: number,
    ctx: RoomContext,
    settings: AutoModeSettings
  ): BetResult

  /**
   * 세션 통계 계산
   */
  calculateSessionStats(contexts: Map<string, RoomContext>): SessionStats

  /**
   * 방별 승률 계산
   */
  calculateWinRate(ctx: RoomContext): number

  /**
   * 방별 순수익 계산
   */
  calculateNetProfit(ctx: RoomContext): number
}

// ==================== Implementation ====================

export class ResultProcessor implements IResultProcessor {
  private martingaleManager: IMartingaleManager
  private restPeriodManager: IRestPeriodManager

  constructor(
    martingaleManager: IMartingaleManager,
    restPeriodManager: IRestPeriodManager
  ) {
    this.martingaleManager = martingaleManager
    this.restPeriodManager = restPeriodManager
  }

  // ==================== 결과 처리 ====================

  processResult(
    roomId: string,
    result: Winner,
    betType: BetType,
    betAmount: number,
    ctx: RoomContext,
    settings: AutoModeSettings
  ): BetResult {
    // 결과 판정
    const isWin = this.isWin(result, betType)
    const isTie = result === 'T'

    // 수익 계산
    const profit = this.calculateProfit(result, betType, betAmount)

    // 통계 업데이트
    ctx.stats.totalBets++
    ctx.stats.totalProfit += profit

    if (isWin) {
      ctx.stats.wins++
      ctx.stats.currentStreak = ctx.stats.currentStreak >= 0
        ? ctx.stats.currentStreak + 1
        : 1
      ctx.stats.maxWinStreak = Math.max(ctx.stats.maxWinStreak, ctx.stats.currentStreak)

      // 마틴게일 승리 처리
      this.martingaleManager.recordWin(roomId)
      ctx.martingale.level = 0
      ctx.martingale.consecutiveWins++
      ctx.martingale.consecutiveLosses = 0
    } else if (isTie) {
      // 타이는 무승부 처리 (배팅 금액 반환)
      ctx.stats.ties = (ctx.stats.ties || 0) + 1
      // 마틴 레벨 유지
    } else {
      // 패배 처리
      ctx.stats.losses++
      ctx.stats.currentStreak = ctx.stats.currentStreak <= 0
        ? ctx.stats.currentStreak - 1
        : -1
      ctx.stats.maxLoseStreak = Math.max(ctx.stats.maxLoseStreak, Math.abs(ctx.stats.currentStreak))

      // 마틴게일 패배 처리
      this.martingaleManager.recordLoss(roomId)
      ctx.martingale.consecutiveLosses++
      ctx.martingale.consecutiveWins = 0
      ctx.martingale.level = this.martingaleManager.getLevel(roomId)

      // 연패 시 휴식 기간 시작
      if (settings.enableRestAfterLoss && ctx.martingale.consecutiveLosses >= settings.restAfterLossCount) {
        this.restPeriodManager.startRest(roomId, settings.restDurationMinutes)
        ctx.rest.isResting = true
        ctx.rest.restStartTime = Date.now()
        ctx.rest.restEndTime = Date.now() + settings.restDurationMinutes * 60000
      }
    }

    // 배팅 상태 리셋
    ctx.betting.waitingForResult = false
    ctx.betting.lastBetTime = null
    ctx.betting.currentBetAmount = undefined
    ctx.betting.currentBetType = undefined

    return {
      isWin,
      isTie,
      profit,
      newLevel: ctx.martingale.level,
      shouldRest: ctx.rest.isResting,
    }
  }

  // ==================== 승패 판정 ====================

  private isWin(result: Winner, betType: BetType): boolean {
    if (result === 'T') return false // 타이는 승리 아님
    if (betType === 'Banker' && result === 'B') return true
    if (betType === 'Player' && result === 'P') return true
    return false
  }

  // ==================== 수익 계산 ====================

  private calculateProfit(result: Winner, betType: BetType, betAmount: number): number {
    if (result === 'T') {
      // 타이: 배팅 금액 반환 (수익 0)
      return 0
    }

    const isWin = this.isWin(result, betType)
    if (!isWin) {
      // 패배: 배팅 금액 손실
      return -betAmount
    }

    // 승리 시 수익 계산
    if (betType === 'Banker') {
      // 뱅커 승리: 5% 수수료 (0.95 배)
      return Math.floor(betAmount * 0.95)
    } else {
      // 플레이어 승리: 1:1 배당
      return betAmount
    }
  }

  // ==================== 세션 통계 ====================

  calculateSessionStats(contexts: Map<string, RoomContext>): SessionStats {
    let totalBets = 0
    let totalWins = 0
    let totalLosses = 0
    let totalTies = 0
    let totalProfit = 0
    let maxWinStreak = 0
    let maxLoseStreak = 0

    contexts.forEach((ctx) => {
      totalBets += ctx.stats.totalBets
      totalWins += ctx.stats.wins
      totalLosses += ctx.stats.losses
      totalTies += ctx.stats.ties || 0
      totalProfit += ctx.stats.totalProfit
      maxWinStreak = Math.max(maxWinStreak, ctx.stats.maxWinStreak)
      maxLoseStreak = Math.max(maxLoseStreak, ctx.stats.maxLoseStreak)
    })

    // 승률 계산: 타이 제외 (wins / (wins + losses))
    const decidedBets = totalWins + totalLosses
    const winRate = decidedBets > 0 ? (totalWins / decidedBets) * 100 : 0

    return {
      totalBets,
      totalWins,
      totalLosses,
      totalTies,
      totalProfit,
      winRate,
      maxWinStreak,
      maxLoseStreak,
      roomCount: contexts.size,
    }
  }

  // ==================== 방별 통계 ====================

  calculateWinRate(ctx: RoomContext): number {
    const total = ctx.stats.wins + ctx.stats.losses
    if (total === 0) return 0
    return (ctx.stats.wins / total) * 100
  }

  calculateNetProfit(ctx: RoomContext): number {
    return ctx.stats.totalProfit
  }

  // ==================== 유틸리티 ====================

  /**
   * 결과 이력에서 최근 N개 결과 추출
   */
  getRecentResults(results: BetResult[], count: number): BetResult[] {
    return results.slice(-count)
  }

  /**
   * 연속 승패 계산
   */
  calculateCurrentStreak(results: BetResult[]): number {
    if (results.length === 0) return 0

    let streak = 0
    const lastResult = results[results.length - 1]
    const isWinning = lastResult.isWin

    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].isWin === isWinning && !results[i].isTie) {
        streak++
      } else {
        break
      }
    }

    return isWinning ? streak : -streak
  }
}

// ==================== Factory ====================

export function createResultProcessor(
  martingaleManager: IMartingaleManager,
  restPeriodManager: IRestPeriodManager
): ResultProcessor {
  return new ResultProcessor(martingaleManager, restPeriodManager)
}

export default ResultProcessor
