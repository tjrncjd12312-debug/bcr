// AutoModeOrchestrator - 오토 모드 통합 오케스트레이터
// Clean Architecture: Application Layer
// 단일 책임: 분리된 모듈들을 조합하여 오토 모드 기능 제공
// 이전 AutoModeService (2000+ lines)를 모듈로 분해 후 통합

import type { Room, Prediction, Winner, RoomPredictionState } from '../../../domain/entities'
import type {
  Clock,
  RoomContext,
  AutoModeSettings,
  AutoModeStatus,
  AutoModeGlobalState,
  AutoModeBetLogEvent,
  StateChangeCallback,
  BetLogCallback,
  SessionStats,
} from './types'
import {
  SystemClock,
  DEFAULT_SETTINGS,
  createRoomContext,
  STORAGE_KEYS,
} from './types'
import { MartingaleManager, getMartingaleManager } from './MartingaleManager'
import { BettingDecisionService, createBettingDecisionService } from './BettingDecisionService'
import { ResultProcessor, createResultProcessor } from './ResultProcessor'

// ==================== Interface ====================

export interface IAutoModeOrchestrator {
  // 상태 관리
  getStatus(): AutoModeStatus
  getSettings(): AutoModeSettings
  updateSettings(settings: Partial<AutoModeSettings>): void

  // 제어
  start(realBalance?: number): void
  stop(): void
  pause(): void
  resume(): void

  // 방 컨텍스트
  getRoomContext(roomId: string): RoomContext | undefined
  getAllRoomContexts(): Map<string, RoomContext>

  // 배팅 처리
  processBettingPhase(
    roomId: string,
    room: Room,
    prediction: Prediction,
    roomState: RoomPredictionState | null
  ): void

  processResult(
    roomId: string,
    result: Winner,
    room: Room
  ): void

  // 통계
  getSessionStats(): SessionStats
  getCumulativeProfit(): number

  // 콜백 등록
  onStateChange(callback: StateChangeCallback): () => void
  onBetLog(callback: BetLogCallback): () => void

  // 리소스 정리
  dispose(): void
}

// ==================== Implementation ====================

export class AutoModeOrchestrator implements IAutoModeOrchestrator {
  private status: AutoModeStatus = 'idle'
  private settings: AutoModeSettings
  private roomContexts: Map<string, RoomContext> = new Map()

  // 분리된 모듈
  private martingaleManager: MartingaleManager
  private bettingDecisionService: BettingDecisionService
  private resultProcessor: ResultProcessor

  // 전역 통계
  private totalWins = 0
  private totalLosses = 0
  private totalBetAmount = 0
  private cumulativeProfit = 0
  private maxProfit = 0
  private maxLoss = 0
  private startTime: number | null = null
  private startBalance = 0

  // 콜백
  private stateChangeCallbacks: Set<StateChangeCallback> = new Set()
  private betLogCallbacks: Set<BetLogCallback> = new Set()

  // Clock (테스트용 주입 가능)
  private clock: Clock

  constructor(clock: Clock = SystemClock) {
    this.clock = clock
    this.settings = this.loadSettings()

    // 모듈 초기화
    this.martingaleManager = getMartingaleManager(this.settings.maxMartin)
    this.bettingDecisionService = createBettingDecisionService(
      this.martingaleManager
    )
    this.resultProcessor = createResultProcessor(
      this.martingaleManager
    )
  }

  // ==================== 상태 관리 ====================

  getStatus(): AutoModeStatus {
    return this.status
  }

  getSettings(): AutoModeSettings {
    return { ...this.settings }
  }

  updateSettings(partial: Partial<AutoModeSettings>): void {
    this.settings = { ...this.settings, ...partial }

    // 마틴 레벨 설정 동기화
    if (partial.maxMartin !== undefined) {
      this.martingaleManager.setMaxLevel(partial.maxMartin)
    }

    this.saveSettings()
    this.notifyStateChange()
  }

  // ==================== 제어 ====================

  start(realBalance?: number): void {
    if (this.status === 'running') return

    this.status = 'running'
    this.startTime = this.clock.now()
    this.startBalance = realBalance ?? 0

    // 통계 리셋
    if (this.settings.resetMartinOnStop) {
      this.resetAllStats()
    }

    this.emitLog('info', '오토 모드 시작')
    this.notifyStateChange()
  }

