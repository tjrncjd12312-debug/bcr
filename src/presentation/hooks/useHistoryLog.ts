// useHistoryLog - 히스토리 로그 관리 훅
// Clean Architecture: Presentation Layer
// SemiAutoPanel과 AutoModePanel에서 중복되던 로그 관리 로직 통합

import { useState, useCallback, useRef } from 'react'

/**
 * 기본 히스토리 로그 인터페이스
 */
export interface BaseHistoryLog {
  id: number
  time: string
  message: string
  type: string
}

/**
 * SemiAutoPanel용 히스토리 로그
 */
export interface SemiAutoHistoryLog extends BaseHistoryLog {
  type: 'prediction' | 'win' | 'loss' | 'move' | 'info'
}

/**
 * AutoModePanel용 히스토리 로그
 */
export interface AutoModeHistoryLog extends BaseHistoryLog {
  roomName: string
  type: 'prediction' | 'bet' | 'win' | 'loss' | 'move' | 'info' | 'error' | 'skip'
  betAmount?: number
  profit?: number
  cumulativeProfit?: number
}

interface UseHistoryLogOptions {
  /** 최대 로그 개수 (기본: 50) */
  maxLogs?: number
}

interface UseHistoryLogReturn<T extends BaseHistoryLog> {
  /** 현재 로그 목록 */
  logs: T[]
  /** 로그 추가 */
  addLog: (message: string, type: T['type'], extra?: Omit<T, 'id' | 'time' | 'message' | 'type'>) => void
  /** 모든 로그 삭제 */
  clearLogs: () => void
}

/**
 * 히스토리 로그 관리 훅
 *
 * @example
 * // SemiAutoPanel
 * const { logs, addLog } = useHistoryLog<SemiAutoHistoryLog>()
 * addLog('예측: 뱅커', 'prediction')
 *
 * @example
 * // AutoModePanel
 * const { logs, addLog } = useHistoryLog<AutoModeHistoryLog>()
 * addLog('베팅 완료', 'bet', { roomName: '바카라 A', betAmount: 10000 })
 */
export function useHistoryLog<T extends BaseHistoryLog = BaseHistoryLog>(
  options: UseHistoryLogOptions = {}
): UseHistoryLogReturn<T> {
  const { maxLogs = 50 } = options
  const [logs, setLogs] = useState<T[]>([])
  const idRef = useRef(0)

  const addLog = useCallback((
    message: string,
    type: T['type'],
    extra?: Omit<T, 'id' | 'time' | 'message' | 'type'>
  ) => {
    const now = new Date()
    const time = now.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

    setLogs(prev => {
      const newLog = {
        id: ++idRef.current,
        time,
        message,
        type,
        ...extra,
      } as T

      return [newLog, ...prev].slice(0, maxLogs)
    })
  }, [maxLogs])

  const clearLogs = useCallback(() => {
    setLogs([])
    idRef.current = 0
  }, [])

  return { logs, addLog, clearLogs }
}

export default useHistoryLog
