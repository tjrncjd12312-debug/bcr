import type { RoomFilterType } from '../../domain/entities'
import {
  CUSTOM_STRATEGY_SCHEMA_VERSION,
  createDefaultCustomStrategy,
  describeCustomStrategy,
  evaluateEntryFilter,
  type CustomStrategyDefinitionV1,
  type CustomStrategyFilterType,
  validateCustomStrategy,
} from '../../domain/strategies/customStrategy'

const STORAGE_KEY = 'smart-helper:custom-strategies:v1'

function cloneStrategy(strategy: CustomStrategyDefinitionV1): CustomStrategyDefinitionV1 {
  return JSON.parse(JSON.stringify(strategy)) as CustomStrategyDefinitionV1
}

export class CustomStrategyServiceImpl {
  private strategies: CustomStrategyDefinitionV1[] = []
  private listeners: Array<(strategies: CustomStrategyDefinitionV1[]) => void> = []

  constructor() {
    this.strategies = this.load()
  }

  getStrategies(): CustomStrategyDefinitionV1[] {
    return this.strategies.map(cloneStrategy)
  }

  getEnabledStrategies(): CustomStrategyDefinitionV1[] {
    return this.getStrategies().filter(strategy => strategy.enabled)
  }

  getById(id: string): CustomStrategyDefinitionV1 | null {
    const found = this.strategies.find(strategy => strategy.id === id)
    return found ? cloneStrategy(found) : null
  }

  getByFilterType(filterType: RoomFilterType | string): CustomStrategyDefinitionV1 | null {
    if (!this.isStrategyFilter(filterType)) return null
    return this.getById(filterType.slice('strategy:'.length))
  }

  add(input: Omit<CustomStrategyDefinitionV1, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'> & { id?: string }): CustomStrategyDefinitionV1 {
    const now = Date.now()
    const strategy: CustomStrategyDefinitionV1 = {
      ...cloneStrategy(input as CustomStrategyDefinitionV1),
      schemaVersion: CUSTOM_STRATEGY_SCHEMA_VERSION,
      id: input.id?.trim() || this.generateId(),
      createdAt: now,
      updatedAt: now,
    }
    const validation = validateCustomStrategy(strategy)
    if (!validation.valid) throw new Error(validation.errors.join('\n'))
    if (this.strategies.some(current => current.id === strategy.id)) {
      strategy.id = this.generateId()
    }
    this.strategies.unshift(strategy)
    this.persist()
    return cloneStrategy(strategy)
  }

  update(id: string, updates: Partial<CustomStrategyDefinitionV1>): CustomStrategyDefinitionV1 {
    const index = this.strategies.findIndex(strategy => strategy.id === id)
    if (index < 0) throw new Error('수정할 커스텀 전략을 찾을 수 없습니다.')
    const current = this.strategies[index]
    const next: CustomStrategyDefinitionV1 = {
      ...current,
      ...cloneStrategy(updates as CustomStrategyDefinitionV1),
      schemaVersion: CUSTOM_STRATEGY_SCHEMA_VERSION,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }
    const validation = validateCustomStrategy(next)
    if (!validation.valid) throw new Error(validation.errors.join('\n'))
    this.strategies[index] = next
    this.persist()
    return cloneStrategy(next)
  }

  duplicate(id: string): CustomStrategyDefinitionV1 {
    const source = this.getById(id)
    if (!source) throw new Error('복제할 커스텀 전략을 찾을 수 없습니다.')
    return this.add({
      ...source,
      id: undefined,
      name: `${source.name} 복사본`,
      enabled: true,
    })
  }

  createNew(): CustomStrategyDefinitionV1 {
    const template = createDefaultCustomStrategy()
    return this.add({
      ...template,
      id: undefined,
      name: '새 커스텀 전략',
      description: '',
    })
  }

  remove(id: string): void {
    const next = this.strategies.filter(strategy => strategy.id !== id)
    if (next.length === this.strategies.length) return
    this.strategies = next
    this.persist()
  }

  setEnabled(id: string, enabled: boolean): void {
    this.update(id, { enabled })
  }

  matchesFilter(filterType: RoomFilterType | string, history: Parameters<typeof evaluateEntryFilter>[0]): boolean {
    const strategy = this.getByFilterType(filterType)
    if (!strategy || !strategy.enabled) return false
    const validation = validateCustomStrategy(strategy)
    if (!validation.valid) return false
    return evaluateEntryFilter(history, strategy).matched
  }

  getLabel(filterType: RoomFilterType | string): { label: string; description: string } | null {
    const strategy = this.getByFilterType(filterType)
    if (!strategy) return null
    return { label: strategy.name, description: describeCustomStrategy(strategy) }
  }

  onChange(callback: (strategies: CustomStrategyDefinitionV1[]) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(listener => listener !== callback)
    }
  }

  reinitialize(): void {
    this.strategies = this.load()
    this.emit()
  }

  resetToDefault(): void {
    this.strategies = [createDefaultCustomStrategy()]
    this.persist()
  }

  isStrategyFilter(filterType: RoomFilterType | string): filterType is CustomStrategyFilterType {
    return typeof filterType === 'string' && filterType.startsWith('strategy:')
  }

  private load(): CustomStrategyDefinitionV1[] {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return [createDefaultCustomStrategy()]
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return [createDefaultCustomStrategy()]
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return [createDefaultCustomStrategy()]
      const valid = parsed.filter((strategy): strategy is CustomStrategyDefinitionV1 => {
        return strategy?.schemaVersion === CUSTOM_STRATEGY_SCHEMA_VERSION && validateCustomStrategy(strategy).valid
      })
      return valid.length > 0 ? valid.map(cloneStrategy) : [createDefaultCustomStrategy()]
    } catch {
      return [createDefaultCustomStrategy()]
    }
  }

  private persist(): void {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.strategies))
      } catch (error) {
        throw new Error(`커스텀 전략 저장에 실패했습니다: ${error instanceof Error ? error.message : '저장소 오류'}`)
      }
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.getStrategies()
    this.listeners.slice().forEach(listener => listener(snapshot))
  }

  private generateId(): string {
    return `strategy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
}

export const CustomStrategyService = new CustomStrategyServiceImpl()
export default CustomStrategyService