  stop(): void {
    if (this.status === 'idle') return

    this.status = 'idle'

    if (this.settings.resetMartinOnStop) {
      this.martingaleManager.resetAllLevels()
    }

    this.emitLog('info', '오토 모드 중지')
    this.notifyStateChange()
  }

  pause(): void {
    if (this.status !== 'running') return

    this.status = 'paused'
    this.emitLog('info', '오토 모드 일시정지')
    this.notifyStateChange()
  }

  resume(): void {
    if (this.status !== 'paused') return

    this.status = 'running'
    this.emitLog('info', '오토 모드 재개')
    this.notifyStateChange()
  }

  // ==================== 방 컨텍스트 ====================

  getRoomContext(roomId: string): RoomContext | undefined {
    return this.roomContexts.get(roomId)
  }

  getAllRoomContexts(): Map<string, RoomContext> {
    return new Map(this.roomContexts)
  }

  private ensureRoomContext(roomId: string, roomName: string): RoomContext {
    let ctx = this.roomContexts.get(roomId)
    if (!ctx) {
      ctx = createRoomContext(roomId, roomName)
      this.roomContexts.set(roomId, ctx)
    }
    return ctx
  }

  // ==================== 배팅 처리 ====================

  processBettingPhase(
    roomId: string,
    room: Room,
    prediction: Prediction,
    _roomState: RoomPredictionState | null
  ): void {
    if (this.status !== 'running') return

    const ctx = this.ensureRoomContext(roomId, room.name)

    // 배팅 결정
    const decision = this.bettingDecisionService.shouldBet(
      roomId,
      prediction,
      this.settings,
      ctx
    )

    if (!decision.shouldBet) {
      // 스킵 로그
      this.emitBetLog({
        type: 'prediction',
        roomId,
        roomName: room.name,
        prediction: prediction.prediction === 'B' ? 'B' : prediction.prediction === 'P' ? 'P' : null,
        martinLevel: ctx.martingale.level,
        status: 'pass',
        confidence: prediction.confidence,
        reasoning: decision.skipReason,
        timestamp: this.clock.now(),
      })
      return
    }

    // 배팅 실행
    ctx.betting.waitingForResult = true
    ctx.betting.lastBetTime = this.clock.now()
    ctx.betting.lastPrediction = prediction
    ctx.betting.lastBetAmount = decision.betAmount!
    ctx.betting.currentBetAmount = decision.betAmount!
    ctx.betting.currentBetType = decision.betType!
    ctx.betting.wasVirtualBet = this.settings.isVirtualMode

    this.totalBetAmount += decision.betAmount!

    // 배팅 로그
    this.emitBetLog({
      type: 'bet_placed',
      roomId,
      roomName: room.name,
      prediction: prediction.prediction === 'B' ? 'B' : 'P',
      betType: decision.betType!,
      betAmount: decision.betAmount!,
      martinLevel: ctx.martingale.level,
      status: 'pending',
      confidence: prediction.confidence,
      timestamp: this.clock.now(),
    })

    this.notifyStateChange()
  }

  processResult(
    roomId: string,
    result: Winner,
    room: Room
  ): void {
    const ctx = this.roomContexts.get(roomId)
    if (!ctx || !ctx.betting.waitingForResult) return

    const betType = ctx.betting.currentBetType!
    const betAmount = ctx.betting.currentBetAmount!

    // 결과 처리
    const betResult = this.resultProcessor.processResult(
      roomId,
      result,
      betType,
      betAmount,
      ctx,
      this.settings
    )

    // 전역 통계 업데이트
    if (betResult.isWin) {
      this.totalWins++
    } else if (!betResult.isTie) {
      this.totalLosses++
    }
    this.cumulativeProfit += betResult.profit
    this.maxProfit = Math.max(this.maxProfit, this.cumulativeProfit)
    this.maxLoss = Math.min(this.maxLoss, this.cumulativeProfit)

    // 결과 로그
    this.emitBetLog({
      type: 'bet_result',
      roomId,
      roomName: room.name,
      betType,
      betAmount,
      martinLevel: betResult.newLevel,
      won: betResult.isTie ? null : betResult.isWin,
      winner: result,
      status: betResult.isTie ? 'tie' : betResult.isWin ? 'win' : 'loss',
      profit: betResult.profit,
      cumulativeProfit: this.cumulativeProfit,
      timestamp: this.clock.now(),
    })

    // 윈컷/로스컷 확인
    const cutConditions = this.bettingDecisionService.checkCutConditions(
      this.cumulativeProfit,
      this.settings
    )

    if (cutConditions.winCutReached) {
      this.emitLog('info', `윈컷 도달: ${this.cumulativeProfit}`)
      this.stop()
    } else if (cutConditions.lossCutReached) {
      this.emitLog('info', `로스컷 도달: ${this.cumulativeProfit}`)
      this.stop()
    }

    this.notifyStateChange()
  }

