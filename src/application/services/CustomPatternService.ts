// CustomPatternService - Manage user-defined patterns with localStorage persistence
// Presentation-friendly application service (no React dependency)

import type { CustomPattern, Winner, PatternBetDirection } from '../../domain/entities'

const STORAGE_KEY = 'smart-helper:custom-patterns'

function isStorageAvailable(): boolean {
  if (
    typeof window === 'undefined' ||
    !window.localStorage ||
    typeof window.localStorage.setItem !== 'function'
  ) {
    return false
  }

  try {
    const testKey = '__smart_helper_patterns__'
    window.localStorage.setItem(testKey, '1')
    window.localStorage.removeItem(testKey)
    return true
  } catch (error) {
    console.warn('Local storage unavailable for custom patterns:', error)
    return false
  }
}

function cleanSequence(input: string | Winner[]): Winner[] {
  if (Array.isArray(input)) {
    return input.map(c => (c || '').toString().toUpperCase()).filter((c): c is Winner => c === 'B' || c === 'P' || c === 'T')
  }

  const normalized = input.toUpperCase().replace(/[^BPT]/g, '')
  return normalized.split('') as Winner[]
}

class CustomPatternServiceImpl {
  private patterns: CustomPattern[] = []
  private listeners: Array<(patterns: CustomPattern[]) => void> = []

  constructor() {
    this.patterns = this.loadFromStorage()
  }

  getPatterns(): CustomPattern[] {
    return [...this.patterns]
  }

  addPattern(data: { name: string; sequence: string | Winner[]; enabled?: boolean; description?: string; betDirection?: PatternBetDirection }): CustomPattern {
    const sequence = cleanSequence(data.sequence)
    const now = Date.now()

    const pattern: CustomPattern = {
      id: this.generateId(),
      name: data.name.trim(),
      sequence,
      enabled: data.enabled ?? true,
      description: data.description?.trim(),
      betDirection: data.betDirection ?? 'ai',
      createdAt: now,
      updatedAt: now,
    }

    this.patterns.unshift(pattern)
    this.persist()
    return pattern
  }

  updatePattern(
    id: string,
    updates: Partial<Omit<CustomPattern, 'id' | 'createdAt'>> & { sequence?: string | Winner[] }
  ): CustomPattern | null {
    const index = this.patterns.findIndex(p => p.id === id)
    if (index === -1) return null

    const current = this.patterns[index]
    const sequence = updates.sequence ? cleanSequence(updates.sequence) : current.sequence

    const updated: CustomPattern = {
      ...current,
      ...updates,
      sequence,
      updatedAt: Date.now(),
    }

    this.patterns[index] = updated
    this.persist()
    return updated
  }

  removePattern(id: string): void {
    this.patterns = this.patterns.filter(p => p.id !== id)
    this.persist()
  }

  setEnabled(id: string, enabled: boolean): void {
    const pattern = this.patterns.find(p => p.id === id)
    if (!pattern) return
    pattern.enabled = enabled
    pattern.updatedAt = Date.now()
    this.persist()
  }

  clear(): void {
    this.patterns = []
    this.persist()
  }

  onChange(callback: (patterns: CustomPattern[]) => void): () => void {
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback)
    }
  }

  private loadFromStorage(): CustomPattern[] {
    if (!isStorageAvailable()) return []

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return []

      const parsed = JSON.parse(raw) as Partial<CustomPattern>[]
      return parsed
        .filter(p => p && Array.isArray(p.sequence) && (p.sequence?.length || 0) > 0)
        .map(p => ({
          id: p.id || this.generateId(),
          name: (p.name || 'Custom Pattern').toString(),
          sequence: cleanSequence(p.sequence as Winner[]),
          enabled: p.enabled ?? true,
          description: p.description,
          betDirection: p.betDirection || 'ai',
          createdAt: p.createdAt || Date.now(),
          updatedAt: p.updatedAt,
        }))
    } catch {
      return []
    }
  }

  private persist(): void {
    if (isStorageAvailable()) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.patterns))
      } catch {
        // Ignore storage errors
      }
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.getPatterns()
    this.listeners.forEach(cb => cb(snapshot))
  }

  private generateId(): string {
    return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  // ==================== Lifecycle ====================

  /**
   * 완전한 리소스 해제 (로그아웃 시 호출)
   * 콜백만 정리하고 패턴 데이터는 유지 (localStorage에 저장됨)
   */
  dispose(): void {
    console.log('[CustomPatternService] Disposing service...')

    // 콜백 배열 정리 (메모리 누수 방지)
    this.listeners = []

    // 패턴 데이터는 localStorage에 저장되어 있으므로 메모리만 정리
    // 다음 로그인 시 loadFromStorage()로 다시 로드됨

    console.log('[CustomPatternService] Service disposed')
  }

  /**
   * 서비스 재초기화 (로그인 시 호출 가능)
   */
  reinitialize(): void {
    this.patterns = this.loadFromStorage()
  }
}

export const CustomPatternService = new CustomPatternServiceImpl()
export { cleanSequence }
export default CustomPatternService
