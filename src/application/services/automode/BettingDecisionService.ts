// BettingDecisionService - 배팅 결정 로직
// Clean Architecture: Application Layer
// 단일 책임: 배팅 여부 결정 (shouldBet, validateConfidence)
// 주의: 배팅 금액 계산은 MartingaleManager에 위임 (Codex 피드백)

import type { Prediction, BetType, Room, RoomPredictionState } from '../../../domain/entities'
import type {
  AutoModeSettings,
  BetDecision,
  RoomContext,
} from './types'
import type { IMartingaleManager } from './MartingaleManager'
import type { IRestPeriodManager } from './RestPeriodManager'

// ==================== Interface ====================

export interface IBettingDecisionService {
  /**
   * 배팅 여부 결정
   * @returns BetDecision - shouldBet: true면 배팅 진행
   */
  shouldBet(
    roomId: string,
    prediction: Prediction,
    settings: AutoModeSettings,
    ctx: RoomContext
  ): BetDecision

  /**
   * 방 활성화 여부 확인
   */
  isRoomEnabled(roomId: string, settings: AutoModeSettings): boolean

  /**
   * 윈컷/로스컷 도달 여부 확인
   */
  checkCutConditions(
    cumulativeProfit: number,
    settings: AutoModeSettings
  ): { winCutReached: boolean; lossCutReached: boolean }
}

// ==================== Implementation ====================

export class BettingDecisionService implements IBettingDecisionService {
  private martingaleManager: IMartingaleManager
  // NOTE: restPeriodManager는 더 이상 사용하지 않음 (ctx.rest 사용)
  // 생성자 시그니처는 하위 호환성을 위해 유지

  constructor(
    martingaleManager: IMartingaleManager,
    _restPeriodManager: IRestPeriodManager  // 미사용 - ctx.rest로 대체됨
  ) {
    this.martingaleManager = martingaleManager
  }

  // ==================== 배팅 결정 ====================

  shouldBet(
    roomId: string,
    prediction: Prediction,
    settings: AutoModeSettings,
    ctx: RoomContext
  ): BetDecision {
    // 1. 방 활성화 확인
    if (!this.isRoomEnabled(roomId, settings)) {
      return { shouldBet: false, skipReason: '방이 비활성화됨' }
    }

    // 2. 이미 결과 대기 중인지 확인
    if (ctx.betting.waitingForResult) {
      return { shouldBet: false, skipReason: '결과 대기 중' }
    }

    // 3. 휴식 중인지 확인 (전달받은 ctx.rest 사용 - Codex 피드백)
    if (ctx.rest.isResting || (ctx.rest.restingUntil && ctx.rest.restingUntil > Date.now())) {
      const remainingMs = ctx.rest.restingUntil ? ctx.rest.restingUntil - Date.now() : 0
      const remaining = Math.ceil(remainingMs / 60000)
      return { shouldBet: false, skipReason: `휴식 중 (${remaining}분 남음)` }
    }

    // 4. 예측 유효성 확인
    if (!prediction || !prediction.prediction) {
      return { shouldBet: false, skipReason: '예측 없음' }
    }

    // 5. 스킵 예측 확인
    if (prediction.isSkip) {
      return { shouldBet: false, skipReason: '패스 예측' }
    }

    // 5.5. 타이 예측 확인
    if (prediction.prediction === 'T') {
      return { shouldBet: false, skipReason: '타이 예측' }
    }

    // 6. 마틴 레벨 확인 (전달받은 ctx.martingale.level 사용 - Codex 피드백)
    const currentLevel = ctx.martingale.level
    if (currentLevel >= settings.maxMartin) {
      return { shouldBet: false, skipReason: `최대 마틴 도달 (${currentLevel}M)` }
    }

    // 7. 배팅 금액 계산 (MartingaleManager.calculateBetAmount는 순수 함수로 사용)
    const betAmount = this.martingaleManager.calculateBetAmount(
      currentLevel,
      settings.baseBetAmount,
      settings.betStrategy,
      settings.customBetAmounts
    )

    // 8. 배팅 타입 결정
    const betType: BetType = prediction.prediction === 'B' ? 'Banker' : 'Player'

    return {
      shouldBet: true,
      betAmount,
      betType,
    }
  }

