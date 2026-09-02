// Domain Entities - Pure TypeScript types without external dependencies

export type Winner = 'B' | 'P' | 'T'
export type PredictionResult = 'B' | 'P' | 'T' | null

// ==================== App Mode Types ====================

/** 앱 모드 - 오토 배팅 vs 예측 분석 */
export type AppMode = 'auto' | 'predict'

// ==================== Error Types ====================

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'success' | 'danger'

export interface AppError {
  code: string
  message: string
  severity: ErrorSeverity
  recoverable: boolean
  details?: string
  timestamp: number
}

export type AppErrorCode =
  | 'AUTH_FAILED'
  | 'AUTH_SESSION_EXPIRED'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_LOST'
  | 'PREDICTION_FAILED'
  | 'ROOM_SELECT_FAILED'
  | 'ROOM_ENTER_FAILED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR'

export function createAppError(
  code: AppErrorCode,
  message: string,
  options: Partial<Omit<AppError, 'code' | 'message' | 'timestamp'>> = {}
): AppError {
  return {
    code,
    message,
    severity: options.severity ?? 'error',
    recoverable: options.recoverable ?? true,
    details: options.details,
    timestamp: Date.now(),
  }
}

// ==================== User ====================

export interface User {
  id: string
  username: string
  siteUrl: string
  totalPredictions: number
  correctPredictions: number
  winRate: number
  /** 🆕 v3.7.0: 세션 ID (로그인 시 생성, 같은 세션 그룹화) */
  sessionId?: string
  /** 🆕 v3.7.0: 현재 잔액 (원) */
  currentBalance?: number
}

/** Notice information from server */
export interface NoticeData {
  id: number
  title: string
  content: string
  regDate?: string
}

export interface LoginResult {
  success: boolean
  message: string
  user: User | null
  /** 정액 시간 (초) - Session duration from server */
  remainingSeconds?: number
  /** 공지사항 정보 */
  notice?: NoticeData | null
}

// ==================== Session Types ====================

/** 세션 상태 정보 */
export interface SessionStatus {
  isValid: boolean
  remainingSeconds?: number
  expiresAt?: number
  invalidationReason?: SessionInvalidReason
}

/** 세션 무효화 사유 */
export type SessionInvalidReason =
  | 'expired'         // 정액 시간 만료
  | 'duplicate_login' // 중복 로그인 (다른 기기에서 로그인)
  | 'token_revoked'   // 토큰 취소 (서버에서 강제 로그아웃)
  | 'offline'         // 오프라인 상태 (네트워크 연결 없음)
  | 'server_error'    // 서버 오류

/** 세션 무효화 사유별 메시지 */
export const SESSION_INVALID_MESSAGES: Record<SessionInvalidReason, string> = {
  expired: '세션이 만료되었습니다. 프로그램이 종료됩니다.',
  duplicate_login: '다른 기기에서 로그인되어 연결이 종료됩니다.',
  token_revoked: '세션이 종료되었습니다. 프로그램이 종료됩니다.',
  offline: '네트워크 연결이 없습니다. 온라인 상태에서만 사용 가능합니다.',
  server_error: '서버 오류로 연결이 종료됩니다.',
}

export interface GameResult {
  roomId: string
  roomName: string
  result: Winner
  timestamp: number
  predicted?: PredictionResult
  isCorrect?: boolean
}

export interface RoadResult {
  winner: Winner
  isPlayerPair: boolean
  isBankerPair: boolean
  playerScore?: number
  bankerScore?: number
  tieCount?: number  // 로드맵에서 타이 선 표시용 (별도 결과로 카운트 안 함)
}

export interface Room {
  id: string
  name: string
  koreanName: string
  history: RoadResult[]
  gameCount: number
  lastResultTime?: number
  remainingSeconds?: number
  phase?: GamePhase
  /** 배팅 마감 시각(epoch ms). 서버가 BetsOpen 순간 준 timeRemaining으로 고정 — UI 카운트다운의 단일 기준 */
  bettingDeadlineAt?: number
  /** 배팅 창 전체 길이(ms, 서버 timeInitial). 진행 바 비율 계산용 */
  bettingWindowMs?: number
  gameState?: GameState
  /** 카지노 프로바이더 (evolution | pragmatic) */
  provider?: 'evolution' | 'pragmatic'
}

