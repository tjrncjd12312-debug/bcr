// MoveOnTieListener — Fresh-Shoe Tie Martingale 프리셋의 "이동" 트리거 감지 서브시스템
// Clean Architecture: Application Layer
// 단일 책임: game-result 이벤트와 martin-cap 신호를 받아 적절한 TriggerReason으로 emit

import type { BetType } from '../../../domain/entities'

export type TriggerReason = 'tie_hit' | 'organic_tie' | 'martin_cap'
export type Scope = 'auto' | 'semiauto'

// 외부 의존성: casino adapter는 onGameResult(cb) → () => void 만 노출하면 됨
export interface IGameResultSource {
  onGameResult(cb: (event: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) => void): () => void
}

export interface MoveOnTieListenerDeps {
  casinoAdapter: IGameResultSource
  // semiauto 모드에서 현재 CDP 탭이 가리키는 방의 id를 돌려준다 (null이면 미집중)
  getCurrentFocusedRoomId: () => string | null
  // 결과가 'T'이거나 martin_cap일 때 마틴 레벨을 0으로 리셋하는 부수효과
  onMartinReset: (roomId: string) => void
}

type TriggerCallback = (roomId: string, reason: TriggerReason) => void

export class MoveOnTieListener {
  private callbacks: TriggerCallback[] = []
  private pendingBets: Map<string, { roundId: string; betType: BetType }> = new Map()
  private firedKeys: Set<string> = new Set()  // (roomId, roundId, reason) dedup keys
  private scope: Scope | null = null
  private unsubscribeAdapter: (() => void) | null = null

  constructor(private readonly deps: MoveOnTieListenerDeps) {}

  enable(scope: Scope): () => void {
    this.scope = scope
    this.unsubscribeAdapter = this.deps.casinoAdapter.onGameResult((event) => {
      this.handleResult(event)
    })
    return () => this.disable()
  }

  disable(): void {
    this.unsubscribeAdapter?.()
    this.unsubscribeAdapter = null
    this.scope = null
    this.pendingBets.clear()
    this.firedKeys.clear()
  }

  onTrigger(cb: TriggerCallback): () => void {
    this.callbacks.push(cb)
    return () => {
      const i = this.callbacks.indexOf(cb)
      if (i >= 0) this.callbacks.splice(i, 1)
    }
  }

  // 베팅 발사 경로가 호출: 어떤 베팅이 어떤 라운드에 들어갔는지 기록
  notePendingBet(roomId: string, info: { roundId: string; betType: BetType }): void {
    this.pendingBets.set(roomId, info)
  }

  // BettingDecisionService가 martin cap 도달을 알릴 때 호출
  signalMartinCap(roomId: string): void {
    if (!this.passesScope(roomId)) return
    this.deps.onMartinReset(roomId)
    this.emit(roomId, 'martin_cap', `cap:${roomId}:${Date.now()}`)
  }

  // === 내부 ===

  private handleResult(event: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }): void {
    if (!this.passesScope(event.roomId)) return
    if (event.winner !== 'T') {
      return
    }

    const pending = this.pendingBets.get(event.roomId)
    const reason: TriggerReason =
      pending?.betType === 'Tie' && (event.roundId === undefined || event.roundId === pending.roundId)
        ? 'tie_hit'
        : 'organic_tie'

    this.deps.onMartinReset(event.roomId)
    const dedupKey = `${event.roomId}:${event.roundId ?? 'noround'}:${reason}`
    this.emit(event.roomId, reason, dedupKey)

    this.pendingBets.delete(event.roomId)
  }

  private passesScope(roomId: string): boolean {
    if (this.scope === null) return false
    if (this.scope === 'auto') return true
    return this.deps.getCurrentFocusedRoomId() === roomId
  }

  private emit(roomId: string, reason: TriggerReason, dedupKey: string): void {
    if (this.firedKeys.has(dedupKey)) return
    this.firedKeys.add(dedupKey)
    // 메모리 안정성: 너무 커지면 오래된 것 정리
    if (this.firedKeys.size > 1000) {
      const arr = Array.from(this.firedKeys)
      for (let i = 0; i < 100; i++) this.firedKeys.delete(arr[i])
    }
    this.callbacks.slice().forEach(cb => cb(roomId, reason))
  }
}
