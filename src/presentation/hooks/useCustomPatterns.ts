// useCustomPatterns - Manage custom pattern list with localStorage persistence

import { useCallback, useEffect, useState } from 'react'
import type { CustomPattern, Winner, PatternBetDirection } from '../../domain/entities'
import CustomPatternService, { cleanSequence } from '../../application/services/CustomPatternService'

export interface CustomPatternInput {
  name: string
  sequence: string | Winner[]
  enabled?: boolean
  description?: string
  betDirection?: PatternBetDirection
}

export function useCustomPatterns() {
  const [patterns, setPatterns] = useState<CustomPattern[]>(() => CustomPatternService.getPatterns())

  useEffect(() => {
    // 마운트 시 최신 패턴으로 동기화
    const latest = CustomPatternService.getPatterns()
    if (latest.length !== patterns.length) {
      setPatterns(latest)
    }
    
    const unsubscribe = CustomPatternService.onChange(setPatterns)
    return unsubscribe
  }, [])

  const addPattern = useCallback((data: CustomPatternInput) => {
    return CustomPatternService.addPattern(data)
  }, [])

  const updatePattern = useCallback((id: string, updates: Partial<CustomPatternInput>) => {
    return CustomPatternService.updatePattern(id, updates as any)
  }, [])

  const removePattern = useCallback((id: string) => {
    CustomPatternService.removePattern(id)
  }, [])

  const togglePattern = useCallback((id: string, enabled: boolean) => {
    CustomPatternService.setEnabled(id, enabled)
  }, [])

  const clearPatterns = useCallback(() => {
    CustomPatternService.clear()
  }, [])

  return {
    patterns,
    addPattern,
    updatePattern,
    removePattern,
    togglePattern,
    clearPatterns,
    normalizeSequence: cleanSequence,
  }
}

export default useCustomPatterns
