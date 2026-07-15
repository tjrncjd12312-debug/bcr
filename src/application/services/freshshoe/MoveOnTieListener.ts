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
interface ScopedTriggerCallback {
  callback: TriggerCallback
  scope: Scope | null
}

export class MoveOnTieListener {
  private callbacks: ScopedTriggerCallback[] = []
  private pendingBets: Map<string, { roundId: string; betType: BetType }> = new Map()
  private firedKeys: Set<string> = new Set()  // (roomId, roundId, reason) dedup keys
  private enabledScopes: Set<Scope> = new Set()
  private unsubscribeAdapter: (() => void) | null = null

  constructor(private readonly deps: MoveOnTieListenerDeps) {}

  enable(scope: Scope): () => void {
    this.enabledScopes.add(scope)
    if (!this.unsubscribeAdapter) {
      this.unsubscribeAdapter = this.deps.casinoAdapter.onGameResult((event) => {
        this.handleResult(event)
      })
    }
    return () => this.disable(scope)
  }

  disable(scope?: Scope): void {
    if (scope) this.enabledScopes.delete(scope)
    else this.enabledScopes.clear()
    if (this.enabledScopes.size > 0) return

    this.unsubscribeAdapter?.()
    this.unsubscribeAdapter = null
    this.pendingBets.clear()
    this.firedKeys.clear()
  }

  onTrigger(cb: TriggerCallback, scope?: Scope): () => void {
    const entry: ScopedTriggerCallback = { callback: cb, scope: scope ?? null }
    this.callbacks.push(entry)
    return () => {
      const i = this.callbacks.indexOf(entry)
      if (i >= 0) this.callbacks.splice(i, 1)
    }
  }

  // 베팅 발사 경로가 호출: 어떤 베팅이 어떤 라운드에 들어갔는지 기록
  notePendingBet(roomId: string, info: { roundId: string; betType: BetType }): void {
    this.pendingBets.set(roomId, info)
  }

  // 슈 리셋 등으로 한 방의 트리거 이력을 잊는다 (FreshShoeTieMartingalePreset 사용)
  forgetRoom(roomId: string): void {
    // firedKeys 에서 해당 roomId 항목 모두 제거
    const prefix = `${roomId}:`
    for (const key of Array.from(this.firedKeys)) {
      if (key.startsWith(prefix)) this.firedKeys.delete(key)
    }
    // pendingBets 에서도 제거
    this.pendingBets.delete(roomId)
  }

  // BettingDecisionService가 martin cap 도달을 알릴 때 호출
  signalMartinCap(roomId: string): void {
    const scopes = this.getMatchingScopes(roomId)
    if (scopes.length === 0) return
    this.deps.onMartinReset(roomId)
    for (const scope of scopes) {
      this.emit(roomId, 'martin_cap', `cap:${roomId}:${Date.now()}:${scope}`, scope)
    }
  }

  // === 내부 ===

  private handleResult(event: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }): void {
    const scopes = this.getMatchingScopes(event.roomId)
    if (scopes.length === 0) return
    if (event.winner !== 'T') {
      return
    }

    const pending = this.pendingBets.get(event.roomId)
    const reason: TriggerReason =
      pending?.betType === 'Tie' && (event.roundId === undefined || event.roundId === pending.roundId)
        ? 'tie_hit'
        : 'organic_tie'

    this.deps.onMartinReset(event.roomId)
    for (const scope of scopes) {
      const dedupKey = `${event.roomId}:${event.roundId ?? 'noround'}:${reason}:${scope}`
      this.emit(event.roomId, reason, dedupKey, scope)
    }

    this.pendingBets.delete(event.roomId)
  }

  private getMatchingScopes(roomId: string): Scope[] {
    const scopes: Scope[] = []
    if (this.enabledScopes.has('auto')) scopes.push('auto')
    if (this.enabledScopes.has('semiauto') && this.deps.getCurrentFocusedRoomId() === roomId) {
      scopes.push('semiauto')
    }
    return scopes
  }

  private emit(roomId: string, reason: TriggerReason, dedupKey: string, scope: Scope): void {
    if (this.firedKeys.has(dedupKey)) return
    this.firedKeys.add(dedupKey)
    // 메모리 안정성: 너무 커지면 오래된 것 정리
    if (this.firedKeys.size > 1000) {
      const arr = Array.from(this.firedKeys)
      for (let i = 0; i < 100; i++) this.firedKeys.delete(arr[i])
    }
    this.callbacks.slice().forEach(({ callback, scope: callbackScope }) => {
      if (callbackScope === null || callbackScope === scope) callback(roomId, reason)
    })
  }
}
