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
import { PragmaticAdapter } from '../../infrastructure/adapters/PragmaticAdapter'

/** 실배팅 전송에 필요한 최소 여유(ms). 서버 마감 절대시각 기준. 라이브 응답 지연 ~250ms + 안전분. */
const REAL_BET_MIN_LEAD_MS = 800

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

export type BetExecutionStatus = 'not_sent' | 'sent' | 'confirmed' | 'rejected' | 'unknown'

/**
 * `success`는 기존 호출부 호환용이다. 실배팅에서는 `placementStatus`를 함께 확인해야 한다.
 * 특히 `unknown`은 미체결이 아니라 서버 확인 전 상태이므로 동일 라운드 재전송 대상이 아니다.
 */
export interface BetExecutionResult {
  success: boolean
  placementStatus: BetExecutionStatus
  error?: string
}

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
    const pendingBet = this.pendingBets.get(tableId)

    if (pendingBet?.gameId === gameId || EvolutionAdapter.hasAlreadyBetOnGame(tableId, gameId)) {
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
  ): Promise<BetExecutionResult> {
    // Skip if no prediction
    if (!prediction.prediction) {
      return { success: false, placementStatus: 'not_sent', error: 'No valid prediction' }
    }

    const betType: BetType =
      prediction.prediction === 'B' ? 'Banker' :
      prediction.prediction === 'P' ? 'Player' : 'Tie'
    return this.placeBet(tableId, betType, betAmount, undefined, true)
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
  ): Promise<BetExecutionResult> {
    // 🛡️ 가상 모드 활성화 시 실제 소켓 전송 완전 차단
    if (this.virtualModeEnabled) {
      console.log(`[AutoBetting] 🛡️ BLOCKED - Virtual mode enabled, no socket message sent`)
      return { success: false, placementStatus: 'not_sent', error: '가상 모드 활성화됨 - 실제 배팅 차단' }
    }

    // 🎲 프라그마틱 방(prefix 'pragmatic:')은 브릿지 경로로 분기한다(게임 소켓 XML 주입).
    if (tableId.startsWith('pragmatic:')) {
      return this.placePragmaticBet(tableId, betType, amount, isRealBetting)
    }

    // Check if can place bet
    const check = this.canPlaceBet(tableId)
    if (!check.canBet) {
      console.log(`[AutoBetting] ❌ Cannot bet: ${check.reason}`)
      return { success: false, placementStatus: 'not_sent', error: check.reason }
    }

    // 🛡️ [실배팅 안전장치 #1] 실시간 gameId가 없거나 synthetic이면 실배팅을 차단한다.
    // 가짜(synthetic)·미수신(null) gameId로 실제 돈이 나가면 Evolution이 칩만 받고
    // 현재 라운드 불일치로 무효 처리해 "돈은 나가는데 잘못됨" 사고가 난다(라이브 확인 2026-06-10).
    // 가상/로그 배팅(isRealBetting=false)은 실제 돈이 안 나가므로 synthetic 폴백을 그대로 둔다.
    if (isRealBetting) {
      const liveGameId = EvolutionAdapter.getCurrentGameId(tableId)
      if (!liveGameId || liveGameId.startsWith('synthetic-')) {
        console.warn(`[AutoBetting] 🛡️ 실배팅 차단 — 실시간 gameId 미수신(현재값=${liveGameId ?? 'null'}). 가짜 gameId로 실제 배팅 방지.`)
        this.feDiag(`REAL-BET-BLOCKED-NO-GAMEID table=${tableId} bet=${betType} amount=${amount} gameId=${liveGameId ?? 'null'}`)
        return { success: false, placementStatus: 'not_sent', error: '게임 정보를 받는 중입니다 — 이번 판은 건너뜁니다' }
      }

      // 🛡️ [실배팅 안전장치 #2] 서버 마감 절대시각(bettingDeadlineAt) 기준으로 여유가 없으면 보내지 않는다.
      //   마감 뒤 도착한 베팅은 Evolution이 응답 없이 무시해 '체결 미확인'만 남는다
      //   (2026-09-02 라이브 3차: 7초 창 테이블에 마감 10초 뒤 전송 → 무응답). 호출 경로가 무엇이든 여기서 막는다.
      //   마감 시각을 아는 경우에만 판정한다(모르면 호출측 가드에 맡긴다 — AutoMode는 스냅샷 기준으로 fail-closed).
      const liveRoom = EvolutionAdapter.getRoom(tableId)
      const msLeft = liveRoom?.bettingDeadlineAt !== undefined ? liveRoom.bettingDeadlineAt - Date.now() : null
      if (msLeft !== null && msLeft < REAL_BET_MIN_LEAD_MS) {
        console.warn(`[AutoBetting] 🛡️ 실배팅 차단 — 배팅창 여유 부족(msLeft=${msLeft ?? 'unknown'})`)
        this.feDiag(`REAL-BET-BLOCKED-TIMING table=${tableId} bet=${betType} amount=${amount} msLeft=${msLeft ?? 'unknown'}`)
        return { success: false, placementStatus: 'not_sent', error: '배팅창이 마감됐거나 남은 시간이 부족해요 — 이번 판은 건너뜁니다' }
      }
    }

    // Ensure multi-socket is connected before sending
    const isConnected = await TauriAdapter.getEvolutionMultiStatus().catch(() => false)
    if (!isConnected) {
      console.warn('[AutoBetting] ❌ Cannot bet: Evolution multi-socket not connected')
      if (isRealBetting) this.feDiag(`REAL-BET-BLOCKED-NOT-CONNECTED table=${tableId} bet=${betType} amount=${amount}`)
      return { success: false, placementStatus: 'not_sent', error: '연결이 끊겼어요 (재연결 대기 중)' }
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
      return { success: false, placementStatus: 'not_sent', error: `잔액이 부족해요 (보유 ${balance.toLocaleString()}원 < 배팅 ${amount.toLocaleString()}원)` }
    }

    if (balance !== null && tableConfig.tableMinLimit && amount < tableConfig.tableMinLimit && EvolutionAdapter.hasCapturedConfig(tableId)) {
      console.log(`[AutoBetting] ❌ Below min limit: ${amount} < ${tableConfig.tableMinLimit}`)
      return { success: false, placementStatus: 'not_sent', error: `최소 배팅금액보다 적어요 (배팅 ${amount.toLocaleString()}원 < 최소 ${tableConfig.tableMinLimit.toLocaleString()}원)` }
    }

    if (balance !== null && tableConfig.tableMaxLimit && amount > tableConfig.tableMaxLimit && EvolutionAdapter.hasCapturedConfig(tableId)) {
      console.log(`[AutoBetting] ❌ Above max limit: ${amount} > ${tableConfig.tableMaxLimit}`)
      return { success: false, placementStatus: 'not_sent', error: `최대 배팅금액을 넘었어요 (배팅 ${amount.toLocaleString()}원 > 최대 ${tableConfig.tableMaxLimit.toLocaleString()}원)` }
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
      return { success: false, placementStatus: 'not_sent', error: '배팅 메시지를 만들지 못했어요 (게임 정보 대기 중)' }
    }

    let realBetAttempted = false
    try {
      let confirmationPromise: ReturnType<typeof EvolutionAdapter.waitForBetConfirmation> | null = null

      if (isRealBetting) {
        // A second caller can pass the initial guard while the first caller is
        // awaiting connection/subscription checks, so claim atomically here.
        const pendingBet = this.pendingBets.get(tableId)
        if (pendingBet?.gameId === gameId || EvolutionAdapter.hasAlreadyBetOnGame(tableId, gameId)) {
          return { success: false, placementStatus: 'not_sent', error: '이미 배팅됨' }
        }

        // Claim the round before crossing the send boundary. A timeout or disconnect
        // is an unknown outcome and must not cause another send for the same round.
        EvolutionAdapter.markGameAsBet(tableId, gameId)
        this.pendingBets.set(tableId, {
          tableId,
          betType,
          amount: actualAmount,
          gameId,
          timestamp: Date.now(),
          placementStatus: 'attempted',
        })
        realBetAttempted = true
        confirmationPromise = EvolutionAdapter.waitForBetConfirmation({
          tableId,
          gameId,
          betType,
          amount: actualAmount,
        })
      }

      // Send message via Tauri
      console.log(`[AutoBetting] 📤 ${isRealBetting ? '실제 배팅 메시지 전송' : '가상 배팅 로그'}...`)
      if (isRealBetting) this.feDiag(`REAL-BET-SEND table=${tableId} bet=${betType} amount=${actualAmount} gameId=${gameId}`)
      await TauriAdapter.sendEvolutionMultiMessage(message)

      if (confirmationPromise) {
        const confirmation = await confirmationPromise
        this.feDiag(`REAL-BET-CONFIRM table=${tableId} status=${confirmation.status} source=${confirmation.source} gameId=${confirmation.gameId ?? '?'} bet=${confirmation.betType ?? '?'} amount=${confirmation.amount ?? '?'} err=${confirmation.error ?? ''}`)
        if (confirmation.status === 'rejected') {
          const reason = confirmation.error || '실제 베팅이 거절되었습니다'
          this.pendingBets.delete(tableId)
          console.warn(`[AutoBetting] ❌ Real bet rejected: ${reason}`)
          return { success: false, placementStatus: 'rejected', error: reason }
        }

        if (confirmation.status === 'unknown') {
          const reason = confirmation.error || '실제 베팅 체결 여부를 확인할 수 없습니다'
          const pendingBet = this.pendingBets.get(tableId)
          if (pendingBet) {
            this.pendingBets.set(tableId, {
              ...pendingBet,
              placementStatus: 'unknown',
              placementError: reason,
            })
          }
          console.warn(`[AutoBetting] ⚠️ Real bet outcome unknown: ${reason}`)
          return { success: false, placementStatus: 'unknown', error: reason }
        }

        const pendingBet = this.pendingBets.get(tableId)
        if (pendingBet) {
          this.pendingBets.set(tableId, {
            ...pendingBet,
            placementStatus: 'accepted',
            placementError: undefined,
          })
        }
        console.log(`[AutoBetting] ✅ Real bet confirmed: ${confirmation.betType ?? betType} ${confirmation.amount ?? actualAmount} on ${tableId}`)
      } else {
        EvolutionAdapter.markGameAsBet(tableId, gameId)
        this.pendingBets.set(tableId, {
          tableId,
          betType,
          amount: actualAmount,
          gameId,
          timestamp: Date.now(),
          placementStatus: 'sent',
        })
      }

      // 잔액은 Evolution WebSocket에서 자동 업데이트됨
      // 수동으로 setBalance 호출하지 않음 (동기화 문제 방지)

      console.log(`[AutoBetting] ✅ ${isRealBetting ? '실제 배팅' : '가상 배팅'} 완료: ${betType} ${actualAmount.toLocaleString()}원 on ${tableId}`)

      // 배팅 실행 이벤트 emit
      this.emitBetPlaced({
        tableId,
        betType,
        amount: actualAmount,
        gameId,
        timestamp: Date.now(),
      })

      return {
        success: true,
        placementStatus: isRealBetting ? 'confirmed' : 'sent',
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('[AutoBetting] ❌ Failed to send bet:', errorMsg)
      if (isRealBetting) this.feDiag(`REAL-BET-SEND-ERROR table=${tableId} bet=${betType} amount=${actualAmount} err=${errorMsg}`)
      if (realBetAttempted) {
        const pendingBet = this.pendingBets.get(tableId)
        if (pendingBet) {
          this.pendingBets.set(tableId, {
            ...pendingBet,
            placementStatus: 'unknown',
            placementError: errorMsg,
          })
        }
        return { success: false, placementStatus: 'unknown', error: errorMsg }
      }
      return { success: false, placementStatus: 'not_sent', error: errorMsg }
    }
  }

  /**
   * 🎲 프라그마틱 실배팅(브릿지). 라이브 프로토콜(2026-09-03): 마감 = betsopen + betting_time − 1s,
   * ACK `command success` ~0.2초, 마감 후 `bet/bets` 확정, `win` 정산. Rust가 마감 여유·gameId·uId·
   * 훅 컨텍스트를 fail-closed로 검사하므로 여기서는 중복·연결·확인만 다룬다.
   */
  private async placePragmaticBet(
    tableId: string,
    betType: BetType,
    amount: number,
    isRealBetting: boolean
  ): Promise<BetExecutionResult> {
    const gameId = PragmaticAdapter.getCurrentGameId(tableId) ?? `unknown-${Date.now()}`
    const pendingBet = this.pendingBets.get(tableId)
    if (pendingBet?.gameId === gameId) {
      return { success: false, placementStatus: 'not_sent', error: '이미 배팅됨' }
    }

    if (!isRealBetting) {
      // 가상/로그 배팅: 소켓 전송 없음
      this.pendingBets.set(tableId, { tableId, betType, amount, gameId, timestamp: Date.now(), placementStatus: 'sent' })
      this.emitBetPlaced({ tableId, betType, amount, gameId, timestamp: Date.now() })
      return { success: true, placementStatus: 'sent' }
    }

    if (!PragmaticAdapter.isConnected()) {
      this.feDiag(`REAL-BET-BLOCKED-NOT-CONNECTED provider=pragmatic table=${tableId} bet=${betType} amount=${amount}`)
      return { success: false, placementStatus: 'not_sent', error: '프라그마틱 게임 소켓에 붙어 있지 않아요 (멀티플레이 진입 필요)' }
    }
    const room = PragmaticAdapter.getRoom(tableId.replace(/^pragmatic:/, ''))
    const msLeft = room?.bettingDeadlineAt !== undefined ? room.bettingDeadlineAt - Date.now() : null
    if (msLeft === null || msLeft < REAL_BET_MIN_LEAD_MS) {
      this.feDiag(`REAL-BET-BLOCKED-TIMING provider=pragmatic table=${tableId} bet=${betType} amount=${amount} msLeft=${msLeft ?? 'unknown'}`)
      return { success: false, placementStatus: 'not_sent', error: '배팅창이 마감됐거나 남은 시간이 부족해요 — 이번 판은 건너뜁니다' }
    }

    this.pendingBets.set(tableId, { tableId, betType, amount, gameId, timestamp: Date.now(), placementStatus: 'attempted' })
    this.feDiag(`REAL-BET-SEND provider=pragmatic table=${tableId} bet=${betType} amount=${amount} gameId=${gameId} msLeft=${msLeft}`)
    const ackPromise = PragmaticAdapter.waitForBetAck(tableId)
    try {
      await PragmaticAdapter.placeBet(tableId, betType, amount)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.pendingBets.delete(tableId)
      this.feDiag(`REAL-BET-SEND-ERROR provider=pragmatic table=${tableId} err=${errorMsg}`)
      return { success: false, placementStatus: 'not_sent', error: errorMsg }
    }

    const ack = await ackPromise
    this.feDiag(`REAL-BET-CONFIRM provider=pragmatic table=${tableId} status=${ack.status} gameId=${gameId} bet=${betType} amount=${amount} err=${ack.error ?? ''}`)
    if (ack.status === 'rejected') {
      this.pendingBets.delete(tableId)
      return { success: false, placementStatus: 'rejected', error: ack.error || '프라그마틱이 배팅을 거절했어요' }
    }
    if (ack.status === 'unknown') {
      const pending = this.pendingBets.get(tableId)
      if (pending) this.pendingBets.set(tableId, { ...pending, placementStatus: 'unknown', placementError: ack.error })
      return { success: false, placementStatus: 'unknown', error: ack.error || '실제 베팅 체결 여부를 확인할 수 없습니다' }
    }
    const pending = this.pendingBets.get(tableId)
    if (pending) this.pendingBets.set(tableId, { ...pending, placementStatus: 'accepted' })
    this.emitBetPlaced({ tableId, betType, amount, gameId, timestamp: Date.now() })
    return { success: true, placementStatus: 'confirmed' }
  }

  /** 🔬 실배팅 핵심 단계를 Rust 로그(bcr-runtime.log)로 포워딩한다. 웹뷰 콘솔은 파일로 남지 않는다. */
  private feDiag(line: string): void {
    try {
      import('@tauri-apps/api/core')
        .then((m) => m.invoke('fe_diag', { line }).catch(() => {}))
        .catch(() => {})
    } catch { /* ignore */ }
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
