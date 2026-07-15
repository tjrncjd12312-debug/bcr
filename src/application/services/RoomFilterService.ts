// Room Filter Service - Pattern detection and room filtering logic

import type {
  Room,
  Winner,
  RoadResult,
  RoomFilterType,
  RoomFilter,
  RoomPattern,
  RoomPredictionState,
  CustomPattern,
} from '../../domain/entities'
import { TIE_DROUGHT_THRESHOLD, FRESH_ROOM_GAMES } from '../../domain/entities'
import { toWinnerArray } from '../../domain/utils/converters'
import CustomPatternService from './CustomPatternService'
import CustomStrategyService from './CustomStrategyService'
import FilterThresholdsService from './FilterThresholdsService'

// NOTE: 내장 패턴(FILTER_DEFINITIONS) 제거됨
// 이제 사용자가 PatternManagerModal에서 직접 등록한 커스텀 패턴만 사용
const BUILT_IN_FILTERS: RoomFilter[] = [
  {
    type: 'losing_streak',
    enabled: false,
    label: '연패(5~8)',
    description: '예측 5~8연패 방',
  },
  {
    type: 'alternating',
    enabled: false,
    label: '퐁당퐁당',
    description: 'B/P 번갈아 4+',
  },
  {
    type: 'long_streak',
    enabled: false,
    label: '장줄(4+)',
    description: '동일 결과 4연속 이상',
  },
  {
    type: 'short_streak',
    enabled: false,
    label: '단줄(2~3)',
    description: '동일 결과 2~3연속',
  },
  {
    type: 'after_tie',
    enabled: false,
    label: '타이 직후',
    description: '마지막 결과가 T',
  },
  {
    type: 'banker_dominant',
    enabled: false,
    label: '뱅커 우세',
    description: '최근 10판 B > P',
  },
  {
    type: 'player_dominant',
    enabled: false,
    label: '플레이어 우세',
    description: '최근 10판 P > B',
  },
  {
    type: 'winning_streak',
    enabled: false,
    label: '연승(3+)',
    description: '예측 3연승 이상',
  },
  {
    type: 'tie_drought',
    enabled: false,
    label: '타이 가뭄',
    description: `최근 ${TIE_DROUGHT_THRESHOLD}게임 동안 Tie 미발생`,
  },
  {
    type: 'tie_frequent',
    enabled: false,
    label: '타이 자주',
    description: '관측 윈도우 안에 Tie 횟수가 지정 범위 안',
  },
  {
    type: 'no_tie_room',
    enabled: false,
    label: '타이 없는 방',
    description: '이 방의 히스토리에 타이가 0건',
  },
  {
    type: 'fresh_room',
    enabled: false,
    label: '신규 방',
    description: `방 진입 후 ${FRESH_ROOM_GAMES}게임 이내`,
  },
  {
    type: 'fresh_shoe',
    enabled: false,
    label: '새 슈',
    description: '카지노 슈가 막 시작된 방',
  },
]

class RoomFilterServiceImpl {
  private activeFilters: Set<RoomFilterType> = new Set()
  private filterChangeCallbacks: Array<(filters: RoomFilterType[]) => void> = []
  private availableFilterCallbacks: Array<(filters: RoomFilter[]) => void> = []
  private customPatterns: CustomPattern[] = []

  constructor() {
    this.customPatterns = CustomPatternService.getPatterns()
    CustomPatternService.onChange((patterns) => {
      this.setCustomPatterns(patterns)
    })
    CustomStrategyService.onChange(() => {
      this.cleanupInactiveStrategyFilters()
      this.emitAvailableFiltersChange()
    })
    // Re-emit available filters when thresholds change so labels (e.g. "타이 가뭄 (20)") update live
    FilterThresholdsService.onChange(() => {
      this.emitAvailableFiltersChange()
    })
  }

  refreshFromCustomPatterns(): void {
    this.customPatterns = [...CustomPatternService.getPatterns()]
    this.emitAvailableFiltersChange()
  }

