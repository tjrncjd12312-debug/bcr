// Virtual Betting Service - Simulated betting with Martingale system
// Implements IVirtualBettingUseCase (Clean Architecture)
// NOTE: Presentation logic (formatters) moved to presentation/utils/formatters.ts

import type {
  Winner,
  PredictionResult,
  VirtualBetSettings,
  VirtualBettingState,
  VirtualBetState,
  VirtualBetLog,
  MartingaleSettings,
} from '../../domain/entities'
import { TIE_PAYOUT_MULTIPLIER } from '../../domain/entities'
import type { IVirtualBettingUseCase, UnsubscribeFn } from '../../domain/interfaces'
import { CallbackManager } from '../utils'

// Default settings
const DEFAULT_MARTINGALE: MartingaleSettings = {
  enabled: true,
  baseAmount: 1000,  // 기본값 1,000원 (이전 10,000원에서 변경)
  maxLevel: 5,
  resetOnWin: true,
}

const DEFAULT_SETTINGS: VirtualBetSettings = {
  initialBalance: 1000000,
  martingale: DEFAULT_MARTINGALE,
}

// Persistence key for the user-configured initial balance. Only `initialBalance`
// is persisted — runtime state (balance, bets, history) is session-scoped.
const STORAGE_KEY = 'bcr-virtual-betting-initial-balance'

function loadInitialBalanceFromStorage(fallback: number): number {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function saveInitialBalanceToStorage(value: number): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // ignore (storage full / private mode / etc.)
  }
}

type StateChangeCallback = (state: VirtualBettingState) => void
type BetLogCallback = (log: VirtualBetLog) => void

class VirtualBettingServiceImpl implements IVirtualBettingUseCase {
  private state: VirtualBettingState = {
    enabled: false,
    settings: {
      ...DEFAULT_SETTINGS,
      initialBalance: loadInitialBalanceFromStorage(DEFAULT_SETTINGS.initialBalance),
    },
    // globalBalance starts at the persisted/default initialBalance so the
    // very first read of getGlobalBalance() reflects the user's setting.
    globalBalance: loadInitialBalanceFromStorage(DEFAULT_SETTINGS.initialBalance),
    roomStates: new Map(),
    betHistory: [],
    // Extended statistics
    totalBetAmount: 0,
    totalWinnings: 0, // Net profit from wins only (not including losses)
    totalNetProfit: 0, // Net profit (Wins - Losses)
    totalBetCount: 0,
    // ✅ Tie bet tracking (refunded bets)
    tieBetAmount: 0,
    tieBetCount: 0,
    // Pending bet tracking
    pendingBetAmount: 0,
    pendingBetCount: 0,
  }

  private logIdCounter = 0
  private stateManager = new CallbackManager<StateChangeCallback>('VirtualBetting')
  private betLogManager = new CallbackManager<BetLogCallback>('VirtualBetting')

  // ==================== IVirtualBettingUseCase Implementation ====================

  // State getters
  getState(): VirtualBettingState {
    return {
      ...this.state,
      roomStates: new Map(this.state.roomStates),
      betHistory: [...this.state.betHistory],
      totalBetAmount: this.state.totalBetAmount,
      totalWinnings: this.state.totalWinnings,
      totalNetProfit: this.state.totalNetProfit,
      totalBetCount: this.state.totalBetCount,
      tieBetAmount: this.state.tieBetAmount,
      tieBetCount: this.state.tieBetCount,
      pendingBetAmount: this.state.pendingBetAmount,
      pendingBetCount: this.state.pendingBetCount,
    }
  }

  isEnabled(): boolean {
    return this.state.enabled
  }

  getSettings(): VirtualBetSettings {
    return { ...this.state.settings }
  }

  getGlobalBalance(): number {
    return this.state.globalBalance
  }

  /**
   * 🔥 FIX: AutoModeService와 잔액 동기화
   * AutoModeService에서 cumulativeProfit 기반으로 계산한 잔액을 동기화
   * 두 시스템 간의 잔액 불일치 문제 해결
   */
  syncGlobalBalance(newBalance: number): void {
    const oldBalance = this.state.globalBalance
    if (oldBalance !== newBalance) {
      console.log(`[VirtualBetting] 🔄 syncGlobalBalance: ${oldBalance} -> ${newBalance}`)
      this.state.globalBalance = newBalance
      this.emitStateChange()
    }
  }

