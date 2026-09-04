// useManualBet — 수동(반자동) 칩 배팅 훅. ManualBetService 상태 구독 + 액션.
import { useCallback, useEffect, useState } from 'react'
import ManualBetService, { type ManualBetState, type ManualSide, type ManualBetLog } from '../../application/services/ManualBetService'
import type { Room } from '../../domain/entities'

export function useManualBet() {
  const [state, setState] = useState<ManualBetState>(() => ManualBetService.getState())
  useEffect(() => ManualBetService.onStateChange(setState), [])

  const setChip = useCallback((amount: number) => ManualBetService.setChip(amount), [])
  const addChip = useCallback((room: Room, side: ManualSide) => ManualBetService.addChip(room, side), [])
  const undoChip = useCallback((room: Room) => ManualBetService.undoChip(room), [])
  const clearRoom = useCallback((room: Room) => ManualBetService.clearRoom(room), [])
  const undoLast = useCallback(() => ManualBetService.undoLast(), [])
  const setFollowMartin = useCallback((on: boolean) => ManualBetService.setFollowMartin(on), [])
  const setChipPresets = useCallback((p: number[]) => ManualBetService.setChipPresets(p), [])
  const setRecommendConfidence = useCallback((v: number) => ManualBetService.setRecommendConfidence(v), [])
  const clearAll = useCallback(() => ManualBetService.clearAll(), [])
  const onLog = useCallback((cb: (l: ManualBetLog) => void) => ManualBetService.onLog(cb), [])
  const resetStats = useCallback(() => ManualBetService.resetStats(), [])

  return { ...state, setChip, addChip, undoChip, clearRoom, undoLast, clearAll, setFollowMartin, setChipPresets, setRecommendConfidence, onLog, resetStats }
}

export default useManualBet