export interface GameState {
  playerHand?: { score: number; cards?: any[] }
  bankerHand?: { score: number; cards?: any[] }
}

export type GamePhase = 'betting' | 'dealing' | 'result' | 'idle'

// ==================== Room Sorting ====================

/** 방 정렬 타입 */
export type RoomSortType =
  | 'name'        // 이름순 (가나다)
  | 'games'       // 게임 수 (많은 순)
  | 'martin'      // 마틴 레벨 (높은 순)
  | 'winRate'     // 승률 (높은 순)
  | 'streak'      // 연승/연패 (많은 순)
  | 'recent'      // 최근 활동 순
  | 'bankerDominant'  // 뱅커 우세
  | 'playerDominant'  // 플레이어 우세
  | 'profit'      // 손익순
  | 'optimal'     // 최적 방 (연승*10 + 승률*100, 2연패/50%미만 제외)

/** 정렬 방향 */
export type SortDirection = 'asc' | 'desc'

/** 정렬 옵션 정의 */
export interface SortOption {
  type: RoomSortType
  label: string
  shortLabel: string  // 버튼에 표시할 짧은 라벨
  defaultDirection: SortDirection  // 기본 정렬 방향
}

/** 사용 가능한 정렬 옵션 목록 */
export const SORT_OPTIONS: SortOption[] = [
  { type: 'optimal', label: '최적 방', shortLabel: '최적', defaultDirection: 'desc' },
  { type: 'name', label: '이름순', shortLabel: '이름', defaultDirection: 'asc' },
  { type: 'games', label: '게임 수', shortLabel: '게임', defaultDirection: 'desc' },
  { type: 'martin', label: '마틴 레벨', shortLabel: '마틴', defaultDirection: 'desc' },
  { type: 'winRate', label: '승률순', shortLabel: '승률', defaultDirection: 'desc' },
  { type: 'streak', label: '연승/연패', shortLabel: '연속', defaultDirection: 'desc' },
  { type: 'recent', label: '최근 활동', shortLabel: '최근', defaultDirection: 'desc' },
  { type: 'bankerDominant', label: '뱅커 우세', shortLabel: 'B우세', defaultDirection: 'desc' },
  { type: 'playerDominant', label: '플레이어 우세', shortLabel: 'P우세', defaultDirection: 'desc' },
  { type: 'profit', label: '손익순', shortLabel: '손익', defaultDirection: 'desc' },
]

export interface Prediction {
  roomId: string
  prediction: PredictionResult
  confidence: number
  reasoning?: string
  isSkip: boolean
  timestamp: number
  /** 서버의 연패/연승 추적 정보 (동기화용) */
  streakTracking?: {
    consecutiveLosses: number
    consecutiveWins: number
    totalPredictions: number
    totalWins: number
    winRate: number
    inSkipMode: boolean
    martinLevel: number
    recommendedMultiplier: number
  }
  /** 서버 동적 최적화 설정 (minConfidence 등) */
  betTypeOptimization?: BetTypeOptimizationV2
}

export interface PredictionStats {
  total: number
  correct: number
  winRate: number
  consecutiveWins: number
  consecutiveLosses: number
  maxConsecutiveWins: number    // 최대 연승 기록
  maxConsecutiveLosses: number  // 최대 연패 기록
}

export type PredictionMode = 'Analyzing' | 'Ready' | 'WaitingResult' | 'ShowingResult'

export interface SingleRoomState {
  mode: PredictionMode
  roomId: string | null
  roomName: string | null
  lastPrediction: Prediction | null
  stats: PredictionStats
}

export interface ConnectionStatus {
  isConnected: boolean
  wsUrl: string | null
  messageCount: number
  lastMessageTime: number | null
}

// ==================== Events ====================

export interface BettingPhaseEvent {
  roomId: string
  remainingSeconds: number
  phase: 'start' | 'end'
  /** 배팅 마감 절대시각(epoch ms). 있으면 UI는 감산 대신 이 값으로 센다 */
  deadlineAt?: number
  /** 배팅 창 전체 길이(ms) */
  windowMs?: number
}

