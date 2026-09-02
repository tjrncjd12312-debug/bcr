// Evolution Casino Adapter - Multi-Socket Only
// Clean Architecture: Infrastructure Layer
//
// 설계 원칙:
// - 멀티소켓만 사용 (widget.resolved, game.result, encodedShoeState)
// - 모든 방의 히스토리를 실시간 감시
// - handleGameState로 새 결과 감지 및 히스토리 업데이트
// - 슈 체인지: processShoeHistory에서 히스토리 길이 감소 시 감지

import type {
  ICasinoAdapter,
  CasinoConfig,
  ParsedMessage,
} from '../../domain/interfaces'
import type {
  Room,
  Winner,
  RoadResult,
  GameResultEvent,
  BettingPhaseEvent,
  GamePhase,
  BetType,
  BetOutcome,
  TableBettingConfig,
  EvolutionBetPayload,
} from '../../domain/entities'
import { BET_CODES, DEFAULT_TABLE_BETTING_CONFIG } from '../../domain/entities'

// Timer max duration limit (seconds) - prevents unreasonably high timer values
const MAX_TIMER_SECONDS = 60

/** 서버 시간값을 ms로 정규화한다. Evolution은 ms(예 13000)를 주지만 300 이하면 초로 본다. */
function toMillis(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const num = Number(raw)
  if (Number.isNaN(num) || num < 0) return undefined
  return num > 300 ? Math.round(num) : Math.round(num * 1000)
}

// ==================== Room Filtering ====================
// 제외할 테이블 패턴 (라이트닝, 살롱, RNG 등)
const EXCLUDED_PATTERNS = ['lightning', '라이트닝', 'salon', '살롱', 'sal', 'priv', 'rng-']

// 바카라 테이블 포함 패턴
const BACCARAT_PATTERNS = ['baccarat', '바카라', 'bac']

/**
 * 테이블을 포함할지 여부 결정 (동적 필터링)
 * - 라이트닝/살롱/RNG 제외
 * - 바카라 테이블만 포함
 */
function shouldIncludeRoom(tableId: string, tableName: string): boolean {
  const idLower = tableId.toLowerCase()
  const nameLower = tableName.toLowerCase()

  // 1. 제외 패턴 체크 (ID 또는 이름에 포함되면 제외)
  for (const pattern of EXCLUDED_PATTERNS) {
    if (idLower.includes(pattern) || nameLower.includes(pattern)) {
      return false
    }
  }

  // 2. 바카라 테이블인지 체크 (ID 또는 이름에 포함되면 포함)
  for (const pattern of BACCARAT_PATTERNS) {
    if (idLower.includes(pattern) || nameLower.includes(pattern)) {
      return true
    }
  }

  return false
}

// ==================== Room Mapping (한글명 변환용) ====================
// 한글명 매핑 - 동적 필터링 통과 후 한글명 변환에 사용
const ROOM_MAPPING: Record<string, string> = {
  // 스피드 바카라 A-Z
  leqhceumaq6qfoug: '스피드 바카라 A',
  lv2kzclunt2qnxo5: '스피드 바카라 B',
  ndgvwvgthfuaad3q: '스피드 바카라 C',
  ndgvz5mlhfuaad6e: '스피드 바카라 D',
  ndgv45bghfuaaebf: '스피드 바카라 E',
  nmwde3fd7hvqhq43: '스피드 바카라 F',
  nmwdzhbg7hvqh6a7: '스피드 바카라 G',
  nxpj4wumgclak2lx: '스피드 바카라 H',
  nxpkul2hgclallno: '스피드 바카라 I',
  obj64qcnqfunjelj: '스피드 바카라 J',
  ovu5cwp54ccmymck: '스피드 바카라 L',
  ovu5eja74ccmyoiq: '스피드 바카라 N',
  o4kyj7tgpwqqy4m4: '스피드 바카라 Q',
  o4kylkahpwqqy57w: '스피드 바카라 R',
  o4kymodby2fa2c7g: '스피드 바카라 S',
  qgonc7t4ucdiel4o: '스피드 바카라 T',
  qgqrhfvsvltnueqf: '스피드 바카라 U',
  qgqrrnuqvltnvejx: '스피드 바카라 V',
  qgqrucipvltnvnvq: '스피드 바카라 W',
  qgqrv4asvltnvuty: '스피드 바카라 X',
  qsf63ownyvbqnz33: '스피드 바카라 Z',

  // 스피드 바카라 1-4
  qsf65xtoyvbqoaop: '스피드 바카라 1',
  qsf7alptyvbqohva: '스피드 바카라 2',
  qsf7bpfvyvbqolwp: '스피드 바카라 3',
  rdjda6zq7jdyo6cs: '스피드 바카라 4',

  // 슈퍼 스피드 바카라
  '774SuperSpeedBac': '슈퍼 스피드 바카라',

  // 코리안 스피드 바카라 A-H
  p63cmvmwagteemoy: '코리안 스피드 바카라 A',
  onokyd4wn7uekbjx: '코리안 스피드 바카라 B',
  qgdk6rtpw6hax4fe: '코리안 스피드 바카라 C',
  q25awuwygsy3lvnj: '코리안 스피드 바카라 D',
  q25bmd63gsy3ngfl: '코리안 스피드 바카라 E',
  q7jgx3w4fk7nmrz2: '코리안 스피드 바카라 F',
  srsrrygouz4svxla: '코리안 스피드 바카라 G',
  srswfjnpuz4ucmwm: '코리안 스피드 바카라 H',

  // 코리안 스피킹 스피드 바카라
  'npn3y3hkld2mcdjt:s7ajlaeuh6raadta': '코리안 스피킹 스피드 바카라',
  'oga6ftnw3fltvggm:s7ajlixvh6raadtj': '코리안 스피킹 스피드 바카라 2',

  // 살롱 프라이빗 바카라 - 제외됨 (EXCLUDED_PATTERNS에 의해 필터링)

  // Dynasty 스피드 바카라 1-8
  PeryaSpeedBac001: 'Dynasty 스피드 바카라 1',
  PeryaSpeedBac002: 'Dynasty 스피드 바카라 2',
  PeryaSpeedBac003: 'Dynasty 스피드 바카라 3',
  PeryaSpeedBac004: 'Dynasty 스피드 바카라 4',
  PeryaSpeedBac005: 'Dynasty 스피드 바카라 5',
  PeryaSpeedBac006: 'Dynasty 스피드 바카라 6',
  PeryaSpeedBac007: 'Dynasty 스피드 바카라 7',
  PeryaSpeedBac008: 'Dynasty 스피드 바카라 8',

  // 본자이 스피드 바카라 A-C
  BonsaiBacc000001: '본자이 스피드 바카라 A',
  BonsaiBacc000002: '본자이 스피드 바카라 B',
  BonsaiBacc000003: '본자이 스피드 바카라 C',

  // 바 바카라 A-H
  InBarBacc0000001: '바 바카라 A',
  InBarBacc0000002: '바 바카라 B',
  InBarBacc0000003: '바 바카라 C',
  InBarBacc0000004: '바 바카라 D',
  InBarBacc0000005: '바 바카라 E',
  InBarBacc0000006: '바 바카라 F',
  InBarBacc0000007: '바 바카라 G',
  InBarBacc0000008: '바 바카라 H',

  // 로투스 스피드 바카라 A-C
  pv2y4kmsanvdvwgy: '로투스 스피드 바카라 A',
  srsnxlybuz4rrqr6: '로투스 스피드 바카라 B',
  srsp4ai6uz4sfq4z: '로투스 스피드 바카라 C',

  // 엠퍼러 스피드 바카라 A-D
  puu4yfymic3reudn: '엠퍼러 스피드 바카라 A',
  puu43e6c5uvrfikr: '엠퍼러 스피드 바카라 B',
  pwsaqk24fcz5qpcr: '엠퍼러 스피드 바카라 C',
  q6ardco6opnfwes4: '엠퍼러 스피드 바카라 D',

  // 힌디어 스피드 바카라 A-B
  qhhjdnovai4a3a6k: '힌디어 스피드 바카라 A',
  HSpeedBac0000002: '힌디어 스피드 바카라 B',

  // 타이 스피드 바카라
  pezjou3ltf6hvzjk: '타이 스피드 바카라 A',

  // 올웨이즈 바카라
  always9baccarat1: '올웨이즈 9 바카라',
  Always8baccarat0: '올웨이즈 8 바카라',

  // 노 커미션 바카라 (스피드 계열)
  NoCommBac0000001: '노 커미션 바카라',

  // 풍성한 골든 바카라 (Golden Wealth Baccarat)
  gwbaccarat000001: '풍성한 골든 바카라',
  Empgwbaccarat001: '엠퍼러 풍성한 골든 바카라',
  Kogwbaccarat0001: '코리안 풍성한 골든 바카라',
}



// ==================== Types ====================
type RoomUpdateCallback = (rooms: Room[]) => void
type GameResultCallback = (event: GameResultEvent) => void
type BettingPhaseCallback = (event: BettingPhaseEvent) => void
type HistoryUpdateCallback = (roomId: string, history: RoadResult[]) => void
type ShoeChangeCallback = (roomId: string, koreanName: string) => void
type BalanceUpdateCallback = (balance: number) => void
type TableConfigUpdateCallback = (config: Partial<TableBettingConfig>) => void

export interface BetPlacementConfirmation {
  tableId: string
  gameId?: string
  betType?: BetType
  amount?: number
  status: 'accepted' | 'rejected' | 'unknown'
  accepted: boolean
  rejected: boolean
  error?: string
  source: 'playerBettingState' | 'playerBetResponse' | 'resolved' | 'timeout' | 'disconnect' | 'dispose'
}

interface BetConfirmationWaiter {
  tableId: string
  gameId?: string
  betType: BetType
  amount: number
  timeoutId: ReturnType<typeof setTimeout>
  resolve: (confirmation: BetPlacementConfirmation) => void
}

type BetPlacementConfirmationCallback = (confirmation: BetPlacementConfirmation) => void

// ==================== Adapter Implementation ====================
class EvolutionAdapterImpl implements ICasinoAdapter {
  readonly name = 'Evolution Gaming'
  readonly type = 'evolution' as const

  private connected = false

  // Callbacks
  private roomUpdateCallbacks: RoomUpdateCallback[] = []
  private gameResultCallbacks: GameResultCallback[] = []
  private bettingPhaseCallbacks: BettingPhaseCallback[] = []
  private historyUpdateCallbacks: HistoryUpdateCallback[] = []
  private shoeChangeCallbacks: ShoeChangeCallback[] = []
  private balanceUpdateCallbacks: BalanceUpdateCallback[] = []
  private tableConfigCallbacks: TableConfigUpdateCallback[] = []
  private betPlacementConfirmationCallbacks: BetPlacementConfirmationCallback[] = []
  private betConfirmationWaiters: BetConfirmationWaiter[] = []

  // State
  private rooms: Map<string, Room> = new Map()
  private initializedRooms: Set<string> = new Set()
  private lastBalance: number | null = null  // 캐시된 잔액

  // ==================== Auto Betting State ====================
  /** gameId per tableId (from baccarat.newGame, baccarat.gameState) */
  private currentGameIds: Map<string, string> = new Map()
  /** currencyCode from balanceUpdated */
  private currencyCode: string = 'KRW'
  /** Table betting config (from CDP capture) - 전역 기본 설정 */
  private tableConfig: TableBettingConfig = { ...DEFAULT_TABLE_BETTING_CONFIG }
  /** 테이블별 배팅 설정 (CDP에서 캡처된 실제 데이터) */
  private tableConfigs: Map<string, TableBettingConfig> = new Map()
  /** 테이블별 통화 코드 (배팅 메시지에 필요) */
  private tableCurrencies: Map<string, string> = new Map()
  /** 테이블별 설정 캡처 여부 */
  private capturedTables: Set<string> = new Set()
  /** Last bet gameId per table to prevent duplicate bets (Map<tableId, gameId>) */
  private lastBetGameIds: Map<string, string> = new Map()
  private lastHistoryLengths: Map<string, number> = new Map() // 방별 마지막 히스토리 길이 (중복/슈체인지 감지)
  private longShoeWarned: Set<string> = new Set() // [진단] 히스토리가 정상 슈 길이를 초과(누적 의심)했다고 한 번 경고한 방
  private lastEmittedResults: Map<string, { winner: Winner; timestamp: number; historyLength: number }> = new Map() // 방별 마지막 emit된 결과 (최종 중복 방지)
  private lastProcessedGameIds: Map<string, string> = new Map() // 방별 마지막 처리된 gameId (중복 결과 방지)
  /** v2 lobby.historyUpdated의 results 형식(c:"R"/"B")으로 '바카라'임이 입증된 테이블 ID.
   *  암호 ID(예: tzxd9y6k1sqqqztk)는 이름 패턴 필터(shouldIncludeRoom)를 통과 못하므로,
   *  데이터로 바카라가 확인되면 이 Set에 넣어 방 생성 필터를 우회한다(전체 바카라 멀티방 표시). */
  private v2BaccaratTables: Set<string> = new Set()

