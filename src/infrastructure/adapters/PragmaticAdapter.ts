// Pragmatic Play Casino Adapter (Frontend)
// Clean Architecture: Infrastructure Layer
//
// Features:
// - Listens to Rust backend events (pragmatic_event)
// - Invokes Tauri commands for connection
// - Updates local state based on normalized events

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
    ICasinoAdapter,
    CasinoConfig,
    ParsedMessage,
} from '../../domain/interfaces'
import type {
    Room,
    RoadResult,
    GameResultEvent,
    BettingPhaseEvent,
    Winner,
} from '../../domain/entities'

// ==================== Types ====================
type RoomUpdateCallback = (rooms: Room[]) => void
type GameResultCallback = (event: GameResultEvent) => void
type BettingPhaseCallback = (event: BettingPhaseEvent) => void
type HistoryUpdateCallback = (roomId: string, history: RoadResult[]) => void

const PRAGMATIC_BETTING_SECONDS = 15

// Rust Event Types (Normalized)
type RustCasinoEvent =
    | { type: 'room_update'; data: NormalizedRoom[] }
    | { type: 'game_result'; data: NormalizedGameResult }
    | { type: 'betting_phase'; data: NormalizedBettingPhase }
    | { type: 'balance_update'; data: NormalizedBalanceUpdate }

interface NormalizedRoom {
    id: string
    name: string
    history: NormalizedRoadResult[]
    status: string
}

interface NormalizedRoadResult {
    winner: Winner
    is_player_pair?: boolean
    is_banker_pair?: boolean
}

interface NormalizedGameResult {
    room_id: string
    winner: Winner
    player_score?: number | null
    banker_score?: number | null
    is_player_pair?: boolean
    is_banker_pair?: boolean
    table_name?: string | null
    table_type?: string | null
}

interface NormalizedBettingPhase {
    room_id: string
    remaining_seconds: number
}

interface NormalizedBalanceUpdate {
    balance: number
    currency: string
}

// Pragmatic room name mapping (fallback: "프라그마틱 {id}")
const PRAGMATIC_ROOM_LABELS: Record<string, string> = {
    // 예시: '413': '프라그마틱 413',
}

function getPragmaticRoomName(roomId: string, incomingName?: string | null): string {
    const cleanName = incomingName?.trim()
    // 일부 소켓이 '-' 같은 플레이스홀더를 보낼 수 있어 무시
    const isPlaceholder = cleanName === '-' || cleanName === '' || cleanName?.toUpperCase() === 'N/A'

    if (cleanName && !isPlaceholder) return cleanName
    if (roomId in PRAGMATIC_ROOM_LABELS) return PRAGMATIC_ROOM_LABELS[roomId]

    // roomId에서 숫자를 추출해 간단한 표시명 생성
    const digits = roomId.replace(/\D+/g, '')
    if (digits) return `Baccarat ${digits}`

    return `프라그마틱 ${roomId}`
}

export class PragmaticAdapterImpl implements ICasinoAdapter {
    readonly name = 'Pragmatic Play'
    readonly type = 'pragmatic' as const
    readonly supportsRealBetting = true

    private connected = false

    // State
    private rooms: Map<string, Room> = new Map()
    private requestedRooms: Set<string> = new Set()

    // Callbacks
    private roomUpdateCallbacks: RoomUpdateCallback[] = []
    private gameResultCallbacks: GameResultCallback[] = []
    private bettingPhaseCallbacks: BettingPhaseCallback[] = []
    private historyUpdateCallbacks: HistoryUpdateCallback[] = []
    private balanceUpdateCallbacks: ((balance: number) => void)[] = []
    private shoeChangeCallbacks: ((roomId: string, roomName: string) => void)[] = []
    private lastHistoryLengthPerRoom: Map<string, number> = new Map()

    // Unsubscribe function for global event listener
    private unlistenValues: Array<() => void> = []

    constructor() {
        this.setupListeners()
    }

    private async setupListeners() {
        // 1. Normalized Events
        const unlistenEvent = await listen<RustCasinoEvent>('pragmatic_event', (event) => {
            this.handleRustEvent(event.payload)
        })
        this.unlistenValues.push(unlistenEvent)

        // 2. Raw Messages (for debugging or custom parsing if needed)
        const unlistenRaw = await listen<{ roomId?: string, message: string }>('pragmatic_raw_message', (event) => {
            const payload = event.payload as any
            const roomId = typeof payload === 'object' && payload !== null ? (payload.roomId || payload.url || 'unknown') : 'unknown'
            const message = typeof payload === 'string' ? payload : payload?.message
            if (typeof message === 'string') {
                console.log(`[PragmaticAdapter] Raw [${roomId || 'unknown'}]:`, message.substring(0, 100))
            } else {
                console.log('[PragmaticAdapter] Raw (non-string payload)', payload)
            }
        })
        this.unlistenValues.push(unlistenRaw)

        // 3. Connection Status
        const unlistenDisconnect = await listen('pragmatic_disconnected', () => {
            console.log('[PragmaticAdapter] Disconnected from Rust backend')
            this.connected = false
        })
        this.unlistenValues.push(unlistenDisconnect)

        // 4. Connection Error
        const unlistenError = await listen<string>('pragmatic_connection_error', (event) => {
            console.error('[PragmaticAdapter] Connection error:', event.payload)
            this.connected = false
        })
        this.unlistenValues.push(unlistenError)
    }

