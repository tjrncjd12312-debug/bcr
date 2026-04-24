import { createContext, useContext, ReactNode } from 'react'
import type { Room, RoomPredictionState } from '../../domain/entities'

export interface GameDataContextType {
    // Casino State
    status: string
    provider: string | null
    rooms: Map<string, Room>
    roomDataVersion: number  // 방 데이터 업데이트 시마다 증가 (실시간 패턴 업데이트 트리거용)
    roomsReady: boolean  // 멀티소켓 방 구독 완료 여부 (AutoMode에서 사용)
    selectedRoom: Room | null
    shoeChanges: Map<string, number>
    realBalance: number | null
    casinoUrl: string
    evolutionBaseUrl: string | null
    messageCount: number
    openCasino: (url: string) => Promise<void>
    reconnectLobby: () => Promise<void>
    selectRoom: (room: Room) => void
    enterRoom: (roomId: string) => Promise<void>

    // Prediction & Room States
    roomStates: Map<string, RoomPredictionState>
    flashingRooms: Set<string>
    lastResults: Map<string, boolean>
    roomTimers: Map<string, number>
    bettingTimer: number
    resultOverlay: any
    gameResultVersion: number  // 게임 결과마다 증가 (실시간 패턴 업데이트 트리거용)

    // Real Betting Action
    placeBet: (roomId: string, betType: string, amount: number) => Promise<void>

    // Virtual Betting Data
    globalBalance: number
    virtualBetStates: Map<string, any>
    totalNetProfit: number
    totalBetAmount: number
    totalBetCount: number
    pendingBetAmount: number
    pendingBetCount: number

    // Stats Data
    globalStats: any
    logs: any[]
    chartData: any[]

    // Derived Data
    patternCounts: Record<string, number>
}

export const GameDataContext = createContext<GameDataContextType | null>(null)

export function useGameData() {
    const context = useContext(GameDataContext)
    if (!context) throw new Error('useGameData must be used within a GameDataProvider')
    return context
}

export interface GameDataProviderProps {
    children: ReactNode
    value: GameDataContextType
}

export function GameDataProvider({ children, value }: GameDataProviderProps) {
    return <GameDataContext.Provider value={value}>{children}</GameDataContext.Provider>
}
