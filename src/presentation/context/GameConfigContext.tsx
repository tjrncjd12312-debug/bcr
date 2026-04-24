import { createContext, useContext, ReactNode } from 'react'
import type {
    Room,
    RoomPredictionState,
    RoomFilterType,
    RoomFilter,
    VirtualBetSettings,
    CustomPattern,
    AppMode,
    RoomSortType,
    SortDirection,
    PatternBetDirection
} from '../../domain/entities'

// UI용 패턴 데이터 타입 (sequence가 문자열)
export interface PatternFormData {
    name: string
    sequence: string
    enabled: boolean
    description?: string
    betDirection?: PatternBetDirection
}

// 기본 가상배팅 설정 (초기값)
export const DEFAULT_VIRTUAL_SETTINGS: VirtualBetSettings = {
    initialBalance: 1000000,
    martingale: {
        enabled: true,
        baseAmount: 10000,
        maxLevel: 5,
        resetOnWin: true
    }
}

export interface GameConfigContextType {
    // User/Session
    user: { username: string; siteUrl: string } | null

    // App Mode (auto betting vs prediction only)
    appMode: AppMode

    // Real Betting Config
    realBettingEnabled: boolean
    toggleRealBetting: () => void

    // Virtual Betting Config
    virtualBettingEnabled: boolean
    toggleVirtualBetting: () => void
    virtualSettings: VirtualBetSettings
    updateVirtualSettings: (settings: Partial<VirtualBetSettings>) => void
    resetVirtualBetting: () => void

    // Stats Control
    clearLogs: () => void
    resetStats: () => void

    // UI Control
    semiAutoMode: boolean
    toggleSemiAuto: () => void
    sortType: RoomSortType
    setSortType: (type: RoomSortType) => void
    sortDirection: SortDirection
    toggleSortDirection: () => void

    // Filters & Patterns
    availableFilters: RoomFilter[]
    activeFilters: RoomFilterType[]
    toggleFilter: (type: RoomFilterType) => void
    clearFilters: () => void
    selectedPattern: RoomFilterType | 'all'
    setPattern: (pattern: RoomFilterType | 'all') => void
    customPatterns: CustomPattern[]
    matchesFilter: (room: Room, state: RoomPredictionState | null, type: RoomFilterType) => boolean
    patternManager: {
        add: (data: PatternFormData) => void
        update: (id: string, data: PatternFormData) => void
        remove: (id: string) => void
        toggle: (id: string, enabled: boolean) => void
    }

    // Utilities
    formatCurrency: (amount: number) => string
}

export const GameConfigContext = createContext<GameConfigContextType | null>(null)

export function useGameConfig() {
    const context = useContext(GameConfigContext)
    if (!context) throw new Error('useGameConfig must be used within a GameConfigProvider')
    return context
}

export interface GameConfigProviderProps {
    children: ReactNode
    value: GameConfigContextType
}

export function GameConfigProvider({ children, value }: GameConfigProviderProps) {
    return <GameConfigContext.Provider value={value}>{children}</GameConfigContext.Provider>
}
