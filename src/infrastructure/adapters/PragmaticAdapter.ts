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

/** 실배팅 체결 확인 대기(ms). 브릿지 ACK(`command success`)는 라이브 실측 ~0.2초. */
const PRAGMATIC_BET_ACK_TIMEOUT_MS = 2500

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
    /** 브릿지: 서버 마감 절대시각(epoch ms) = betsopen 수신 + betting_time − 1s */
    deadline_at_ms?: number | null
    /** 브릿지: 배팅 창 길이(ms) */
    window_ms?: number | null
    /** 브릿지: 현재 라운드 gameId */
    game_id?: string | null
    /** 브릿지: betsclosed 프레임 */
    closed?: boolean
}

/** 브릿지 체결/정산 이벤트(Rust `pragmatic_bet_event`) */
interface PragmaticBetEvent {
    type: 'command_ack' | 'bet_confirmed' | 'bets_confirmed' | 'bets_cleared' | 'settled'
    table?: string | null
    status?: string
    amount?: string | null
    betcode?: string | null
    game_id?: string | null
    win?: number
    nwb?: number
}

export interface PragmaticBetAck {
    status: 'accepted' | 'rejected' | 'unknown'
    error?: string
}

export interface PragmaticSettlement {
    roomId: string
    gameId?: string | null
    win: number
    netWin: number
}

interface NormalizedBalanceUpdate {
    balance: number
    currency: string
}

interface PragmaticBetReceipt {
    tableId: string
    betType: string
    amount: number
    gameId: string
    sentAtMs: number
    attempts: number
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
    /** 테이블별 현재 라운드 gameId(betsopen/game/timer 프레임에서) */
    private currentGameIds: Map<string, string> = new Map()
    private betAckWaiters: Map<string, { resolve: (ack: PragmaticBetAck) => void; timeoutId: ReturnType<typeof setTimeout> }> = new Map()
    private betSettledCallbacks: Array<(s: PragmaticSettlement) => void> = []

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
            const roomId = typeof payload?.roomId === 'string' ? payload.roomId : 'unknown'
            const message = typeof payload === 'string' ? payload : payload?.message
            if (typeof message === 'string') {
                console.log(`[PragmaticAdapter] Raw metadata room=${roomId} length=${message.length}`)
            } else {
                console.log(`[PragmaticAdapter] Raw non-string payload type=${typeof payload}`)
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

        // 5. 브릿지 부착 상태 — 브라우저 게임 소켓에 붙었는지(= 실배팅 가능)
        const unlistenBridge = await listen<{ attached: boolean; reason?: string }>('pragmatic_bridge_status', (event) => {
            this.connected = !!event.payload?.attached
            console.log(`[PragmaticAdapter] bridge ${this.connected ? 'attached' : `detached (${event.payload?.reason ?? ''})`}`)
            if (!this.connected) this.rejectAllAckWaiters('브릿지 분리')
        })
        this.unlistenValues.push(unlistenBridge)

        // 6. 체결/정산 이벤트 — command ACK, 마감 후 bet/bets 확정, win 정산
        const unlistenBet = await listen<PragmaticBetEvent>('pragmatic_bet_event', (event) => {
            this.handleBetEvent(event.payload)
        })
        this.unlistenValues.push(unlistenBet)
    }

    private handleBetEvent(ev: PragmaticBetEvent) {
        const table = (ev.table ?? '').replace(/^table-/, '')
        if (!table) return
        switch (ev.type) {
            case 'command_ack': {
                const waiter = this.betAckWaiters.get(table)
                if (waiter) {
                    this.betAckWaiters.delete(table)
                    clearTimeout(waiter.timeoutId)
                    waiter.resolve(ev.status === 'success'
                        ? { status: 'accepted' }
                        : { status: 'rejected', error: `Pragmatic 명령 거절 (${ev.status ?? '?'})` })
                }
                break
            }
            case 'bet_confirmed':
            case 'bets_confirmed': {
                const waiter = this.betAckWaiters.get(table)
                if (waiter) {
                    this.betAckWaiters.delete(table)
                    clearTimeout(waiter.timeoutId)
                    waiter.resolve({ status: 'accepted' })
                }
                break
            }
            case 'settled': {
                const s: PragmaticSettlement = { roomId: table, gameId: ev.game_id ?? null, win: Number(ev.win ?? 0), netWin: Number(ev.nwb ?? 0) }
                this.betSettledCallbacks.forEach(cb => { try { cb(s) } catch (e) { console.warn('[PragmaticAdapter] settled cb error', e) } })
                break
            }
            default:
                break
        }
    }

    private rejectAllAckWaiters(error: string) {
        this.betAckWaiters.forEach((w) => { clearTimeout(w.timeoutId); w.resolve({ status: 'unknown', error }) })
        this.betAckWaiters.clear()
    }

    /** 실배팅 체결 확인: command ACK(success) 또는 bet/bets 확정을 기다린다. 타임아웃이면 unknown. */
    waitForBetAck(roomId: string, timeoutMs = PRAGMATIC_BET_ACK_TIMEOUT_MS): Promise<PragmaticBetAck> {
        const table = roomId.replace(/^pragmatic:/, '')
        return new Promise((resolve) => {
            const prev = this.betAckWaiters.get(table)
            if (prev) { clearTimeout(prev.timeoutId); prev.resolve({ status: 'unknown', error: '새 배팅으로 대체' }) }
            const timeoutId = setTimeout(() => {
                this.betAckWaiters.delete(table)
                resolve({ status: 'unknown', error: '실제 베팅 체결 확인 시간 초과' })
            }, timeoutMs)
            this.betAckWaiters.set(table, { resolve, timeoutId })
        })
    }