/**
 * 실배팅 체결 결과 — Evolution `baccarat.resolved`의 args에서 추출.
 * 히스토리 추론과 달리 "내가 보낸 베팅이 실제로 체결됐는지/거절됐는지"를 알려준다.
 * acceptedBets/rejectedBets 키 = 평문 베팅 spot('Banker'|'Player'|'Tie' 등).
 */
export interface BetOutcome {
  gameId?: string
  winningSpots?: string[]
  acceptedBets?: Record<string, number | { amount?: number; payoff?: number; limited?: boolean }>
  rejectedBets?: Record<string, { amount?: number; error?: string }>
}

export interface GameResultEvent {
  roomId: string
  winner: Winner
  playerScore?: number
  bankerScore?: number
  isPlayerPair?: boolean
  isBankerPair?: boolean
  isReplay?: boolean
  history?: RoadResult[]
  /** baccarat.resolved에서만 채워짐. 없으면 히스토리 추론으로 폴백(기존 동작). */
  betOutcome?: BetOutcome
}

// ==================== Room Filters ====================

export type CustomPatternType = `custom:${string}`
export type CustomStrategyFilterType = `strategy:${string}`

export type RoomFilterType =
  | 'losing_streak'      // 5-8 consecutive losses
  | 'alternating'        // 퐁당퐁당 pattern (P-B-P-B or B-P-B-P)
  | 'long_streak'        // 장줄 pattern (4+ same result)
  | 'winning_streak'     // Rooms with recent prediction wins
  | 'short_streak'       // 단줄 pattern (2-3 same result)
  | 'after_tie'          // 타이 직후 (last result is T)
  | 'banker_dominant'    // 뱅커 우세 (recent 10 games, B > P)
  | 'player_dominant'    // 플레이어 우세 (recent 10 games, P > B)
  | 'tie_drought'        // Tie 미발생 N게임 이상 (default N=20)
  | 'tie_frequent'       // 최근 TIE_FREQUENT_WINDOW판 안에 Tie ≥ N (default N=2)
  | 'no_tie_room'        // 이 방의 히스토리에 Tie 0건
  | 'fresh_room'         // 방 입장 직후 N게임 이내 (default N=5)
  | 'fresh_shoe'         // 카지노 슈가 막 시작된 방
  | CustomPatternType
  | CustomStrategyFilterType

/** Tie 미발생 임계 게임 수 (tie_drought 필터용) */
export const TIE_DROUGHT_THRESHOLD = 20
/** Tie 자주 출현 — 관측 윈도우 기본값(판 수) (tie_frequent 필터용) */
export const TIE_FREQUENT_WINDOW = 5
/** Tie 자주 출현 — 시작 게임 번호 (1-based, 슈 처음부터 카운트) */
export const TIE_FREQUENT_START = 1
/** Tie 자주 출현 — 최소 횟수 기본값 (tie_frequent 필터용) */
export const TIE_FREQUENT_MIN_COUNT = 0
/** Tie 자주 출현 — 최대 횟수 기본값 (상한 미사용 시) (tie_frequent 필터용) */
export const TIE_FREQUENT_MAX_COUNT = 0
/** tie_frequent 진입 시점 — true: 구간(예 1~20판)이 다 끝난 뒤에만 매칭("20판부터").
 *  false: 구간 진행 중에도 지금까지 본 결과로 미리 매칭(슈 시작부터, 기존 '타이 자동' 조기진입). */
export const TIE_FREQUENT_REQUIRE_FULL_WINDOW = true
/** 새 방 진입 직후 N게임 (fresh_room 필터용) */
export const FRESH_ROOM_GAMES = 5
/** 카지노 슈가 막 시작된 직후 N게임 (fresh_shoe 필터용) */
export const FRESH_SHOE_MAX_GAME_NUMBER = 5
/** Tie 베팅 순이익 배수 (8:1 net payout — 1000 stake win → +8000 profit) */
export const TIE_PAYOUT_MULTIPLIER = 8

export interface RoomFilter {
  type: RoomFilterType
  enabled: boolean
  label: string
  description: string
  isCustom?: boolean
  isStrategy?: boolean
  patternId?: string
  strategyId?: string
  sequence?: Winner[]
  betDirection?: PatternBetDirection  // 이 패턴 감지시 배팅 방향 (표시용)
}

