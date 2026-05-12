// FilterThresholdsService - User-configurable filter threshold values with localStorage persistence
// Presentation-friendly application service (no React dependency)

import { TIE_DROUGHT_THRESHOLD, FRESH_ROOM_GAMES } from '../../domain/entities'

const STORAGE_KEY = 'bcr-filter-thresholds'

export interface FilterThresholds {
  tieDroughtThreshold: number
  freshRoomGames: number
}

const DEFAULTS: FilterThresholds = {
  tieDroughtThreshold: TIE_DROUGHT_THRESHOLD,
  freshRoomGames: FRESH_ROOM_GAMES,
}

class FilterThresholdsServiceImpl {
  private values: FilterThresholds = { ...DEFAULTS }
  private listeners: Array<(v: FilterThresholds) => void> = []

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<FilterThresholds>
      this.values = {
        tieDroughtThreshold: this.coerce(parsed.tieDroughtThreshold, DEFAULTS.tieDroughtThreshold, 1, 200),
        freshRoomGames: this.coerce(parsed.freshRoomGames, DEFAULTS.freshRoomGames, 1, 200),
      }
    } catch {
      this.values = { ...DEFAULTS }
    }
  }

  private save(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values))
    } catch {
      // ignore
    }
  }

  private coerce(v: unknown, fallback: number, min: number, max: number): number {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }

  get(): FilterThresholds {
    return { ...this.values }
  }

  set(partial: Partial<FilterThresholds>): void {
    this.values = {
      tieDroughtThreshold: partial.tieDroughtThreshold !== undefined
        ? this.coerce(partial.tieDroughtThreshold, this.values.tieDroughtThreshold, 1, 200)
        : this.values.tieDroughtThreshold,
      freshRoomGames: partial.freshRoomGames !== undefined
        ? this.coerce(partial.freshRoomGames, this.values.freshRoomGames, 1, 200)
        : this.values.freshRoomGames,
    }
    this.save()
    this.emit()
  }

  onChange(cb: (v: FilterThresholds) => void): () => void {
    this.listeners.push(cb)
    return () => { this.listeners = this.listeners.filter(l => l !== cb) }
  }

  private emit(): void {
    const snap = this.get()
    this.listeners.forEach(l => l(snap))
  }
}

const FilterThresholdsService = new FilterThresholdsServiceImpl()
export default FilterThresholdsService
export { FilterThresholdsService }
