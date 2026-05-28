// AutoBettingService - Automatic betting execution service
// Clean Architecture: Application Layer
//
// 기능:
// - 예측 결과 기반 자동 배팅 실행
// - Evolution WebSocket 메시지 빌드 및 전송
// - 중복 배팅 방지
// - 배팅 취소 지원
// - 배팅 이벤트 콜백 시스템

import type { BetType, Prediction, PendingBetInfo, TableBettingConfig } from '../../domain/entities'
import { winProfit } from '../../domain/betting/payout'
import { TauriAdapter } from '../../infrastructure/adapters/TauriAdapter'
import { EvolutionAdapter } from '../../infrastructure/adapters/EvolutionAdapter'

/** 배팅 이벤트 타입 */
export interface BetPlacedEvent {
  tableId: string
  betType: BetType
  amount: number
  gameId: string
  timestamp: number
}

/** 배팅 결과 이벤트 타입 */
export interface BetResultEvent {
  tableId: string
  betType: BetType
  amount: number
  gameId: string
  won: boolean
  profit: number  // 양수면 이익, 음수면 손실
  timestamp: number
}

type BetPlacedCallback = (event: BetPlacedEvent) => void
type BetResultCallback = (event: BetResultEvent) => void

class AutoBettingServiceImpl {
  /** 진행 중인 배팅 (테이블별 관리 - 멀티룸 동시 배팅 지원) */
  private pendingBets: Map<string, PendingBetInfo> = new Map()

  /** 배팅 실행 콜백 */
  private betPlacedCallbacks: BetPlacedCallback[] = []

  /** 배팅 결과 콜백 */
  private betResultCallbacks: BetResultCallback[] = []

  /** 🛡️ 가상 모드 활성화 여부 - true면 실제 소켓 전송 완전 차단 */
  private virtualModeEnabled: boolean = false

  // ==================== Virtual Mode Control ====================

  /**
   * 🛡️ 가상 모드 설정 - 실제 소켓 메시지 전송 차단
   */
  setVirtualMode(enabled: boolean): void {
    console.log(`[AutoBetting] 🛡️ Virtual mode ${enabled ? 'ENABLED' : 'DISABLED'} - socket messages will be ${enabled ? 'BLOCKED' : 'allowed'}`)
    this.virtualModeEnabled = enabled
  }

  /**
   * 🛡️ 가상 모드 상태 확인
   */
  isVirtualMode(): boolean {
    return this.virtualModeEnabled
  }

  // ==================== Getters ====================

  /** 진행 중인 배팅 정보 (특정 테이블) */
  getPendingBet(tableId?: string): PendingBetInfo | null {
    if (tableId) {
      return this.pendingBets.get(tableId) || null
    }
    // 하위 호환: tableId 없이 호출 시 첫 번째 pending bet 반환
    const first = this.pendingBets.values().next()
    return first.done ? null : first.value
  }

  /** 모든 진행 중인 배팅 정보 */
  getAllPendingBets(): Map<string, PendingBetInfo> {
    return new Map(this.pendingBets)
  }

  /** 진행 중인 배팅 개수 */
  getPendingBetCount(): number {
    return this.pendingBets.size
  }

  /** 배팅 가능 여부 확인 */
  canPlaceBet(tableId: string): { canBet: boolean; reason?: string } {
    const gameId = EvolutionAdapter.getCurrentGameId(tableId) || EvolutionAdapter.ensureGameId(tableId)

    if (EvolutionAdapter.hasAlreadyBetOnGame(tableId, gameId)) {
      console.log(`[AutoBetting] ❌ canPlaceBet: Already bet on game ${gameId} for table ${tableId}`)
      return { canBet: false, reason: '이미 배팅됨' }
    }

    const balance = EvolutionAdapter.getBalance()
    if (balance === null) {
      console.log(`[AutoBetting] ⚠️ canPlaceBet: Balance not available, allowing bet with caution`)
    }

    const config = EvolutionAdapter.getTableConfig(tableId)
    const hasCaptured = EvolutionAdapter.hasCapturedConfig(tableId)

    if (balance !== null) {
      if (balance < config.tableMinLimit && hasCaptured) {
        console.log(`[AutoBetting] ❌ canPlaceBet: Insufficient balance ${balance} < ${config.tableMinLimit}`)
        return { canBet: false, reason: `잔액 부족 (${balance.toLocaleString()}원)` }
      }
      // 캡처 안 된 기본 설정인 경우엔 min 체크를 건너뛰어 과도한 차단을 피함
    }

    console.log(`[AutoBetting] ✅ canPlaceBet: OK (gameId=${gameId}, balance=${balance})`)
    return { canBet: true }
  }