export interface CustomPattern {
  id: string
  name: string
  sequence: Winner[]
  enabled: boolean
  description?: string
  betDirection?: PatternBetDirection  // 이 패턴 감지시 배팅 방향
  betStrategy?: BetStrategyType       // 이 패턴 감지시 사용할 배팅 전략 (없으면 글로벌 전략)
  createdAt: number
  updatedAt?: number
}

export interface RoomPattern {
  type: 'alternating' | 'streak' | 'mixed'
  length: number
  lastResult: Winner
}

// ==================== Virtual Betting ====================

export interface MartingaleSettings {
  enabled: boolean
  baseAmount: number        // Starting bet amount
  maxLevel: number          // Max martingale level (e.g., 5 = 5 doubles)
  resetOnWin: boolean       // Reset to base after win
}

export interface VirtualBetSettings {
  initialBalance: number    // Starting balance
  martingale: MartingaleSettings
}

export interface VirtualBetState {
  roomId: string
  currentBalance: number
  currentBetAmount: number
  martingaleLevel: number   // 0 = base, 1 = 2x, 2 = 4x, etc.
  totalBets: number
  wins: number
  losses: number
  profitLoss: number
  lastBetResult?: 'win' | 'loss' | 'pending' | 'tie' | 'cancelled' | null
  lastBetTime?: number      // Timestamp of last bet for stale pending detection
}

export interface VirtualBettingState {
  enabled: boolean
  settings: VirtualBetSettings
  globalBalance: number
  roomStates: Map<string, VirtualBetState>
  betHistory: VirtualBetLog[]
  // Extended statistics
  totalBetAmount: number      // 누적 배팅금액
  totalWinnings: number       // 총 당첨금 (순이익만)
  totalNetProfit: number      // 순수익 (총 당첨금 - 총 배팅금)
  totalBetCount: number       // 배팅 횟수
  // ✅ Tie bet tracking (refunded bets)
  tieBetAmount: number        // 타이로 환불된 배팅금액
  tieBetCount: number         // 타이 횟수
  // Pending bet tracking
  pendingBetAmount: number    // 현재 결과 대기 중인 배팅 총액
  pendingBetCount: number     // 현재 결과 대기 중인 배팅 수
}

export interface VirtualBetLog {
  id: number
  timestamp: number
  roomId: string
  roomName: string
  prediction: PredictionResult
  result: Winner | null         // null = 배팅 시점 (결과 대기 중)
  betAmount: number
  martingaleLevel: number
  won: boolean | null           // null = 배팅 시점 (결과 대기 중)
  balanceAfter: number
  type: 'placed' | 'resolved'   // 로그 타입: 배팅 / 결과
}

// ==================== Multi-Room Prediction ====================

// ✅ 예측 결과 히스토리 아이템 (O/X 표시용)
export interface PredictionHistoryItem {
  result: 'WIN' | 'LOSS' | 'TIE' | 'SKIP'
  prediction: Winner // 예측한 값 (B/P/T)
  actual: Winner // 실제 결과 (B/P/T)
  timestamp: number
  playerScore?: number // 플레이어 카드 합계 점수
  bankerScore?: number // 뱅커 카드 합계 점수
}

export interface RoomPredictionState {
  roomId: string
  roomName: string
  lastPrediction: Prediction | null
  stats: PredictionStats
  pattern: RoomPattern | null
  isFiltered: boolean       // Matches current filter criteria
  predictionCount: number   // Total predictions made for this room (for visual feedback)
  history: PredictionHistoryItem[] // ✅ 최근 예측 결과 히스토리 (O/X)
  isShoeReset?: boolean     // 🔥 슈 초기화 상태 (히스토리 5개 미만)
  /** Timestamp from an explicit casino shoe-change event, not inferred from short history. */
  shoeChangeDetectedAt?: number
}

export interface MultiRoomPredictionState {
  autoMode: boolean
  activeFilters: RoomFilterType[]
  roomStates: Map<string, RoomPredictionState>
  globalStats: PredictionStats
}

// ==================== Room Selection (Server) ====================

export interface RoomSelectionOptions {
  betType?: BetStrategyType
  martinLevel?: number
  minConfidence?: number
  maxResults?: number
  includeSkipped?: boolean
}

export interface RoomSelectionResult {
  roomId: string
  roomName: string
  prediction: PredictionResult
  confidence: number
  isSkip: boolean
  skipReason?: string
  score: number
}

