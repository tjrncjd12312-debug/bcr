// ManualBetService — 반자동(수동 칩 배팅). 같은 자동배팅 화면에서 AI 예측을 보고 사용자가 칩을 올리고 뺀다.
//   - 방마다 한 자리(P/B/T)에 칩을 여러 장 쌓을 수 있다(Evolution과 같은 조작감: 칩 고르고 자리 클릭, 빼기, 취소).
//   - 가상: 자체 잔고(초기잔액 + 손익 − 걸린 금액). 실제: Evolution은 칩마다 playerBetRequest(누적), 빼기는 Undo;
//     프라그마틱은 lpbet가 자리별 절대 금액이 아닐 수 있어 '취소 후 합계 재전송'으로 결정적으로 맞춘다.
//   - 정산: 방의 게임 결과 이벤트(에볼 어댑터·프라그마틱 어댑터)로 손익 계산(payout 단일 정책).
//   - 마감 가드: 배팅창(phase betting)이고 마감까지 여유가 있을 때만 칩을 받는다(실제는 서버 무시 방지, 가상은 실전 동일).
import type { Room, Prediction, BetType, GameResultEvent, BettingPhaseEvent } from '../../domain/entities'
import type { ICasinoAdapter } from '../../domain/interfaces'
import { computeNetProfit } from '../../domain/betting/payout'
import { container } from '../di/Container'
import { CallbackManager } from '../utils'
import { EvolutionAdapter } from '../../infrastructure/adapters/EvolutionAdapter'
import { PragmaticAdapter } from '../../infrastructure/adapters/PragmaticAdapter'
import { TauriAdapter } from '../../infrastructure/adapters/TauriAdapter'
import VirtualBettingService from './VirtualBettingService'

export type ManualSide = 'B' | 'P' | 'T'
const PRAGMATIC_PREFIX = 'pragmatic:'
const MIN_LEAD_MS = 1200
const VOID_AFTER_MS = 120_000
const CHIP_STORAGE_KEY = 'bcr-manual-bet:chip'
export const MANUAL_CHIPS = [1_000, 5_000, 10_000, 50_000, 100_000] as const

export interface ManualRoomBet {
  roomId: string
  roomName: string
  side: ManualSide
  chips: number[]
  total: number
  historyLenAtBet: number
  placedAt: number
  isVirtual: boolean
  /** 실배팅 전송 중(중복 클릭 방지) */
  sending: boolean
  /** 실배팅 체결 확인이 안 된 칩이 있으면 true(서버는 받았을 수 있음) */
  unconfirmed: boolean
}

export type ManualLogKind = 'placed' | 'undo' | 'clear' | 'win' | 'loss' | 'tie' | 'void' | 'error'

export interface ManualBetLog {
  id: number
  timestamp: number
  kind: ManualLogKind
  roomId: string
  roomName: string
  side: ManualSide
  amount: number
  profit?: number
  winner?: ManualSide
  message: string
}

export interface ManualStats {
  wins: number
  losses: number
  ties: number
  betCount: number
  totalBet: number
  profit: number
}

export interface ManualBetState {
  enabled: boolean
  isVirtualMode: boolean
  selectedChip: number
  bets: Map<string, ManualRoomBet>
  stats: ManualStats
  /** 가상 모드 표시 잔고 = 초기잔액 + 손익 − 걸린 금액 */
  virtualBalance: number
  pendingAmount: number
  logs: ManualBetLog[]
  /** 마지막으로 칩을 올린 방(트레이의 '마지막 칩 빼기' 대상) */
  lastRoomId: string | null
}

export interface ManualActionResult {
  ok: boolean
  error?: string
}

function sideToBetType(side: ManualSide): BetType {
  return side === 'B' ? 'Banker' : side === 'P' ? 'Player' : 'Tie'
}

function sideLabel(side: ManualSide): string {
  return side === 'B' ? '뱅커' : side === 'P' ? '플레이어' : '타이'
}

function loadChip(): number {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CHIP_STORAGE_KEY) : null
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : 10_000
  } catch {
    return 10_000
  }
}

class ManualBetServiceImpl {
  private enabled = false
  private isVirtualMode = true
  private selectedChip = loadChip()
  private bets = new Map<string, ManualRoomBet>()
  private logs: ManualBetLog[] = []
  private logSeq = 0
  private stats: ManualStats = { wins: 0, losses: 0, ties: 0, betCount: 0, totalBet: 0, profit: 0 }
  private virtualInitial = VirtualBettingService.getSettings().initialBalance
  private lastRoomId: string | null = null
  private stateManager = new CallbackManager<(s: ManualBetState) => void>('ManualBet')
  private logManager = new CallbackManager<(l: ManualBetLog) => void>('ManualBet')
  private unsubscribers: Array<() => void> = []
  private voidTimer: ReturnType<typeof setInterval> | null = null
  private _casinoAdapter: ICasinoAdapter | null = null