  getAvailableFilters(): RoomFilter[] {
    const {
      tieDroughtThreshold,
      tieFrequentWindow,
      tieFrequentStart,
      tieFrequentMinCount,
      tieFrequentMaxCount,
      tieFrequentRequireFullWindow,
      freshRoomGames,
      freshShoeMaxGameNumber,
    } = FilterThresholdsService.get()

    // 1) 내장 필터 - 임계값을 라벨/설명에 반영
    const builtin = BUILT_IN_FILTERS.map(filter => {
      let label = filter.label
      let description = filter.description
      if (filter.type === 'tie_drought') {
        label = `타이 가뭄 (${tieDroughtThreshold})`
        description = `최근 ${tieDroughtThreshold}게임 동안 Tie 미발생`
      } else if (filter.type === 'tie_frequent') {
        const rangeText = tieFrequentMinCount === tieFrequentMaxCount
          ? (tieFrequentMinCount === 0 ? '한 번도 없음' : `정확히 ${tieFrequentMinCount}번`)
          : `${tieFrequentMinCount}~${tieFrequentMaxCount}번`
        label = tieFrequentMinCount === 0 && tieFrequentMaxCount === 0
          ? `타이 없음 (${rangeText})`
          : `타이 자주 (${rangeText})`
        const endGame = tieFrequentStart + tieFrequentWindow - 1
        // requireFullWindow 상태를 설명에 포함 → 체크박스 토글 시 label/description 변경으로
        // 프론트(filterSettingsSignature)가 즉시 재필터링한다(실시간 반영).
        const entryText = tieFrequentRequireFullWindow ? '구간 완료 후 진입' : '슈 시작부터 진입'
        description = `${tieFrequentStart}~${endGame}번째 게임 사이에 Tie가 ${rangeText} 나온 방 · ${entryText}`
      } else if (filter.type === 'fresh_room') {
        label = `신규 방 (≤${freshRoomGames})`
        description = `방 진입 후 ${freshRoomGames}게임 이내`
      } else if (filter.type === 'fresh_shoe') {
        label = `새 슈 (≤${freshShoeMaxGameNumber})`
        description = `카지노 슈가 막 시작된 방 (${freshShoeMaxGameNumber}게임 이내)`
      }
      return {
        ...filter,
        label,
        description,
        enabled: this.activeFilters.has(filter.type),
      }
    })

    // 2) 커스텀 필터 (등록된 모든 패턴 표시)
    const customFilters: RoomFilter[] = this.customPatterns
      .map(p => {
        const type = `custom:${p.id}` as RoomFilterType
        return {
          type,
          enabled: this.activeFilters.has(type),
          label: p.name || '커스텀 패턴',
          description: `${p.sequence.join('')} → ${p.betDirection === 'B' ? '뱅커' : p.betDirection === 'P' ? '플레이어' : p.betDirection === 'T' ? '타이' : p.betDirection === 'skip' ? '스킵' : 'AI'}`,
          isCustom: true,
          patternId: p.id,
          sequence: p.sequence,
          betDirection: p.betDirection || 'ai',
        }
      })

    const strategyFilters: RoomFilter[] = CustomStrategyService.getEnabledStrategies().map(strategy => ({
      type: `strategy:${strategy.id}` as RoomFilterType,
      enabled: this.activeFilters.has(`strategy:${strategy.id}` as RoomFilterType),
      label: strategy.name,
      description: CustomStrategyService.getLabel(`strategy:${strategy.id}`)?.description || strategy.description || '커스텀 전략',
      isStrategy: true,
      strategyId: strategy.id,
    }))

    return [...builtin, ...customFilters, ...strategyFilters]
  }

  getActiveFilters(): RoomFilterType[] {
    return Array.from(this.activeFilters)
  }

  toggleFilter(type: RoomFilterType): void {
    if (this.activeFilters.has(type)) {
      this.activeFilters.delete(type)
    } else {
      this.activeFilters.add(type)
    }
    this.emitFilterChange()
    this.emitAvailableFiltersChange()
  }

  setFilters(types: RoomFilterType[]): void {
    this.activeFilters = new Set(types)
    this.emitFilterChange()
    this.emitAvailableFiltersChange()
  }

  clearFilters(): void {
    this.activeFilters.clear()
    this.emitFilterChange()
    this.emitAvailableFiltersChange()
  }

  getCustomPatterns(): CustomPattern[] {
    return [...this.customPatterns]
  }