  getRoomState(roomId: string): VirtualBetState | null {
    return this.state.roomStates.get(roomId) || null
  }

  getRecentLogs(count: number = 50): VirtualBetLog[] {
    return this.state.betHistory.slice(-count)
  }

  // Actions
  enable(): void {
    this.state.enabled = true
    this.emitStateChange()
  }

  disable(): void {
    this.state.enabled = false
    this.emitStateChange()
  }

  toggle(): void {
    this.state.enabled = !this.state.enabled
    this.emitStateChange()
  }

  updateSettings(settings: Partial<VirtualBetSettings>): void {
    const oldInitialBalance = this.state.settings.initialBalance

    this.state.settings = {
      ...this.state.settings,
      ...settings,
      martingale: {
        ...this.state.settings.martingale,
        ...(settings.martingale || {}),
      },
    }

    // ✅ FIX: initialBalance 변경 시 자동 리셋
    // 기준 잔액 변경은 세션 리셋을 의미함
    if (settings.initialBalance !== undefined && settings.initialBalance !== oldInitialBalance) {
      console.log(`[VirtualBetting] Initial balance changed: ${oldInitialBalance} -> ${settings.initialBalance}, resetting session`)
      saveInitialBalanceToStorage(settings.initialBalance)
      this.reset()
      return // reset already emits state change
    }

    this.emitStateChange()
  }

  reset(): void {
    // NOTE: We do NOT reset enabled state here
    // Tests should call disable() explicitly if needed

    // ✅ FIX: 먼저 모든 pending 베팅 로그 출력 (디버깅용)
    const pendingRooms: string[] = []
    this.state.roomStates.forEach((state, roomId) => {
      if (state.lastBetResult === 'pending') {
        pendingRooms.push(`${roomId}: ${state.currentBetAmount}원`)
      }
    })
    if (pendingRooms.length > 0) {
      console.log(`[VirtualBetting] 🔄 Reset - clearing ${pendingRooms.length} pending bets:`, pendingRooms)
    }

    // 잔액을 초기값으로 완전 리셋 (모든 pending/resolved 무관하게)
    this.state.globalBalance = this.state.settings.initialBalance
    this.state.roomStates.clear()
    this.state.betHistory = []
    // Reset extended statistics
    this.state.totalBetAmount = 0
    this.state.totalWinnings = 0
    this.state.totalNetProfit = 0
    this.state.totalBetCount = 0
    // Reset tie bet tracking
    this.state.tieBetAmount = 0
    this.state.tieBetCount = 0
    // Reset pending bet tracking
    this.state.pendingBetAmount = 0
    this.state.pendingBetCount = 0
    this.logIdCounter = 0

    console.log(`[VirtualBetting] ✅ Reset complete - balance: ${this.state.globalBalance.toLocaleString()}원`)
    this.emitStateChange()
  }

  /**
   * 잔액 검증 및 조정 (디버깅/복구용)
   * 잔액이 올바르지 않을 때 호출하여 pending 상태를 정리
   */
  reconcileBalance(): { fixed: boolean; adjustment: number; details: string } {
    const initialBalance = this.state.settings.initialBalance
    const currentBalance = this.state.globalBalance
    const netProfit = this.state.totalNetProfit
    const pendingAmount = this.state.pendingBetAmount

    // 예상 잔액 = 초기잔액 + 순손익 - pending금액
    const expectedBalance = initialBalance + netProfit - pendingAmount

    const discrepancy = currentBalance - expectedBalance

    if (Math.abs(discrepancy) > 1) {
      console.warn(`[VirtualBetting] ⚠️ Balance discrepancy detected!`)
      console.warn(`  Initial: ${initialBalance}, NetProfit: ${netProfit}, Pending: ${pendingAmount}`)
      console.warn(`  Expected: ${expectedBalance}, Actual: ${currentBalance}, Diff: ${discrepancy}`)

      // 자동 수정
      this.state.globalBalance = expectedBalance
      this.emitStateChange()

      return {
        fixed: true,
        adjustment: -discrepancy,
        details: `잔액 ${discrepancy > 0 ? '초과' : '부족'} ${Math.abs(discrepancy)}원 조정됨`
      }
    }

    return { fixed: false, adjustment: 0, details: '잔액 정상' }
  }