  private get casinoAdapter(): ICasinoAdapter {
    if (!this._casinoAdapter) this._casinoAdapter = container.get('casinoAdapter')
    return this._casinoAdapter
  }

  // ==================== Lifecycle ====================

  initialize(): void {
    this.cleanupSubscriptions()
    this._casinoAdapter = null
    this.unsubscribers.push(this.casinoAdapter.onGameResult((e) => this.onGameResult(e.roomId, e)))
    this.unsubscribers.push(this.casinoAdapter.onBettingPhase((e) => this.onBettingPhase(e.roomId, e)))
    try {
      this.unsubscribers.push(PragmaticAdapter.onGameResult((e) => this.onGameResult(`${PRAGMATIC_PREFIX}${e.roomId}`, e)))
      this.unsubscribers.push(PragmaticAdapter.onBettingPhase((e) => this.onBettingPhase(`${PRAGMATIC_PREFIX}${e.roomId}`, e)))
    } catch { /* 프라그마틱 어댑터 미사용 환경 */ }
  }

  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.virtualInitial = VirtualBettingService.getSettings().initialBalance
    this.voidTimer = setInterval(() => this.sweepStale(), 5000)
    this.emit()
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.voidTimer) { clearInterval(this.voidTimer); this.voidTimer = null }
    // 가상 pending은 환불, 실배팅 pending은 서버가 정산하므로 결과를 계속 기다린다.
    this.bets.forEach((bet, roomId) => {
      if (bet.isVirtual) {
        this.pushLog('void', bet, 0, `수동 배팅 종료 — ${bet.total.toLocaleString()}원 환불`)
        this.bets.delete(roomId)
      }
    })
    this.emit()
  }

  isEnabled(): boolean { return this.enabled }

  setVirtualMode(virtual: boolean): void {
    if (this.isVirtualMode === virtual) return
    this.isVirtualMode = virtual
    this.emit()
  }

  setChip(amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) return
    this.selectedChip = Math.round(amount)
    try { window.localStorage.setItem(CHIP_STORAGE_KEY, String(this.selectedChip)) } catch { /* ignore */ }
    this.emit()
  }

  resetStats(): void {
    this.stats = { wins: 0, losses: 0, ties: 0, betCount: 0, totalBet: 0, profit: 0 }
    this.virtualInitial = VirtualBettingService.getSettings().initialBalance
    this.logs = []
    this.emit()
  }

  getState(): ManualBetState {
    return {
      enabled: this.enabled,
      isVirtualMode: this.isVirtualMode,
      selectedChip: this.selectedChip,
      bets: new Map(this.bets),
      stats: { ...this.stats },
      virtualBalance: this.virtualBalance(),
      pendingAmount: this.pendingAmount(),
      logs: this.logs.slice(-100),
      lastRoomId: this.lastRoomId && this.bets.has(this.lastRoomId) ? this.lastRoomId : null,
    }
  }

  /** 트레이 버튼용: 마지막으로 칩을 올린 방에서 칩 하나 빼기 */
  async undoLast(): Promise<ManualActionResult> {
    const room = this.lastOpenRoom()
    if (!room) return { ok: false, error: '뺄 칩이 없어요' }
    return this.undoChip(room)
  }

  /** 트레이 버튼용: 열려 있는 방의 칩을 전부 빼기(마감된 방은 건너뜀) */
  async clearAll(): Promise<{ ok: boolean; cleared: number; error?: string }> {
    let cleared = 0
    let lastError: string | undefined
    for (const roomId of Array.from(this.bets.keys())) {
      const room = this.resolveRoom(roomId)
      if (!room) continue
      const res = await this.clearRoom(room)
      if (res.ok) cleared++
      else lastError = res.error
    }
    return { ok: cleared > 0 || !lastError, cleared, error: lastError }
  }

  private lastOpenRoom(): Room | null {
    const candidates = [this.lastRoomId, ...Array.from(this.bets.keys()).reverse()].filter((id): id is string => !!id)
    for (const id of candidates) {
      if (!this.bets.has(id)) continue
      const room = this.resolveRoom(id)
      if (room) return room
    }
    return null
  }

  getBet(roomId: string): ManualRoomBet | null { return this.bets.get(roomId) ?? null }
  onStateChange(cb: (s: ManualBetState) => void): () => void { return this.stateManager.subscribe(cb) }
  onLog(cb: (l: ManualBetLog) => void): () => void { return this.logManager.subscribe(cb) }

  dispose(): void {
    this.disable()
    this.cleanupSubscriptions()
    this.bets.clear()
    this.stateManager.clear()
    this.logManager.clear()
  }

  // ==================== Betting ====================

  /** 배팅창이 열려 있고 마감까지 여유가 있는지 */
  canBet(room: Room | null): { ok: boolean; reason?: string } {
    if (!room) return { ok: false, reason: '방 정보가 없어요' }
    if (room.phase !== 'betting') return { ok: false, reason: '지금은 배팅창이 닫혀 있어요' }
    if (room.bettingDeadlineAt !== undefined && room.bettingDeadlineAt - Date.now() < MIN_LEAD_MS) {
      return { ok: false, reason: '마감 직전이라 이번 판은 받을 수 없어요' }
    }
    return { ok: true }
  }

  /** 선택한 칩을 방의 자리에 올린다(같은 방은 한 자리만). */
  async addChip(room: Room, side: ManualSide, chipAmount = this.selectedChip): Promise<ManualActionResult> {
    if (!this.enabled) return { ok: false, error: '수동 배팅이 꺼져 있어요' }
    const gate = this.canBet(room)
    if (!gate.ok) return { ok: false, error: gate.reason }
    const existing = this.bets.get(room.id)
    if (existing?.sending) return { ok: false, error: '이전 칩을 전송하는 중이에요' }
    if (existing && existing.side !== side) {
      return { ok: false, error: `이 방은 이미 ${sideLabel(existing.side)}에 걸려 있어요 — 먼저 빼거나 취소하세요` }
    }
    const chip = Math.round(chipAmount)
    if (!(chip > 0)) return { ok: false, error: '칩 금액이 없어요' }
    const isVirtual = this.isVirtualMode
    if (isVirtual && this.virtualBalance() < chip) {
      return { ok: false, error: `가상 잔고가 부족해요 (${this.virtualBalance().toLocaleString()}원)` }
    }
    const newTotal = (existing?.total ?? 0) + chip
    const draft: ManualRoomBet = existing
      ? { ...existing, sending: !isVirtual }
      : {
          roomId: room.id, roomName: room.koreanName || room.name, side, chips: [], total: 0,
          historyLenAtBet: room.history.length, placedAt: Date.now(), isVirtual, sending: !isVirtual, unconfirmed: false,
        }
    this.bets.set(room.id, draft)
    this.emit()

    if (!isVirtual) {
      const sent = await this.sendReal(room, side, chip, newTotal, existing?.total ?? 0)
      const after = this.bets.get(room.id)
      if (!sent.ok) {
        if (after && after.chips.length === 0) this.bets.delete(room.id)
        else if (after) this.bets.set(room.id, { ...after, sending: false })
        this.pushLog('error', draft, chip, sent.error || '배팅 전송 실패')
        this.emit()
        return { ok: false, error: sent.error }
      }
      if (!after) return { ok: false, error: '배팅 상태가 사라졌어요' }
      this.bets.set(room.id, {
        ...after, chips: [...after.chips, chip], total: after.total + chip, sending: false,
        unconfirmed: after.unconfirmed || sent.unconfirmed === true,
      })
    } else {
      this.bets.set(room.id, { ...draft, chips: [...draft.chips, chip], total: draft.total + chip })
    }
    const placed = this.bets.get(room.id)!
    this.lastRoomId = room.id
    this.pushLog('placed', placed, chip, `${sideLabel(side)} 칩 ${chip.toLocaleString()}원 (합계 ${placed.total.toLocaleString()}원)`)
    this.emit()
    return { ok: true }
  }

  /** 마지막 칩 하나를 뺀다. */
  async undoChip(room: Room): Promise<ManualActionResult> {
    const bet = this.bets.get(room.id)
    if (!bet || bet.chips.length === 0) return { ok: false, error: '뺄 칩이 없어요' }
    if (bet.sending) return { ok: false, error: '전송 중이에요' }
    const gate = this.canBet(room)
    if (!gate.ok) return { ok: false, error: gate.reason }
    const chip = bet.chips[bet.chips.length - 1]
    const remaining = bet.chips.slice(0, -1)
    const newTotal = bet.total - chip
    if (!bet.isVirtual) {
      this.bets.set(room.id, { ...bet, sending: true })
      this.emit()
      const res = await this.sendRealUndo(room, bet.side, newTotal)
      if (!res.ok) {
        this.bets.set(room.id, { ...bet, sending: false })
        this.pushLog('error', bet, chip, res.error || '빼기 실패')
        this.emit()
        return res
      }
    }
    if (remaining.length === 0) this.bets.delete(room.id)
    else this.bets.set(room.id, { ...bet, chips: remaining, total: newTotal, sending: false })
    this.pushLog('undo', { ...bet, total: newTotal }, chip, `${sideLabel(bet.side)} 칩 ${chip.toLocaleString()}원 뺌 (남은 ${newTotal.toLocaleString()}원)`)
    this.emit()
    return { ok: true }
  }

  /** 이 방의 칩을 전부 뺀다. */
  async clearRoom(room: Room): Promise<ManualActionResult> {
    const bet = this.bets.get(room.id)
    if (!bet) return { ok: false, error: '걸린 칩이 없어요' }
    if (bet.sending) return { ok: false, error: '전송 중이에요' }
    const gate = this.canBet(room)
    if (!gate.ok) return { ok: false, error: gate.reason }
    if (!bet.isVirtual) {
      this.bets.set(room.id, { ...bet, sending: true })
      this.emit()
      const res = await this.sendRealClear(room, bet)
      if (!res.ok) {
        this.bets.set(room.id, { ...bet, sending: false })
        this.pushLog('error', bet, bet.total, res.error || '취소 실패')
        this.emit()
        return res
      }
    }
    this.bets.delete(room.id)
    this.pushLog('clear', bet, bet.total, `${sideLabel(bet.side)} ${bet.total.toLocaleString()}원 전부 뺌`)
    this.emit()
    return { ok: true }
  }

  // ==================== Real transport ====================

  private isPragmatic(roomId: string): boolean { return roomId.startsWith(PRAGMATIC_PREFIX) }

  private async sendReal(room: Room, side: ManualSide, chip: number, newTotal: number, prevTotal: number): Promise<ManualActionResult & { unconfirmed?: boolean }> {
    const betType = sideToBetType(side)
    try {
      if (this.isPragmatic(room.id)) {
        // 프라그마틱: 합계를 결정적으로 맞추기 위해 (기존이 있으면) 취소 후 합계 재전송.
        if (prevTotal > 0) await PragmaticAdapter.cancelBet(room.id)
        const ack = PragmaticAdapter.waitForBetAck(room.id)
        await PragmaticAdapter.placeBet(room.id, betType, newTotal)
        const a = await ack
        if (a.status === 'rejected') return { ok: false, error: a.error || '프라그마틱이 배팅을 거절했어요' }
        return { ok: true, unconfirmed: a.status === 'unknown' }
      }
      const gameId = EvolutionAdapter.getCurrentGameId(room.id)
      if (!gameId || gameId.startsWith('synthetic-')) return { ok: false, error: '게임 정보를 받는 중이에요 — 잠시 뒤 다시 눌러 주세요' }
      const connected = await TauriAdapter.getEvolutionMultiStatus().catch(() => false)
      if (!connected) return { ok: false, error: '연결이 끊겼어요 (재연결 대기 중)' }
      const message = EvolutionAdapter.buildPlayerBetRequest({ tableId: room.id, betType, amount: chip })
      if (!message) return { ok: false, error: '배팅 메시지를 만들지 못했어요' }
      EvolutionAdapter.markGameAsBet(room.id, gameId)
      // 확인 프레임(playerBetResponse/playerBettingState)은 자리별 누적 금액을 주므로 새 합계로 기다린다.
      const confirmation = EvolutionAdapter.waitForBetConfirmation({ tableId: room.id, gameId, betType, amount: newTotal }, 2500)
      await TauriAdapter.sendEvolutionMultiMessage(message)
      const c = await confirmation
      if (c.status === 'rejected') return { ok: false, error: c.error || 'Evolution이 배팅을 거절했어요' }
      return { ok: true, unconfirmed: c.status === 'unknown' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async sendRealUndo(room: Room, side: ManualSide, newTotal: number): Promise<ManualActionResult> {
    try {
      if (this.isPragmatic(room.id)) {
        await PragmaticAdapter.cancelBet(room.id)
        if (newTotal > 0) {
          const ack = PragmaticAdapter.waitForBetAck(room.id)
          await PragmaticAdapter.placeBet(room.id, sideToBetType(side), newTotal)
          const a = await ack
          if (a.status === 'rejected') return { ok: false, error: a.error || '남은 금액 재전송이 거절됐어요' }
        }
        return { ok: true }
      }
      const message = EvolutionAdapter.buildPlayerUndoRequest(room.id)
      if (!message) return { ok: false, error: '게임 정보를 받는 중이에요' }
      await TauriAdapter.sendEvolutionMultiMessage(message)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async sendRealClear(room: Room, bet: ManualRoomBet): Promise<ManualActionResult> {
    try {
      if (this.isPragmatic(room.id)) {
        await PragmaticAdapter.cancelBet(room.id)
        return { ok: true }
      }
      // Evolution: 칩 수만큼 Undo(마지막 칩부터 하나씩 빠진다).
      for (let i = 0; i < bet.chips.length; i++) {
        const message = EvolutionAdapter.buildPlayerUndoRequest(room.id)
        if (!message) return { ok: false, error: '게임 정보를 받는 중이에요' }
        await TauriAdapter.sendEvolutionMultiMessage(message)
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ==================== Settlement ====================

  private onGameResult(roomId: string, event: GameResultEvent): void {
    const bet = this.bets.get(roomId)
    if (!bet) return
    this.settle(roomId, bet, event.winner as ManualSide)
  }

  /** 결과 이벤트를 놓쳤을 때: 다음 배팅창이 열리면 히스토리로 정산한다. */
  private onBettingPhase(roomId: string, event: BettingPhaseEvent): void {
    if (event.phase !== 'start') return
    const bet = this.bets.get(roomId)
    if (!bet) return
    const room = this.resolveRoom(roomId)
    if (!room || room.history.length <= bet.historyLenAtBet) return
    const idx = room.history.length - bet.historyLenAtBet - 1
    const winner = room.history[idx]?.winner as ManualSide | undefined
    if (winner) this.settle(roomId, bet, winner)
  }

  private settle(roomId: string, bet: ManualRoomBet, winner: ManualSide): void {
    if (bet.sending) return
    const profit = computeNetProfit(bet.side, winner, bet.total)
    const kind: ManualLogKind = profit > 0 ? 'win' : profit < 0 ? 'loss' : 'tie'
    this.stats.betCount++
    this.stats.totalBet += bet.total
    this.stats.profit += profit
    if (kind === 'win') this.stats.wins++
    else if (kind === 'loss') this.stats.losses++
    else this.stats.ties++
    this.bets.delete(roomId)
    const label = kind === 'win' ? `적중 +${profit.toLocaleString()}원` : kind === 'loss' ? `미적중 ${profit.toLocaleString()}원` : '타이 — 환불'
    this.pushLog(kind, bet, bet.total, `${sideLabel(bet.side)} ${bet.total.toLocaleString()}원 → ${sideLabel(winner)} 승 · ${label}`, profit, winner)
    this.emit()
  }

  private sweepStale(): void {
    const now = Date.now()
    let changed = false
    this.bets.forEach((bet, roomId) => {
      if (bet.sending || now - bet.placedAt < VOID_AFTER_MS) return
      if (!bet.isVirtual) return // 실배팅은 서버가 정산 — 결과가 늦게 와도 지우지 않는다
      this.bets.delete(roomId)
      this.pushLog('void', bet, bet.total, `결과를 받지 못해 ${bet.total.toLocaleString()}원 환불(무효)`)
      changed = true
    })
    if (changed) this.emit()
  }

  // ==================== Helpers ====================

  private resolveRoom(roomId: string): Room | null {
    if (this.isPragmatic(roomId)) {
      const raw = PragmaticAdapter.getRoom(roomId.slice(PRAGMATIC_PREFIX.length))
      return raw ? { ...raw, id: roomId } : null
    }
    return this.casinoAdapter.getRoom(roomId)
  }

  private pendingAmount(): number {
    let sum = 0
    this.bets.forEach((b) => { if (b.isVirtual) sum += b.total })
    return sum
  }

  private virtualBalance(): number {
    return this.virtualInitial + this.stats.profit - this.pendingAmount()
  }

  private pushLog(kind: ManualLogKind, bet: ManualRoomBet, amount: number, message: string, profit?: number, winner?: ManualSide): void {
    const log: ManualBetLog = {
      id: ++this.logSeq, timestamp: Date.now(), kind, roomId: bet.roomId, roomName: bet.roomName,
      side: bet.side, amount, profit, winner, message,
    }
    this.logs.push(log)
    if (this.logs.length > 300) this.logs = this.logs.slice(-200)
    this.logManager.emit(log)
  }

  private emit(): void { this.stateManager.emit(this.getState()) }

  private cleanupSubscriptions(): void {
    this.unsubscribers.forEach((u) => { try { u() } catch { /* ignore */ } })
    this.unsubscribers = []
  }
}

export const ManualBetService = new ManualBetServiceImpl()
export default ManualBetService
export { ManualBetServiceImpl }
export type { Prediction as ManualPrediction }
