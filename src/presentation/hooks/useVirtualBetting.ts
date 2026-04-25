// useVirtualBetting Hook - Virtual betting state management

import { useState, useEffect, useCallback, useMemo } from 'react'
import type {
  VirtualBettingState,
  VirtualBetSettings,
  VirtualBetState,
  VirtualBetLog,
} from '../../domain/entities'
import VirtualBettingService from '../../application/services/VirtualBettingService'
import {
  formatCurrency as formatCurrencyUtil,
  formatMartingaleLevel,
  getProfitClass as getProfitClassUtil,
} from '../utils/formatters'

export interface UseVirtualBettingResult {
  // State
  enabled: boolean
  settings: VirtualBetSettings
  globalBalance: number
  roomStates: Map<string, VirtualBetState>
  recentLogs: VirtualBetLog[]

  // Extended statistics
  totalBetAmount: number
  totalWinnings: number
  totalNetProfit: number
  totalBetCount: number

  // Pending bet tracking
  pendingBetAmount: number
  pendingBetCount: number

  // Actions
  enable: () => void
  disable: () => void
  toggle: () => void
  updateSettings: (settings: Partial<VirtualBetSettings>) => void
  reset: () => void

  // Utilities
  formatCurrency: (amount: number) => string
  getMartingaleLevelText: (level: number) => string
  getProfitClass: (amount: number) => string

  // Subscriptions
  onBetLog: (callback: (log: VirtualBetLog) => void) => () => void
}

export function useVirtualBetting(): UseVirtualBettingResult {
  const [state, setState] = useState<VirtualBettingState>(
    VirtualBettingService.getState()
  )

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = VirtualBettingService.onStateChange((newState) => {
      setState(newState)
    })
    return unsubscribe
  }, [])

  const enable = useCallback(() => {
    VirtualBettingService.enable()
  }, [])

  const disable = useCallback(() => {
    VirtualBettingService.disable()
  }, [])

  const toggle = useCallback(() => {
    VirtualBettingService.toggle()
  }, [])

  const updateSettings = useCallback((settings: Partial<VirtualBetSettings>) => {
    VirtualBettingService.updateSettings(settings)
  }, [])

  const reset = useCallback(() => {
    VirtualBettingService.reset()
  }, [])

  // Presentation utilities (moved from service to presentation layer)
  const formatCurrency = useCallback((amount: number) => {
    return formatCurrencyUtil(amount)
  }, [])

  const getMartingaleLevelText = useCallback((level: number) => {
    return formatMartingaleLevel(level)
  }, [])

  const getProfitClass = useCallback((amount: number) => {
    return getProfitClassUtil(amount)
  }, [])

  const onBetLog = useCallback((callback: (log: VirtualBetLog) => void) => {
    return VirtualBettingService.onBetLog(callback)
  }, [])

  return useMemo(
    () => ({
      enabled: state.enabled,
      settings: state.settings,
      globalBalance: state.globalBalance,
      roomStates: state.roomStates,
      recentLogs: state.betHistory.slice(-50),
      // Extended statistics
      totalBetAmount: state.totalBetAmount,
      totalWinnings: state.totalWinnings,
      totalNetProfit: state.totalNetProfit,
      totalBetCount: state.totalBetCount,
      // Pending bet tracking
      pendingBetAmount: state.pendingBetAmount,
      pendingBetCount: state.pendingBetCount,
      // Actions
      enable,
      disable,
      toggle,
      updateSettings,
      reset,
      formatCurrency,
      getMartingaleLevelText,
      getProfitClass,
      onBetLog,
    }),
    [
      state.enabled,
      state.settings,
      state.globalBalance,
      state.roomStates,
      state.betHistory,
      state.totalBetAmount,
      state.totalWinnings,
      state.totalNetProfit,
      state.totalBetCount,
      state.pendingBetAmount,
      state.pendingBetCount,
      enable,
      disable,
      toggle,
      updateSettings,
      reset,
      formatCurrency,
      getMartingaleLevelText,
      getProfitClass,
      onBetLog,
    ]
  )
}

export default useVirtualBetting
