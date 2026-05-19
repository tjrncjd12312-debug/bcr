// automode/types.ts - AutoMode 서비스 공유 타입
// Clean Architecture: Application Layer
// 단일 책임 원칙에 따라 분리된 모듈들의 공유 타입 정의

import type {
  Prediction,
  BetType,
  RoomBetConfig,
  PatternBetConfig,
  Winner,
} from '../../../domain/entities'

// ==================== Clock Interface (테스트 용이성) ====================

/**
 * 시간 추상화 인터페이스 - 테스트에서 fake time 사용 가능
 */
export interface Clock {
  now(): number
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(id: ReturnType<typeof setTimeout>): void
}

/**
 * 실제 시스템 시간 구현
 */
export const SystemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (id) => clearTimeout(id),
}

// ==================== Settings Types ====================

export type BetStrategy = 'martingale' | 'fibonacci' | 'paroli' | 'flat' | 'custom'
export type BettingMode = 'ai' | 'pattern'

export interface AutoModeSettings {
  enabled: boolean
  // 배팅 설정
  baseBetAmount: number
  maxMartin: number
  betStrategy: BetStrategy
  customBetAmounts?: number[]
  resetMartinOnStop: boolean
  // 방 설정
  roomConfigs: RoomBetConfig[]
  onlySelectedRooms: boolean
  globalMaxConsecutiveLosses: number
  lossThreshold: number
  // 배팅 모드
  isVirtualMode: boolean
  bettingMode: BettingMode
  // 강제 베팅 방향: 'tie_only'일 때 prediction 무시하고 Tie 강제 (Fresh-Shoe 프리셋이 사용)
  forceBetDirection?: 'auto' | 'tie_only'
  // SemiAutoSettings 호환 필드
  autoBetting: boolean
  useAiPrediction: boolean
  winCutAmount: number
  lossCutAmount: number
  baseUrl: string
  patternConfigs: PatternBetConfig[]
}

export const DEFAULT_SETTINGS: AutoModeSettings = {
  enabled: false,
  baseBetAmount: 10000,
  maxMartin: 5,
  betStrategy: 'martingale',
  customBetAmounts: undefined,
  resetMartinOnStop: true,
  roomConfigs: [],
  onlySelectedRooms: false,
  globalMaxConsecutiveLosses: 5,
  lossThreshold: 0,
  isVirtualMode: true,
  bettingMode: 'ai',
  forceBetDirection: 'auto',
  autoBetting: false,
  useAiPrediction: true,
  winCutAmount: 0,
  lossCutAmount: 0,
  baseUrl: '',
  patternConfigs: [],
}

// ==================== Room Context (방별 런타임 상태) ====================

/**
 * 방별 마틴게일 상태 - MartingaleManager가 관리
 */
export interface MartingaleState {
  level: number
  consecutiveLosses: number
  consecutiveWins: number
}

/**
 * 방별 배팅 상태 - BettingDecisionService/ResultProcessor가 관리
 */
export interface BettingState {
  lastPrediction: Prediction | null
  lastBetAmount: number
  waitingForResult: boolean
  lastBetTime: number | null
  lastBetHistoryLength: number | null
  lastResultTime: number | null
  wasVirtualBet?: boolean
  currentBetAmount?: number
  currentBetType?: BetType
}

/**
 * 방별 결과 추론 상태 - ResultProcessor가 관리
 */
export interface InferenceState {
  resultInferenceRetries: number
  lastInferenceRetryTime: number | null
}

/**
 * 방별 통합 런타임 상태 (RoomContext)
 * 각 매니저가 자신의 영역만 읽고 씀
 */
export interface RoomContext {
  roomId: string
  roomName: string
  // 각 매니저의 상태
  martingale: MartingaleState
  betting: BettingState
  inference: InferenceState
  // 통계
  stats: {
    totalBets: number
    wins: number
    losses: number
    ties?: number
    totalProfit: number
    currentStreak: number
    maxWinStreak: number
    maxLoseStreak: number
    // 레거시 호환
    totalWins: number
    totalLosses: number
  }
}

/**
 * RoomContext 생성 팩토리
 */
export function createRoomContext(roomId: string, roomName: string): RoomContext {
  return {
    roomId,
    roomName,
    martingale: {
      level: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
    },
    betting: {
      lastPrediction: null,
      lastBetAmount: 0,
      waitingForResult: false,
      lastBetTime: null,
      lastBetHistoryLength: null,
      lastResultTime: null,
    },
    inference: {
      resultInferenceRetries: 0,
      lastInferenceRetryTime: null,
    },
    stats: {
      totalBets: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      totalProfit: 0,
      currentStreak: 0,
      maxWinStreak: 0,
      maxLoseStreak: 0,
      totalWins: 0,
      totalLosses: 0,
    },
  }
}

// ==================== Legacy Compatible Types ====================

/**
 * 기존 RoomBettingState와 호환 (마이그레이션 용)
 */
export interface RoomBettingState {
  roomId: string
  roomName: string
  martinLevel: number
  consecutiveLosses: number
  consecutiveWins: number
  totalBets: number
  totalWins: number
  totalLosses: number
  totalProfit: number
  lastPrediction: Prediction | null
  lastBetAmount: number
  waitingForResult: boolean
  lastBetTime: number | null
  lastBetHistoryLength: number | null
  lastResultTime: number | null
  resultInferenceRetries: number
  lastInferenceRetryTime: number | null
  wasVirtualBet?: boolean
}

/**
 * RoomContext → RoomBettingState 변환 (후방 호환)
 */