  // ==================== 방 활성화 확인 ====================

  isRoomEnabled(roomId: string, settings: AutoModeSettings): boolean {
    // roomConfigs가 비어있으면 모든 방 활성화 (onlySelectedRooms=false인 경우)
    if (!settings.roomConfigs || settings.roomConfigs.length === 0) {
      return !settings.onlySelectedRooms
    }

    // roomConfigs에서 해당 방 찾기
    const config = settings.roomConfigs.find((c) => c.roomId === roomId)
    if (!config) {
      // 설정에 없으면 onlySelectedRooms에 따라 결정
      return !settings.onlySelectedRooms
    }

    return config.enabled
  }

  // ==================== 컷 조건 확인 ====================

  checkCutConditions(
    cumulativeProfit: number,
    settings: AutoModeSettings
  ): { winCutReached: boolean; lossCutReached: boolean } {
    const winCutReached =
      settings.winCutAmount > 0 && cumulativeProfit >= settings.winCutAmount

    const lossCutReached =
      settings.lossCutAmount > 0 && cumulativeProfit <= -settings.lossCutAmount

    return { winCutReached, lossCutReached }
  }

  // ==================== 패턴 기반 배팅 결정 ====================

  /**
   * 패턴 모드에서의 배팅 결정
   * (AI 모드가 아닌 경우 사용)
   */
  shouldBetByPattern(
    roomId: string,
    room: Room,
    roomState: RoomPredictionState | null,
    settings: AutoModeSettings,
    ctx: RoomContext,
    matchesFilter: (room: Room, state: RoomPredictionState | null, pattern: string) => boolean
  ): BetDecision {
    // 기본 검사
    if (!this.isRoomEnabled(roomId, settings)) {
      return { shouldBet: false, skipReason: '방이 비활성화됨' }
    }

    if (ctx.betting.waitingForResult) {
      return { shouldBet: false, skipReason: '결과 대기 중' }
    }

    // 휴식 중인지 확인 (ctx 사용 - Codex 피드백)
    if (ctx.rest.isResting || (ctx.rest.restingUntil && ctx.rest.restingUntil > Date.now())) {
      return { shouldBet: false, skipReason: '휴식 중' }
    }

    // 패턴 매칭 확인
    const matchedPattern = settings.patternConfigs.find(
      (pc) => pc.enabled && matchesFilter(room, roomState, pc.patternType)
    )

    if (!matchedPattern) {
      return { shouldBet: false, skipReason: '매칭 패턴 없음' }
    }

    // 방향 확인
    if (matchedPattern.betDirection === 'skip') {
      return { shouldBet: false, skipReason: '패턴 스킵 설정' }
    }

    // 배팅 금액 계산 (ctx.martingale.level 사용 - Codex 피드백)
    const currentLevel = ctx.martingale.level
    const betAmount = this.martingaleManager.calculateBetAmount(
      currentLevel,
      settings.baseBetAmount,
      settings.betStrategy,
      settings.customBetAmounts
    )

    // 배팅 타입 결정
    let betType: BetType
    if (matchedPattern.betDirection === 'ai') {
      // AI 예측 필요 - 여기서는 처리하지 않음
      return { shouldBet: false, skipReason: 'AI 예측 필요' }
    } else {
      betType = matchedPattern.betDirection === 'B' ? 'Banker' : 'Player'
    }

    return {
      shouldBet: true,
      betAmount,
      betType,
    }
  }
}

// ==================== Factory ====================

export function createBettingDecisionService(
  martingaleManager: IMartingaleManager,
  restPeriodManager: IRestPeriodManager
): BettingDecisionService {
  return new BettingDecisionService(martingaleManager, restPeriodManager)
}

export default BettingDecisionService