  setCustomPatterns(patterns: CustomPattern[]): void {
    this.customPatterns = [...patterns]
    this.cleanupInactiveCustomFilters()
    this.emitAvailableFiltersChange()
  }

  /**
   * Detect the current pattern in room history
   */
  detectPattern(history: Winner[] | RoadResult[]): RoomPattern | null {
    // ✅ EvolutionAdapter에서 이미 newest-first로 반환하므로 reverse 불필요
    // history[0] = 가장 최신 결과
    const winners = toWinnerArray(history)
    if (winners.length < 2) return null

    const recent = winners.slice(0, 10) // Look at last 10 results (most recent first)
    const lastResult = recent[0]

    // Check for alternating pattern (퐁당퐁당)
    const alternatingLength = this.getAlternatingLength(recent)
    if (alternatingLength >= 4) {
      return { type: 'alternating', length: alternatingLength, lastResult }
    }

    // Check for streak pattern (장줄)
    const streakLength = this.getStreakLength(recent)
    if (streakLength >= 4) {
      return { type: 'streak', length: streakLength, lastResult }
    }

    return { type: 'mixed', length: 0, lastResult }
  }

  /**
   * Get length of alternating pattern (P-B-P-B or B-P-B-P)
   * Ties are completely ignored in alternating calculation
   */
  private getAlternatingLength(history: Winner[]): number {
    // Filter out ties first for accurate alternating detection
    const nonTieHistory = history.filter(w => w !== 'T')
    if (nonTieHistory.length < 2) return 0

    let length = 1
    for (let i = 1; i < nonTieHistory.length; i++) {
      // Check if alternating (B-P or P-B)
      if (nonTieHistory[i] !== nonTieHistory[i - 1]) {
        length++
      } else {
        break
      }
    }

    return length
  }

  /**
   * Get length of streak pattern (consecutive same results)
   * Ties are ignored - streak continues through ties
   */
  private getStreakLength(history: Winner[]): number {
    // Filter out ties first for accurate streak detection
    const nonTieHistory = history.filter(w => w !== 'T')
    if (nonTieHistory.length === 0) return 0

    const first = nonTieHistory[0]
    let length = 1

    for (let i = 1; i < nonTieHistory.length; i++) {
      if (nonTieHistory[i] === first) {
        length++
      } else {
        break
      }
    }

    return length
  }