  // ==================== 통계 ====================

  getSessionStats(): SessionStats {
    return this.resultProcessor.calculateSessionStats(this.roomContexts)
  }

  getCumulativeProfit(): number {
    return this.cumulativeProfit
  }

  private resetAllStats(): void {
    this.totalWins = 0
    this.totalLosses = 0
    this.totalBetAmount = 0
    this.cumulativeProfit = 0
    this.maxProfit = 0
    this.maxLoss = 0
    this.roomContexts.clear()
    this.martingaleManager.resetAllLevels()
  }

  // ==================== 콜백 ====================

  onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeCallbacks.add(callback)
    return () => this.stateChangeCallbacks.delete(callback)
  }

  onBetLog(callback: BetLogCallback): () => void {
    this.betLogCallbacks.add(callback)
    return () => this.betLogCallbacks.delete(callback)
  }

  private notifyStateChange(): void {
    const state = this.buildGlobalState()
    this.stateChangeCallbacks.forEach((cb) => cb(state))
  }

  private buildGlobalState(): AutoModeGlobalState {
    return {
      status: this.status,
      settings: { ...this.settings },
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      totalBetAmount: this.totalBetAmount,
      cumulativeProfit: this.cumulativeProfit,
      maxProfit: this.maxProfit,
      maxLoss: this.maxLoss,
      roomContexts: new Map(this.roomContexts),
      statusMessage: this.getStatusMessage(),
      lastEventTime: this.clock.now(),
      startTime: this.startTime,
      startBalance: this.startBalance,
    }
  }

  private getStatusMessage(): string {
    switch (this.status) {
      case 'idle': return '대기 중'
      case 'running': return '실행 중'
      case 'paused': return '일시정지'
      case 'stopping': return '중지 중'
      default: return ''
    }
  }

  private emitBetLog(event: AutoModeBetLogEvent): void {
    this.betLogCallbacks.forEach((cb) => cb(event))
  }

  private emitLog(level: 'info' | 'error', message: string): void {
    // 시스템 로그는 bet_placed 타입으로 전송
    this.betLogCallbacks.forEach((cb) => cb({
      type: 'bet_placed',
      roomId: 'system',
      roomName: 'System',
      martinLevel: 0,
      level,
      reasoning: message,
      timestamp: this.clock.now(),
    }))
  }

  // ==================== 영속성 ====================

  private loadSettings(): AutoModeSettings {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS)
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }
      }
    } catch (e) {
      console.warn('[AutoModeOrchestrator] Failed to load settings:', e)
    }
    return { ...DEFAULT_SETTINGS }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings))
    } catch (e) {
      console.warn('[AutoModeOrchestrator] Failed to save settings:', e)
    }
  }

  // ==================== 리소스 정리 ====================

  dispose(): void {
    this.stateChangeCallbacks.clear()
    this.betLogCallbacks.clear()
  }
}

// ==================== Singleton Export ====================

let orchestratorInstance: AutoModeOrchestrator | null = null

export function getAutoModeOrchestrator(clock?: Clock): AutoModeOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AutoModeOrchestrator(clock)
  }
  return orchestratorInstance
}

export function resetAutoModeOrchestrator(): void {
  if (orchestratorInstance) {
    orchestratorInstance.dispose()
    orchestratorInstance = null
  }
}

export default AutoModeOrchestrator
