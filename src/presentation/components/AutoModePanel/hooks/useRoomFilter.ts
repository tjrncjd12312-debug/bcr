import { useMemo } from 'react'
import type { Room, RoomPredictionState, RoomFilterType, RoomSortType, SortDirection } from '../../../../domain/entities'
import type { RoomBettingState } from '../../../../application/services/AutoModeService'

interface UseRoomFilterProps {
    rooms: Room[]
    roomStates: Map<string, RoomPredictionState>
    bettingStates: Map<string, RoomBettingState>
    enabledRoomIds?: Set<string>
    selectedPattern: RoomFilterType | 'all'
    matchesFilter?: (room: Room, state: RoomPredictionState | null, pattern: RoomFilterType) => boolean
    sortType: RoomSortType
    sortDirection: SortDirection
    roomDataVersion: number
}

export const useRoomFilter = ({
    rooms,
    roomStates,
    bettingStates,
    enabledRoomIds,
    selectedPattern,
    matchesFilter,
    sortType,
    sortDirection,
    roomDataVersion
}: UseRoomFilterProps) => {
    return useMemo(() => {
        // 1. Basic Filtering (Baccarat only, excluding special ones)
        let roomList = rooms.filter(room => {
            const name = (room.koreanName || room.name || '').toLowerCase()
            if (name.includes('salon') || name.includes('lightning')) return false
            if (!name.includes('baccarat') && !name.includes('바카라')) return false
            return true
        })

        // 2. User Selection Filtering
        if (enabledRoomIds && enabledRoomIds.size > 0) {
            roomList = roomList.filter(room => enabledRoomIds.has(room.id))
        }

        // 3. Pattern Filtering
        if (selectedPattern !== 'all' && matchesFilter) {
            roomList = roomList.filter(room => {
                const state = roomStates.get(room.id) || null
                return matchesFilter(room, state, selectedPattern as RoomFilterType)
            })
        }

        // 4. Sorting Helpers
        const getMartin = (roomId: string) => bettingStates.get(roomId)?.martinLevel || 0
        const getWinRate = (roomId: string) => roomStates.get(roomId)?.stats?.winRate || 0
        const getProfit = (roomId: string) => bettingStates.get(roomId)?.totalProfit || 0
        const getStreak = (roomId: string) => {
            const state = roomStates.get(roomId)
            if (!state?.stats) return 0
            return Math.max(state.stats.consecutiveWins || 0, state.stats.consecutiveLosses || 0)
        }
        const getBankerDominance = (room: Room) => {
            const recent = room.history.slice(0, 10)
            const bCount = recent.filter(r => r.winner === 'B').length
            const pCount = recent.filter(r => r.winner === 'P').length
            return bCount - pCount
        }
        const isBetting = (roomId: string) => bettingStates.get(roomId)?.waitingForResult ? 1 : 0

        const dir = sortDirection === 'asc' ? 1 : -1

        // 5. Apply Sorting
        switch (sortType) {
            case 'name':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (a.koreanName || a.name).localeCompare(b.koreanName || b.name, 'ko')
                })
                break
            case 'games':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (b.history.length - a.history.length)
                })
                break
            case 'martin':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (getMartin(b.id) - getMartin(a.id))
                })
                break
            case 'winRate':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (getWinRate(b.id) - getWinRate(a.id))
                })
                break
            case 'streak':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (getStreak(b.id) - getStreak(a.id))
                })
                break
            case 'recent':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * ((b.lastResultTime || 0) - (a.lastResultTime || 0))
                })
                break
            case 'bankerDominant':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (getBankerDominance(b) - getBankerDominance(a))
                })
                break
            case 'playerDominant':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (getBankerDominance(a) - getBankerDominance(b))
                })
                break
            case 'profit':
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    return dir * (getProfit(b.id) - getProfit(a.id))
                })
                break
            default:
                // Default: Martin desc, then history length desc
                roomList.sort((a, b) => {
                    const bettingDiff = isBetting(b.id) - isBetting(a.id)
                    if (bettingDiff !== 0) return bettingDiff
                    const martinA = getMartin(a.id)
                    const martinB = getMartin(b.id)
                    if (martinA !== martinB) return dir * (martinB - martinA)
                    return dir * (b.history.length - a.history.length)
                })
        }

        return roomList
    }, [rooms, roomStates, bettingStates, enabledRoomIds, selectedPattern, matchesFilter, sortType, sortDirection, roomDataVersion])
}