  /**
   * Check if room matches the given filter
   */
  matchesFilter(
    room: Room,
    predictionState: RoomPredictionState | null,
    filterType: RoomFilterType
  ): boolean {
    // ✅ EvolutionAdapter에서 이미 newest-first로 반환하므로 reverse 불필요
    // history[0] = 가장 최신 결과
    const winners = toWinnerArray(room.history)

    if (this.isStrategyFilter(filterType)) {
      return CustomStrategyService.matchesFilter(filterType, winners)
    }

    if (this.isCustomFilter(filterType)) {
      const pattern = this.getCustomPatternByType(filterType)
      if (!pattern) return false
      return this.matchesCustomPattern(winners, pattern)
    }
    
    switch (filterType) {
      case 'losing_streak': {
        // 5-8 consecutive prediction losses
        const losses = predictionState?.stats.consecutiveLosses || 0
        return losses >= 5 && losses <= 8
      }

      case 'alternating':
        // P-B-P-B or B-P-B-P pattern (4+ length)
        return this.getAlternatingLength(winners) >= 4

      case 'long_streak':
        // 4+ consecutive same result
        return this.getStreakLength(winners) >= 4

      case 'short_streak': {
        // 2-3 consecutive same result (but not 4+)
        const streakLen = this.getStreakLength(winners)
        return streakLen >= 2 && streakLen <= 3
      }

      case 'after_tie':
        // Last result is Tie
        return winners.length > 0 && winners[0] === 'T'

      case 'banker_dominant': {
        // Recent 10 games: Banker count > Player count
        const recent10 = winners.slice(0, 10)
        const bankerCount = recent10.filter(w => w === 'B').length
        const playerCount = recent10.filter(w => w === 'P').length
        return bankerCount > playerCount && recent10.length >= 5
      }

      case 'player_dominant': {
        // Recent 10 games: Player count > Banker count
        const recent10 = winners.slice(0, 10)
        const bankerCount = recent10.filter(w => w === 'B').length
        const playerCount = recent10.filter(w => w === 'P').length
        return playerCount > bankerCount && recent10.length >= 5
      }

      case 'winning_streak': {
        // 3+ consecutive prediction wins
        const wins = predictionState?.stats.consecutiveWins || 0
        return wins >= 3
      }

      case 'tie_drought': {
        // history[0] is newest. Find first 'T' index; if not found or >= threshold, match.
        const { tieDroughtThreshold } = FilterThresholdsService.get()
        const idx = winners.findIndex(w => w === 'T')
        const gamesSinceTie = idx < 0 ? winners.length : idx
        return gamesSinceTie >= tieDroughtThreshold
      }

      case 'tie_frequent': {
        const { tieFrequentWindow, tieFrequentStart, tieFrequentMinCount, tieFrequentMaxCount, tieFrequentRequireFullWindow } = FilterThresholdsService.get()
        // history는 newest-first. '정확 모델'(사용자 확인 2026-07-07): 슈 시작(game `start`)부터
        // 현재 최신까지 '전체' 타이 수를 [min,max]로 판정한다 → 타이가 한 번이라도 나오면(창 밖이라도)
        // 그 방은 목록에서 빠지고, 새 슈로 히스토리가 리셋되면 다시 후보가 된다. window는 '진입에
        // 필요한 최소 진행 판수' 게이트:
        //  - requireFullWindow(기본): start+window 판이 다 지나야 판정("1~20판 무타이면 진입").
        //  - false: 슈 시작부터 조기 진입.
        // 참고: '20판 무타이'는 원래 드문 조건이라 매칭 방이 적다(버그 아님) — 방을 더 띄우려면
        //   window를 줄이거나 requireFullWindow를 끈다.
        const windowEnd = tieFrequentStart - 1 + tieFrequentWindow
        if (tieFrequentRequireFullWindow) {
          if (winners.length < windowEnd) return false
        } else if (winners.length < tieFrequentStart - 1) {
          return false
        }
        const chrono = [...winners].reverse()
        const slice = chrono.slice(tieFrequentStart - 1)
        const tieCount = slice.filter(w => w === 'T').length
        return tieCount >= tieFrequentMinCount && tieCount <= tieFrequentMaxCount
      }

      case 'no_tie_room': {
        return winners.length > 0 && !winners.includes('T')
      }

      case 'fresh_room': {
        const { freshRoomGames } = FilterThresholdsService.get()
        return winners.length > 0 && winners.length <= freshRoomGames
      }

      case 'fresh_shoe': {
        const { freshShoeMaxGameNumber } = FilterThresholdsService.get()
        const historyLen = winners.length
        const hasVerifiedShoeChange = typeof predictionState?.shoeChangeDetectedAt === 'number'
        return hasVerifiedShoeChange && historyLen > 0 && historyLen <= freshShoeMaxGameNumber
      }

      default:
        return false
    }
  }

  /**
   * Filter rooms based on active filters
   * If no filters active, all rooms pass
   */
  filterRooms(
    rooms: Room[],
    predictionStates: Map<string, RoomPredictionState>
  ): Room[] {
    if (this.activeFilters.size === 0) {
      return rooms
    }

    return rooms.filter(room => {
      const predState = predictionStates.get(room.id) || null

      // Room passes if it matches ANY of the active filters (OR logic)
      for (const filterType of this.activeFilters) {
        if (this.matchesFilter(room, predState, filterType)) {
          return true
        }
      }

      return false
    })
  }

  /**
   * Get filter match info for a room
   */
  getMatchingFilters(
    room: Room,
    predictionState: RoomPredictionState | null
  ): RoomFilterType[] {
    const matching: RoomFilterType[] = []

    for (const filter of this.getAvailableFilters()) {
      if (this.matchesFilter(room, predictionState, filter.type)) {
        matching.push(filter.type)
      }
    }

    return matching
  }

  onAvailableFiltersChange(callback: (filters: RoomFilter[]) => void): () => void {
    this.availableFilterCallbacks.push(callback)
    return () => {
      this.availableFilterCallbacks = this.availableFilterCallbacks.filter(cb => cb !== callback)
    }
  }