  /** lobby.configs(lobby v2)에서 받은 테이블 메타: tableId → {title(한글명), gt(게임타입)}.
   *  lobby.categories의 평문 ID 목록에 한글명을 붙이고 바카라 여부를 판별하는 데 쓴다. */
  private tableMeta: Map<string, { title?: string; gt?: string }> = new Map()

  // 🔥 Room update 렉 방지용 타이머
  private roomUpdateTimer: ReturnType<typeof setTimeout> | null = null
  // @ts-ignore - used in disconnect cleanup
  private roomUpdatePending = false

  // ==================== Connection ====================
  async connect(_config: CasinoConfig): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.rooms.clear()
    this.initializedRooms.clear()
    this.lastHistoryLengths.clear()
    this.lastEmittedResults.clear()
    this.lastProcessedGameIds.clear() // Bug Fix: gameId 기반 중복 체크 상태 초기화
    this.lastBalance = null
    // ✅ Auto betting state reset
    this.currentGameIds.clear()
    this.lastBetGameIds.clear()
    this.tableConfigs.clear()
    this.tableCurrencies.clear()
    this.capturedTables.clear()
    this.clearBetConfirmationWaiters('Evolution 연결이 종료되어 체결 여부를 확인할 수 없습니다', 'disconnect')
    // 🔥 타이머 초기화 (렉 방지)
    if (this.roomUpdateTimer) {
      clearTimeout(this.roomUpdateTimer)
      this.roomUpdateTimer = null
    }
    this.roomUpdatePending = false
  }

  /**
   * 완전한 리소스 해제 (앱 종료 또는 재초기화 시 사용)
   * disconnect()와 달리 콜백 배열까지 모두 정리
   */
  dispose(): void {
    // 1. 연결 상태 정리 (disconnect와 동일)
    this.connected = false
    this.rooms.clear()
    this.initializedRooms.clear()
    this.lastHistoryLengths.clear()
    this.lastEmittedResults.clear()
    this.lastProcessedGameIds.clear() // Bug Fix: gameId 기반 중복 체크 상태 초기화
    this.lastBalance = null

    // 2. Auto betting state 정리
    this.currentGameIds.clear()
    this.lastBetGameIds.clear()
    this.tableConfigs.clear()
    this.tableCurrencies.clear()
    this.capturedTables.clear()

    // 3. 타이머 정리
    if (this.roomUpdateTimer) {
      clearTimeout(this.roomUpdateTimer)
      this.roomUpdateTimer = null
    }
    this.roomUpdatePending = false

    // 4. 🔥 콜백 배열 완전 정리 (메모리 누수 방지)
    this.roomUpdateCallbacks = []
    this.gameResultCallbacks = []
    this.bettingPhaseCallbacks = []
    this.historyUpdateCallbacks = []
    this.shoeChangeCallbacks = []
    this.balanceUpdateCallbacks = []
    this.tableConfigCallbacks = []
    this.betPlacementConfirmationCallbacks = []
    this.clearBetConfirmationWaiters('Evolution 어댑터가 종료되어 체결 여부를 확인할 수 없습니다', 'dispose')

    // 5. 기본값으로 초기화
    this.currencyCode = 'KRW'
    this.tableConfig = { ...DEFAULT_TABLE_BETTING_CONFIG }
  }

  /**
   * 오래된 캐시 데이터 정리 (주기적 호출 권장)
   * @param maxAgeMs - 이 시간(ms)보다 오래된 항목 제거 (기본 5분)
   */
  cleanupStaleCache(maxAgeMs: number = 5 * 60 * 1000): void {
    const now = Date.now()

    // lastEmittedResults에서 오래된 항목 제거
    for (const [roomId, data] of this.lastEmittedResults) {
      if (now - data.timestamp > maxAgeMs) {
        this.lastEmittedResults.delete(roomId)
      }
    }

    // 더 이상 rooms에 없는 항목들 정리
    const activeRoomIds = new Set(this.rooms.keys())

    for (const roomId of this.lastHistoryLengths.keys()) {
      if (!activeRoomIds.has(roomId)) {
        this.lastHistoryLengths.delete(roomId)
      }
    }

    for (const roomId of this.currentGameIds.keys()) {
      if (!activeRoomIds.has(roomId)) {
        this.currentGameIds.delete(roomId)
      }
    }

    for (const roomId of this.lastBetGameIds.keys()) {
      if (!activeRoomIds.has(roomId)) {
        this.lastBetGameIds.delete(roomId)
      }
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  // ==================== Message Parsing ====================
  parseMessage(raw: string, _contextTableId?: string): ParsedMessage | null {
    try {
      const data = JSON.parse(raw)
      const msgType = (data.type as string) || ''

      // 💰 실시간 잔액 (라이브 확인 2026-06-02): 중계사이트 소켓(wss://hl-101.com/ws)이 보내는
      //   {"type":"balance","total":N,"local":N,"game":N,"breakdown":{"hl","cs","mega"}}
      // Playwright로 실제 캡처해 확인한 형식. 이 프레임은 기존 Evolution forward 필터에 안 걸려
      // 프론트로 오지 못했고(=자동 실배팅 시 realBalance 안 오르던 근본 원인), Rust CDP에서
      // evolution_multi_event로 forward하도록 고쳤다. 여기서 잔액을 '동적으로' 추출한다 —
      // game(게임 내 베팅 잔액) 우선, 없으면 total. 특정 테이블/필드경로 하드코딩 없음.
      if (msgType === 'balance') {
        const b = data as Record<string, unknown>
        const bal = typeof b.game === 'number' ? b.game
          : typeof b.total === 'number' ? b.total
            : null
        if (typeof bal === 'number' && bal !== this.lastBalance) {
          this.lastBalance = bal
          this.emitBalanceUpdate(bal)
        }
        return { type: 'balance', data }
      }

      // 🔬 [BET-DIAG] 임시 진단(2026-06-02): 실배팅 후 Evolution의 반응(수락/거부/에러)을 확인해
      // "실배팅이 실제로 안 되는" 원인을 확정한다. 실배팅 1회 후 devtools 콘솔 'BET-DIAG'로 본다.
      //  - 거부/에러가 보이면 → 그 사유(gameId/채널/포맷)에 맞춰 고친다.
      //  - 아무 반응도 없으면 → lobby v2 소켓이 betting 채널이 아닐 가능성(전송돼도 무시).
      // (확정 후 이 블록과 AutoBettingService의 [BET-DIAG]는 제거)
      if (/playerbet|betsaccept|betsreject|betresponse|notauthor|notaccept|insufficient|betdenied|"error"/i.test(raw)) {
        console.log(`[BET-DIAG] Evo resp/err: type="${msgType}" | ${raw.slice(0, 400)}`)
      }

      // Direct log payloads (CLIENT_BET_CHIP / Undo etc.) from multi-socket
      if (data.log && typeof data.log.type === 'string') {
        const logType = data.log.type as string
        const value = data.log.value || {}
        const tableId = value.tableId as string | undefined
        const gameId = value.gameId as string | undefined
        const balanceRaw = value.balance as number | string | undefined
        const currency = value.currency as string | undefined

        if (logType === 'CLIENT_BET_CHIP') {
          if (gameId && tableId) {
            this.currentGameIds.set(tableId, gameId)
          }

          if (tableId) {
            // 테이블 설정 업데이트 (칩스택/한도/통화 포함)
            this.updateTableConfigFromCDP({
              type: 'bet_chip',
              tableId,
              gameId,
              chipStack: value.chipStack,
              tableMinLimit: value.tableMinLimit,
              tableMaxLimit: value.tableMaxLimit,
              currency,
              channel: value.channel,
              orientation: value.orientation,
              gameDimensions: value.gameDimensions,
              balance: value.balance,
            })
          }

          // 잔액 업데이트
          const parsedBalance =
            typeof balanceRaw === 'number'
              ? balanceRaw
              : typeof balanceRaw === 'string'
                ? Number(balanceRaw.replace(/,/g, ''))
                : null
          if (typeof parsedBalance === 'number' && !Number.isNaN(parsedBalance)) {
            this.lastBalance = parsedBalance
            this.emitBalanceUpdate(parsedBalance)
          }
        }
      }

      // table state updates
      if ((msgType === 'tableState' || msgType === 'baccarat.tableState') && data.args) {
        this.handleTableState(data.args)
        return { type: msgType, data: data.args }
      }

      // encoded shoe state with full history
      if (msgType === 'baccarat.encodedShoeState' && data.args) {
        this.handleEncodedShoeState(data.args)
        return { type: msgType, data: data.args }
      }

      // game state / resolved (single result)
      if ((msgType === 'baccarat.gameState' || msgType === 'baccarat.resolved') && data.args) {
        this.handleGameState(data.args)
        return { type: msgType, data: data.args }
      }

      if (msgType === 'game.state' && data.args) {
        this.handleGameState(data.args)
        return { type: msgType, data: data.args }
      }

      // ✅ widget.resolved - 게임 결과 확정 (멀티위젯)
      if (msgType === 'widget.resolved' && data.args) {
        this.handleGameState(data.args)
        return { type: msgType, data: data.args }
      }

      // ✅ 멀티소켓 게임 결과 이벤트 (game.result, baccarat.result, baccarat.gameResult)
      if ((msgType === 'game.result' || msgType === 'baccarat.result' || msgType === 'baccarat.gameResult') && data.args) {
        this.handleGameState(data.args)
        return { type: msgType, data: data.args }
      }

      if (msgType === 'lobby.historyUpdated' && data.args) {
        const a = data.args as any
        if (a.historyUpdated) {
          // CDP 옵저버 경유: args.historyUpdated = 단일 객체
          this.handleLobbyHistoryUpdated(a.historyUpdated)
        } else if (a.tableId) {
          // 단일 객체 형식: args = {tableId, history|results}
          this.handleLobbyHistoryUpdated(a)
        } else {
          // v2 멀티소켓 맵 형식: args = {<tableId>: {results:[...]}}
          this.handleV2HistoryMap(a as Record<string, unknown>)
        }
        return { type: msgType, data: data.args }
      }

      if (data.args?.historyUpdated) {
        this.handleLobbyHistoryUpdated(data.args.historyUpdated)
        return { type: 'lobby.historyUpdated', data: data.args.historyUpdated }
      }

      if (msgType === 'lobby.histories' && data.args) {
        this.handleV2HistoryMap(data.args as Record<string, unknown>)
        return { type: msgType, data: data.args }
      }

      // ✅ baccarat.newGame - 새 게임 시작 (타이머 리셋)
      if (msgType === 'baccarat.newGame' && data.args) {
        this.handleNewGame(data.args)
        return { type: msgType, data: data.args }
      }

      // ✅ baccarat.cardDealt - 카드 딜링 (실시간 카드 업데이트)
      if (msgType === 'baccarat.cardDealt' && data.args) {
        this.handleCardDealt(data.args)
        return { type: msgType, data: data.args }
      }

      // betting stats / player betting state → phase update
      if ((msgType === 'baccarat.bettingStats' || msgType === 'baccarat.playerBettingState' || msgType === 'baccarat.playerBetResponse') && data.args) {
        this.handleBettingState(data.args, msgType)
        return { type: msgType, data: data.args }
      }

      // lobby.configs (lobby v2) - 테이블 메타데이터(한글명 title, 게임타입 gt). 방 이름/필터 소스.
      // 라이브 캡처(2026-06-10)로 확인: args.configs = { <tableId>: { gt:"baccarat", title:"코리안 스피드 바카라 B", ... } }
      // lobby.categories는 ID만 주므로, 여기서 한글명을 캐시해 두고 방 생성 시 갖다 쓴다.
      if (msgType === 'lobby.configs' && data.args?.configs) {
        this.handleLobbyConfigs(data.args.configs as Record<string, { title?: string; gt?: string }>)
        return { type: 'lobby.configs', data: data.args }
      }

      // lobby.categories - 방 목록
      if (msgType === 'lobby.categories' && data.args?.categories) {
        this.handleLobbyCategories(data.args.categories)
        return { type: 'lobby.categories', data: data.args }
      }

      if (msgType === 'widget.availableTables' && data.args?.availableTables) {
        this.handleAvailableTables(data.args.availableTables)
        return { type: msgType, data: data.args }
      }

      // lobby.balanceUpdated - 잔액 업데이트 (다양한 형식 지원)
      if (msgType === 'lobby.balanceUpdated' || msgType === 'balanceUpdated') {
        const args = data.args || data
        // 다양한 형식 지원: args.balances, args.balance, args 직접
        const balanceData = args?.balances || args?.balance || args
        if (balanceData) {
          this.handleBalanceUpdated(balanceData, args)
          return { type: 'lobby.balanceUpdated', data: args }
        } else {
        }
      }

      // game.balanceUpdated - 게임 중 잔액 업데이트
      if (msgType === 'game.balanceUpdated' && data.args) {
        const balanceData = data.args.balances || data.args.balance || data.args
        if (balanceData) {
          this.handleBalanceUpdated(balanceData, data.args)
          return { type: 'game.balanceUpdated', data: data.args }
        }
      }

      return null
    } catch {
      return null
    }
  }

  processMessage(raw: string, contextTableId?: string): void {
    this.parseMessage(raw, contextTableId)
  }

  // ==================== Lobby Categories ====================
  /** lobby.configs 처리: 테이블 메타(한글명 title / 게임타입 gt)를 캐시한다. 방 생성은 lobby.categories에서. */
  private handleLobbyConfigs(configs: Record<string, { title?: string; gt?: string }>): void {
    if (!configs || typeof configs !== 'object') return
    for (const [tableId, cfg] of Object.entries(configs)) {
      if (!cfg || typeof cfg !== 'object') continue
      this.tableMeta.set(tableId, { title: cfg.title, gt: cfg.gt })
    }
  }

  private handleLobbyCategories(categories: Array<{ id?: string; tables?: unknown }>): void {
    const updatedRooms: Room[] = []

    categories.forEach((category) => {
      // 🔧 [LOBBY-V2 2026-06-10] lobby v2: 'baccarat' 카테고리에 전체 바카라 테이블 ID가
      // **평문 문자열 배열**로 온다(예: "onokyd4wn7uekbjx"). 일부는 합성 콜론 ID
      // (예: "KoPTBaccarat0001:swkbnct6r3nqifjf")인데 ROOM_MAPPING 키와 동일하게 **전체가 tableId**다.
      // 구버전은 "id:name" 형태였는데, split(':') 후 length>=2만 받던 옛 코드가 평문 ID 94/98개를
      // 통째로 버려서 "방 1개만" 떴다. 이제 콜론 분리 없이 entry 전체를 tableId로 쓰고, 한글명은
      // lobby.configs(tableMeta) → ROOM_MAPPING 순으로 붙인다.
      if (!category?.id?.includes('baccarat') || !Array.isArray(category.tables)) return

      category.tables.forEach((entry) => {
        if (typeof entry !== 'string' || !entry) return
        const tableId = entry
        const koreanName = ROOM_MAPPING[tableId] || this.tableMeta.get(tableId)?.title

        // 이름을 아는 경우에만 라이트닝/살롱/RNG 제외 필터를 적용한다(이름 없으면 카테고리 멤버십을
        // 신뢰해 포함 — 암호 ID 전체 바카라 표시). v2BaccaratTables에 넣어 ensureRoom의 이름필터도 우회.
        if (koreanName && !shouldIncludeRoom(tableId, koreanName)) return
        this.v2BaccaratTables.add(tableId)

        const existing = this.rooms.get(tableId)
        const displayName = koreanName || existing?.koreanName || tableId
        const room: Room = {
          id: tableId,
          name: existing?.name || displayName,
          koreanName: displayName,
          history: existing?.history || [],
          gameCount: existing?.gameCount || 0,
        }
        this.rooms.set(tableId, room)
        // 테이블별 기본 설정/통화 초기화(배팅 블로킹 방지) — ensureRoom과 동일 규칙.
        if (!this.tableConfigs.has(tableId)) this.tableConfigs.set(tableId, { ...this.tableConfig })
        if (!this.tableCurrencies.has(tableId)) this.tableCurrencies.set(tableId, this.currencyCode)
        updatedRooms.push(room)
      })
    })

    if (updatedRooms.length > 0) {
      this.emitRoomUpdate(Array.from(this.rooms.values()))
    }
  }

  private handleAvailableTables(tables: Array<Record<string, unknown>>): void {
    const updatedRooms: Room[] = []

    tables.forEach((table) => {
      const tableId = (table.tableId || table.id || table.table_id) as string | undefined
      const tableName = (table.tableName || table.name || table.table_name) as string | undefined
      if (!tableId) return

      const room = this.ensureRoom(tableId, tableName)
      if (room) updatedRooms.push(room)
    })

    if (updatedRooms.length > 0) {
      this.emitRoomUpdate(Array.from(this.rooms.values()))
    }
  }

  /**
   * v2 lobby.historyUpdated / lobby.histories 공통 처리.
   * args = {<tableId>: {results:[...]}} 맵. 각 테이블의 results 형식으로 바카라 여부를 판별해
   * (드래곤타이거/식보/룰렛/크랩스 제외) 바카라만 방으로 생성한다. 암호 ID도 데이터로 바카라가
   * 입증되면 포함한다 → 전체 바카라 멀티방이 표시됨.
   */
  private handleV2HistoryMap(argsMap: Record<string, unknown>): void {
    const source = ((argsMap as any).histories as Record<string, unknown> | undefined) || argsMap
    if (!source || typeof source !== 'object') return

    Object.entries(source).forEach(([tableId, value]) => {
      if (!tableId || !value || typeof value !== 'object') return
      const results = (value as { results?: unknown }).results
      if (!Array.isArray(results) || results.length === 0) return
      if (!this.isBaccaratV2Results(results)) return // 비-바카라 게임 제외
      this.v2BaccaratTables.add(tableId)
      this.handleLobbyHistoryUpdated({ tableId, results })
    })
  }

  /** results 첫 항목 형식으로 바카라 판별. 바카라: c="R"|"B"(또는 "Banker"/"Player"/"Tie"). */
  private isBaccaratV2Results(results: unknown[]): boolean {
    const first = results[0]
    if (typeof first === 'string') {
      return /^(b|p|t|banker|player|tie)$/i.test(first.trim())
    }
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const f = first as Record<string, unknown>
      // 비-바카라 형식 배제: 드래곤타이거(color/oddEven/lightning), 식보(value), 룰렛(number)
      if ('color' in f || 'value' in f || 'number' in f || 'oddEven' in f || 'lightning' in f) return false
      const c = String(f.c ?? '').toUpperCase()
      return c === 'R' || c === 'B'
    }
    return false // 룰렛([{number}]) / 크랩스(raw int) 등
  }

  private handleLobbyHistoryUpdated(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return

    const data = ((raw as any).historyUpdated || raw) as Record<string, unknown>
    const tableId =
      (data.tableId as string | undefined) ||
      (data.table_id as string | undefined) ||
      ((data.table as Record<string, unknown> | undefined)?.id as string | undefined)

    if (!tableId) return

    const historyData = this.extractHistoryData(data)
    if (historyData && historyData.length > 0) {
      this.processShoeHistory(tableId, { ...data, tableId }, historyData)
      return
    }

    const winner = this.extractWinner(data)
    if (winner) {
      const result = (data.result || data.gameResult || data) as Record<string, unknown>
      this.handleGameState({
        tableId,
        result: {
          winner,
          playerScore: result.playerScore ?? result.pScore,
          bankerScore: result.bankerScore ?? result.bScore,
          playerPair: result.playerPair ?? result.pPair,
          bankerPair: result.bankerPair ?? result.bPair,
        },
      })
    }
  }

  private extractHistoryData(data: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
    const keys = ['history_v2', 'history', 'results', 'roadmap', 'shoe'] as const
    for (const key of keys) {
      const value = data[key]
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>
    }

    const roads = data.roads as Record<string, unknown> | undefined
    if (roads) {
      const bigRoad = roads.bigRoad || roads.roadmap
      if (Array.isArray(bigRoad)) return bigRoad as Array<Record<string, unknown>>
    }

    return undefined
  }

  private extractWinner(data: Record<string, unknown>): Winner | null {
    const fromString = (raw: unknown): Winner | null => {
      if (typeof raw !== 'string') return null
      const s = raw.toLowerCase()
      if (s.startsWith('b')) return 'B'
      if (s.startsWith('p')) return 'P'
      if (s.startsWith('t')) return 'T'
      return null
    }

    const direct = fromString(data.winner) || fromString(data.outcome)
    if (direct) return direct

    const result = data.result as Record<string, unknown> | undefined
    const fromResult = result ? fromString(result.winner) || fromString(result.outcome) : null
    if (fromResult) return fromResult

    const gameResult = data.gameResult as Record<string, unknown> | undefined
    return gameResult ? fromString(gameResult.winner) || fromString(gameResult.outcome) : null
  }

  // ==================== Balance Updated ====================
  private handleBalanceUpdated(balanceData: unknown, args?: unknown): void {
    let balance: number | null = null

    // ✅ currencyCode 추출 (from full args)
    if (args && typeof args === 'object') {
      const a = args as Record<string, unknown>
      if (typeof a.currencyCode === 'string') {
        this.currencyCode = a.currencyCode
        // 이미 알려진 테이블들에 통화 동기화 (fallback)
        this.rooms.forEach((_room, id) => {
          this.tableCurrencies.set(id, this.currencyCode)
        })
      }
    }

    // 다양한 형식 지원
    if (typeof balanceData === 'number') {
      balance = balanceData
    }
    else if (typeof balanceData === 'string') {
      const cleaned = balanceData.replace(/,/g, '')
      const parsed = Number(cleaned)
      if (!Number.isNaN(parsed)) {
        balance = parsed
      } else {
      }
    }
    // ✅ Array handling (e.g., [{id:'combined', amount:0}, ...])
    else if (Array.isArray(balanceData) && balanceData.length > 0) {
      const combined = balanceData.find((b: any) => b.id === 'combined')
      const main = balanceData.find((b: any) => b.id === 'main')
      const target = combined || main || balanceData[0]

      if (target && typeof target.amount === 'number') {
        balance = target.amount
      } else {
      }
    }
    // Object handling
    else if (typeof balanceData === 'object' && balanceData !== null) {
      const bd = balanceData as Record<string, unknown>
      // Evolution 형식: { combined: number, main: number }
      if (typeof bd.combined === 'number') {
        balance = bd.combined
      }
      else if (typeof bd.main === 'number') {
        balance = bd.main
      }
      // 대안 형식: { balance: number } or { amount: number }
      else if (typeof bd.balance === 'number') {
        balance = bd.balance
      }
      else if (typeof bd.amount === 'number') {
        balance = bd.amount
      }
      // KRW 등 통화별 형식: { KRW: number }
      else {
        const numVal = Object.values(bd).find(v => typeof v === 'number')
        if (typeof numVal === 'number') {
          balance = numVal
        } else {
        }
      }
    } else {
    }

    if (balance !== null && balance !== this.lastBalance) {
      this.lastBalance = balance
      this.emitBalanceUpdate(balance)
    } else if (balance !== null && balance === this.lastBalance) {
    }
  }

  // ==================== Table State / Game State ====================
  private ensureRoom(tableId: string, tableName?: string): Room | null {
    const existing = this.rooms.get(tableId)
    const effectiveName = tableName || existing?.name || tableId

    // 동적 필터링: 라이트닝/살롱/RNG 제외, 바카라만 포함.
    // 단, v2 결과 형식으로 바카라가 입증된 테이블(암호 ID)은 이름 패턴 필터를 우회한다.
    if (!this.v2BaccaratTables.has(tableId) && !shouldIncludeRoom(tableId, effectiveName)) return null

    // 한글명 매핑 (있으면 사용, 없으면 원본 이름 사용)
    const koreanName = ROOM_MAPPING[tableId] || effectiveName

    const room: Room = {
      id: tableId,
      name: effectiveName,
      koreanName,
      history: existing?.history || [],
      gameCount: existing?.gameCount || 0,
      lastResultTime: existing?.lastResultTime,
      remainingSeconds: existing?.remainingSeconds,
      phase: existing?.phase,
    }
    this.rooms.set(tableId, room)

    // 테이블별 기본 설정/통화가 없으면 전역 기본으로 초기화하여 배팅 블로킹 방지
    if (!this.tableConfigs.has(tableId)) {
      this.tableConfigs.set(tableId, { ...this.tableConfig })
    }
    if (!this.tableCurrencies.has(tableId)) {
      this.tableCurrencies.set(tableId, this.currencyCode)
    }

    return room
  }

  private handleTableState(args: Record<string, unknown>): void {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) return

    // 🔧 [GAMEID-FIX 2026-06-10] 실시간 gameId 추적: 멀티테이블 모드에서는 newGame/gameState 프레임이
    // 오지 않고 gameId가 오직 baccarat.tableState.currentGame.gameId 로만 온다(라이브 덤프 확인).
    // 여기서 안 잡으면 getCurrentGameId()=null → ensureGameId()가 synthetic-… 을 만들고, 실배팅이 그
    // stale/synthetic gameId로 나가 Evolution이 칩만 받고 '잘못된'(현재 라운드 불일치)으로 무효 처리한다
    // → "돈은 나가는데 잘못됨"의 근본 원인(사용자 라이브 2026-06-10). 매 tableState마다 최신값으로 갱신.
    const currentGameId = (args as any)?.currentGame?.gameId as string | undefined
    if (currentGameId && typeof currentGameId === 'string' && !currentGameId.startsWith('synthetic-')) {
      this.currentGameIds.set(tableId, currentGameId)
    }

    const tableName = (args as any)?.tableName as string | undefined

    // Try multiple possible paths for time remaining and betting status
    // ✅ 수정: timeInitial, timeRemaining 등 다양한 필드 지원
    // 남은 시간(timeRemaining)과 창 길이(timeInitial)는 다른 값이다 — 마감 뒤 오는 프레임엔
    // timeInitial만 남는데 예전엔 그걸 남은 시간으로 읽어 마감 후에도 13초가 떠 있었다.
    const cg = (args as any)?.currentGame
    const rawTimeRemaining = toMillis(
      cg?.timeRemaining ?? cg?.timeRemainingMs ??
      (args as any)?.timeRemaining ?? (args as any)?.timeRemainingMs ??
      (args as any)?.betTime ?? (args as any)?.betTimeInMs
    )
    const windowMsTS = toMillis(cg?.timeInitial ?? (args as any)?.timeInitial) ?? rawTimeRemaining
    const bettingStatus =
      (args as any)?.currentGame?.betting ??
      (args as any)?.betting ??
      (args as any)?.state ??
      undefined

    // ROOM_MAPPING에 있는 테이블만 처리
    const room = this.ensureRoom(tableId, tableName)
    if (!room) return  // 라이트닝 등 제외된 테이블은 무시

    let phase: GamePhase | undefined = room.phase
    if (bettingStatus) {
      const statusLower = String(bettingStatus).toLowerCase()
      if (statusLower.includes('open') || statusLower.includes('betting') || statusLower.includes('bet')) phase = 'betting'
      else if (statusLower.includes('closed') || statusLower.includes('deal') || statusLower.includes('no_more')) phase = 'dealing'
      else if (statusLower.includes('result') || statusLower.includes('resolved')) phase = 'result'
    }

    let remainingSeconds = room.remainingSeconds
    if (rawTimeRemaining !== undefined) {
      remainingSeconds = Math.max(0, Math.min(Math.ceil(rawTimeRemaining / 1000), MAX_TIMER_SECONDS))
    }

    // Game Data (Live Scores/Cards) - 빈 카드 배열이면 기존 데이터 유지
    const gameData = (args as any)?.currentGame?.gameData || (args as any)?.gameData
    let gameState: any = room.gameState // 기존 gameState 유지
    if (gameData) {
      const hasPlayerCards = gameData.playerHand?.cards?.length > 0
      const hasBankerCards = gameData.bankerHand?.cards?.length > 0

      // 카드가 있거나 점수가 있는 경우에만 업데이트
      if (
        hasPlayerCards ||
        hasBankerCards ||
        gameData.playerHand?.score !== undefined ||
        gameData.bankerHand?.score !== undefined
      ) {
        gameState = {
          playerHand: {
            cards: hasPlayerCards ? gameData.playerHand.cards : (room.gameState?.playerHand?.cards || []),
            score: gameData.playerHand?.score ?? room.gameState?.playerHand?.score
          },
          bankerHand: {
            cards: hasBankerCards ? gameData.bankerHand.cards : (room.gameState?.bankerHand?.cards || []),
            score: gameData.bankerHand?.score ?? room.gameState?.bankerHand?.score
          }
        }
      }
    }

    const openWithTimer = phase === 'betting' && rawTimeRemaining !== undefined && remainingSeconds !== undefined && remainingSeconds > 0
    const deadlineAt = openWithTimer && rawTimeRemaining !== undefined ? Date.now() + rawTimeRemaining : undefined
    this.rooms.set(tableId, {
      ...room,
      phase,
      remainingSeconds: phase === 'betting' ? remainingSeconds : 0,
      bettingDeadlineAt: deadlineAt ?? (phase === 'betting' ? room.bettingDeadlineAt : undefined),
      bettingWindowMs: windowMsTS ?? room.bettingWindowMs,
      gameState,
    })
    this.emitRoomUpdate(Array.from(this.rooms.values()))

    // 베팅 오픈 상태면 타이머 이벤트도 전파 (멀티테이블 타이머 동기화)
    if (openWithTimer && remainingSeconds !== undefined) {
      this.emitBettingPhase({
        roomId: tableId,
        remainingSeconds,
        phase: 'start',
        deadlineAt,
        windowMs: windowMsTS ?? rawTimeRemaining,
      })
    }
  }

  private handleEncodedShoeState(args: Record<string, unknown>): void {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) {
      return
    }

    // Try multiple possible history field names
    const historyV2 = (args as any)?.history_v2 as Array<Record<string, unknown>> | undefined
    const history = (args as any)?.history as Array<Record<string, unknown>> | undefined
    const results = (args as any)?.results as Array<Record<string, unknown>> | undefined
    const roadmap = (args as any)?.roadmap as Array<Record<string, unknown>> | undefined
    const shoe = (args as any)?.shoe as Array<Record<string, unknown>> | undefined
    const roadmapObj = (args as any)?.roads as Record<string, unknown> | undefined

    // Log for debugging
    const availableKeys = Object.keys(args).filter(k => Array.isArray((args as any)[k]))
    if (availableKeys.length > 0) {
    }

    const findNestedArray = (): Array<Record<string, unknown>> | undefined => {
      // direct array on args.* already handled above
      for (const val of Object.values(args)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
          return val as Array<Record<string, unknown>>
        }
        if (val && typeof val === 'object') {
          for (const nested of Object.values(val as Record<string, unknown>)) {
            if (Array.isArray(nested) && nested.length > 0 && typeof nested[0] === 'object') {
              return nested as Array<Record<string, unknown>>
            }
          }
        }
      }
      return undefined
    }

    // Pick the first available history source
    const roadmapGrid = roadmapObj
      ? (roadmapObj.bigRoad as Array<Record<string, unknown>> | undefined) ||
      (roadmapObj.roadmap as Array<Record<string, unknown>> | undefined)
      : undefined

    const historyData = historyV2 || history || results || roadmap || roadmapGrid || shoe
    if (!historyData || historyData.length === 0) {
      const altHistory = findNestedArray()
      if (altHistory && altHistory.length > 0) {
        this.processShoeHistory(tableId, args, altHistory)
        return
      }
      return
    }

    this.processShoeHistory(tableId, args, historyData)
  }

  private processShoeHistory(tableId: string, args: Record<string, unknown>, historyData: Array<Record<string, unknown>>): void {
    // ROOM_MAPPING에 없는 테이블은 무시 (라이트닝 등 제외)
    let room: Room | undefined = this.rooms.get(tableId)
    const koreanName = room?.koreanName || ROOM_MAPPING[tableId] || tableId

    // First check if room already exists (may have been created by tableState)

    // If not, try ensureRoom (for ROOM_MAPPING tables)
    if (!room) {
      const ensured = this.ensureRoom(tableId, (args as any)?.tableName as string | undefined)
      if (ensured) room = ensured
    }

    // ensureRoom이 null 반환하면 (ROOM_MAPPING에 없으면) 무시
    if (!room) return

    const parsedHistory = this.parseHistoryAuto(historyData)
    const isInitialized = this.initializedRooms.has(tableId)

    // 🔥 슈 체인지 감지: 히스토리 길이가 줄어들면 새 슈 시작
    const prevLen = room.history?.length ?? 0
    if (isInitialized && room.history && parsedHistory.length < room.history.length) {
      // [진단] 슈 체인지가 실제로 감지될 때 — 이게 찍혀야 빠진 방이 재진입한다.
      console.log(`[SHOE] 🔄 슈 체인지 감지 ${koreanName}(${tableId}): ${prevLen} → ${parsedHistory.length}`)
      this.longShoeWarned.delete(tableId)
      this.initializedRooms.delete(tableId)
      this.lastHistoryLengths.delete(tableId)
      this.emitShoeChange(tableId, koreanName)
    } else if (isInitialized && parsedHistory.length > 90 && !this.longShoeWarned.has(tableId)) {
      // [진단] 정상 바카라 슈는 ~60-80판. 90을 넘는데도 리셋이 안 됐다면 히스토리가
      // 슈별로 리셋되지 않고 누적/롤링되는 것 → "히스토리 길이 감소" 기반 슈 감지가 영영
      // 안 떠서 한번 빠진 방이 재진입 못 하는 원인. 방당 한 번만 경고.
      this.longShoeWarned.add(tableId)
      console.warn(`[SHOE] ⚠️ ${koreanName}(${tableId}) 히스토리 길이=${parsedHistory.length} — 슈 리셋이 안 됨(누적 의심). 슈 경계 감지 실패 가능성.`)
    }

    // 변경 없으면 불필요한 emit 건너뛴다
    const isSameHistory = room?.history
      ? this.historiesEqual(room.history, parsedHistory)
      : false
    if (room && isSameHistory) {
      return
    }

    // ✅ 초기화 상태 및 길이 추적 업데이트
    if (!this.initializedRooms.has(tableId)) {
      this.initializedRooms.add(tableId)
    }
    this.lastHistoryLengths.set(tableId, parsedHistory.length)

    const updated: Room = {
      ...room,
      history: parsedHistory,
      gameCount: parsedHistory.length,
      lastResultTime: Date.now(),
    }
    this.rooms.set(tableId, updated)
    this.emitHistoryUpdate(tableId, parsedHistory)
    this.emitRoomUpdate(Array.from(this.rooms.values()))

    // ✅ 히스토리 증가 감지 시 GameResult emit (로비 모드 + 승률 체크용)
    // 중복 방지: lastEmittedResults로 이미 emit된 결과는 스킵
    const previousLength = room.history?.length || 0
    if (isInitialized && parsedHistory.length > previousLength && parsedHistory.length > 0) {
      const latestResult = parsedHistory[0]

      // 중복 체크: 이미 emit된 결과인지 확인
      const lastEmitted = this.lastEmittedResults.get(tableId)
      const isDuplicate = lastEmitted &&
        lastEmitted.winner === latestResult.winner &&
        lastEmitted.historyLength === parsedHistory.length

      if (!isDuplicate) {
        console.log(`[EvolutionAdapter] 📤 ShoeHistory GameResult emit: ${tableId}, winner=${latestResult.winner}, len=${parsedHistory.length}`)

        this.emitGameResult({
          roomId: tableId,
          winner: latestResult.winner,
          isPlayerPair: latestResult.isPlayerPair,
          isBankerPair: latestResult.isBankerPair,
          playerScore: latestResult.playerScore,
          bankerScore: latestResult.bankerScore,
          history: parsedHistory,
        })

        // ⛔ 히스토리 갱신 직후 가짜 'start'(12초)를 쏘지 않는다. 결과가 뜬 시점엔 다음 라운드가 아직
        //   열리지 않았고(실측: 결과 → 약 5초 뒤 BetsOpen), 여기서 시작을 알리면 자동배팅이 끝난 라운드
        //   gameId로 즉시 배팅해 Evolution이 무시한다(2026-09-02 라이브 3차: 7초 창 테이블, 마감 10초 뒤 전송).
        //   시작 신호는 baccarat.gameState BetsOpen(실제 timeRemaining 포함) 하나만 쓴다.
      }
    }
  }

  private historiesEqual(a: RoadResult[], b: RoadResult[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const x = a[i]
      const y = b[i]
      if (
        x.winner !== y.winner ||
        x.isPlayerPair !== y.isPlayerPair ||
        x.isBankerPair !== y.isBankerPair ||
        x.playerScore !== y.playerScore ||
        x.bankerScore !== y.bankerScore
      ) {
        return false
      }
    }
    return true
  }

  // Auto-detect history format and parse
  private parseHistoryAuto(historyData: Array<Record<string, unknown>>): RoadResult[] {
    if (historyData.length === 0) return []

    // Normalize possible formats:
    // - winner as string ("Banker"/"B")
    // - winner as object ({ winner: "Banker" } or { type: "banker" })
    // - color shorthand (c/color), roadmap pos
    const sample = historyData[0]

    const hasWinnerField = 'winner' in sample || 'result' in sample || 'outcome' in sample
    const hasColorField = 'c' in sample || 'color' in sample || 'pos' in sample

    if (hasWinnerField) {
      return this.parseHistoryFromHistoryV2(historyData)
    }

    if (hasColorField) {
      return this.parseHistoryFromResults(historyData as any)
    }

    return this.parseHistoryFromHistoryV2(historyData)
  }

  private handleGameState(args: Record<string, unknown>): void {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) return

    // 🔍 DEBUG 제거 - 메시지 형식 확인 완료

    // ✅ gameId 추출 및 저장 (Auto Betting용)
    const gameId = (args as any)?.gameId as string | undefined
    if (gameId) {
      this.currentGameIds.set(tableId, gameId)
    }

    // ROOM_MAPPING에 없는 테이블은 무시 (라이트닝 등 제외)
    if (!ROOM_MAPPING[tableId]) return

    // Try to get existing room or create via ensureRoom
    const room = this.rooms.get(tableId) || this.ensureRoom(tableId, (args as any)?.tableName as string | undefined)
    if (!room) return  // 라이트닝 등 제외된 테이블은 무시

    // ✅ 타이머 파싱 — 라이브 캡처(2026-09-02) 기준 baccarat.gameState는 BetsOpen 순간 한 번
    //   `timeRemaining`(ms, 예 13000)과 `timeInitial`(ms, 창 길이)을 준다. 이후 카운트다운 프레임은
    //   오지 않으므로 여기서 마감 시각을 절대시간으로 고정하고 UI가 그것을 기준으로 센다.
    //   BetsClosed 프레임엔 timeInitial만 남는다 — 그것을 남은 시간으로 읽으면 안 된다.
    const remainingMs = toMillis(
      (args as any)?.timeRemaining ?? (args as any)?.timeRemainingMs ?? (args as any)?.gameData?.timeRemaining
    )
    const windowMs = toMillis((args as any)?.timeInitial) ?? remainingMs

    let remainingSeconds: number | undefined = undefined
    if (remainingMs !== undefined) {
      remainingSeconds = Math.max(0, Math.min(Math.ceil(remainingMs / 1000), MAX_TIMER_SECONDS))
    }

    // 🔥 결과 추출: 두 가지 메시지 형식 지원
    // - baccarat.resolved: args.result.winner
    // - baccarat.gameState: args.gameData.result.winner
    const result = ((args as any)?.result || (args as any)?.gameData?.result) as Record<string, unknown> | undefined
    if (result && typeof result === 'object' && result.winner) {
      const winnerStr = (result.winner as string | undefined)?.toLowerCase() || ''
      const winner: Winner | null =
        winnerStr.startsWith('b') ? 'B' : winnerStr.startsWith('p') ? 'P' : winnerStr.startsWith('t') ? 'T' : null

      if (winner) {
        // ✅ 단일화된 중복 체크 로직 (Clean Architecture: 단일 책임)
        const currentLength = room.history?.length || 0
        const lastLength = this.lastHistoryLengths.get(tableId) || 0
        const lastProcessedGameId = this.lastProcessedGameIds.get(tableId)

        // 1차: gameId 기반 중복 체크 (가장 정확)
        if (gameId && lastProcessedGameId && gameId === lastProcessedGameId) {
          console.log(`[EvolutionAdapter] 🚫 중복 스킵 (gameId): ${tableId}, gameId=${gameId}`)
          return
        }

        // 2차: 히스토리 기반 중복 체크 (gameId 유무와 관계없이 항상 체크)
        const latestInHistory = room.history?.[0]
        const resultPlayerScore = typeof result.playerScore === 'number' ? result.playerScore : (result as any).pScore
        const resultBankerScore = typeof result.bankerScore === 'number' ? result.bankerScore : (result as any).bScore

        if (latestInHistory && currentLength >= lastLength && lastLength > 0) {
          // 최신 히스토리와 winner + 점수 모두 일치하면 중복
          if (latestInHistory.winner === winner &&
              latestInHistory.playerScore === resultPlayerScore &&
              latestInHistory.bankerScore === resultBankerScore) {
            console.log(`[EvolutionAdapter] 🚫 중복 스킵 (점수): ${tableId}, winner=${winner}, score=${resultPlayerScore}:${resultBankerScore}`)
            return
          }
        }

        // 3차: lastEmittedResults 기반 중복 체크 (emitGameResult 호출 전 사전 차단)
        const lastEmitted = this.lastEmittedResults.get(tableId)
        if (lastEmitted && lastEmitted.winner === winner && lastEmitted.historyLength === currentLength + 1) {
          console.log(`[EvolutionAdapter] 🚫 중복 스킵 (emit): ${tableId}, winner=${winner}, len=${currentLength + 1}`)
          return
        }

        // 중복 아님 - gameId 기록
        if (gameId) {
          this.lastProcessedGameIds.set(tableId, gameId)
        }

        console.log(`[EvolutionAdapter] ✅ 결과 처리: ${tableId}, winner=${winner}, gameId=${gameId || 'N/A'}, len=${currentLength}→${currentLength + 1}`)

        // 점수 추출
        const playerScore = typeof result.playerScore === 'number' ? result.playerScore
          : typeof (result as any).pScore === 'number' ? (result as any).pScore
            : undefined
        const bankerScore = typeof result.bankerScore === 'number' ? result.bankerScore
          : typeof (result as any).bScore === 'number' ? (result as any).bScore
            : undefined

        const parsed: RoadResult = {
          winner,
          isPlayerPair: Boolean(result.playerPair || result.playerpair),
          isBankerPair: Boolean(result.bankerPair || result.bankerpair),
          playerScore,
          bankerScore,
        }

        // 🔥 멀티소켓: 히스토리 업데이트 (단일 소스)
        const history = [parsed, ...(room.history || [])]
        this.lastHistoryLengths.set(tableId, history.length)


        const updated: Room = {
          ...room,
          history,
          gameCount: history.length,
          phase: 'result',
          lastResultTime: Date.now(),
          remainingSeconds: 0,
          bettingDeadlineAt: undefined,
        }
        this.rooms.set(tableId, updated)
        this.emitRoomUpdate(Array.from(this.rooms.values()))
        this.emitHistoryUpdate(tableId, history)

        // 🎯 실배팅 체결결과 추출(2026-06-23, baccarat.resolved): 내 베팅이 수락(acceptedBets)/거절
        // (rejectedBets, 예 error '1013'=최소금액 미달)됐는지를 정산에 전달한다. gameState에는 bets가
        // 없으므로 betOutcome=undefined → AutoMode는 기존 히스토리 추론으로 폴백.
        const betsRaw = (args as any)?.bets as Record<string, unknown> | undefined
        const winningSpotsRaw = (args as any)?.winningSpots
        const betOutcome = (betsRaw || Array.isArray(winningSpotsRaw))
          ? {
              gameId,
              winningSpots: Array.isArray(winningSpotsRaw) ? (winningSpotsRaw as string[]) : undefined,
              acceptedBets: betsRaw?.acceptedBets as Record<string, number> | undefined,
              rejectedBets: betsRaw?.rejectedBets as Record<string, { amount?: number; error?: string }> | undefined,
            }
          : undefined
        const placementConfirmations = betOutcome
          ? this.extractResolvedBetPlacementConfirmations(tableId, betOutcome)
          : []
        placementConfirmations.forEach(confirmation => this.emitBetPlacementConfirmation(confirmation))

        // 🔥 GameResult emit (AutoMode, SemiAuto 등에서 사용)
        this.emitGameResult({
          roomId: tableId,
          winner,
          isPlayerPair: parsed.isPlayerPair,
          isBankerPair: parsed.isBankerPair,
          playerScore: parsed.playerScore,
          bankerScore: parsed.bankerScore,
          betOutcome,
        })

        // ⛔ 결과 직후 가짜 'start'(12초)를 쏘지 않는다. 다음 라운드의 실제 BetsOpen 프레임(새 gameId +
        //   timeRemaining)이 시작 신호다. 예전엔 여기서 즉시 시작을 알려 마틴 재배팅이 끝난 라운드의
        //   gameId로 나가 Evolution이 무시했고(2026-09-02 라이브: 마틴 2만 미등록), 타이머도 결과
        //   직후부터 11초 거짓 카운트다운을 했다. 실제 다음 BetsOpen은 결과 후 약 5초 뒤에 온다.

        return
      }
    }

    // ✅ 베팅 상태 처리 - BetsOpen/BetsClosed 감지
    const betting = (args as any)?.betting as string | undefined
    let phase: GamePhase | undefined = room.phase
    let shouldEmitBettingPhase = false

    // 🔥 DEBUG: Log betting field for analysis

    let bettingClosedNow = false
    if (betting) {
      const bettingLower = betting.toLowerCase()
      if (bettingLower.includes('open') || bettingLower === 'betsopen') {
        phase = 'betting'
        // ✅ 베팅 오픈 시 타이머와 함께 betting phase emit
        if (remainingSeconds !== undefined && remainingSeconds > 0) {
          shouldEmitBettingPhase = true
        }
      } else if (bettingLower.includes('closed') || bettingLower === 'betsclosed') {
        phase = 'dealing'
        bettingClosedNow = true
      }
    }

    // ✅ dealing 상태 감지
    const dealing = (args as any)?.dealing as string | undefined
    if (dealing) {
      const dealingLower = dealing.toLowerCase()
      if (dealingLower === 'dealing' || dealingLower === 'revealing') {
        phase = 'dealing'
      } else if (dealingLower === 'finished') {
        phase = 'result'
      }
    }

    // Live GameState update (cards/scores during game)
    const gameData = (args as any)?.gameData
    let gameState = room.gameState
    if (gameData) {
      const hasPlayerCards = gameData.playerHand?.cards?.length > 0
      const hasBankerCards = gameData.bankerHand?.cards?.length > 0

      // 카드나 점수가 있는 경우에만 gameState 업데이트
      if (
        hasPlayerCards ||
        hasBankerCards ||
        gameData.playerHand?.score !== undefined ||
        gameData.bankerHand?.score !== undefined
      ) {
        gameState = {
          playerHand: {
            cards: hasPlayerCards ? gameData.playerHand.cards : (room.gameState?.playerHand?.cards || []),
            score: gameData.playerHand?.score ?? room.gameState?.playerHand?.score
          },
          bankerHand: {
            cards: hasBankerCards ? gameData.bankerHand.cards : (room.gameState?.bankerHand?.cards || []),
            score: gameData.bankerHand?.score ?? room.gameState?.bankerHand?.score
          }
        }
      }
    }

    // 방 상태 업데이트 — 마감 시각은 절대시간으로 고정(UI·자동배팅이 같은 기준으로 센다)
    const now = Date.now()
    const deadlineAt = shouldEmitBettingPhase && remainingMs !== undefined ? now + remainingMs : undefined
    const wasBettingOpen = room.phase === 'betting' || room.bettingDeadlineAt !== undefined
    const updatedRoom: Room = {
      ...room,
      phase,
      remainingSeconds: bettingClosedNow ? 0 : (remainingSeconds ?? room.remainingSeconds),
      bettingDeadlineAt: deadlineAt ?? (bettingClosedNow || phase === 'result' ? undefined : room.bettingDeadlineAt),
      bettingWindowMs: windowMs ?? room.bettingWindowMs,
      gameState,
    }
    this.rooms.set(tableId, updatedRoom)
    this.emitRoomUpdate(Array.from(this.rooms.values()))

    // ✅ 베팅 페이즈 emit (BetsOpen일 때만). 마감(BetsClosed) 전환 순간엔 'end'를 한 번 알려
    //   UI 타이머를 즉시 지우고 자동배팅의 배팅 창 스냅샷을 정리한다.
    if (shouldEmitBettingPhase && remainingSeconds !== undefined) {
      this.emitBettingPhase({
        roomId: tableId,
        remainingSeconds,
        phase: 'start',
        deadlineAt,
        windowMs: updatedRoom.bettingWindowMs,
      })
    } else if (bettingClosedNow && wasBettingOpen) {
      this.emitBettingPhase({ roomId: tableId, remainingSeconds: 0, phase: 'end' })
    }
  }

  // ✅ 새 게임 시작 처리 - 카드 클리어, 베팅 페이즈 준비
  private handleNewGame(args: Record<string, unknown>): void {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) return

    // ✅ gameId 추출 및 저장 (Auto Betting용)
    const gameId = (args as any)?.gameId as string | undefined
    if (gameId) {
      this.currentGameIds.set(tableId, gameId)
    }

    // ROOM_MAPPING에 없는 테이블은 무시 (라이트닝 등 제외)
    if (!ROOM_MAPPING[tableId]) return

    const room = this.rooms.get(tableId) || this.ensureRoom(tableId)
    if (!room) return  // 라이트닝 등 제외된 테이블은 무시

    // 카드 상태는 유지(마지막 라운드 카드 표시)하고, 페이즈 betting으로 전환.
    // 남은 시간은 프레임이 준 값만 쓴다(고정 12초 금지 — 테이블마다 창 길이가 7~35초로 다르다).
    const newGameRemainingMs = toMillis((args as any)?.timeRemaining ?? (args as any)?.timeInitial)
    const updatedRoom: Room = {
      ...room,
      phase: 'betting',
      remainingSeconds: newGameRemainingMs !== undefined ? Math.ceil(newGameRemainingMs / 1000) : (room.remainingSeconds ?? 0),
      bettingDeadlineAt: newGameRemainingMs !== undefined ? Date.now() + newGameRemainingMs : room.bettingDeadlineAt,
      bettingWindowMs: toMillis((args as any)?.timeInitial) ?? room.bettingWindowMs,
    }
    this.rooms.set(tableId, updatedRoom)
    this.emitRoomUpdate(Array.from(this.rooms.values()))

    // ✅ newGame이 실제 남은 시간을 실어 왔을 때만 시작을 알린다(고정 12초 금지).
    //   멀티위젯에선 newGame과 같은 순간 gameState BetsOpen(timeRemaining 포함)이 따로 오므로
    //   보통 그쪽이 유일한 시작 신호가 된다. 테이블 창 길이는 7~35초로 달라 12초 가정은 틀린다.
    if (newGameRemainingMs !== undefined && newGameRemainingMs > 0) {
      this.emitBettingPhase({
        roomId: tableId,
        remainingSeconds: Math.ceil(newGameRemainingMs / 1000),
        phase: 'start',
        deadlineAt: updatedRoom.bettingDeadlineAt,
        windowMs: updatedRoom.bettingWindowMs,
      })
    }
  }

  // ✅ 카드 딜링 처리 - 실시간 카드 업데이트
  private handleCardDealt(args: Record<string, unknown>): void {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) return

    // ROOM_MAPPING에 없는 테이블은 무시 (라이트닝 등 제외)
    if (!ROOM_MAPPING[tableId]) return

    const room = this.rooms.get(tableId)
    if (!room) return

    const card = (args as any)?.card as string | undefined
    const spot = (args as any)?.spot as string | undefined
    const gameData = (args as any)?.gameData

    if (!card || !spot) return

    // gameData가 있으면 그것을 사용 (spot은 디버깅용으로 로깅 가능)
    if (gameData) {
      const hasPlayerCards = gameData.playerHand?.cards?.length > 0
      const hasBankerCards = gameData.bankerHand?.cards?.length > 0
      const playerScore = gameData.playerHand?.score
      const bankerScore = gameData.bankerHand?.score

      // score가 있어야 gameState 타입을 만족
      if ((hasPlayerCards || hasBankerCards) && (playerScore !== undefined || bankerScore !== undefined)) {
        const gameState = {
          playerHand: {
            cards: hasPlayerCards ? gameData.playerHand.cards : (room.gameState?.playerHand?.cards || []),
            score: playerScore ?? room.gameState?.playerHand?.score ?? 0,
          },
          bankerHand: {
            cards: hasBankerCards ? gameData.bankerHand.cards : (room.gameState?.bankerHand?.cards || []),
            score: bankerScore ?? room.gameState?.bankerHand?.score ?? 0,
          },
        }

        const updatedRoom: Room = {
          ...room,
          phase: 'dealing',
          gameState,
        }
        this.rooms.set(tableId, updatedRoom)
        this.emitRoomUpdate(Array.from(this.rooms.values()))
      }
    }
  }

  private extractBetPlacementConfirmations(
    args: Record<string, unknown>,
    source: 'playerBettingState' | 'playerBetResponse',
  ): BetPlacementConfirmation[] {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) return []

    const gameId = ((args as any)?.gameId || (args as any)?.currentGame?.gameId) as string | undefined
    const nestedState = (args as any)?.state
    const betsRaw = ((args as any)?.bets && typeof (args as any).bets === 'object')
      ? (args as any).bets as Record<string, unknown>
      : (nestedState && typeof nestedState === 'object')
        ? nestedState as Record<string, unknown>
        : args
    const acceptedBets = this.asBetAmountRecord((betsRaw as any)?.acceptedBets)
    const currentChips = this.asBetAmountRecord((betsRaw as any)?.currentChips)
    const rejectedBets = (betsRaw as any)?.rejectedBets as Record<string, unknown> | undefined
    const confirmations: BetPlacementConfirmation[] = []

    Object.entries(rejectedBets || {}).forEach(([spot, rejected]) => {
      const rejectedInfo = typeof rejected === 'object' && rejected !== null
        ? rejected as { amount?: number; error?: string }
        : {}
      confirmations.push({
        tableId,
        gameId,
        betType: this.spotToBetType(spot),
        amount: this.numberFromUnknown(rejected),
        status: 'rejected',
        accepted: false,
        rejected: true,
        error: rejectedInfo.error || 'Evolution rejected bet',
        source,
      })
    })

    const acceptedSpots = new Set([...Object.keys(acceptedBets), ...Object.keys(currentChips)])
    acceptedSpots.forEach(spot => {
      if (rejectedBets && Object.prototype.hasOwnProperty.call(rejectedBets, spot)) return
      const acceptedAmount = acceptedBets[spot]
      const amount = acceptedAmount && acceptedAmount > 0 ? acceptedAmount : currentChips[spot]
      if (!(amount > 0)) return
      confirmations.push({
        tableId,
        gameId,
        betType: this.spotToBetType(spot),
        amount,
        status: 'accepted',
        accepted: true,
        rejected: false,
        source,
      })
    })

    // Parse these live fields as corroborating state, but do not use them to
    // satisfy an exact waiter without a spot. They cannot identify betType.
    const totalAmount = this.numberFromUnknown((betsRaw as any)?.totalAmount)
    const hasBet = (betsRaw as any)?.HasBet === true || (betsRaw as any)?.hasBet === true
    if (confirmations.length === 0 && (hasBet || (typeof totalAmount === 'number' && totalAmount > 0))) {
      confirmations.push({
        tableId,
        gameId,
        amount: totalAmount,
        status: 'accepted',
        accepted: true,
        rejected: false,
        source,
      })
    }

    return confirmations
  }

  private extractResolvedBetPlacementConfirmations(tableId: string, betOutcome: BetOutcome): BetPlacementConfirmation[] {
    const confirmations: BetPlacementConfirmation[] = []
    Object.entries(betOutcome.rejectedBets || {}).forEach(([spot, rejectedInfo]) => {
      confirmations.push({
        tableId,
        gameId: betOutcome.gameId,
        betType: this.spotToBetType(spot),
        amount: rejectedInfo?.amount,
        status: 'rejected',
        accepted: false,
        rejected: true,
        error: rejectedInfo?.error || 'Evolution rejected bet',
        source: 'resolved',
      })
    })

    const acceptedBets = this.asBetAmountRecord(betOutcome.acceptedBets)
    Object.entries(acceptedBets).forEach(([spot, amount]) => {
      if (!(amount > 0)) return
      confirmations.push({
        tableId,
        gameId: betOutcome.gameId,
        betType: this.spotToBetType(spot),
        amount,
        status: 'accepted',
        accepted: true,
        rejected: false,
        source: 'resolved',
      })
    })
    return confirmations
  }

  private asBetAmountRecord(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object') return {}
    const record: Record<string, number> = {}
    Object.entries(value as Record<string, unknown>).forEach(([spot, raw]) => {
      const amount = this.numberFromUnknown(raw)
      if (typeof amount === 'number') record[spot] = amount
    })
    return record
  }

  private numberFromUnknown(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/,/g, ''))
      return Number.isFinite(parsed) ? parsed : undefined
    }
    if (value && typeof value === 'object') {
      const amount = (value as { amount?: unknown }).amount
      return this.numberFromUnknown(amount)
    }
    return undefined
  }

  private spotToBetType(spot: string): BetType | undefined {
    const normalized = spot.toLowerCase()
    if (normalized.includes('banker')) return 'Banker'
    if (normalized.includes('player')) return 'Player'
    if (normalized.includes('tie')) return 'Tie'
    return undefined
  }

  private handleBettingState(args: Record<string, unknown>, msgType?: string): void {
    const tableId = (args as any)?.tableId as string | undefined
    if (!tableId) return

    if (msgType === 'baccarat.playerBettingState' || msgType === 'baccarat.playerBetResponse') {
      const source = msgType === 'baccarat.playerBetResponse' ? 'playerBetResponse' : 'playerBettingState'
      this.extractBetPlacementConfirmations(args, source)
        .forEach(confirmation => this.emitBetPlacementConfirmation(confirmation))
    }

    // 💰 실잔액(서버 권위값): playerBettingState.state.balances = [{id:'combined', amount}] — 베팅 수락
    //   시점에 차감된 잔액이 온다. 게임의 CLIENT_BALANCE_UPDATED 포워딩과 함께 실시간 잔액의 두 소스.
    const balances = (args as any)?.state?.balances
    if (Array.isArray(balances) && balances.length > 0) {
      this.handleBalanceUpdated(balances)
    }

    const room = this.ensureRoom(tableId)
    if (!room) return

    // ⛔ 페이즈를 무조건 'betting'으로 덮지 않는다. state.status가 권위값이다:
    //   Betting → 배팅중(새 라운드; 이 프레임의 gameId가 새 라운드 id), Accepted → 마감/딜링,
    //   Settled → 결과, Idle/그 외 → 유지. 예전엔 결과 직후 오는 Settled 프레임이 방을 다시
    //   '배팅중'으로 뒤집어 마감 가드를 통과시켰고, 마틴 재배팅이 끝난 라운드 gameId로 나가
    //   Evolution이 무시했다(2026-09-02 라이브). bettingStats(공개 통계)는 페이즈를 건드리지 않는다.
    const status = String((args as any)?.state?.status ?? '').toLowerCase()
    let phase: GamePhase | undefined = room.phase
    if (msgType === 'baccarat.playerBettingState' || msgType === 'baccarat.playerBetResponse') {
      if (status === 'betting') {
        phase = 'betting'
        const gid = (args as any)?.gameId
        if (typeof gid === 'string' && gid && !gid.startsWith('synthetic-')) {
          this.currentGameIds.set(tableId, gid)
        }
      } else if (status === 'accepted') {
        phase = 'dealing'
      } else if (status === 'settled') {
        phase = 'result'
      }
    }

    const remainingMs = toMillis((args as any)?.timeRemaining)
    const remainingSeconds = remainingMs !== undefined
      ? Math.max(0, Math.min(Math.ceil(remainingMs / 1000), MAX_TIMER_SECONDS))
      : undefined

    this.rooms.set(tableId, {
      ...room,
      phase,
      remainingSeconds: remainingSeconds ?? room.remainingSeconds ?? 0,
      bettingDeadlineAt: phase === 'betting' ? room.bettingDeadlineAt : undefined,
    })
    this.emitRoomUpdate(Array.from(this.rooms.values()))
  }

  // ==================== History Parser ====================
  private parseHistoryFromResults(results: Array<{
    row?: number
    pos?: number[]
    ties?: number
    c?: string
    color?: string
    s?: number          // v2: 이긴 쪽 점수
    score?: number
    nat?: number
    pp?: number         // v2: 플레이어 페어
    bp?: number         // v2: 뱅커 페어
    pairs?: string[]
    pPair?: boolean
    playerPair?: boolean
    bPair?: boolean
    bankerPair?: boolean
  }>): RoadResult[] {
    const history: RoadResult[] = []

    results.forEach((item) => {
      const ties = item.ties ?? 0
      const colorField = item.c || item.color || ''

      // Winner 결정
      let winner: Winner
      if (colorField) {
        const c = colorField.toUpperCase()
        if (c === 'R' || c === 'RED') winner = 'B'
        else if (c === 'B' || c === 'BLUE') winner = 'P'
        else if (c === 'G' || c === 'GREEN') winner = 'T'
        else winner = 'P'
      } else {
        const row = item.pos?.[0] ?? item.row ?? 0
        winner = row % 2 === 1 ? 'B' : 'P'
      }

      // Pairs (v2는 pp/bp=1, 구형은 pairs/pPair/bPair)
      const pairs = item.pairs || []
      const isPlayerPair = Array.isArray(pairs) && pairs.length
        ? (pairs.includes('P') || pairs.includes('PLAYER'))
        : (item.pp === 1 || item.pPair === true || item.playerPair === true)
      const isBankerPair = Array.isArray(pairs) && pairs.length
        ? (pairs.includes('B') || pairs.includes('BANKER'))
        : (item.bp === 1 || item.bPair === true || item.bankerPair === true)

      // v2 로드맵은 '이긴 쪽 점수(s)'만 제공한다 → 승자 점수만 채운다(반대쪽은 데이터 없음 → undefined).
      const winScore = typeof item.s === 'number' ? item.s
        : typeof item.score === 'number' ? item.score
          : undefined
      const playerScore = winner === 'P' ? winScore : undefined
      const bankerScore = winner === 'B' ? winScore : undefined

      // 로드맵 results 형식: 셀 1개 = 승자(P/B) 1판 + 그 직후 발생한 타이 횟수(ties).
      // 라이브 경로(parseHistoryFromHistoryV2)·게임결과 경로(handleGameState)는 타이를
      // 별도 'T' 항목으로 히스토리에 넣으므로, 로비 경로도 동일하게 펼쳐 넣어야 한다.
      // 안 그러면 ① 타이 필터(tie_frequent/no_tie_room/tie_drought)가 타이를 0건으로
      // 오인하고 ② 빅로드·통계·입장 후 라이브 화면과 히스토리가 어긋난다(길이 차로
      // 거짓 슈체인지까지 유발). 빅로드 렌더러는 'T'를 직전 셀의 마크로 다시 접는다.
      history.push({
        winner,
        isPlayerPair,
        isBankerPair,
        playerScore,
        bankerScore,
      })
      // 이 셀 직후 타이들을 시간순으로 펼침(승자 다음 = 다음 승자 이전).
      for (let t = 0; t < ties; t++) {
        history.push({ winner: 'T', isPlayerPair: false, isBankerPair: false })
      }
    })

    return history.reverse() // newest-first
  }

  private parseHistoryFromHistoryV2(historyV2: Array<Record<string, unknown>>): RoadResult[] {
    const parseWinner = (item: Record<string, unknown>): Winner | null => {
      const fromString = (raw: string | undefined): Winner | null => {
        if (!raw) return null
        const s = raw.toLowerCase()
        if (s.startsWith('b')) return 'B'
        if (s.startsWith('p')) return 'P'
        if (s.startsWith('t')) return 'T'
        return null
      }

      // winner field could be string or object
      const w = item.winner as unknown
      if (typeof w === 'string') return fromString(w)
      if (w && typeof w === 'object') {
        const obj = w as Record<string, unknown>
        return fromString(
          (obj.winner as string | undefined) ||
          (obj.type as string | undefined) ||
          (obj.side as string | undefined) ||
          (obj.value as string | undefined) ||
          (obj.name as string | undefined)
        )
      }

      // result/outcome nested
      if (item.result && typeof item.result === 'object') {
        const obj = item.result as Record<string, unknown>
        const nested = fromString(
          (obj.winner as string | undefined) ||
          (obj.outcome as string | undefined) ||
          (obj.type as string | undefined)
        )
        if (nested) return nested
      }

      // color shorthand
      const color = (item as any)?.c || (item as any)?.color
      if (typeof color === 'string') {
        const c = color.toUpperCase()
        if (c === 'R' || c === 'RED') return 'B'
        if (c === 'B' || c === 'BLUE') return 'P'
        if (c === 'G' || c === 'GREEN') return 'T'
      }

      return null
    }

    const history: RoadResult[] = []
    let hasTimeField = false
    const times: number[] = []

    historyV2.forEach((item) => {
      const winner = parseWinner(item)
      if (!winner) return

      // Evolution API에서 점수 필드 추출 (다양한 필드명 지원)
      const playerScore = typeof item.playerScore === 'number'
        ? item.playerScore
        : typeof (item as any)?.result?.playerScore === 'number'
          ? (item as any).result.playerScore
          : typeof (item as any)?.player?.score === 'number'
            ? (item as any).player.score
            : typeof (item as any)?.pScore === 'number'
              ? (item as any).pScore
              : typeof (item as any)?.playerTotal === 'number'
                ? (item as any).playerTotal
                : undefined
      const bankerScore = typeof item.bankerScore === 'number'
        ? item.bankerScore
        : typeof (item as any)?.result?.bankerScore === 'number'
          ? (item as any).result.bankerScore
          : typeof (item as any)?.banker?.score === 'number'
            ? (item as any).banker.score
            : typeof (item as any)?.bScore === 'number'
              ? (item as any).bScore
              : typeof (item as any)?.bankerTotal === 'number'
                ? (item as any).bankerTotal
                : undefined

      history.push({
        winner,
        isPlayerPair: Boolean(
          (item as any).playerPair ||
          (item as any).player_pair ||
          (item as any).pPair ||
          (item as any)?.result?.playerPair ||
          (item as any)?.pairs?.player === true
        ),
        isBankerPair: Boolean(
          (item as any).bankerPair ||
          (item as any).banker_pair ||
          (item as any).bPair ||
          (item as any)?.result?.bankerPair ||
          (item as any)?.pairs?.banker === true
        ),
        playerScore,
        bankerScore,
      })

      const timeVal = (item as any)?.time ?? (item as any)?.timestamp ?? (item as any)?.ts
      if (typeof timeVal === 'number') {
        hasTimeField = true
        times.push(timeVal)
      }
    })

    // Detect ordering: if time exists and increasing, assume oldest-first -> reverse
    const shouldReverse = (() => {
      if (!hasTimeField || times.length < 2) return true // default behavior
      const first = times[0]
      const last = times[times.length - 1]
      return first < last
    })()

    return shouldReverse ? history.reverse() : history
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

  // 베팅 페이즈 이벤트 발생 (외부에서 호출 가능)
  triggerBettingPhase(roomId: string, remainingSeconds: number): void {
    const koreanName = ROOM_MAPPING[roomId]
    if (!koreanName) return

    const event: BettingPhaseEvent = {
      roomId,
      remainingSeconds,
      phase: remainingSeconds > 0 ? 'start' : 'end',
    }
    this.emitBettingPhase(event)
  }

  onHistoryUpdate(callback: HistoryUpdateCallback): () => void {
    this.historyUpdateCallbacks.push(callback)
    return () => {
      this.historyUpdateCallbacks = this.historyUpdateCallbacks.filter((cb) => cb !== callback)
    }
  }

  onShoeChange(callback: ShoeChangeCallback): () => void {
    this.shoeChangeCallbacks.push(callback)
    return () => {
      this.shoeChangeCallbacks = this.shoeChangeCallbacks.filter((cb) => cb !== callback)
    }
  }

  onBalanceUpdate(callback: BalanceUpdateCallback): () => void {
    this.balanceUpdateCallbacks.push(callback)
    // 이미 캐시된 잔액이 있으면 즉시 전달
    if (this.lastBalance !== null) {
      callback(this.lastBalance)
    }
    return () => {
      this.balanceUpdateCallbacks = this.balanceUpdateCallbacks.filter((cb) => cb !== callback)
    }
  }

  onBetPlacementConfirmation(callback: BetPlacementConfirmationCallback): () => void {
    this.betPlacementConfirmationCallbacks.push(callback)
    return () => {
      this.betPlacementConfirmationCallbacks = this.betPlacementConfirmationCallbacks.filter((cb) => cb !== callback)
    }
  }

  waitForBetConfirmation(
    request: { tableId: string; gameId?: string; betType: BetType; amount: number },
    timeoutMs = 2500,
  ): Promise<BetPlacementConfirmation> {
    return new Promise(resolve => {
      let waiterRef: BetConfirmationWaiter
      const timeoutId = setTimeout(() => {
        this.betConfirmationWaiters = this.betConfirmationWaiters.filter(waiter => waiter !== waiterRef)
        resolve({
          tableId: request.tableId,
          gameId: request.gameId,
          betType: request.betType,
          amount: request.amount,
          status: 'unknown',
          accepted: false,
          rejected: false,
          error: '실제 베팅 체결 확인 시간 초과',
          source: 'timeout',
        })
      }, timeoutMs)

      waiterRef = {
        ...request,
        timeoutId,
        resolve,
      }
      this.betConfirmationWaiters.push(waiterRef)
    })
  }

  // ==================== Event Emitters ====================
  // ✅ 스로틀링 제거 - 실시간 업데이트
  private emitRoomUpdate(_rooms?: Room[]): void {
    const rooms = Array.from(this.rooms.values())
    this.roomUpdateCallbacks.forEach((cb) => cb(rooms))
  }

  // ✅ 단일화: 최종 중복 방지 (handleGameState에서만 호출됨)
  // Clean Architecture: 단일 emit 경로로 중복 완전 차단
  private emitGameResult(event: GameResultEvent): void {
    const { roomId, winner } = event
    const last = this.lastEmittedResults.get(roomId)
    const now = Date.now()

    // 현재 히스토리 길이 가져오기
    const room = this.rooms.get(roomId)
    const currentHistoryLength = room?.history?.length || 0

    // 최종 중복 체크: 히스토리 길이 + winner 조합
    if (last && last.winner === winner && last.historyLength === currentHistoryLength) {
      return // 이미 handleGameState에서 로깅됨
    }

    // 결과 기록 후 emit
    this.lastEmittedResults.set(roomId, { winner, timestamp: now, historyLength: currentHistoryLength })
    this.gameResultCallbacks.forEach((cb) => {
      try {
        cb(event)
      } catch (_e) {
        // Silent error handling for production
      }
    })
  }

  private emitBettingPhase(event: BettingPhaseEvent): void {
    this.bettingPhaseCallbacks.forEach((cb) => cb(event))
  }

  private emitHistoryUpdate(roomId: string, history: RoadResult[]): void {
    this.historyUpdateCallbacks.forEach((cb) => cb(roomId, history))
  }

  private emitShoeChange(roomId: string, koreanName: string): void {
    this.shoeChangeCallbacks.forEach((cb) => cb(roomId, koreanName))
  }

  private emitBalanceUpdate(balance: number): void {
    this.balanceUpdateCallbacks.forEach((cb) => cb(balance))
  }

  private emitBetPlacementConfirmation(confirmation: BetPlacementConfirmation): void {
    this.betPlacementConfirmationCallbacks.forEach(cb => cb(confirmation))

    const matched = this.betConfirmationWaiters.filter(waiter => this.matchesBetConfirmation(waiter, confirmation))
    matched.forEach(waiter => {
      clearTimeout(waiter.timeoutId)
      waiter.resolve(confirmation)
    })
    if (matched.length > 0) {
      this.betConfirmationWaiters = this.betConfirmationWaiters.filter(waiter => !matched.includes(waiter))
    }
  }

  private matchesBetConfirmation(waiter: BetConfirmationWaiter, confirmation: BetPlacementConfirmation): boolean {
    if (waiter.tableId !== confirmation.tableId) return false
    if (waiter.gameId !== confirmation.gameId) return false
    if (waiter.betType !== confirmation.betType) return false
    if (waiter.amount !== confirmation.amount) return false
    return confirmation.status === 'accepted' || confirmation.status === 'rejected'
  }

  private clearBetConfirmationWaiters(
    error = 'Evolution 체결 확인 대기가 중단되었습니다',
    source: 'disconnect' | 'dispose' = 'disconnect',
  ): void {
    const waiters = this.betConfirmationWaiters
    this.betConfirmationWaiters = []
    waiters.forEach(waiter => {
      clearTimeout(waiter.timeoutId)
      waiter.resolve({
        tableId: waiter.tableId,
        gameId: waiter.gameId,
        betType: waiter.betType,
        amount: waiter.amount,
        status: 'unknown',
        accepted: false,
        rejected: false,
        error,
        source,
      })
    })
  }

  // ==================== Getters ====================
  getRooms(): Map<string, Room> {
    return this.rooms
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) || null
  }

  // ==================== Auto Betting Getters & Methods ====================

  /** Get current gameId for a table */
  getCurrentGameId(tableId: string): string | null {
    return this.currentGameIds.get(tableId) || null
  }

  /** Ensure a gameId exists for a table (fallback when CDP/state messages are missing) */
  ensureGameId(tableId: string): string {
    const existing = this.currentGameIds.get(tableId)
    if (existing) return existing
    const synthetic = `synthetic-${tableId}-${Date.now()}`
    this.currentGameIds.set(tableId, synthetic)
    return synthetic
  }

  /** Get currencyCode (from balanceUpdated) */
  getCurrencyCode(): string {
    return this.currencyCode
  }

  /** Get cached balance */
  getBalance(): number | null {
    return this.lastBalance
  }

  /** Manually update balance and emit (used when server balance is missing) */
  setBalance(newBalance: number): void {
    this.lastBalance = newBalance
    this.emitBalanceUpdate(newBalance)
  }

  /** Get table betting config */
  getTableConfig(tableId?: string): TableBettingConfig {
    if (tableId) {
      // Ensure per-table entry exists to avoid missing-config blocks
      if (!this.tableConfigs.has(tableId)) {
        this.tableConfigs.set(tableId, { ...this.tableConfig })
      }
      if (!this.tableCurrencies.has(tableId)) {
        this.tableCurrencies.set(tableId, this.currencyCode)
      }
      const perTable = this.tableConfigs.get(tableId)
      return perTable ? { ...perTable } : { ...this.tableConfig }
    }
    return { ...this.tableConfig }
  }

  /** Check if we have table-specific config captured */
  hasTableConfig(tableId: string): boolean {
    return this.tableConfigs.has(tableId)
  }

  /** Check if CDP로 실제 설정을 캡처했는지 */
  hasCapturedConfig(tableId: string): boolean {
    return this.capturedTables.has(tableId)
  }

  /** Check if we have currency info for a table (fallback to global) */
  hasTableCurrency(tableId: string): boolean {
    return this.tableCurrencies.has(tableId) || !!this.currencyCode
  }

  /** Update table config from CDP capture event */
  updateTableConfigFromCDP(data: Record<string, unknown>): void {
    const type = data.type as string
    const tableId = data.tableId as string | undefined

    if (type === 'chips_hidden') {
      // CLIENT_UNAVAILABLE_CHIPS_HIDDEN
      const originalChipStack = data.originalChipStack as number[] | undefined
      const channel = data.channel as string | undefined
      const orientation = data.orientation as 'landscape' | 'portrait' | undefined

      if (originalChipStack && Array.isArray(originalChipStack)) {
        // Filter out hidden chips
        const hiddenChips = data.hiddenChips as number[] | undefined
        const availableChips = hiddenChips
          ? originalChipStack.filter(c => !hiddenChips.includes(c))
          : originalChipStack
        this.tableConfig.chipStack = availableChips
        // 최소/최대 한도를 칩스택 기반으로 보정 (CDP에 tableMinLimit가 없는 경우 기본값 상향으로 인한 차단 방지)
        const minChip = Math.min(...availableChips)
        const maxChip = Math.max(...availableChips)
        this.tableConfig.tableMinLimit = Math.min(this.tableConfig.tableMinLimit, minChip)
        this.tableConfig.tableMaxLimit = Math.max(this.tableConfig.tableMaxLimit, maxChip)

        // 이미 알려진 모든 테이블에 동일한 구성 복사 (초기 캡처 대용)
        this.rooms.forEach((_room, id) => {
          this.tableConfigs.set(id, { ...this.tableConfig })
          this.tableCurrencies.set(id, this.currencyCode)
          this.capturedTables.add(id)
        })
      }
      if (channel) this.tableConfig.channel = channel
      if (orientation) this.tableConfig.orientation = orientation

      this.emitTableConfigUpdate({ ...this.tableConfig })
    }
    else if (type === 'bet_chip') {
      // CLIENT_BET_CHIP - more detailed config (테이블별 저장)
      const chipStack = data.chipStack as number[] | undefined
      const tableMinLimit = data.tableMinLimit as number | undefined
      const tableMaxLimit = data.tableMaxLimit as number | undefined
      const channel = data.channel as string | undefined
      const orientation = data.orientation as 'landscape' | 'portrait' | undefined
      const gameDimensions = data.gameDimensions as { width: number; height: number } | undefined
      const currency = data.currency as string | undefined
      const gameId = data.gameId as string | undefined
      const balanceRaw = data.balance as number | string | undefined

      // 전역 설정 업데이트 (fallback)
      if (chipStack && Array.isArray(chipStack)) this.tableConfig.chipStack = chipStack
      if (typeof tableMinLimit === 'number') this.tableConfig.tableMinLimit = tableMinLimit
      if (typeof tableMaxLimit === 'number') this.tableConfig.tableMaxLimit = tableMaxLimit
      if (channel) this.tableConfig.channel = channel
      if (orientation) this.tableConfig.orientation = orientation
      if (gameDimensions) this.tableConfig.gameDimensions = gameDimensions
      if (currency) this.currencyCode = currency

      // 테이블별 설정 저장
      if (tableId) {
        const existingConfig = this.tableConfigs.get(tableId) || { ...DEFAULT_TABLE_BETTING_CONFIG }
        const updatedConfig: TableBettingConfig = {
          chipStack: chipStack || existingConfig.chipStack,
          tableMinLimit: tableMinLimit ?? existingConfig.tableMinLimit,
          tableMaxLimit: tableMaxLimit ?? existingConfig.tableMaxLimit,
          channel: channel || existingConfig.channel,
          orientation: orientation || existingConfig.orientation,
          gameDimensions: gameDimensions || existingConfig.gameDimensions,
        }
        this.tableConfigs.set(tableId, updatedConfig)
        const currencyCode = currency || this.currencyCode
        this.tableCurrencies.set(tableId, currencyCode)
        this.capturedTables.add(tableId)
        // Balance가 숫자나 문자열로 올 수 있음
        const balanceParsed =
          typeof balanceRaw === 'number'
            ? balanceRaw
            : typeof balanceRaw === 'string'
              ? Number(balanceRaw.replace(/,/g, ''))
              : null
        if (typeof balanceParsed === 'number' && !Number.isNaN(balanceParsed)) {
          this.lastBalance = balanceParsed
          this.emitBalanceUpdate(balanceParsed)
        }
        if (gameId) this.currentGameIds.set(tableId, gameId)
      }

      this.emitTableConfigUpdate({ ...this.tableConfig })
    }
  }

  /** 테이블별 설정 조회 (없으면 전역 설정 반환) */
  getTableConfigFor(tableId: string): TableBettingConfig {
    return this.tableConfigs.get(tableId) || this.tableConfig
  }

  /** Check if already bet on current game for specific table (prevent duplicates) */
  hasAlreadyBetOnGame(tableId: string, gameId: string): boolean {
    return this.lastBetGameIds.get(tableId) === gameId
  }

  /** Mark game as bet for specific table */
  markGameAsBet(tableId: string, gameId: string): void {
    this.lastBetGameIds.set(tableId, gameId)
  }

  /** Reset last bet game for specific table (after result) */
  resetLastBetGame(tableId: string): void {
    this.lastBetGameIds.delete(tableId)
  }

  /** Reset all last bet games (for full reset) */
  resetAllLastBetGames(): void {
    this.lastBetGameIds.clear()
  }

  /** Build Evolution bet message */
  buildBetMessage(params: {
    tableId: string
    betType: BetType
    amount: number
    balance: number
    config?: Partial<TableBettingConfig>
  }): string | null {
    const { tableId, betType, amount, balance, config } = params
    const gameId = this.currentGameIds.get(tableId)
    if (!gameId) {
      return null
    }

    // Merge with default config
    const finalConfig = { ...this.getTableConfig(tableId), ...config }

    const now = new Date()
    const gameTime = now.toLocaleTimeString('en-GB', { hour12: false })
    const betCode = BET_CODES[betType]
    const currencyCode = this.tableCurrencies.get(tableId) || this.currencyCode

    const payload: EvolutionBetPayload = {
      type: 'Chip',
      amount,
      codes: { [betCode]: amount },
      bets: { [betType]: amount },
      gameType: 'baccarat',
      gameTime,
      currency: currencyCode,
      chipStack: finalConfig.chipStack,
      tableMinLimit: finalConfig.tableMinLimit,
      tableMaxLimit: finalConfig.tableMaxLimit,
      balance,
      tableId,
      orientation: finalConfig.orientation,
      goodRoads: false,
      channel: finalConfig.channel,
      gameDimensions: finalConfig.gameDimensions,
      gameId,
    }

    return JSON.stringify({ log: { type: 'CLIENT_BET_CHIP', value: payload } })
  }

  /**
   * Build Evolution playerBetRequest message (실제 배팅용)
   * 이 메시지는 실제로 Evolution WebSocket으로 전송되어 배팅을 실행함
   */
  buildPlayerBetRequest(params: {
    tableId: string
    betType: BetType
    amount: number
  }): string | null {
    const { tableId, betType, amount } = params
    const gameId = this.currentGameIds.get(tableId)
    // 🛡️ [실배팅 안전장치 #1] 실배팅 메시지는 synthetic/미수신 gameId로 절대 만들지 않는다.
    // (가짜 gameId로 실제 돈이 나가 Evolution이 무효 처리하는 사고 방지 — 메시지 빌더 레벨 방어)
    if (!gameId || gameId.startsWith('synthetic-')) {
      return null
    }

    const timestamp = Date.now()
    const messageId = this.generateMessageId()
    const replyId = `baccarat.playerBetRequest-${Math.floor(Math.random() * 1000000000)}-${timestamp}`
    const correlationId = this.generateCorrelationId()

    // playerBetRequest는 화면용 betType이 아니라 Evolution bet code를 chips key로 보낸다.
    const betCode = BET_CODES[betType]
    const chips: Record<string, number> = {}
    chips[betCode] = amount

    const message = {
      id: messageId,
      type: 'baccarat.playerBetRequest',
      args: {
        tableId,
        gameId,
        replyId,
        timestamp,
        betTags: {
          btTableView: '0',
          mwLayout: 9,
          openMwTables: 2,
        },
        action: {
          name: 'Chips',
          chips,
        },
        correlationId,
      },
    }

    return JSON.stringify(message)
  }

  /** Generate unique message ID */
  private generateMessageId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < 10; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  /** Generate correlation ID */
  private generateCorrelationId(): string {
    const hex = '0123456789abcdef'
    let result = ''
    for (let i = 0; i < 20; i++) {
      result += hex.charAt(Math.floor(Math.random() * hex.length))
    }
    return result
  }

  /** Subscribe to table config updates */
  onTableConfigUpdate(callback: TableConfigUpdateCallback): () => void {
    this.tableConfigCallbacks.push(callback)
    return () => {
      this.tableConfigCallbacks = this.tableConfigCallbacks.filter(cb => cb !== callback)
    }
  }

  private emitTableConfigUpdate(config: Partial<TableBettingConfig>): void {
    this.tableConfigCallbacks.forEach(cb => cb(config))
  }
}

// Singleton
export const EvolutionAdapter = new EvolutionAdapterImpl()
export default EvolutionAdapter