export interface RoomSelectionResponse {
  bestRoomId?: string
  bestRoomName?: string
  results: RoomSelectionResult[]
  evaluated: number
  skipped: number
  responseTimeMs?: number
  reason?: string
}

// ==================== Auto Betting ====================

/** 배팅 전략 타입 */
export type BetStrategyType = 'martingale' | 'fibonacci' | 'paroli' | 'flat' | 'custom'

/** 배팅 타입 */
export type BetType = 'Player' | 'Banker' | 'Tie'

/** Evolution 배팅 코드(=베팅 스팟 키).
 *  ★2026-06-23 라이브 캡처로 확정: 실제 baccarat.playerBetRequest 의 action.chips 키는 평문
 *  'Player'/'Banker'/'Tie' 다(BAC_ 접두사 아님). 과거 'BAC_*' 는 Evolution이 인식 못 해 베팅이
 *  무시(HasBet:false)되던 근본 원인 → 평문으로 교정(캡처: chips:{"Banker":2000}, currentChips/rejectedBets 동일). */
export const BET_CODES: Record<BetType, string> = {
  Player: 'Player',
  Banker: 'Banker',
  Tie: 'Tie',
} as const

/** 자동 배팅 상태 */
export interface AutoBettingState {
  enabled: boolean              // 자동배팅 활성화
  realBalance: number | null    // 실제 잔액 (null = 연결 필요)
  currentBetAmount: number      // 현재 배팅액 (마틴 적용)
  pendingBet: boolean           // 배팅 전송 대기 중
  lastBetTime: number | null    // 마지막 배팅 시간
}

/** 테이블 배팅 설정 (CDP에서 캡처한 실제 데이터) */
export interface TableBettingConfig {
  chipStack: number[]           // 사용 가능한 칩 스택
  tableMinLimit: number         // 테이블 최소 배팅
  tableMaxLimit: number         // 테이블 최대 배팅
  channel: string               // 채널 (PCMac, mobile 등)
  orientation: 'landscape' | 'portrait'
  gameDimensions: { width: number; height: number }
}

/** 기본 테이블 배팅 설정 (CDP 캡처 전 사용) */
export const DEFAULT_TABLE_BETTING_CONFIG: TableBettingConfig = {
  chipStack: [200, 1000, 5000, 10000, 20000, 100000],
  // Evolution 실 테이블 기본 최소 베팅은 대부분 10,000원대라서 기본값을 상향
  tableMinLimit: 10000,
  tableMaxLimit: 20000000,
  channel: 'PCMac',
  orientation: 'landscape',
  gameDimensions: { width: 400, height: 790 },
}

/** Evolution 배팅 메시지 페이로드 */
export interface EvolutionBetPayload {
  type: 'Chip' | 'Undo'
  amount: number
  codes: Record<string, number>
  bets: Record<string, number>
  gameType: 'baccarat'
  gameTime: string
  currency: string
  chipStack: number[]
  tableMinLimit: number
  tableMaxLimit: number
  balance: number
  tableId: string
  orientation: 'landscape' | 'portrait'
  goodRoads: boolean
  channel: string
  gameDimensions: { width: number; height: number }
  gameId: string
}

/** 실배팅 요청의 현재 체결 상태. */
export type BetPlacementLifecycleStatus = 'attempted' | 'accepted' | 'unknown' | 'sent'

/** 진행 중인 배팅 정보 */
export interface PendingBetInfo {
  tableId: string
  betType: BetType
  amount: number
  gameId: string
  timestamp: number
  /**
   * `unknown`은 요청 전송 후 제한 시간 안에 서버 응답을 확정하지 못한 상태다.
   * 미체결을 뜻하지 않으므로 같은 gameId에 다시 전송하면 안 된다.
   */
  placementStatus: BetPlacementLifecycleStatus
  placementError?: string
}

// ==================== Semi-Auto Settings ====================

/** 패턴별 배팅 방향 설정 */
export type PatternBetDirection = 'B' | 'P' | 'T' | 'skip' | 'ai'

/** 패턴별 배팅 설정 */
export interface PatternBetConfig {
  patternType: RoomFilterType       // 패턴 타입
  betDirection: PatternBetDirection // 해당 패턴 발생시 배팅 방향
  includeTie: boolean               // 패턴 검출시 타이 포함 여부
  enabled: boolean                  // 이 패턴 설정 활성화
  betStrategy?: BetStrategyType     // 이 패턴 감지시 사용할 배팅 전략 (없으면 글로벌 전략)
}

