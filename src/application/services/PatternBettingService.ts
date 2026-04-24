// PatternBettingService - Unified pattern betting configuration
// Manages betting direction for both built-in and custom patterns

import type {
  RoomFilterType,
  PatternBetDirection,
  PatternBetConfig
} from '../../domain/entities'
import { DEFAULT_PATTERN_CONFIGS } from '../../domain/entities'
import CustomPatternService from './CustomPatternService'

const STORAGE_KEY = 'bcr-pattern-betting-configs'

// Built-in pattern types that need betting config
const BUILTIN_PATTERN_TYPES: RoomFilterType[] = [
  'alternating',
  'long_streak',
  'short_streak',
  'after_tie',
  'banker_dominant',
  'player_dominant',
  'winning_streak',
  'losing_streak',
]

class PatternBettingServiceImpl {
  private builtinConfigs: Map<RoomFilterType, PatternBetConfig> = new Map()
  private listeners: Array<() => void> = []

  constructor() {
    this.loadFromStorage()
  }

  /**
   * Get betting direction for any pattern (built-in or custom)
   */
  getBetDirection(patternType: RoomFilterType): PatternBetDirection {
    // Check if it's a custom pattern
    if (this.isCustomPattern(patternType)) {
      const customPattern = this.getCustomPatternById(patternType)
      const result = customPattern?.betDirection || 'ai'
      console.log(`[PatternBettingService] getBetDirection(${patternType}): custom pattern -> ${result}`)
      return result
    }

    // Built-in pattern
    const config = this.builtinConfigs.get(patternType)
    const result = config?.betDirection || 'ai'
    console.log(`[PatternBettingService] getBetDirection(${patternType}): builtin -> ${result}, config:`, config)
    return result
  }

  /**
   * Check if pattern is enabled for betting
   */
  isPatternEnabled(patternType: RoomFilterType): boolean {
    if (this.isCustomPattern(patternType)) {
      const customPattern = this.getCustomPatternById(patternType)
      return customPattern?.enabled ?? true
    }

    const config = this.builtinConfigs.get(patternType)
    return config?.enabled ?? true
  }

  /**
   * Get full config for built-in pattern
   */
  getBuiltinConfig(patternType: RoomFilterType): PatternBetConfig {
    const config = this.builtinConfigs.get(patternType)
    if (config) return { ...config }

    // Return default
    const defaultConfig = DEFAULT_PATTERN_CONFIGS.find(c => c.patternType === patternType)
    return defaultConfig || {
      patternType,
      betDirection: 'ai',
      includeTie: false,
      enabled: true,
    }
  }

  /**
   * Get all built-in pattern configs
   */
  getAllBuiltinConfigs(): PatternBetConfig[] {
    return BUILTIN_PATTERN_TYPES.map(type => this.getBuiltinConfig(type))
  }

  /**
   * Update betting direction for built-in pattern
   */
  updateBuiltinConfig(patternType: RoomFilterType, updates: Partial<PatternBetConfig>): void {
    const current = this.getBuiltinConfig(patternType)
    this.builtinConfigs.set(patternType, { ...current, ...updates })
    this.persist()
    this.emit()
  }

  /**
   * Update betting direction for custom pattern
   */
  updateCustomPatternBetDirection(patternId: string, betDirection: PatternBetDirection): void {
    CustomPatternService.updatePattern(patternId, { betDirection })
  }

  /**
   * Set betting direction for any pattern
   */
  setBetDirection(patternType: RoomFilterType, betDirection: PatternBetDirection): void {
    console.log(`[PatternBettingService] setBetDirection called: ${patternType} -> ${betDirection}`)
    if (this.isCustomPattern(patternType)) {
      const patternId = this.getCustomPatternId(patternType)
      if (patternId) {
        this.updateCustomPatternBetDirection(patternId, betDirection)
      }
    } else {
      this.updateBuiltinConfig(patternType, { betDirection })
    }
    // 설정 후 확인
    const saved = this.getBetDirection(patternType)
    console.log(`[PatternBettingService] after setBetDirection: ${patternType} = ${saved}`)
  }

  /**
   * Subscribe to config changes
   */
  onChange(callback: () => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  // ==================== Private Helpers ====================

  private isCustomPattern(type: RoomFilterType): boolean {
    return typeof type === 'string' && type.startsWith('custom:')
  }

  private getCustomPatternId(type: RoomFilterType): string | null {
    if (!this.isCustomPattern(type)) return null
    return (type as string).replace('custom:', '')
  }

  private getCustomPatternById(type: RoomFilterType) {
    const id = this.getCustomPatternId(type)
    if (!id) return null
    return CustomPatternService.getPatterns().find(p => p.id === id)
  }

  private loadFromStorage(): void {
    // Initialize with defaults
    DEFAULT_PATTERN_CONFIGS.forEach(config => {
      this.builtinConfigs.set(config.patternType, { ...config })
    })

    // Load from localStorage
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as PatternBetConfig[]
        parsed.forEach(config => {
          if (config.patternType && !this.isCustomPattern(config.patternType)) {
            this.builtinConfigs.set(config.patternType, config)
          }
        })
      }
    } catch (e) {
      console.warn('[PatternBettingService] Failed to load from storage:', e)
    }
  }

  private persist(): void {
    try {
      const configs = Array.from(this.builtinConfigs.values())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(configs))
    } catch (e) {
      console.warn('[PatternBettingService] Failed to save to storage:', e)
    }
  }

  private emit(): void {
    this.listeners.forEach(cb => cb())
  }

  // ==================== Lifecycle ====================

  /**
   * 완전한 리소스 해제 (로그아웃 시 호출)
   * 모든 상태와 콜백을 초기화하여 메모리 누수 방지
   */
  dispose(): void {
    console.log('[PatternBettingService] Disposing service...')

    // 1. 콜백 배열 정리
    this.listeners = []

    // 2. 설정을 기본값으로 초기화
    this.builtinConfigs.clear()
    DEFAULT_PATTERN_CONFIGS.forEach(config => {
      this.builtinConfigs.set(config.patternType, { ...config })
    })

    console.log('[PatternBettingService] Service disposed')
  }
}

export const PatternBettingService = new PatternBettingServiceImpl()
export default PatternBettingService