    private handleRustEvent(event: RustCasinoEvent) {
        try {
            switch (event.type) {
                case 'room_update':
                    this.handleRoomUpdate(event.data)
                    break
                case 'game_result':
                    this.handleGameResult(event.data)
                    break
                case 'betting_phase':
                    this.handleBettingPhase(event.data)
                    break
                case 'balance_update':
                    this.handleBalanceUpdate(event.data)
                    break
            }
        } catch (error) {
            console.error('[PragmaticAdapter] Check event handling error:', error)
        }
    }

    // ==================== Connection ====================
    async connect(config: CasinoConfig): Promise<void> {
        if (!config.wsUrl) {
            console.warn('[PragmaticAdapter] No WebSocket URL provided')
            return
        }

        try {
            console.log(`[PragmaticAdapter] Connecting via Rust to ${config.wsUrl}`)
            await invoke('connect_pragmatic', { wsUrl: config.wsUrl })
            this.connected = true
        } catch (error) {
            console.error('[PragmaticAdapter] Connection failed:', error)
            this.connected = false
        }
    }

    async disconnect(): Promise<void> {
        try {
            await invoke('disconnect_pragmatic')
        } catch (error) {
            console.warn('Disconnect error:', error)
        }
        this.connected = false
        this.rooms.clear()
    }

    async placeBet(roomId: string, betType: string, amount: number): Promise<void> {
        if (!this.connected) {
            console.warn('[PragmaticAdapter] Cannot place bet: Not connected')
            return
        }

        // TODO: formatting message based on Pragmatic protocol
        // For now, sending a placeholder JSON
        const payload = JSON.stringify({
            type: 'place_bet',
            betType,
            amount,
            timestamp: Date.now()
        })

        try {
            console.log(`[PragmaticAdapter] Placing Real Bet: ${betType} ${amount} on ${roomId}`)
            await invoke('send_pragmatic_message', {
                roomId,
                message: payload
            })
        } catch (error) {
            console.error('[PragmaticAdapter] Failed to place bet:', error)
            throw error
        }
    }

    isConnected(): boolean {
        return this.connected
    }

    // ==================== Handlers ====================

    private handleRoomUpdate(normalizedRooms: NormalizedRoom[]) {
        const updatedRooms: Room[] = []

        normalizedRooms.forEach(nr => {
            const roadHistory: RoadResult[] = nr.history.map(h => ({
                winner: this.normalizeWinner(h.winner),
                isPlayerPair: Boolean(h.is_player_pair),
                isBankerPair: Boolean(h.is_banker_pair)
            }))
            const displayName = getPragmaticRoomName(nr.id, nr.name)

            const room: Room = {
                id: nr.id,
                name: displayName,
                koreanName: displayName,
                history: roadHistory,
                gameCount: roadHistory.length,
                lastResultTime: Date.now(),
                provider: 'pragmatic'
            }

            // Detect shoe change (history cleared)
            const prevLen = this.lastHistoryLengthPerRoom.get(nr.id) || 0
            if (prevLen > 3 && roadHistory.length < 3) {
                console.log(`[PragmaticAdapter] 👟 Shoe change detected in ${displayName} (${nr.id})`)
                this.emitShoeChange(nr.id, displayName)
            }
            this.lastHistoryLengthPerRoom.set(nr.id, roadHistory.length)

            this.rooms.set(nr.id, room)
            updatedRooms.push(room)
        })

        if (updatedRooms.length > 0) {
            this.emitRoomUpdate(Array.from(this.rooms.values()))
        }

        // 방 소켓 병렬 연결: 로비 통계에서 받은 tableId 기준으로 실제 룸 소켓을 붙인다.
        updatedRooms.forEach(room => {
            if (!this.requestedRooms.has(room.id)) {
                this.requestedRooms.add(room.id)
                invoke('connect_pragmatic_table', { tableId: room.id }).catch((error) => {
                    console.warn('[PragmaticAdapter] Failed to connect table socket:', error)
                })
            }
        })
    }