  /**
   * 모든 방의 stale pending 배팅을 정리하고 잔액 복구
   * 45초 이상 pending 상태인 배팅은 stale로 간주
   */
  cleanupAllStalePending(): number {
    const STALE_THRESHOLD_MS = 45000 // 45초
    const now = Date.now()
    let refundedCount = 0
    let refundedAmount = 0

    this.state.roomStates.forEach((roomState, roomId) => {
      if (roomState.lastBetResult === 'pending') {
        // ✅ Bug Fix: lastBetTime null 방어 - null이면 stale로 간주하지 않음 (시간 측정 불가)
        if (roomState.lastBetTime === null || roomState.lastBetTime === undefined) {
          console.warn(`[VirtualBetting] ⚠️ lastBetTime missing for pending bet: ${roomId}`)
          return // skip this room, don't treat as stale
        }
        const pendingDuration = now - roomState.lastBetTime
        if (pendingDuration > STALE_THRESHOLD_MS) {
          const amount = roomState.currentBetAmount || 0

          // 잔액 환불
          this.state.globalBalance = Math.round(this.state.globalBalance + amount)
          this.state.pendingBetAmount = Math.max(0, this.state.pendingBetAmount - amount)
          this.state.pendingBetCount = Math.max(0, this.state.pendingBetCount - 1)

          // 상태 초기화
          roomState.lastBetResult = 'cancelled'

          refundedCount++
          refundedAmount += amount
          console.log(`[VirtualBetting] ♻️ Stale pending 환불: ${roomId} (${Math.floor(pendingDuration / 1000)}s, ${amount.toLocaleString()}원)`)
        }
      }
    })

    if (refundedCount > 0) {
      console.log(`[VirtualBetting] ✅ Stale cleanup 완료: ${refundedCount}건, ${refundedAmount.toLocaleString()}원 환불, 현재 잔액: ${this.state.globalBalance.toLocaleString()}원`)
      this.emitStateChange()
    }

    return refundedCount
  }

  resetRoom(roomId: string): void {
    const roomState = this.state.roomStates.get(roomId)
    if (roomState) {
      roomState.martingaleLevel = 0
      roomState.currentBetAmount = this.state.settings.martingale.baseAmount
      roomState.lastBetResult = undefined
      this.emitStateChange()
    }
  }

  /**
   * ✅ 서버의 연패 정보를 마틴게일 레벨에 동기화
   * 예측모드에서 VirtualBetting이 늦게 활성화되어도 서버 연패 정보로 레벨을 복구
   * @param roomId 방 ID
   * @param serverConsecutiveLosses 서버에서 받은 연속 패배 횟수
   */
  syncMartingaleLevelFromServer(roomId: string, serverConsecutiveLosses: number): void {
    let roomState = this.state.roomStates.get(roomId)

    // roomState가 없으면 생성
    if (!roomState) {
      roomState = this.createInitialRoomState(roomId)
      this.state.roomStates.set(roomId, roomState)
    }

    // 서버 연패 정보가 클라이언트보다 크면 동기화
    // (클라이언트가 더 높으면 클라이언트 값 유지 - 로컬 베팅이 더 정확할 수 있음)
    if (serverConsecutiveLosses > roomState.martingaleLevel) {
      const { martingale } = this.state.settings
      const previousLevel = roomState.martingaleLevel
      roomState.martingaleLevel = serverConsecutiveLosses
      roomState.currentBetAmount = martingale.baseAmount * Math.pow(2, serverConsecutiveLosses)
      console.log(`[VirtualBetting] 🔄 서버 연패 동기화: ${roomId} - level ${previousLevel} → ${serverConsecutiveLosses}`)
      this.emitStateChange()
    }
  }

