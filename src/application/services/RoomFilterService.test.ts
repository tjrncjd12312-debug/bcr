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
    function createPredictionState(
      roomId: string,
      isShoeReset?: boolean,
      shoeChangeDetectedAt?: number,
    ): RoomPredictionState {
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
        shoeChangeDetectedAt,
      }
    }

    beforeEach(() => {
      FilterThresholdsService.set({ freshShoeMaxGameNumber: 5 })
    })

    it('does not match a long shoe even after an explicit shoe-change event', () => {
      const room = createRoom('r1', createHistory('BBPBPBBPPBBPBP')) // 14 results > 5
      const state = createPredictionState('r1', false, Date.now())
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
    })

    it('matches short history only after an explicit shoe-change event', () => {
      const room = createRoom('r2', createHistory('BPB')) // 3 results
      const state = createPredictionState('r2', false, Date.now())
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(true)
    })

    it('does not treat isShoeReset inferred from short history as a verified shoe change', () => {
      const room = createRoom('r3', createHistory('BPB'))
      const state = createPredictionState('r3', true)
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
    })

    it('does NOT match when the explicit signal is missing and history is long', () => {
      const room = createRoom('r4', createHistory('BPBPBPBP'))
      const state = createPredictionState('r4', undefined)
      expect(RoomFilterService.matchesFilter(room, state, 'fresh_shoe')).toBe(false)
    })

    it('does NOT match when predictionState is null and history is long', () => {
      const room = createRoom('r5', createHistory('BPBPBPBP'))
      expect(RoomFilterService.matchesFilter(room, null, 'fresh_shoe')).toBe(false)
    })

    it('does not match short history when predictionState is null', () => {
      const room = createRoom('r6', createHistory('BP'))
      expect(RoomFilterService.matchesFilter(room, null, 'fresh_shoe')).toBe(false)
    })
  })

  describe('tie_frequent filter', () => {
    // 정확 모델(2026-07-07): counts ties from game `start` through the CURRENT
    // newest (whole shoe so far). `window` is the minimum-games entry gate.
    // Defaults: start=1, window=5, min=0, max=0 → "no tie anywhere in the shoe
    // so far, with >= 5 games played". A tie ANYWHERE (even past the window)
    // drops the room; a new shoe resets history so it re-qualifies.
    // The window must be FULLY played before a room matches (no early matching).
    // history is newest-first, so createHistory(s) treats s[0] as newest.

    beforeEach(() => {
      FilterThresholdsService.set({
        tieFrequentStart: 1,
        tieFrequentWindow: 5,
        tieFrequentMinCount: 0,
        tieFrequentMaxCount: 0,
        tieFrequentRequireFullWindow: true,
      })
    })

    it('matches default 0-0 when first 5 games of shoe have no ties', () => {
      // chronological: B P B P B (oldest→newest) — no ties in games 1-5
      // newest-first input: B P B P B  (palindrome here)
      const room = createRoom('r1', createHistory('BPBPB'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
    })

    it('labels the 0-0 condition as a shoe interval tie-none filter', () => {
      const filter = RoomFilterService.getAvailableFilters().find(f => f.type === 'tie_frequent')
      expect(filter?.label).toContain('타이 없음')
      expect(filter?.label).not.toContain('타이 자주')
      expect(filter?.description).toContain('1~5번째 게임')
    })

    it('does NOT match 0-0 once a tie appears within the first 5 games', () => {
      // chronological order has T in game 3: P, B, T, P, B
      // newest-first: B P T B P
      const room = createRoom('r2', createHistory('BPTBP'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('drops a max=0 room once ANY tie appears, even after the window (정확 모델)', () => {
      // chronological: B P B P B T T  (first 5 games tie-free, ties at game 6-7)
      // newest-first: T T B P B P B
      // 정확 모델: 슈에 타이가 한 번이라도 나오면(창 밖이라도) 그 방은 목록에서 빠진다.
      // (새 슈로 히스토리가 리셋되면 다시 후보가 됨)
      const room = createRoom('r3', createHistory('TTBPBPB'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('does NOT match until the configured shoe window is fully played', () => {
      // Only 3 games, window=5 → wait for the full 5-game window before
      // deciding ("20개부터 찾기" intent — no early matching).
      const room = createRoom('r4', createHistory('BPB'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    it('does NOT match an empty shoe before the window has any results', () => {
      const room = createRoom('rFirst', createHistory(''))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(false)
    })

    // 사용자 전략: "1~20번째 게임 안에 타이가 한 번도 안 뜬 방을 찾아서 배팅"
    // = start=1, window=20, 타이 0~0, 구간 완료 후 진입.
    it('finds "no tie in games 1-20" rooms (start=1, window=20, max=0)', () => {
      FilterThresholdsService.set({
        tieFrequentStart: 1,
        tieFrequentWindow: 20,
        tieFrequentMinCount: 0,
        tieFrequentMaxCount: 0,
        tieFrequentRequireFullWindow: true,
      })
      // 20판 모두 무타이 → 매칭
      expect(RoomFilterService.matchesFilter(createRoom('r20', createHistory('B'.repeat(20))), null, 'tie_frequent')).toBe(true)
      // 1~20 안에 타이가 하나라도 있으면 → 제외
      expect(RoomFilterService.matchesFilter(createRoom('rTie', createHistory('B'.repeat(19) + 'T')), null, 'tie_frequent')).toBe(false)
      // 아직 20판이 안 참 → 제외 (구간 완료 후 진입)
      expect(RoomFilterService.matchesFilter(createRoom('r19', createHistory('B'.repeat(19))), null, 'tie_frequent')).toBe(false)
    })

    it('matches early (window still in progress) when full-window wait is OFF', () => {
      // 조기진입 모드(슈 시작부터): 구간(5판)이 안 차도 지금까지 타이가 없으면 매칭.
      FilterThresholdsService.set({ tieFrequentRequireFullWindow: false })
      const room = createRoom('rEarly', createHistory('BPB')) // 3 games, no tie yet
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
    })

    it('respects a configurable start offset (e.g. skip the first 2 games)', () => {
      // start=3, window=3 → look at chronological games 3-5
      FilterThresholdsService.set({ tieFrequentStart: 3, tieFrequentWindow: 3 })
      // chronological: T T B P B  (ties in games 1-2, none in 3-5)
      // newest-first:  B P B T T
      const room = createRoom('r5', createHistory('BPBTT'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
    })

    it('honors a non-zero count range (e.g. exactly 2 ties in window of 5)', () => {
      FilterThresholdsService.set({
        tieFrequentMinCount: 2,
        tieFrequentMaxCount: 2,
      })
      // chronological: T B P B T  (2 ties in first 5)
      // newest-first:  T B P B T
      const room = createRoom('r6', createHistory('TBPBT'))
      expect(RoomFilterService.matchesFilter(room, null, 'tie_frequent')).toBe(true)
    })
  })
})