  // ==================== Betting Actions ====================

  /**
   * 예측 결과 기반 배팅 실행
   * @returns true if bet was placed successfully
   */
  async placeBetForPrediction(
    prediction: Prediction,
    tableId: string,
    betAmount: number
  ): Promise<{ success: boolean; error?: string }> {
    // Skip if no prediction
    if (!prediction.prediction) {
      return { success: false, error: 'No valid prediction' }
    }

    const betType: BetType =
      prediction.prediction === 'B' ? 'Banker' :
      prediction.prediction === 'P' ? 'Player' : 'Tie'
    return this.placeBet(tableId, betType, betAmount)
  }

  /**
   * 배팅 실행
   * @param isRealBetting true면 실제 배팅 (playerBetRequest), false면 로그 메시지만 (CLIENT_BET_CHIP)
   */
  async placeBet(
    tableId: string,
    betType: BetType,
    amount: number,
    config?: Partial<TableBettingConfig>,
    isRealBetting: boolean = false
  ): Promise<{ success: boolean; error?: string }> {
    // 🛡️ 가상 모드 활성화 시 실제 소켓 전송 완전 차단
    if (this.virtualModeEnabled) {
      console.log(`[AutoBetting] 🛡️ BLOCKED - Virtual mode enabled, no socket message sent`)
      return { success: false, error: '가상 모드 활성화됨 - 실제 배팅 차단' }
    }

    // Check if can place bet
    const check = this.canPlaceBet(tableId)
    if (!check.canBet) {
      console.log(`[AutoBetting] ❌ Cannot bet: ${check.reason}`)
      return { success: false, error: check.reason }
    }

    // Ensure multi-socket is connected before sending
    const isConnected = await TauriAdapter.getEvolutionMultiStatus().catch(() => false)
    if (!isConnected) {
      console.warn('[AutoBetting] ❌ Cannot bet: Evolution multi-socket not connected')
      return { success: false, error: 'Evolution 소켓 미연결' }
    }

    // Ensure subscription/game state for this table before betting
    try {
      await TauriAdapter.resubscribeEvolutionTable(tableId)
    } catch (e) {
      console.warn('[AutoBetting] ⚠️ resubscribe failed (continuing):', e)
    }

    const gameId = EvolutionAdapter.getCurrentGameId(tableId) || EvolutionAdapter.ensureGameId(tableId)
    const balance = EvolutionAdapter.getBalance()!
    // 테이블별 설정 우선 사용
    const tableConfig = EvolutionAdapter.getTableConfig(tableId)

    // Amount validation
    if (balance !== null && amount > balance) {
      console.log(`[AutoBetting] ❌ Insufficient balance: ${balance}, required: ${amount}`)
      return { success: false, error: 'Insufficient balance' }
    }

    if (balance !== null && tableConfig.tableMinLimit && amount < tableConfig.tableMinLimit && EvolutionAdapter.hasCapturedConfig(tableId)) {
      console.log(`[AutoBetting] ❌ Below min limit: ${amount} < ${tableConfig.tableMinLimit}`)
      return { success: false, error: 'Below minimum bet limit' }
    }

    if (balance !== null && tableConfig.tableMaxLimit && amount > tableConfig.tableMaxLimit && EvolutionAdapter.hasCapturedConfig(tableId)) {
      console.log(`[AutoBetting] ❌ Above max limit: ${amount} > ${tableConfig.tableMaxLimit}`)
      return { success: false, error: 'Above maximum bet limit' }
    }

    // 실제 배팅 금액 = 사용자 설정 금액 그대로 사용 (칩 스택 조정 없음)
    const actualAmount = amount

    // Build message - 실제 배팅이면 playerBetRequest, 아니면 CLIENT_BET_CHIP
    let message: string | null
    if (isRealBetting) {
      message = EvolutionAdapter.buildPlayerBetRequest({
        tableId,
        betType,
        amount: actualAmount,
      })
    } else {
      message = EvolutionAdapter.buildBetMessage({
        tableId,
        betType,
        amount: actualAmount,
        balance,
        config: { ...tableConfig, ...config },
      })
    }

    if (!message) {
      console.log('[AutoBetting] ❌ Failed to build bet message')
      return { success: false, error: 'Failed to build message' }
    }

    try {
      // Send message via Tauri
      console.log(`[AutoBetting] 📤 ${isRealBetting ? '실제 배팅 메시지 전송' : '가상 배팅 로그'}...`)
      console.log(`[AutoBetting] 메시지: ${message.slice(0, 200)}...`)
      await TauriAdapter.sendEvolutionMultiMessage(message)

      // 잔액은 Evolution WebSocket에서 자동 업데이트됨
      // 수동으로 setBalance 호출하지 않음 (동기화 문제 방지)

      // Mark as bet for this specific table
      EvolutionAdapter.markGameAsBet(tableId, gameId)

      // Store pending bet (테이블별 관리)
      this.pendingBets.set(tableId, {
        tableId,
        betType,
        amount: actualAmount,
        gameId,
        timestamp: Date.now(),
      })

      console.log(`[AutoBetting] ✅ ${isRealBetting ? '실제 배팅' : '가상 배팅'} 완료: ${betType} ${actualAmount.toLocaleString()}원 on ${tableId}`)

      // 배팅 실행 이벤트 emit
      this.emitBetPlaced({
        tableId,
        betType,
        amount: actualAmount,
        gameId,
        timestamp: Date.now(),
      })

      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('[AutoBetting] ❌ Failed to send bet:', errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 배팅 취소
   */
  async cancelBet(tableId: string): Promise<{ success: boolean; error?: string }> {
    const pendingBet = this.pendingBets.get(tableId)
    if (!pendingBet) {
      return { success: false, error: 'No pending bet to cancel' }
    }

    const balance = EvolutionAdapter.getBalance()
    if (balance === null) {
      return { success: false, error: 'Balance not available' }
    }

    const message = EvolutionAdapter.buildUndoBetMessage({
      tableId,
      betType: pendingBet.betType,
      amount: pendingBet.amount,
      balance,
    })

    if (!message) {
      return { success: false, error: 'Failed to build undo message' }
    }

    try {
      await TauriAdapter.sendEvolutionMultiMessage(message)

      console.log(`[AutoBetting] ✅ Bet cancelled: ${pendingBet.betType} ${pendingBet.amount}`)
      this.pendingBets.delete(tableId)

      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('[AutoBetting] ❌ Failed to cancel bet:', errorMsg)
      return { success: false, error: errorMsg }
    }
  }

  /**
   * 모든 진행 중인 배팅 취소 (긴급 정지용)
   */
  async cancelAllBets(): Promise<{ success: boolean; cancelled: number; failed: number }> {
    const tableIds = Array.from(this.pendingBets.keys())
    let cancelled = 0
    let failed = 0

    for (const tableId of tableIds) {
      const result = await this.cancelBet(tableId)
      if (result.success) {
        cancelled++
      } else {
        failed++
      }
    }

    console.log(`[AutoBetting] ✅ Cancel all bets: ${cancelled} cancelled, ${failed} failed`)
    return { success: failed === 0, cancelled, failed }
  }

  /**
   * 게임 결과 후 상태 리셋
   */
  onGameResult(tableId: string): void {
    this.pendingBets.delete(tableId)
    EvolutionAdapter.resetLastBetGame(tableId)
  }

  /**
   * 전체 상태 리셋
   */
  reset(): void {
    this.pendingBets.clear()
    EvolutionAdapter.resetAllLastBetGames()
  }

  // ==================== Event Subscriptions ====================

  /**
   * 배팅 실행 이벤트 구독
   */
  onBetPlaced(callback: BetPlacedCallback): () => void {
    this.betPlacedCallbacks.push(callback)
    return () => {
      this.betPlacedCallbacks = this.betPlacedCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * 배팅 결과 이벤트 구독
   */
  onBetResult(callback: BetResultCallback): () => void {
    this.betResultCallbacks.push(callback)
    return () => {
      this.betResultCallbacks = this.betResultCallbacks.filter(cb => cb !== callback)
    }
  }

  /**
   * 배팅 실행 이벤트 emit
   */
  private emitBetPlaced(event: BetPlacedEvent): void {
    console.log('[AutoBetting] 📤 Emitting bet placed event:', event)
    this.betPlacedCallbacks.forEach(cb => {
      try {
        cb(event)
      } catch (e) {
        console.error('[AutoBetting] Error in betPlaced callback:', e)
      }
    })
  }

  /**
   * 배팅 결과 이벤트 emit (외부에서 호출)
   */
  emitBetResult(event: BetResultEvent): void {
    console.log('[AutoBetting] 📤 Emitting bet result event:', event)
    this.betResultCallbacks.forEach(cb => {
      try {
        cb(event)
      } catch (e) {
        console.error('[AutoBetting] Error in betResult callback:', e)
      }
    })
  }

  /**
   * 게임 결과 처리 및 배팅 결과 emit
   */
  processGameResult(tableId: string, winner: 'B' | 'P' | 'T'): void {
    const pendingBet = this.pendingBets.get(tableId)
    if (!pendingBet) {
      return
    }

    const { betType, amount, gameId } = pendingBet

    // 타이 결과: betType=Tie면 승리(×8), 그 외엔 무승부 환불
    if (winner === 'T') {
      if (betType === 'Tie') {
        const profit = winProfit('T', amount)
        this.emitBetResult({
          tableId,
          betType,
          amount,
          gameId,
          won: true,
          profit,
          timestamp: Date.now(),
        })
      }
      this.pendingBets.delete(tableId)
      EvolutionAdapter.resetLastBetGame(tableId)
      return
    }

    const expectedWinner = betType === 'Banker' ? 'B' : betType === 'Player' ? 'P' : 'T'
    const won = winner === expectedWinner

    // 단일 페이아웃 정책(domain/betting/payout.winProfit) — 정수 반올림 통일(calc-2: 소수점 원 방지).
    // 뱅커 0.95:1 / 플레이어 1:1, Tie 베팅은 위에서 처리됨.
    const betSide = betType === 'Banker' ? 'B' : betType === 'Player' ? 'P' : 'T'
    const profit = won ? winProfit(betSide, amount) : -amount

    // 잔액은 Evolution WebSocket에서 자동 업데이트됨
    // 수동으로 setBalance 호출하지 않음 (동기화 문제 방지)

    this.emitBetResult({
      tableId,
      betType,
      amount,
      gameId,
      won,
      profit,
      timestamp: Date.now(),
    })

    this.pendingBets.delete(tableId)
    EvolutionAdapter.resetLastBetGame(tableId)
  }

  // ==================== Lifecycle ====================

  /**
   * 완전한 리소스 해제 (로그아웃 시 호출)
   * 모든 상태와 콜백을 초기화하여 메모리 누수 방지
   */
  dispose(): void {
    console.log('[AutoBetting] Disposing service...')

    // 1. 진행 중인 배팅 정리
    this.pendingBets.clear()

    // 2. 콜백 배열 정리
    this.betPlacedCallbacks = []
    this.betResultCallbacks = []

    // 3. 가상 모드 리셋
    this.virtualModeEnabled = false

    // 4. EvolutionAdapter의 배팅 상태도 정리
    EvolutionAdapter.resetAllLastBetGames()

    console.log('[AutoBetting] Service disposed')
  }
}

export const AutoBettingService = new AutoBettingServiceImpl()
export default AutoBettingService