/** 방별 설정 */
export interface RoomBetConfig {
  roomId: string                    // 방 ID
  enabled: boolean                  // 이 방 배팅 활성화
  maxConsecutiveLosses: number      // 연패 휴식 기준 (0 = 무제한)
  currentRestUntil?: number         // 휴식 종료 시간 (timestamp, undefined = 휴식 아님)
}

/** 오토 배팅 모드 설정 */
export interface SemiAutoSettings {
  enabled: boolean              // 오토 배팅 활성화
  maxMartin: number             // 최대 마틴 단계 (기본 5)
  baseBetAmount: number         // 기본 배팅 금액
  autoBetting: boolean          // 자동배팅 ON/OFF
  betStrategy: BetStrategyType  // 배팅 전략
  forceBetDirection: 'auto' | 'tie_only' // Fresh-Shoe 프리셋 배팅 방향
  baseUrl: string               // Evolution Gaming 베이스 URL
  soundEnabled: boolean         // 사운드 ON/OFF

  // 윈컷/로스컷 설정
  winCutAmount: number          // 목표 수익 (원, 0 = 무제한)
  lossCutAmount: number         // 최대 손실 (원, 0 = 무제한)

  // 확장 설정
  useAiPrediction: boolean      // AI 예측 사용 (true = AI모드, false = 패턴모드)
  patternConfigs: PatternBetConfig[]  // 패턴별 배팅 설정
  roomConfigs: RoomBetConfig[]        // 방별 설정
  globalMaxConsecutiveLosses: number  // 전역 연패 휴식 기준 (기본 5)
  restDurationMinutes: number         // 연패 휴식 시간 (분, 기본 10)
  onlySelectedRooms: boolean          // 선택된 방만 표시 (기본 false)
  lossThreshold: number              // 연패 이동 기준 (0 = 무제한)

  // Legacy fields (deprecated - kept for compatibility)
  winThreshold?: number         // @deprecated 사용 안함
  skipFirstRound?: boolean      // @deprecated 사용 안함
  autoFindRoom?: boolean        // @deprecated 사용 안함
  minHistoryLength?: number     // @deprecated 사용 안함
  continuousSearch?: boolean    // @deprecated 사용 안함
}

/** 패턴별 배팅 기본 설정 */
export const DEFAULT_PATTERN_CONFIGS: PatternBetConfig[] = [
  { patternType: 'alternating', betDirection: 'ai', includeTie: false, enabled: true },
  { patternType: 'long_streak', betDirection: 'ai', includeTie: false, enabled: true },
  { patternType: 'short_streak', betDirection: 'ai', includeTie: false, enabled: true },
  { patternType: 'after_tie', betDirection: 'ai', includeTie: true, enabled: true },
  { patternType: 'banker_dominant', betDirection: 'B', includeTie: false, enabled: true },
  { patternType: 'player_dominant', betDirection: 'P', includeTie: false, enabled: true },
  { patternType: 'tie_drought',  betDirection: 'T', includeTie: false, enabled: true },
  { patternType: 'tie_frequent', betDirection: 'T', includeTie: false, enabled: true },
  { patternType: 'no_tie_room',  betDirection: 'T', includeTie: false, enabled: true },
  { patternType: 'fresh_room',   betDirection: 'T', includeTie: false, enabled: true },
  { patternType: 'fresh_shoe',   betDirection: 'T', includeTie: false, enabled: true },
]

/** 오토 배팅 모드 기본 설정 */
export const DEFAULT_SEMI_AUTO_SETTINGS: SemiAutoSettings = {
  enabled: false,
  maxMartin: 5,
  baseBetAmount: 10000,
  autoBetting: false,
  betStrategy: 'martingale',
  forceBetDirection: 'auto',
  baseUrl: '',
  soundEnabled: true,           // 사운드 기본 ON

  // 윈컷/로스컷 기본값
  winCutAmount: 0,              // 0 = 무제한
  lossCutAmount: 0,             // 0 = 무제한

  // 확장 설정 기본값
  useAiPrediction: true,        // 기본 AI 모드
  patternConfigs: DEFAULT_PATTERN_CONFIGS,
  roomConfigs: [],              // 빈 배열 = 모든 방 활성화
  globalMaxConsecutiveLosses: 5,
  restDurationMinutes: 10,
  onlySelectedRooms: false,
  lossThreshold: 0,
}