export function toRoomBettingState(ctx: RoomContext): RoomBettingState {
  return {
    roomId: ctx.roomId,
    roomName: ctx.roomName,
    martinLevel: ctx.martingale.level,
    consecutiveLosses: ctx.martingale.consecutiveLosses,
    consecutiveWins: ctx.martingale.consecutiveWins,
    totalBets: ctx.stats.totalBets,
    totalWins: ctx.stats.wins,
    totalLosses: ctx.stats.losses,
    totalProfit: ctx.stats.totalProfit,
    lastPrediction: ctx.betting.lastPrediction,
    lastBetAmount: ctx.betting.lastBetAmount,
    waitingForResult: ctx.betting.waitingForResult,
    lastBetTime: ctx.betting.lastBetTime,
    lastBetHistoryLength: ctx.betting.lastBetHistoryLength,
    lastResultTime: ctx.betting.lastResultTime,
    resultInferenceRetries: ctx.inference.resultInferenceRetries,
    lastInferenceRetryTime: ctx.inference.lastInferenceRetryTime,
    wasVirtualBet: ctx.betting.wasVirtualBet,
  }
}

/**
 * RoomBettingState → RoomContext 변환 (마이그레이션)
 */
export function fromRoomBettingState(state: RoomBettingState): RoomContext {
  return {
    roomId: state.roomId,
    roomName: state.roomName,
    martingale: {
      level: state.martinLevel,
      consecutiveLosses: state.consecutiveLosses,
      consecutiveWins: state.consecutiveWins,
    },
    betting: {
      lastPrediction: state.lastPrediction,
      lastBetAmount: state.lastBetAmount,
      waitingForResult: state.waitingForResult,
      lastBetTime: state.lastBetTime,
      lastBetHistoryLength: state.lastBetHistoryLength,
      lastResultTime: state.lastResultTime,
      wasVirtualBet: state.wasVirtualBet,
    },
    inference: {
      resultInferenceRetries: state.resultInferenceRetries,
      lastInferenceRetryTime: state.lastInferenceRetryTime,
    },
    stats: {
      totalBets: state.totalBets,
      wins: state.totalWins,
      losses: state.totalLosses,
      ties: 0,
      totalProfit: state.totalProfit,
      currentStreak: 0,
      maxWinStreak: 0,
      maxLoseStreak: 0,
      totalWins: state.totalWins,
      totalLosses: state.totalLosses,
    },
  }
}

// ==================== State Machine Types ====================

/**
 * AutoMode 상태
 */
export type AutoModeStatus = 'idle' | 'running' | 'paused' | 'stopping'

/**
 * 상태 전이 이벤트
 */
export type AutoModeEvent =
  | { type: 'START'; realBalance?: number }
  | { type: 'STOP' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'WIN_CUT_REACHED' }
  | { type: 'LOSS_CUT_REACHED' }

/**
 * 상태 전이 명령 (Orchestrator가 실행)
 */
export type AutoModeCommand =
  | { type: 'NOTIFY_STATE_CHANGE' }
  | { type: 'RESET_STATS' }
  | { type: 'RESET_MARTINGALE_ALL' }
  | { type: 'SAVE_SESSION' }
  | { type: 'EMIT_LOG'; message: string }

/**
 * 상태 전이 결과
 */
export interface StateTransitionResult {
  newStatus: AutoModeStatus
  commands: AutoModeCommand[]
}

// ==================== Event Types ====================

/**
 * 배팅 결정 결과
 */
export interface BetDecision {
  shouldBet: boolean
  skipReason?: string
  betAmount?: number
  betType?: BetType
}

/**
 * 결과 처리 결과
 */
export interface ResultOutcome {
  won: boolean
  profit: number
  newMartinLevel: number
}

/**
 * 배팅 결과 (ResultProcessor 반환)
 */
export interface BetResult {
  isWin: boolean
  isTie: boolean
  profit: number
  newLevel: number
}

/**
 * 세션 통계 (전체 방 집계)
 */
export interface SessionStats {
  totalBets: number
  totalWins: number
  totalLosses: number
  totalTies: number
  totalProfit: number
  winRate: number
  maxWinStreak: number
  maxLoseStreak: number
  roomCount: number
}

/**
 * 배팅 로그 이벤트 (UI 표시용)
 */
export interface AutoModeBetLogEvent {
  type: 'prediction' | 'bet_placed' | 'bet_result'
  roomId: string
  roomName: string
  prediction?: 'B' | 'P' | 'T' | null
  betType?: BetType
  betAmount?: number
  martinLevel: number
  won?: boolean | null
  winner?: Winner
  historyIndex?: number
  status?: 'pending' | 'win' | 'loss' | 'tie' | 'failed' | 'pass'
  level?: 'info' | 'error'
  profit?: number
  cumulativeProfit?: number
  confidence?: number
  reasoning?: string
  timestamp: number
  /** 플레이어 카드 합계 점수 (결과 표시용) */
  playerScore?: number
  /** 뱅커 카드 합계 점수 (결과 표시용) */
  bankerScore?: number
}

// ==================== Global State ====================

/**
 * AutoMode 전역 상태
 */
export interface AutoModeGlobalState {
  status: AutoModeStatus
  settings: AutoModeSettings
  // 전체 통계
  totalWins: number
  totalLosses: number
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
  // 방별 상태
  roomContexts: Map<string, RoomContext>
  // 메타데이터
  statusMessage: string
  lastEventTime: number | null
  startTime: number | null
  startBalance: number
}

// ==================== Callback Types ====================

export type StateChangeCallback = (state: AutoModeGlobalState) => void
export type BetLogCallback = (event: AutoModeBetLogEvent) => void

// ==================== Storage Keys ====================

export const STORAGE_KEYS = {
  SETTINGS: 'smart-helper:auto-mode-settings',
  SESSION: 'smart-helper:auto-mode-session',
} as const
