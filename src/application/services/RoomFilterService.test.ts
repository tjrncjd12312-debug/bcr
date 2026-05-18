// RoomFilterService Unit Tests
import { describe, it, expect, beforeEach } from 'vitest'
import { RoomFilterService } from './RoomFilterService'
import CustomPatternService from './CustomPatternService'
import FilterThresholdsService from './FilterThresholdsService'
import type { Room, RoadResult, Winner } from '../../domain/entities'
import type { RoomPredictionState } from '../../domain/entities'

// Helper to create RoadResult array from winner string
function createHistory(pattern: string): RoadResult[] {
  return pattern.split('').map(char => ({
    winner: char as Winner,
    isPlayerPair: false,
    isBankerPair: false,
  }))
}

// Helper to create a mock room
function createRoom(id: string, history: RoadResult[]): Room {
  return {
    id,
    name: `Room ${id}`,
    koreanName: `방 ${id}`,
    history,
    gameCount: history.length,
  }
}

describe('RoomFilterService', () => {
  beforeEach(() => {
    // Reset filters before each test
    RoomFilterService.clearFilters()
    CustomPatternService.clear()
  })

  describe('detectPattern', () => {
    it('should detect alternating pattern (퐁당퐁당)', () => {
      const history = createHistory('BPBPBPBP')
      const pattern = RoomFilterService.detectPattern(history)

      expect(pattern).not.toBeNull()
      expect(pattern?.type).toBe('alternating')
      expect(pattern?.length).toBeGreaterThanOrEqual(4)
    })

    it('should detect streak pattern (장줄)', () => {
      const history = createHistory('BBBBB')
      const pattern = RoomFilterService.detectPattern(history)

      expect(pattern).not.toBeNull()
      expect(pattern?.type).toBe('streak')
      expect(pattern?.length).toBeGreaterThanOrEqual(4)
    })

    it('should return mixed for no clear pattern', () => {
      const history = createHistory('BBPBBPB')
      const pattern = RoomFilterService.detectPattern(history)

      expect(pattern).not.toBeNull()
      expect(pattern?.type).toBe('mixed')
    })

    it('should handle empty history', () => {
      const pattern = RoomFilterService.detectPattern([])
      expect(pattern).toBeNull()
    })

    it('should handle history with only one result', () => {
      const history = createHistory('B')
      const pattern = RoomFilterService.detectPattern(history)
      expect(pattern).toBeNull()
    })

    it('should handle ties in history', () => {
      const history = createHistory('BTBTBTBT')
      const pattern = RoomFilterService.detectPattern(history)

      expect(pattern).not.toBeNull()
      // Ties are skipped in pattern detection
    })
  })

  describe('filter management', () => {
    it('should start with no active filters', () => {
      const filters = RoomFilterService.getActiveFilters()
      expect(filters).toHaveLength(0)
    })

    it('should toggle filter on', () => {
      RoomFilterService.toggleFilter('alternating')
      const filters = RoomFilterService.getActiveFilters()

      expect(filters).toContain('alternating')
    })

    it('should toggle filter off', () => {
      RoomFilterService.toggleFilter('alternating')
      RoomFilterService.toggleFilter('alternating')
      const filters = RoomFilterService.getActiveFilters()

      expect(filters).not.toContain('alternating')
    })

    it('should set multiple filters', () => {
      RoomFilterService.setFilters(['alternating', 'long_streak'])
      const filters = RoomFilterService.getActiveFilters()

      expect(filters).toContain('alternating')
      expect(filters).toContain('long_streak')
      expect(filters).toHaveLength(2)
    })

    it('should clear all filters', () => {
      RoomFilterService.setFilters(['alternating', 'long_streak'])
      RoomFilterService.clearFilters()
      const filters = RoomFilterService.getActiveFilters()

      expect(filters).toHaveLength(0)
    })
  })

  describe('matchesFilter', () => {
    it('should match alternating pattern filter', () => {
      const room = createRoom('1', createHistory('BPBPBPBP'))
      const matches = RoomFilterService.matchesFilter(room, null, 'alternating')

      expect(matches).toBe(true)
    })

    it('should match long_streak filter', () => {
      const room = createRoom('1', createHistory('BBBBB'))
      const matches = RoomFilterService.matchesFilter(room, null, 'long_streak')

      expect(matches).toBe(true)
    })

    it('should not match alternating for streak pattern', () => {
      const room = createRoom('1', createHistory('BBBBB'))
      const matches = RoomFilterService.matchesFilter(room, null, 'alternating')

      expect(matches).toBe(false)
    })

    it('should match losing_streak with prediction state', () => {
      const room = createRoom('1', createHistory('BBBBB'))
      const predictionState: any = {
        roomId: 'test-room',
        roomName: 'Test Room',
        lastPrediction: null,
        stats: {
          total: 0,
          correct: 0,
          winRate: 0,
          consecutiveWins: 0,
          consecutiveLosses: 5, // 5 losses
          maxConsecutiveWins: 0,
          maxConsecutiveLosses: 5,
        },
        pattern: null,
        isFiltered: false,
        predictionCount: 0,
        history: [], // ✅ Fix TS Error
      }

      const matches = RoomFilterService.matchesFilter(room, predictionState, 'losing_streak')
      expect(matches).toBe(true)
    })

    it('should match winning_streak with 3+ wins', () => {
      const room = createRoom('1', createHistory('BPBPBPBP'))
      const predictionState: any = {
        roomId: 'test-room',
        roomName: 'Test Room',
        lastPrediction: null,
        stats: {
          total: 0,
          correct: 0,
          winRate: 0,
          consecutiveWins: 3, // 3 wins
          consecutiveLosses: 0,
          maxConsecutiveWins: 3,
          maxConsecutiveLosses: 0,
        },
        pattern: null,
        isFiltered: false,
        predictionCount: 0,
        predictionHistory: [], // Old prop - keeping for safety
        history: [], // ✅ Fix TS Error
      }

      const matches = RoomFilterService.matchesFilter(room, predictionState, 'winning_streak')
      expect(matches).toBe(true)
    })
  })

  describe('filter change callback', () => {
    it('should emit filter change on toggle', () => {
      let emittedFilters: string[] = []
      const unsubscribe = RoomFilterService.onFilterChange((filters) => {
        emittedFilters = filters
      })

      RoomFilterService.toggleFilter('alternating')

      expect(emittedFilters).toContain('alternating')

      unsubscribe()
    })

    it('should unsubscribe correctly', () => {
      let callCount = 0
      const unsubscribe = RoomFilterService.onFilterChange(() => {
        callCount++
      })

      RoomFilterService.toggleFilter('alternating')
      expect(callCount).toBe(1)

      unsubscribe()

      RoomFilterService.toggleFilter('long_streak')
      expect(callCount).toBe(1) // Should not increase
    })
  })

  describe('custom patterns', () => {
    it('should match custom pattern only when recent results match exactly', () => {
      const pattern = CustomPatternService.addPattern({
        name: 'Tail BPB',
        sequence: 'BPB',
        enabled: true,
      })

      const roomMatches = createRoom('1', createHistory('BPBPP'))
      const roomMismatch = createRoom('2', createHistory('BBPBP'))

      expect(RoomFilterService.matchesFilter(roomMatches, null, `custom:${pattern.id}`)).toBe(true)
      expect(RoomFilterService.matchesFilter(roomMismatch, null, `custom:${pattern.id}`)).toBe(false)
    })

  })

  describe('fresh_shoe filter', () => {
    function createPredictionState(roomId: string, isShoeReset?: boolean): RoomPredictionState {
      return {
        roomId,
        roomName: `Room ${roomId}`,
        lastPrediction: null,
        stats: {
          total: 0, correct: 0, winRate: 0,
          consecutiveWins: 0, consecutiveLosses: 0,
          maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
        },
        pattern: null,
        isFiltered: false,
        predictionCount: 0,
        history: [],
        isShoeReset,
      }
    }

    beforeEach(() => {
      FilterThresholdsService.set({ freshShoeMaxGameNumber: 5 })
    })

    it('matches when predictionState.isShoeReset === true regardless of history length', () => {
      const room = createRoom('r1', createHistory('BBPBPBBPPBBPBP')) // 14 results > 5
      const state = createPredictionState('r1', true)
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(true)
    })

    it('matches when history.length <= freshShoeMaxGameNumber and isShoeReset is falsy', () => {
      const room = createRoom('r2', createHistory('BPB')) // 3 results
      const state = createPredictionState('r2', false)
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(true)
    })

    it('does NOT match when history is long and isShoeReset is false', () => {
      const room = createRoom('r3', createHistory('BPBPBPBP')) // 8 > 5
      const state = createPredictionState('r3', false)
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
    })

    it('does NOT match when both isShoeReset is undefined and history is long', () => {
      const room = createRoom('r4', createHistory('BPBPBPBP'))
      const state = createPredictionState('r4', undefined)
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
    })

    it('does NOT match when predictionState is null and history is long', () => {
      const room = createRoom('r5', createHistory('BPBPBPBP'))
      expect(RoomFilterService.matchesFilter(room, null, 'fresh_shoe')).toBe(false)
    })

    it('matches when predictionState is null but history is short (≤ N)', () => {
      const room = createRoom('r6', createHistory('BP'))
      expect(RoomFilterService.matchesFilter(room, null, 'fresh_shoe')).toBe(true)
    })
  })

  describe('tie_frequent filter', () => {
    // Window is fixed at TIE_FREQUENT_WINDOW = 30 most-recent games.
    // threshold = tieFrequentMinCount (default 2).

    beforeEach(() => {
      FilterThresholdsService.set({ tieFrequentMinCount: 2 })
    })

    it('matches when ties in the last 30 games >= threshold', () => {
      // 2 ties in 10 games — meets default threshold of 2
      const room = createRoom('r1', createHistory('BPTBPTBPBP'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
    })

    it('does NOT match when tie count is below threshold', () => {
      // 1 tie in 10 games — below threshold of 2
      const room = createRoom('r2', createHistory('BPTBPBPBPB'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('counts only the most recent 30 games (older ties beyond window are ignored)', () => {
      FilterThresholdsService.set({ tieFrequentMinCount: 3 })
      // newest-first history: first 30 chars have 2 ties, then older ties beyond the window
      // 30 newest: 'BPBPTBPBPBPTBPBPBPBPBPBPBPBPBP' (2 T's at indexes 4 and 11)
      // appended: 'TTTTT' — these are OLDER games, beyond the 30-window
      const room = createRoom('r3', createHistory('BPBPTBPBPBPTBPBPBPBPBPBPBPBPBPTTTTT'))
      // Only 2 T's in the 30-game window → below threshold of 3 → no match
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('reacts to threshold changes from FilterThresholdsService', () => {
      const room = createRoom('r4', createHistory('TBPTBPBP')) // 2 ties
      FilterThresholdsService.set({ tieFrequentMinCount: 2 })
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
      FilterThresholdsService.set({ tieFrequentMinCount: 3 })
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('does NOT match when history has no ties', () => {
      const room = createRoom('r5', createHistory('BPBPBPBPBP'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('respects a configurable window — only counts ties inside it', () => {
      // 50-game window with 4 ties spread across the last 50 games
      FilterThresholdsService.set({
        tieFrequentWindow: 50,
        tieFrequentMinCount: 4,
      })
      // 40 newest games with 4 ties + 20 older games (irrelevant)
      const newest = 'BPBPTBPBPBPTBPBPBPBPBPBPTBPBPBPBPBPBPTBP' // 40 chars, 4 T's
      const older = 'TTTTTTTTTTBPBPBPBPBP' // 20 chars (older, beyond 50 window)
      const room = createRoom('rW', createHistory(newest + older))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
    })

    it('honors max count — does NOT match once tie count exceeds the upper bound', () => {
      // User wants "exactly 5 ties" → set both min and max to 5
      FilterThresholdsService.set({
        tieFrequentMinCount: 5,
        tieFrequentMaxCount: 5,
      })
      const exactlyFiveTies = createRoom('rX', createHistory('TBPTBPTBPTBPTBPBP')) // 5 T's
      const sixTies = createRoom('rY', createHistory('TBPTBPTBPTBPTBPBPT')) // 6 T's
      expect(RoomFilterService.matchesFilter(exactlyFiveTies, null, 'tie_frequent')).toBe(true)
      expect(RoomFilterService.matchesFilter(sixTies, null, 'tie_frequent')).toBe(false)
    })
  })
})
