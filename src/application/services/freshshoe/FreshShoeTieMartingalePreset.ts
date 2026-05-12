// FreshShoeTieMartingalePreset — 단일 토글로 4개 부품(필터/방향/리스너/STOPPED 게이트)을 atomic하게 활성/비활성
// Clean Architecture: Application Layer
// 단일 책임: orchestration. 자체 베팅 상태는 보유하지 않음.

import type { TriggerReason, MoveOnTieListener } from './MoveOnTieListener'

export type Mode = 'auto' | 'semiauto'

// 최소한의 인터페이스만 의존 (테스트 용이성)
export interface IFilterService {
  toggleFilter(type: 'fresh_shoe'): void
  getActiveFilters(): string[]
}

export interface ISettingsBridge {
  get(): { forceBetDirection?: 'auto' | 'tie_only' }
  update(patch: { forceBetDirection: 'auto' | 'tie_only' }): void
}

export interface IShoeChangeSource {
  onShoeChange(cb: (roomId: string, koreanName: string) => void): () => void
}

export interface IPresetStorage {
  get(): string | null
  set(value: string): void
  remove(): void
}

export interface PresetDeps {
  filterService: IFilterService
  settingsBridge: { auto: ISettingsBridge; semiauto: ISettingsBridge }
  listener: Pick<MoveOnTieListener, 'enable' | 'disable' | 'onTrigger' | 'notePendingBet' | 'signalMartinCap'>
  casinoAdapter: IShoeChangeSource
  storage: IPresetStorage
  semiAutoTriggerHandler: (roomId: string, reason: TriggerReason) => Promise<void>
  onMartinReset?: (roomId: string) => void
}

interface PersistedState {
  enabledForAuto: boolean
  enabledForSemiAuto: boolean
}

interface Snapshot {
  filterWasActive: boolean
  prevForceBetDirection: 'auto' | 'tie_only'
  unsubscribeListener: (() => void) | null
  unsubscribeShoeChange: (() => void) | null
  unsubscribeTrigger: (() => void) | null
}

const STORAGE_DEFAULT: PersistedState = { enabledForAuto: false, enabledForSemiAuto: false }

export class FreshShoeTieMartingalePreset {
  private state: PersistedState = { ...STORAGE_DEFAULT }
  private snapshots: Partial<Record<Mode, Snapshot>> = {}
  private stoppedRooms: Set<string> = new Set()
  private activeMode: Mode | null = null

  constructor(private readonly deps: PresetDeps) {
    this.loadFromStorage()
    // 부팅 시 복원
    if (this.state.enabledForAuto) {
      try { this.applyEnable('auto') } catch (e) { console.error('[FreshShoeTieMartingalePreset] auto restore failed', e) }
    }
    if (this.state.enabledForSemiAuto) {
      try { this.applyEnable('semiauto') } catch (e) { console.error('[FreshShoeTieMartingalePreset] semiauto restore failed', e) }
    }
  }

  isEnabled(mode: Mode): boolean {
    return mode === 'auto' ? this.state.enabledForAuto : this.state.enabledForSemiAuto
  }

  isRoomStopped(roomId: string): boolean {
    return this.stoppedRooms.has(roomId)
  }

  getDescription(): string {
    return (
      '슈가 막 시작된 방에서만 베팅 (Evolution 슈 리셋 감지 기반). ' +
      'Tie에 마틴 (기존 설정 금액·마틴 한도 재사용). ' +
      '적중 / 관망 중 Tie 출현 / 마틴 한도 도달 → 자동으로 다음 fresh-shoe 방으로 이동.'
    )
  }

  enable(mode: Mode): void {
    if (this.isEnabled(mode)) return
    this.applyEnable(mode)
    if (mode === 'auto') this.state.enabledForAuto = true
    else this.state.enabledForSemiAuto = true
    this.saveToStorage()
  }

  disable(mode: Mode): void {
    if (!this.isEnabled(mode)) return
    this.applyDisable(mode)
    if (mode === 'auto') this.state.enabledForAuto = false
    else this.state.enabledForSemiAuto = false
    this.saveToStorage()
  }

  // === 내부 ===

  private applyEnable(mode: Mode): void {
    const bridge = mode === 'auto' ? this.deps.settingsBridge.auto : this.deps.settingsBridge.semiauto
    const filterWasActive = this.deps.filterService.getActiveFilters().includes('fresh_shoe')
    const prevForceBetDirection = bridge.get().forceBetDirection ?? 'auto'

    const snap: Snapshot = {
      filterWasActive,
      prevForceBetDirection,
      unsubscribeListener: null,
      unsubscribeShoeChange: null,
      unsubscribeTrigger: null,
    }

    try {
      // 1. fresh_shoe 필터 활성
      if (!filterWasActive) this.deps.filterService.toggleFilter('fresh_shoe')

      // 2. forceBetDirection='tie_only'
      bridge.update({ forceBetDirection: 'tie_only' })

      // 3. listener 활성
      snap.unsubscribeListener = this.deps.listener.enable(mode)
      this.activeMode = mode

      // 4. listener 트리거 콜백 연결
      snap.unsubscribeTrigger = this.deps.listener.onTrigger((roomId, reason) => {
        if (mode === 'auto') {
          this.markRoomStopped(roomId)
        } else {
          void this.deps.semiAutoTriggerHandler(roomId, reason)
        }
      })

      // 5. shoe-change 구독 (auto 모드에서 STOPPED 해제용)
      if (mode === 'auto') {
        snap.unsubscribeShoeChange = this.deps.casinoAdapter.onShoeChange((roomId) => {
          this.stoppedRooms.delete(roomId)
        })
      }

      this.snapshots[mode] = snap
    } catch (err) {
      // rollback
      snap.unsubscribeTrigger?.()
      snap.unsubscribeShoeChange?.()
      snap.unsubscribeListener?.()
      bridge.update({ forceBetDirection: prevForceBetDirection })
      if (!filterWasActive && this.deps.filterService.getActiveFilters().includes('fresh_shoe')) {
        this.deps.filterService.toggleFilter('fresh_shoe')
      }
      this.activeMode = null
      throw err
    }
  }

  private applyDisable(mode: Mode): void {
    const snap = this.snapshots[mode]
    if (!snap) return
    snap.unsubscribeTrigger?.()
    snap.unsubscribeShoeChange?.()
    snap.unsubscribeListener?.()
    const bridge = mode === 'auto' ? this.deps.settingsBridge.auto : this.deps.settingsBridge.semiauto
    bridge.update({ forceBetDirection: snap.prevForceBetDirection })
    if (!snap.filterWasActive && this.deps.filterService.getActiveFilters().includes('fresh_shoe')) {
      this.deps.filterService.toggleFilter('fresh_shoe')
    }
    delete this.snapshots[mode]
    if (this.activeMode === mode) this.activeMode = null
    if (mode === 'auto') this.stoppedRooms.clear()
  }

  private markRoomStopped(roomId: string): void {
    this.stoppedRooms.add(roomId)
  }

  private loadFromStorage(): void {
    try {
      const raw = this.deps.storage.get()
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      this.state = {
        enabledForAuto: !!parsed.enabledForAuto,
        enabledForSemiAuto: !!parsed.enabledForSemiAuto,
      }
    } catch {
      this.state = { ...STORAGE_DEFAULT }
    }
  }

  private saveToStorage(): void {
    try {
      this.deps.storage.set(JSON.stringify(this.state))
    } catch {
      // ignore (best-effort persistence)
    }
  }
}