// ==================== Domain Logic: Betting Strategies ====================

/**
 * Calculate bet amount based on strategy and current level
 * Pure function - no side effects (Domain Layer)
 *
 * @param strategy - 배팅 전략
 * @param baseAmount - 기본 배팅 금액
 * @param level - 현재 마틴 레벨 (0부터 시작)
 * @param customAmounts - 커스텀 전략일 때 단계별 금액 배열 (optional)
 */
export function calculateBetAmount(
  strategy: BetStrategyType,
  baseAmount: number,
  level: number,
  customAmounts?: number[]
): number {
  switch (strategy) {
    case 'martingale':
      // 1, 2, 4, 8, 16, ...
      return baseAmount * Math.pow(2, level)

    case 'fibonacci':
      // 1, 1, 2, 3, 5, 8, 13, ...
      return baseAmount * fibonacci(level)

    case 'paroli':
      // 파롤리 (역마틴): 승리 시 2배, 3연승 후 리셋 → 레벨 0,1,2 = 1·2·4배.
      // 정본인 MartingaleManager.calculateBetAmount('paroli')와 동일하게 cap=2로 통일.
      // (이전 cap=3은 Auto(4배) vs SemiAuto(8배) 금액 불일치를 유발했음)
      return baseAmount * Math.pow(2, Math.min(level, 2))

    case 'custom':
      // 커스텀: 사용자가 직접 설정한 금액 사용
      if (customAmounts && customAmounts[level] !== undefined) {
        return customAmounts[level]
      }
      // fallback to base amount if no custom amount defined
      return baseAmount

    case 'flat':
    default:
      return baseAmount
  }
}

/**
 * Get next level based on strategy and win/loss
 */
export function getNextBetLevel(
  strategy: BetStrategyType,
  currentLevel: number,
  won: boolean,
  maxLevel: number
): number {
  switch (strategy) {
    case 'martingale':
      // 패배시 레벨 증가, 승리시 초기화
      if (won) return 0
      return Math.min(currentLevel + 1, maxLevel)

    case 'fibonacci':
      // 패배시 다음 피보나치, 승리시 2단계 뒤로
      if (won) return Math.max(currentLevel - 2, 0)
      return Math.min(currentLevel + 1, maxLevel)

    case 'paroli':
      // 승리시 레벨 증가 (max 3), 패배시 초기화
      if (won) return Math.min(currentLevel + 1, 3)
      return 0

    case 'flat':
    default:
      return 0
  }
}

/**
 * Calculate total investment at given level (for risk assessment)
 */
export function calculateTotalInvestment(
  strategy: BetStrategyType,
  baseAmount: number,
  level: number
): number {
  let total = 0
  for (let i = 0; i <= level; i++) {
    total += calculateBetAmount(strategy, baseAmount, i)
  }
  return total
}

// Helper: Fibonacci sequence
function fibonacci(n: number): number {
  if (n <= 1) return 1
  let a = 1, b = 1
  for (let i = 2; i <= n; i++) {
    const temp = a + b
    a = b
    b = temp
  }
  return b
}

// ==================== V2 API Types ====================

/** V2 예측 요청에 포함되는 게임 라운드 정보 */
export interface GameRoundV2 {
  gameId?: string
  gameNumber?: number
  result: Winner
  playerCards?: CardInfoV2[]
  bankerCards?: CardInfoV2[]
  playerScore?: number
  bankerScore?: number
  pairs?: {
    player: boolean
    banker: boolean
  }
}

/** V2 카드 정보 */
export interface CardInfoV2 {
  suit: string  // 'H' | 'D' | 'C' | 'S'
  rank: string  // '2'-'10', 'J', 'Q', 'K', 'A'
}

/** V2 베팅 쏠림 통계 */
export interface BettingStatsV2 {
  player_percentage: number
  banker_percentage: number
  tie_percentage: number
  total_bettors?: number
}