  // Subscription
  onFilterChange(callback: (filters: RoomFilterType[]) => void): () => void {
    this.filterChangeCallbacks.push(callback)
    return () => {
      this.filterChangeCallbacks = this.filterChangeCallbacks.filter(cb => cb !== callback)
    }
  }

  private emitFilterChange(): void {
    const filters = this.getActiveFilters()
    this.filterChangeCallbacks.forEach(cb => cb(filters))
  }

  private emitAvailableFiltersChange(): void {
    const filters = this.getAvailableFilters()
    this.availableFilterCallbacks.forEach(cb => cb(filters))
  }

  private isCustomFilter(type: RoomFilterType): boolean {
    return typeof type === 'string' && type.startsWith('custom:')
  }

  private isStrategyFilter(type: RoomFilterType): boolean {
    return CustomStrategyService.isStrategyFilter(type)
  }

  private getCustomPatternByType(type: RoomFilterType): CustomPattern | null {
    if (!this.isCustomFilter(type)) return null
    const id = (type as string).replace('custom:', '')
    return this.customPatterns.find(p => p.id === id) || null
  }

  /**
   * Match history against a custom pattern.
   * 
   * 사용자 입력 패턴: "PPBB" = 오래된→최신 순서 (시간순)
   * 예: 사용자가 "PPBB"를 입력하면, 최근 4게임이 P→P→B→B 순서인 방을 찾음
   * 
   * history[0] = 최신 결과 (EvolutionAdapter에서 newest-first로 반환)
   * seq = 사용자 입력 순서 (오래된→최신, 시간순)
   * 
   * 매칭 방법:
   * - 패턴 "PPBB"의 마지막 글자 B가 history[0](최신)과 같아야 함
   * - 패턴을 reverse하여 비교: seq.reverse() = [B, B, P, P]
   * - history[0]=B, history[1]=B, history[2]=P, history[3]=P 이면 매칭
   */
  private matchesCustomPattern(history: Winner[], pattern: CustomPattern): boolean {
    const seq = pattern.sequence
    if (!seq || seq.length === 0) return false
    if (history.length < seq.length) return false

    // 패턴을 reverse하여 비교 (사용자 입력은 시간순, history는 최신이 앞)
    const reversedSeq = [...seq].reverse()
    
    for (let i = 0; i < reversedSeq.length; i++) {
      if (history[i] !== reversedSeq[i]) {
        return false
      }
    }
    return true
  }

  private cleanupInactiveCustomFilters(): void {
    // 등록된 모든 패턴의 ID를 유효한 것으로 간주 (enabled 필터링 제거)
    const validIds = new Set(
      this.customPatterns.map(p => `custom:${p.id}` as RoomFilterType)
    )

    let changed = false
    this.activeFilters.forEach((filter) => {
      // 삭제된 커스텀 패턴만 정리 (enabled 상태와 무관)
      if (this.isCustomFilter(filter) && !validIds.has(filter)) {
        this.activeFilters.delete(filter)
        changed = true
      }
    })

    if (changed) {
      this.emitFilterChange()
    }
  }

  private cleanupInactiveStrategyFilters(): void {
    const validIds = new Set(
      CustomStrategyService.getEnabledStrategies().map(strategy => `strategy:${strategy.id}` as RoomFilterType)
    )
    let changed = false
    this.activeFilters.forEach(filter => {
      if (this.isStrategyFilter(filter) && !validIds.has(filter)) {
        this.activeFilters.delete(filter)
        changed = true
      }
    })
    if (changed) this.emitFilterChange()
  }

  // ==================== Lifecycle ====================

  /**
   * 완전한 리소스 해제 (로그아웃 시 호출)
   * 모든 상태와 콜백을 초기화하여 메모리 누수 방지
   */
  dispose(): void {
    console.log('[RoomFilterService] Disposing service...')

    // 1. 콜백 배열 정리
    this.filterChangeCallbacks = []
    this.availableFilterCallbacks = []

    // 2. 상태 초기화
    this.activeFilters.clear()
    this.customPatterns = []

    console.log('[RoomFilterService] Service disposed')
  }

  /**
   * 서비스 재초기화 (로그인 시 호출)
   */
  reinitialize(): void {
    this.customPatterns = CustomPatternService.getPatterns()
  }
}

export const RoomFilterService = new RoomFilterServiceImpl()
export default RoomFilterService