    onBetSettled(callback: (s: PragmaticSettlement) => void): () => void {
        this.betSettledCallbacks.push(callback)
        return () => { this.betSettledCallbacks = this.betSettledCallbacks.filter(cb => cb !== callback) }
    }

    /** 현재 라운드 gameId(브릿지가 betsopen/game/timer에서 추적). 없으면 null. */
    getCurrentGameId(roomId: string): string | null {
        return this.currentGameIds.get(roomId.replace(/^pragmatic:/, '')) ?? null
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
            let host = 'unparseable'
            try {
                host = new URL(config.wsUrl).host || 'unknown'
            } catch {
                // Connection validation remains in Rust; logging stays metadata-only.
            }
            console.log(`[PragmaticAdapter] Connecting via Rust host=${host} urlLength=${config.wsUrl.length}`)
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

    /** 실배팅 전송(브릿지). Rust가 마감 여유·gameId·사용자 id·훅 컨텍스트를 검사해 fail-closed로 거절할 수 있다(throw). */
    async placeBet(roomId: string, betType: string, amount: number): Promise<void> {
        if (!this.connected) {
            throw new Error('프라그마틱 게임 소켓에 붙어 있지 않아요 (멀티플레이 진입 필요)')
        }
        const tableId = roomId.replace(/^pragmatic:/, '')
        console.log(`[PragmaticAdapter] Placing Real Bet: ${betType} ${amount} on ${tableId}`)
        const receipt = await invoke<PragmaticBetReceipt>('place_pragmatic_bet', {
            tableId,
            betType,
            amount: Math.trunc(amount)
        })
        console.log('[PragmaticAdapter] Pragmatic bet sent:', receipt)
    }

    /** 배팅 취소(전체). 마감 전에만 가능. */
    async cancelBet(roomId: string): Promise<void> {
        const tableId = roomId.replace(/^pragmatic:/, '')
        await invoke<string>('cancel_pragmatic_bet', { tableId })
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

        // 브릿지 모드: 테이블 소켓은 브라우저(멀티플레이)가 스스로 열고 구독한다. Rust 직접 소켓은 열지 않는다.
    }

    private handleGameResult(data: NormalizedGameResult) {
        const winner = this.normalizeWinner(data.winner)
        const isPlayerPair = Boolean(data.is_player_pair)
        const isBankerPair = Boolean(data.is_banker_pair)
        const displayName = getPragmaticRoomName(data.room_id, data.table_name || this.rooms.get(data.room_id)?.name)

        // ⚠️ 순서 중요(2026-09-03): 방 히스토리를 먼저 키운 뒤 결과 콜백을 발화한다.
        //   종전엔 emitGameResult를 먼저 쏴서, AutoModeService가 결과를 받는 순간 resolveRoom이
        //   아직 안 자란 히스토리를 보고 hist-not-grown으로 무시 → 폴링(~1초)까지 정산이 밀렸다.
        //   그 사이 바로 다음 라운드 betsopen이 지나가 마틴 배팅이 '한 판 씹히는' 원인이었다.
        //   서버 gameresult는 라운드별 확정 승패이므로 히스토리 성장과 동시에 즉시 정산되게 한다.
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
            lastResultTime: Date.now(),
            phase: 'result',
            remainingSeconds: 0,
            bettingDeadlineAt: undefined,
        } : {
            id: data.room_id,
            name: displayName,
            koreanName: displayName,
            history: updatedHistory,
            gameCount: updatedHistory.length,
            lastResultTime: Date.now(),
            phase: 'result',
            remainingSeconds: 0,
            provider: 'pragmatic'
        }

        this.lastHistoryLengthPerRoom.set(data.room_id, updatedHistory.length)
        this.rooms.set(data.room_id, room)

        // 히스토리를 키운 뒤 결과 콜백 발화 → AutoModeService가 즉시(같은 tick) 정산한다.
        this.emitGameResult({
            roomId: data.room_id,
            winner: winner,
            isPlayerPair,
            isBankerPair,
            playerScore: data.player_score ?? undefined,
            bankerScore: data.banker_score ?? undefined
        })
        this.emitRoomUpdate(Array.from(this.rooms.values()))

        // ⛔ 결과 시점에 가짜 배팅 시작(15초)을 쏘지 않는다. 브릿지가 실제 betsopen 프레임으로
        //   마감 시각과 gameId를 실어 보낸다(에볼루션에서 가짜 12초가 끝난 라운드 gameId 배팅을 만든 것과 같은 함정).
    }

    private handleBettingPhase(data: NormalizedBettingPhase) {
        const isStart = !data.closed && data.remaining_seconds > 0
        if (data.game_id) this.currentGameIds.set(data.room_id, data.game_id)
        const deadlineAt = isStart ? (data.deadline_at_ms ?? Date.now() + data.remaining_seconds * 1000) : undefined
        const existing = this.rooms.get(data.room_id)
        if (existing) {
            this.rooms.set(data.room_id, {
                ...existing,
                phase: isStart ? 'betting' : 'dealing',
                remainingSeconds: isStart ? data.remaining_seconds : 0,
                bettingDeadlineAt: deadlineAt,
                bettingWindowMs: data.window_ms ?? existing.bettingWindowMs,
            })
        }
        this.emitBettingPhase({
            roomId: data.room_id,
            remainingSeconds: isStart ? data.remaining_seconds : 0,
            phase: isStart ? 'start' : 'end',
            deadlineAt,
            windowMs: data.window_ms ?? undefined,
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
