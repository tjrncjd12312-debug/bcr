// useRoomFilters Hook - Room filtering state management

import { useState, useEffect, useCallback } from 'react'
import type { RoomFilterType, RoomFilter, Room, RoomPredictionState } from '../../domain/entities'
import RoomFilterService from '../../application/services/RoomFilterService'

export interface UseRoomFiltersResult {
  // State
  availableFilters: RoomFilter[]
  activeFilters: RoomFilterType[]

  // Actions
  toggleFilter: (type: RoomFilterType) => void
  setFilters: (types: RoomFilterType[]) => void
  clearFilters: () => void

  // Utilities
  filterRooms: (rooms: Room[], predictionStates: Map<string, RoomPredictionState>) => Room[]
  getMatchingFilters: (room: Room, predictionState: RoomPredictionState | null) => RoomFilterType[]
  matchesFilter: (room: Room, predictionState: RoomPredictionState | null, filterType: RoomFilterType) => boolean
}

export function useRoomFilters(): UseRoomFiltersResult {
  const [activeFilters, setActiveFilters] = useState<RoomFilterType[]>(
    RoomFilterService.getActiveFilters()
  )
  const [availableFilters, setAvailableFilters] = useState<RoomFilter[]>(
    RoomFilterService.getAvailableFilters()
  )

  // Subscribe to filter changes
  useEffect(() => {
    console.log('[useRoomFilters] subscribing to RoomFilterService')

    // 강제로 CustomPatternService에서 패턴을 다시 가져와서 동기화
    RoomFilterService.refreshFromCustomPatterns()

    // 구독 후 최신 상태로 즉시 업데이트
    const latestFilters = RoomFilterService.getAvailableFilters()
    console.log('[useRoomFilters] initial available filters:', latestFilters.length)
    setAvailableFilters(latestFilters)

    const unsubscribeFilter = RoomFilterService.onFilterChange((filters) => {
      console.log('[useRoomFilters] received filter change:', filters.length)
      setActiveFilters(filters)
    })
    const unsubscribeAvailable = RoomFilterService.onAvailableFiltersChange((filters) => {
      console.log('[useRoomFilters] received available filters change:', filters.length)
      setAvailableFilters(filters)
    })
    return () => {
      unsubscribeFilter()
      unsubscribeAvailable()
    }
  }, [])

  const toggleFilter = useCallback((type: RoomFilterType) => {
    RoomFilterService.toggleFilter(type)
  }, [])

  const setFilters = useCallback((types: RoomFilterType[]) => {
    RoomFilterService.setFilters(types)
  }, [])

  const clearFilters = useCallback(() => {
    RoomFilterService.clearFilters()
  }, [])

  const filterRooms = useCallback((rooms: Room[], predictionStates: Map<string, RoomPredictionState>) => {
    return RoomFilterService.filterRooms(rooms, predictionStates)
  }, [])

  const getMatchingFilters = useCallback((room: Room, predictionState: RoomPredictionState | null) => {
    return RoomFilterService.getMatchingFilters(room, predictionState)
  }, [])

  const matchesFilter = useCallback((room: Room, predictionState: RoomPredictionState | null, filterType: RoomFilterType) => {
    return RoomFilterService.matchesFilter(room, predictionState, filterType)
  }, [])

  return {
    availableFilters,
    activeFilters,
    toggleFilter,
    setFilters,
    clearFilters,
    filterRooms,
    getMatchingFilters,
    matchesFilter,
  }
}

export default useRoomFilters