    private handleGameResult(data: NormalizedGameResult) {
        const winner = this.normalizeWinner(data.winner)
        const isPlayerPair = Boolean(data.is_player_pair)
        const isBankerPair = Boolean(data.is_banker_pair)
        const displayName = getPragmaticRoomName(data.room_id, data.table_name || this.rooms.get(data.room_id)?.name)
        this.emitGameResult({
            roomId: data.room_id,
            winner: winner,
            isPlayerPair,
            isBankerPair,
            playerScore: data.player_score ?? undefined,
            bankerScore: data.banker_score ?? undefined
        })

        // Also update history in room
        const existing = this.rooms.get(data.room_id)
        const history = existing?.history ?? []
        const updatedHistory: RoadResult[] = [{
            winner,
            isPlayerPair,
            isBankerPair
        }, ...history]

        const room: Room = existing ? {
            ...existing,
            name: displayName,
            koreanName: displayName,
            history: updatedHistory,
            gameCount: updatedHistory.length,
            lastResultTime: Date.now()
        } : {
            id: data.room_id,
            name: displayName,
            koreanName: displayName,
            history: updatedHistory,
            gameCount: updatedHistory.length,
            lastResultTime: Date.now(),
            provider: 'pragmatic'
        }

        this.lastHistoryLengthPerRoom.set(data.room_id, updatedHistory.length)
        this.rooms.set(data.room_id, room)
        this.emitRoomUpdate(Array.from(this.rooms.values()))

        // Pragmatic은 타이머 이벤트가 없으므로 결과 시점에 베팅 페이즈를 시작시켜 타이머를 보여준다.
        this.emitBettingPhase({
            roomId: data.room_id,
            remainingSeconds: PRAGMATIC_BETTING_SECONDS,
            phase: 'start'
        })
    }

    private handleBettingPhase(data: NormalizedBettingPhase) {
        this.emitBettingPhase({
            roomId: data.room_id,
            remainingSeconds: data.remaining_seconds,
            phase: data.remaining_seconds > 0 ? 'start' : 'end'
        })
    }

    // ==================== Message Parsing (Legacy/Unused) ====================
    parseMessage(_raw: string): ParsedMessage | null {
        // Parsing is now done in Rust
        return null
    }

    // ==================== Event Emitters ====================
    private emitRoomUpdate(rooms: Room[]): void {
        this.roomUpdateCallbacks.forEach((cb) => cb(rooms))
    }

    private normalizeWinner(value: string): Winner {
        const upper = (value || '').toUpperCase()
        if (upper.startsWith('B')) return 'B'
        if (upper.startsWith('P')) return 'P'
        if (upper.startsWith('T')) return 'T'
        return 'T'
    }

    private emitGameResult(event: GameResultEvent): void {
        this.gameResultCallbacks.forEach((cb) => cb(event))
    }

    private emitBettingPhase(event: BettingPhaseEvent): void {
        this.bettingPhaseCallbacks.forEach((cb) => cb(event))
    }

    private emitShoeChange(roomId: string, roomName: string): void {
        this.shoeChangeCallbacks.forEach((cb) => cb(roomId, roomName))
    }

    // ==================== Subscriptions ====================
    onRoomUpdate(callback: RoomUpdateCallback): () => void {
        this.roomUpdateCallbacks.push(callback)
        return () => {
            this.roomUpdateCallbacks = this.roomUpdateCallbacks.filter((cb) => cb !== callback)
        }
    }

    onGameResult(callback: GameResultCallback): () => void {
        this.gameResultCallbacks.push(callback)
        return () => {
            this.gameResultCallbacks = this.gameResultCallbacks.filter((cb) => cb !== callback)
        }
    }

    onBettingPhase(callback: BettingPhaseCallback): () => void {
        this.bettingPhaseCallbacks.push(callback)
        return () => {
            this.bettingPhaseCallbacks = this.bettingPhaseCallbacks.filter((cb) => cb !== callback)
        }
    }

    onHistoryUpdate(callback: HistoryUpdateCallback): () => void {
        this.historyUpdateCallbacks.push(callback)
        return () => {
            this.historyUpdateCallbacks = this.historyUpdateCallbacks.filter((cb) => cb !== callback)
        }
    }

    onBalanceUpdate(callback: (balance: number) => void): () => void {
        this.balanceUpdateCallbacks.push(callback)
        return () => {
            this.balanceUpdateCallbacks = this.balanceUpdateCallbacks.filter((cb) => cb !== callback)
        }
    }

    onShoeChange(callback: (roomId: string, roomName: string) => void): () => void {
        this.shoeChangeCallbacks.push(callback)
        return () => {
            this.shoeChangeCallbacks = this.shoeChangeCallbacks.filter((cb) => cb !== callback)
        }
    }

    private handleBalanceUpdate(data: NormalizedBalanceUpdate) {
        // data.currency is available if needed
        this.balanceUpdateCallbacks.forEach(cb => cb(data.balance))
    }

    // ==================== Getters ====================
    getRooms(): Map<string, Room> {
        return this.rooms
    }

    getRoom(roomId: string): Room | null {
        return this.rooms.get(roomId) || null
    }
}

// Singleton instance
export const PragmaticAdapter = new PragmaticAdapterImpl()
export default PragmaticAdapter