/** V2 슈 통계 */
export interface ShoeStatsV2 {
  player_count: number
  banker_count: number
  tie_count: number
  player_pair_count: number
  banker_pair_count: number
  total_games: number
  cards_dealt?: number
  cards_remaining?: number
}

/** V2 예측 결과 확률 정보 */
export interface ProbabilitiesInfoV2 {
  player: number
  banker: number
  tie: number
}

/** V2 패턴 정보 */
export interface PatternInfoV2 {
  current_streak: number
  streak_type?: 'player' | 'banker' | null
}

/** V2 예측 요청 */
export interface V2PredictionRequest {
  room_id: string
  room_name: string
  game_id?: string
  game_number?: number
  history: GameRoundV2[]
  last_cards?: CardInfoV2[]
  betting_stats?: BettingStatsV2
  shoe_stats?: ShoeStatsV2
  shoe_cards_out?: number
  bet_type?: BetStrategyType  // 🆕 베팅 전략 타입 (optional)
}

/** V2 예측 응답 */
export interface V2PredictionResponse {
  room_id: string
  prediction: 'Banker' | 'Player' | null
  confidence: number        // 0-100
  reasoning: string
  is_skip: boolean
  skip_reason?: string
  probabilities?: ProbabilitiesInfoV2
  pattern_info?: PatternInfoV2
  streak_tracking?: StreakTrackingV2
  bet_type_optimization?: BetTypeOptimizationV2  // 🆕 베팅 타입별 최적화 설정
}

/** 베팅 타입별 최적화 설정 (10,000판 × 1,000회 시뮬레이션 기반) */
export interface BetTypeOptimizationV2 {
  bet_type: string                        // 베팅 타입 (martingale/fibonacci/paroli/flat/custom)
  recommended_skip_after_losses: number   // 권장 연패 SKIP 기준 (시뮬레이션 최적: 4연패)
  recommended_min_confidence: number      // 권장 최소 신뢰도 (0-100, 시뮬레이션 최적: 0 = 필터 없음)
  max_martin_level: number                // 최대 마틴 레벨 (1→2→4, 기본 2단계)
  max_bet_ratio: number                   // 자본 대비 최대 배팅 비율 (기본 0.05 = 5%)
  stop_loss_ratio: number                 // 손절 비율 (기본 0.5 = 50%)
  expected_profit_rate: number            // 시뮬레이션 기반 예상 수익률 (%)
  expected_win_rate: number               // 시뮬레이션 기반 예상 승률 (%)
  expected_max_loss_streak: number        // 시뮬레이션 기반 최대 연패
  skip_rate: number                       // SKIP 비율 (%)
  bankruptcy_rate: number                 // 파산율 (%, 시뮬레이션 목표: 0%)
  rationale: string                       // 최적화 근거 설명
}

/** 연패/연승 추적 정보 (마틴 베팅용) */
export interface StreakTrackingV2 {
  consecutive_losses: number   // 현재 연패 수
  consecutive_wins: number     // 현재 연승 수
  total_predictions: number    // 총 예측 수
  total_wins: number           // 총 승리 수
  win_rate: number             // 승률 (0-1)
  in_skip_mode: boolean        // SKIP 모드 여부
  martin_level: number         // 마틴 레벨 (0~5)
  recommended_multiplier: number // 추천 베팅 배수 (1,2,4,8,16...)
}

/** V2 결과 비교 (예측 성공/실패) */
export interface V2ResultComparison {
  room_id: string
  prediction: 'Banker' | 'Player' | null
  actual_result: Winner
  is_correct: boolean
  is_push: boolean          // Tie일 때
  consecutive_wins: number
  consecutive_losses: number
  total_predictions: number
  correct_predictions: number
  win_rate: number          // 0-1
}

/** V2 방 게임 데이터 (디버깅용) */
export interface V2RoomGameData {
  roomId: string
  roomName: string
  gameId?: string
  gameNumber?: number
  historyLength: number
  hasBettingStats: boolean
  hasCardInfo: boolean
  hasShoeStats: boolean
  shoeCardsOut?: number
}

/** 예측 추적 상태 */
export interface PredictionTracking {
  room_id: string
  last_prediction?: 'Banker' | 'Player' | null
  last_prediction_time?: number
  consecutive_wins: number
  consecutive_losses: number
  total_predictions: number
  correct_predictions: number
}