  // Betting operations
  placeBet(roomId: string, roomName: string, prediction: PredictionResult): boolean {
    // ✅ DEBUG: 가상배팅 호출 로그
    console.log(`[VirtualBetting] placeBet called - room: ${roomName}, pred: ${prediction}, enabled: ${this.state.enabled}`)

    if (!this.state.enabled || !prediction) {
      console.log(`[VirtualBetting] placeBet BLOCKED - enabled: ${this.state.enabled}, prediction: ${prediction}`)
      return false
    }

    // Calculate bet amount based on Martingale
    const { martingale } = this.state.settings
    let roomState = this.state.roomStates.get(roomId)
    const martinLevel = roomState?.martingaleLevel || 0
    const betAmount = martingale.enabled
      ? martingale.baseAmount * Math.pow(2, martinLevel)
      : martingale.baseAmount

    const result = this.placeBetWithAmount(roomId, roomName, prediction, betAmount)
    // Convert to boolean for backward compatibility
    return result === true
  }

  /**
   * AutoMode에서 호출하는 가상배팅 - 금액을 직접 받음
   * 가상/실제 배팅 동작을 동일하게 유지하기 위해 사용
   */
  placeBetWithAmount(roomId: string, roomName: string, prediction: PredictionResult, betAmount: number): boolean | { success: false; reason: string } {
    console.log(`[VirtualBetting] placeBetWithAmount - room: ${roomName}, pred: ${prediction}, amount: ${betAmount}`)

    if (!this.state.enabled || !prediction) {
      console.log(`[VirtualBetting] placeBetWithAmount BLOCKED - enabled: ${this.state.enabled}, prediction: ${prediction}`)
      return { success: false, reason: !this.state.enabled ? 'disabled' : 'no_prediction' }
    }

    // ✅ FIX: 배팅 전에 모든 방의 stale pending 정리 (잔액 복구)
    this.cleanupAllStalePending()

    let roomState = this.state.roomStates.get(roomId)
    if (!roomState) {
      roomState = this.createInitialRoomState(roomId)
      this.state.roomStates.set(roomId, roomState)
    }

    // Prevent double betting on the same room
    if (roomState.lastBetResult === 'pending') {
      console.log(`[VirtualBetting] ⏸ 중복 배팅 방지 - room: ${roomName}, lastBetResult: pending`)
      return { success: false, reason: 'duplicate_bet' }
    }

    // Check for insufficient balance
    if (this.state.globalBalance < betAmount) {
      console.log(`[VirtualBetting] ❌ 잔액 부족 - balance: ${this.state.globalBalance}, required: ${betAmount}`)
      return { success: false, reason: 'insufficient_balance' }
    }

    // Track last bet time for stale pending detection
    roomState.lastBetTime = Date.now()

    // Update bet amount and deduct from balance
    roomState.currentBetAmount = betAmount
    this.state.globalBalance -= betAmount

    // Update statistics
    this.state.totalBetAmount += betAmount
    this.state.totalBetCount++

    // Track pending bet
    this.state.pendingBetAmount += betAmount
    this.state.pendingBetCount++

    roomState.lastBetResult = 'pending'

    // Create and emit bet placed log
    const placedLog = this.createBetLog(roomId, roomName, prediction, null, betAmount, roomState, null, 'placed')
    this.state.betHistory.push(placedLog)
    this.trimBetHistory()
    this.emitBetLog(placedLog)

    this.emitStateChange()
    return true
  }

