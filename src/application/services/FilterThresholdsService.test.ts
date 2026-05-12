import { describe, it, expect, beforeEach } from 'vitest'
import FilterThresholdsService from './FilterThresholdsService'
import { FRESH_SHOE_MAX_GAME_NUMBER, FRESH_ROOM_GAMES, TIE_DROUGHT_THRESHOLD } from '../../domain/entities'

describe('FilterThresholdsService', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem('bcr-filter-thresholds')
    }
    // Force-reset in-memory values since the service is a module singleton
    FilterThresholdsService.set({
      tieDroughtThreshold: TIE_DROUGHT_THRESHOLD,
      freshRoomGames: FRESH_ROOM_GAMES,
      freshShoeMaxGameNumber: FRESH_SHOE_MAX_GAME_NUMBER,
    })
  })

  it('defaults freshShoeMaxGameNumber to FRESH_SHOE_MAX_GAME_NUMBER', () => {
    const v = FilterThresholdsService.get()
    expect(v.freshShoeMaxGameNumber).toBe(FRESH_SHOE_MAX_GAME_NUMBER)
  })

  it('sets and persists freshShoeMaxGameNumber', () => {
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 8 })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(8)
    const raw = window.localStorage.getItem('bcr-filter-thresholds') ?? ''
    expect(raw).toContain('"freshShoeMaxGameNumber":8')
  })

  it('clamps freshShoeMaxGameNumber to [1, 200]', () => {
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 0 })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(1)
    FilterThresholdsService.set({ freshShoeMaxGameNumber: 9999 })
    expect(FilterThresholdsService.get().freshShoeMaxGameNumber).toBe(200)
  })
})
