// FilterThresholdsService - User-configurable filter threshold values with localStorage persistence
// Presentation-friendly application service (no React dependency)

import {
  TIE_DROUGHT_THRESHOLD,
  TIE_FREQUENT_MIN_COUNT,
  FRESH_ROOM_GAMES,
  FRESH_SHOE_MAX_GAME_NUMBER,
} from '../../domain/entities'

const STORAGE_KEY = 'bcr-filter-thresholds'

export interface FilterThresholds {
  tieDroughtThreshold: number
  tieFrequentMinCount: number
  freshRoomGames: number
  freshShoeMaxGameNumber: number
}

const DEFAULTS: FilterThresholds = {
  tieDroughtThreshold: TIE_DROUGHT_THRESHOLD,
  tieFrequentMinCount: TIE_FREQUENT_MIN_COUNT,
  freshRoomGames: FRESH_ROOM_GAMES,
  freshShoeMaxGameNumber: FRESH_SHOE_MAX_GAME_NUMBER,
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
        tieFrequentMinCount: this.coerce(parsed.tieFrequentMinCount, DEFAULTS.tieFrequentMinCount, 1, 30),
        freshRoomGames: this.coerce(parsed.freshRoomGames, DEFAULTS.freshRoomGames, 1, 200),
        freshShoeMaxGameNumber: this.coerce(parsed.freshShoeMaxGameNumber, DEFAULTS.freshShoeMaxGameNumber, 1, 200),
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
    const next: FilterThresholds = {
      tieDroughtThreshold: partial.tieDroughtThreshold !== undefined
        ? this.coerce(partial.tieDroughtThreshold, this.values.tieDroughtThreshold, 1, 200)
        : this.values.tieDroughtThreshold,
      tieFrequentMinCount: partial.tieFrequentMinCount !== undefined
        ? this.coerce(partial.tieFrequentMinCount, this.values.tieFrequentMinCount, 1, 30)
        : this.values.tieFrequentMinCount,
      freshRoomGames: partial.freshRoomGames !== undefined
        ? this.coerce(partial.freshRoomGames, this.values.freshRoomGames, 1, 200)
        : this.values.freshRoomGames,
      freshShoeMaxGameNumber: partial.freshShoeMaxGameNumber !== undefined
        ? this.coerce(partial.freshShoeMaxGameNumber, this.values.freshShoeMaxGameNumber, 1, 200)
        : this.values.freshShoeMaxGameNumber,
    }
    if (
      next.tieDroughtThreshold === this.values.tieDroughtThreshold &&
      next.tieFrequentMinCount === this.values.tieFrequentMinCount &&
      next.freshRoomGames === this.values.freshRoomGames &&
      next.freshShoeMaxGameNumber === this.values.freshShoeMaxGameNumber
    ) {
      return
    }
    this.values = next
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