  resolveBet(
    roomId: string,
    roomName: string,
    prediction: PredictionResult,
    result: Winner
  ): VirtualBetLog | null {
    // Allow resolution if disabled BUT we have a pending bet for this room
    // This prevents losing money if user disables feature while bet is active
    const hasPendingBet = this.state.roomStates.get(roomId)?.lastBetResult === 'pending'
    if ((!this.state.enabled && !hasPendingBet) || !prediction) return null

    // Tie 결과 — prediction이 'T'가 아니면 푸쉬(환불), 'T'면 적중(8배 페이아웃) 처리
    if (result === 'T' && prediction !== 'T') {
      const roomState = this.state.roomStates.get(roomId)
      if (roomState && roomState.lastBetResult === 'pending') {
        // 배팅금 반환
        this.state.globalBalance += roomState.currentBetAmount
        roomState.lastBetResult = 'tie'

        // ✅ Track tie bet statistics (푸쉬만 — 적중은 아래 win 분기에서 별도 카운트)
        this.state.tieBetAmount += roomState.currentBetAmount
        this.state.tieBetCount++

        // Decrement pending stats on Tie
        this.state.pendingBetAmount -= roomState.currentBetAmount
        this.state.pendingBetCount--
        if (this.state.pendingBetAmount < 0) this.state.pendingBetAmount = 0
        if (this.state.pendingBetCount < 0) this.state.pendingBetCount = 0

        console.log(`[VirtualBetting] Tie result for ${roomName}: bet returned (${roomState.currentBetAmount}), total ties: ${this.state.tieBetCount}`)
        this.emitStateChange()
      }
      return null
    }

    const roomState = this.state.roomStates.get(roomId)
    if (!roomState) return null

    // ✅ FIX: 중복 결과 처리 방지 - pending 상태가 아니면 무시
    if (roomState.lastBetResult !== 'pending') {
      console.log(`[VirtualBetting] ⚠️ Ignoring duplicate result for ${roomName} (current state: ${roomState.lastBetResult})`)
      return null
    }

    const won = prediction === result
    const betAmount = roomState.currentBetAmount

    // Decrease pending bet tracking
    this.state.pendingBetAmount -= betAmount
    this.state.pendingBetCount--
    if (this.state.pendingBetAmount < 0) this.state.pendingBetAmount = 0
    if (this.state.pendingBetCount < 0) this.state.pendingBetCount = 0

    this.updateRoomStateAfterBet(roomState, won, betAmount, prediction)
    const log = this.createBetLog(roomId, roomName, prediction, result, betAmount, roomState, won, 'resolved')

    this.state.betHistory.push(log)
    this.trimBetHistory()

    this.emitStateChange()
    this.emitBetLog(log)

    return log
  }

  cancelPendingBet(roomId: string): void {
    const roomState = this.state.roomStates.get(roomId)
    if (!roomState || roomState.lastBetResult !== 'pending') return

    console.log(`[VirtualBetting] ↩️ Cancelling pending bet for room ${roomId} (Refund: ${roomState.currentBetAmount}원)`)

    // Refund global balance
    this.state.globalBalance = Math.round(this.state.globalBalance + roomState.currentBetAmount)

    // Update statistics
    this.state.pendingBetAmount = Math.max(0, this.state.pendingBetAmount - roomState.currentBetAmount)
    this.state.pendingBetCount = Math.max(0, this.state.pendingBetCount - 1)

    // Reset room state
    roomState.lastBetResult = 'cancelled'

    this.emitStateChange()
  }

  // ==================== Subscriptions ====================

  onStateChange(callback: StateChangeCallback): UnsubscribeFn {
    return this.stateManager.subscribe(callback)
  }

  onBetLog(callback: BetLogCallback): UnsubscribeFn {
    return this.betLogManager.subscribe(callback)
  }

  // ==================== Private Methods ====================

  private createInitialRoomState(roomId: string): VirtualBetState {
    return {
      roomId,
      currentBalance: 0,
      currentBetAmount: this.state.settings.martingale.baseAmount,
      martingaleLevel: 0,
      totalBets: 0,
      wins: 0,
      losses: 0,
      profitLoss: 0,
      lastBetResult: undefined,
    }
  }

  private updateRoomStateAfterBet(
    roomState: VirtualBetState,
    won: boolean,
    betAmount: number,
    prediction: PredictionResult
  ): void {
    const { martingale } = this.state.settings

    if (won) {
      // 뱅커 승리시 5% 커미션 적용 (배당 1.95배)
      // 플레이어 승리시 커미션 없음 (배당 2배)
      // 타이 적중 시 8배 페이아웃 (원금 + 8× 순수익)
      const isBankerWin = prediction === 'B'
      const isTieWin = prediction === 'T'
      const BANKER_COMMISSION = 0.05

      // Payout = Original Bet + Profit
      const payout = isTieWin
        ? betAmount + (betAmount * TIE_PAYOUT_MULTIPLIER) // 타이: 원금 + (배팅액 × 8)
        : isBankerWin
        ? betAmount + (betAmount * (1 - BANKER_COMMISSION)) // 뱅커: 원금 + (배팅액 × 0.95)
        : betAmount + betAmount // 플레이어: 원금 + 배팅액

      // Net Profit = Payout - Original Bet
      const netProfit = Math.round(payout - betAmount)

      this.state.globalBalance = Math.round(this.state.globalBalance + payout)
      this.state.totalWinnings = Math.round(this.state.totalWinnings + netProfit) // Track profit from wins only
      this.state.totalNetProfit = Math.round(this.state.totalNetProfit + netProfit) // Track net profit (wins - losses)

      roomState.profitLoss += netProfit
      roomState.wins++
      roomState.lastBetResult = 'win'

      if (martingale.enabled && martingale.resetOnWin) {
        roomState.martingaleLevel = 0
        roomState.currentBetAmount = martingale.baseAmount
      }
    } else {
      // Loss: No payout
      const netLoss = betAmount

      this.state.totalNetProfit -= netLoss // Deduct loss from net profit

      roomState.profitLoss -= netLoss
      roomState.losses++
      roomState.lastBetResult = 'loss'

      if (martingale.enabled) {
        // 최대 마틴 레벨 초과 시 리셋
        if (roomState.martingaleLevel >= martingale.maxLevel) {
          roomState.martingaleLevel = 0
          roomState.currentBetAmount = martingale.baseAmount
        } else {
          roomState.martingaleLevel++
          // ✅ FIX: 외부에서 관리하는 배팅금(AutoMode의 200원 등)을 존중하도록 수식 변경
          // 기존 배팅금(betAmount)이 settings와 다를 경우, 해당 금액을 기준으로 다음 마틴 계산
          roomState.currentBetAmount = betAmount * 2
        }
      } else {
        roomState.currentBetAmount = martingale.baseAmount
      }
    }

    roomState.totalBets++
  }

  private createBetLog(
    roomId: string,
    roomName: string,
    prediction: PredictionResult,
    result: Winner | null,
    betAmount: number,
    roomState: VirtualBetState,
    won: boolean | null,
    type: 'placed' | 'resolved'
  ): VirtualBetLog {
    return {
      id: ++this.logIdCounter,
      timestamp: Date.now(),
      roomId,
      roomName,
      prediction,
      result,
      betAmount,
      martingaleLevel: roomState.martingaleLevel,
      won,
      balanceAfter: this.state.globalBalance,
      type,
    }
  }

  private trimBetHistory(): void {
    const MAX_HISTORY = 500
    if (this.state.betHistory.length > MAX_HISTORY) {
      this.state.betHistory = this.state.betHistory.slice(-MAX_HISTORY)
    }
  }

  private emitStateChange(): void {
    this.stateManager.emit(this.getState())
  }

  private emitBetLog(log: VirtualBetLog): void {
    this.betLogManager.emit(log)
  }

  // ==================== Lifecycle ====================

  /**
   * 완전한 리소스 해제 (로그아웃 시 호출)
   * 모든 상태와 콜백을 초기화하여 메모리 누수 방지
   */
  dispose(): void {
    console.log('[VirtualBetting] Disposing service...')

    // 1. 콜백 매니저 정리
    this.stateManager.clear()
    this.betLogManager.clear()

    // 2. 상태 초기화 (persisted initialBalance은 유지)
    const persistedInitial = loadInitialBalanceFromStorage(DEFAULT_SETTINGS.initialBalance)
    this.state = {
      enabled: false,
      settings: { ...DEFAULT_SETTINGS, initialBalance: persistedInitial },
      globalBalance: persistedInitial,
      roomStates: new Map(),
      betHistory: [],
      totalBetAmount: 0,
      totalWinnings: 0,
      totalNetProfit: 0,
      totalBetCount: 0,
      tieBetAmount: 0,
      tieBetCount: 0,
      pendingBetAmount: 0,
      pendingBetCount: 0,
    }

    // 3. 카운터 리셋
    this.logIdCounter = 0

    console.log('[VirtualBetting] Service disposed')
  }
}

// Export singleton instance (will be replaced by DI in future)
export const VirtualBettingService = new VirtualBettingServiceImpl()
export default VirtualBettingService

// Export class for DI container
export { VirtualBettingServiceImpl }
