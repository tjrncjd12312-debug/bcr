// AutoModeService - 오토모드 전용 서비스
// Clean Architecture: Application Layer
//
// 오토모드 전용 기능:
// - 멀티룸 동시 모니터링 (사용자가 ON한 방만)
// - 패턴 필터 기반 배팅 (사용자 설정)
// - 방별 마틴게일 관리
// - 가상/실제 배팅 지원
// - 배팅 로그 이벤트 시스템

import type {
  Room,
  Prediction,
  BettingPhaseEvent,
  GameResultEvent,
  RoadResult,
  BetType,
  RoomBetConfig,
  RoomFilterType,
  PatternBetConfig,
  Winner,
  BetOutcome,
} from '../../domain/entities'
import { winProfit } from '../../domain/betting/payout'
import { isBetAccepted, isBetRejected, predResultToSpot } from '../../domain/betting/settlement'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di'
import { CallbackManager } from '../utils'
import { VirtualBettingService } from './VirtualBettingService'
import { AutoBettingService, type BetExecutionStatus } from './AutoBettingService'
import { PragmaticAdapter } from '../../infrastructure/adapters/PragmaticAdapter'

/** 프라그마틱 방 id prefix. useCasino가 병합할 때 붙인다. */
const PRAGMATIC_PREFIX = 'pragmatic:'
import { MultiRoomPredictionService } from './MultiRoomPredictionService'
import { PatternBettingService } from './PatternBettingService'
import FilterThresholdsService from './FilterThresholdsService'
import CustomStrategyService from './CustomStrategyService'
import CustomStrategyRuntime, {
  type CustomStrategyBetDecision,
  type CustomStrategySessionStatus,
} from './customstrategy/CustomStrategyRuntime'

// ==================== AutoMode Modules Integration ====================
import {
  getMartingaleManager,
  createBettingDecisionService,
  createPatternPredictionService,
  getAutoModeRepository,
  fromRoomBettingState,
  type IMartingaleManager,
  type IBettingDecisionService,
  type IPatternPredictionService,
  type IAutoModeRepository,
  type BetDecision,
  type RoomContext,
} from './automode'

// ==================== Types ====================

export interface AutoModeSettings {
  enabled: boolean
  // 배팅 설정
  baseBetAmount: number
  maxMartin: number
  betStrategy: 'martingale' | 'fibonacci' | 'paroli' | 'flat' | 'custom'
  customBetAmounts?: number[] // 커스텀 전략: 단계별 배팅 금액 배열
  resetMartinOnStop: boolean  // 중지 시 마틴 레벨 리셋 여부
  // 🆕 v2.24: 동시 배팅 제한 (0 = 무제한, 예측모드처럼 동작)
  maxConcurrentBets: number
  // 방 설정
  roomConfigs: RoomBetConfig[]
  onlySelectedRooms: boolean
  globalMaxConsecutiveLosses: number
  lossThreshold: number
  // 배팅 모드
  isVirtualMode: boolean
  bettingMode: 'ai' | 'pattern'
  // SemiAutoSettings 호환 필드
  autoBetting: boolean            // 자동 배팅 ON/OFF (isVirtualMode와 반대 개념)
  useAiPrediction: boolean        // AI 예측 사용
  winCutAmount: number            // 윈컷 (0 = 무제한)
  lossCutAmount: number           // 로스컷 (0 = 무제한)
  baseUrl: string                 // Evolution Gaming 베이스 URL
  patternConfigs: PatternBetConfig[] // 패턴별 배팅 설정
  // 강제 배팅 방향: 프리셋/필터가 예측 방향을 무시하고 Tie 등 고정 방향을 적용할 때 사용
  forceBetDirection?: 'auto' | 'tie_only'
  /**
   * 🆕 2026-09-05 마틴 이어치기를 패턴에 묶는다(사용자: "패턴 설정 시 마틴을 걸어도 그 패턴에만 배팅돼야 해").
   * true(기본): 졌던 방은 마틴 단계를 기억하되, 선택한 패턴이 그 방에서 **다시 맞는 판에만** 다음 단계 금액으로
   *   배팅한다(방향도 그 판의 패턴이 정함). 패턴이 안 맞는 판은 건너뛰고 단계는 유지.
   * false: 예전 동작 — 패턴과 무관하게 이길 때까지 같은 방향으로 매판 이어친다.
   * 필터가 'all'(패턴 없음)·타이 계열(타이 자동: 타이 나올 때까지 T 이어치기)·커스텀 전략 진행 중이면 관여하지 않는다.
   */
  martinRequiresPattern?: boolean
  // 🆕 Tie 베팅 전용 최대 한도 (Evolution 테이블은 Tie를 별도로 낮게 제한하지만 CDP 캡처에는
  //   tableMaxLimit 하나만 들어옴). 0 = 사용 안 함 (tableMaxLimit로만 캡).
  tieMaxBetLimit?: number
}

export interface RoomBettingState {
  roomId: string
  roomName: string
  // 아래 세 값은 MartingaleManager에서 읽어오는 파생값이다(저장된 사본이 아님).
  // 변경은 반드시 martingaleManager를 통해서만 — readonly라 대입은 컴파일 에러가 난다.
  readonly martinLevel: number
  readonly consecutiveLosses: number
  readonly consecutiveWins: number
  totalBets: number
  totalWins: number
  totalLosses: number
  totalProfit: number
  lastPrediction: Prediction | null
  /** First bet in the current martingale chain. Kept after a loss so recovery bets use the same direction. */
  martinRecoveryPrediction: Prediction | null
  /** Strategy captured when the current progression chain started. */
  martinRecoveryStrategy: AutoModeSettings['betStrategy'] | null
  lastBetAmount: number
  waitingForResult: boolean
  lastBetTime: number | null
  /** History length snapshot at bet placement time (newest-first history) */
  lastBetHistoryLength: number | null
  lastResultTime: number | null
  // 결과 추론 재시도 상태
  resultInferenceRetries: number
  lastInferenceRetryTime: number | null
  // Bug Fix: 배팅 시점의 모드 저장 (결과 처리 시 모드 불일치 방지)
  wasVirtualBet?: boolean
  /** Real-bet transport/confirmation state. `unknown` must remain pending until resolved. */
  placementStatus?: BetExecutionStatus
  customStrategyId?: string
  customStrategyStage?: number
  customStrategyAttempt?: number
  customStrategyStatus?: CustomStrategySessionStatus
  /** 마틴 진행 중인데 선택한 패턴이 이 판엔 안 맞아 건너뛴 상태(martinRequiresPattern). 배팅이 나가면 풀린다. */
  patternWait?: boolean
  /** 이 마틴 체인을 시작한 패턴 필터. 체인 중 사용자가 필터를 바꿔도 이어치기 판정은 이 패턴으로 한다(martinLevel>0일 때만 의미). */
  martinChainFilter?: RoomFilterType | 'all' | null
}

export interface AutoModeState {
  settings: AutoModeSettings
  // 전체 통계
  totalWins: number
  totalLosses: number
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
  // 방별 상태
  roomStates: Map<string, RoomBettingState>
  // 상태
  statusMessage: string
  lastEventTime: number | null
  // 가동 시간 추적
  startTime: number | null
  // 시작 금액 (세션 시작 시 스냅샷)
  startBalance: number
  // tie_frequent 자동 배팅에서 이 슈 동안 이미 적중(또는 종료)한 방 ID 목록.
  // UI 카운트와 후보 풀에서 제외하기 위해 노출. 슈가 갈리면 자동 비워진다.
  // Zero-tie tie_frequent only: a Tie completes the room for the current shoe.
  // Shoe change clears this marker, so the room can re-enter if it matches the
  // user's current filter thresholds again.
  tieAutoCompletedRoomIds: string[]
  /** 🆕 실배팅 모드의 실잔액 기반 누적 손익(자체 추정 cumulativeProfit과 별개). 가상/미수신 시 null/undefined. */
  realNetProfit?: number | null
  /** 🆕 실모드 표시용 보유금 = 시작잔액 + 누적손익 − 실배팅 pending. 배팅 즉시 차감 반영(가상모드와 동일 모델). */
  realDisplayBalance?: number | null
  /** 🆕 2026-09-05 가상/실제 각각의 세션 통계(설정창 표시용). 현재 모드 쪽이 위 필드들과 같다. */
  modeStats?: { virtual: ModeSessionStats; real: ModeSessionStats }
}

export interface ModeSessionStats {
  totalWins: number
  totalLosses: number
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
}

// 로그 이벤트 타입
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
  /**
   * Result index in `room.history` (newest-first, 0 = latest) when available.
   * Used by UI to mark the actual history dot that corresponds to this bet.
   */
  historyIndex?: number
  /** Additional metadata for UI rendering */
  status?: 'pending' | 'win' | 'loss' | 'tie' | 'failed' | 'pass'
  level?: 'info' | 'error'
  profit?: number
  /** 해당 시점의 누적 손익 (히스토리 CUM 표시용) */
  cumulativeProfit?: number
  confidence?: number
  reasoning?: string
  timestamp: number
  /** 플레이어 카드 합계 점수 (결과 표시용) */
  playerScore?: number
  /** 뱅커 카드 합계 점수 (결과 표시용) */
  bankerScore?: number
  customStrategyId?: string
  customStrategyStage?: number
  customStrategyAttempt?: number
}

type StateChangeCallback = (state: AutoModeState) => void
type BetLogCallback = (event: AutoModeBetLogEvent) => void

// ==================== Default Settings ====================

const DEFAULT_SETTINGS: AutoModeSettings = {
  enabled: false,
  baseBetAmount: 10000,
  maxMartin: 5,
  betStrategy: 'martingale',
  customBetAmounts: undefined, // 커스텀 전략 사용 시 설정
  resetMartinOnStop: true,     // 기본값: 중지 시 마틴 리셋
  maxConcurrentBets: 6,        // 🆕 v2.25: 6 = Top6 집중 배팅 (0=무제한)
  roomConfigs: [],
  onlySelectedRooms: false,
  globalMaxConsecutiveLosses: 5,
  lossThreshold: 0,
  isVirtualMode: true,
  bettingMode: 'ai',
  // SemiAutoSettings 호환 필드
  autoBetting: false,
  useAiPrediction: true,
  winCutAmount: 0,
  lossCutAmount: 0,
  baseUrl: '',
  patternConfigs: [],
  forceBetDirection: 'auto',
  martinRequiresPattern: true,
  // 🆕 Tie 베팅 최대 한도 (선택). 0 = 사용 안 함. 사용자가 명시적으로 설정한 경우에만
  //   클라이언트 측에서 캡을 강제한다. 기본은 사용자가 설정한 마틴 금액 그대로 보낸다.
  tieMaxBetLimit: 0,
}

// ==================== Service Implementation ====================

class AutoModeServiceImpl {
  private settings: AutoModeSettings

  constructor() {
    // Load settings from localStorage, but ALWAYS start with enabled: false
    const saved = this.loadFromStorage()
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      // CRITICAL: Always start disabled - never auto-start from saved state
      // This prevents accidental betting without explicit user action
      enabled: false,
      autoBetting: false,
    }

    // globalMaxConsecutiveLosses는 maxMartin과 항상 동일하게 유지 (하위 호환) — 마틴은 MAX 단까지
    // 진행(이길 때까지)이 정상 동작이므로 연패 횟수로 방을 중간에 멈추지 않는다(사용자 확인 2026-06-24).
    this.settings.globalMaxConsecutiveLosses = this.settings.maxMartin
    this.normalizeCustomBetSettings()

    // MartingaleManager 내부 cap을 사용자 설정과 동기화 — 그렇지 않으면 recordLoss가
    // 내부 기본값(5)에서 막혀 100단 설정해도 level이 5에서 더 안 올라간다.
    this.martingaleManager.setMaxLevel(this.settings.maxMartin)

    console.log('[AutoMode] Settings loaded, enabled forced to false for safety, maxMartin synced:', this.settings.maxMartin)
  }

  private normalizeCustomBetSettings(): void {
    if (this.settings.betStrategy !== 'custom') return

    const baseAmount = Number.isFinite(Number(this.settings.baseBetAmount)) && Number(this.settings.baseBetAmount) > 0
      ? Math.round(Number(this.settings.baseBetAmount))
      : DEFAULT_SETTINGS.baseBetAmount
    const rawMaxMartin = Number(this.settings.maxMartin)
    let maxMartin = Number.isFinite(rawMaxMartin) && rawMaxMartin > 0
      ? Math.floor(rawMaxMartin)
      : DEFAULT_SETTINGS.maxMartin

    let customAmounts = Array.isArray(this.settings.customBetAmounts)
      ? this.settings.customBetAmounts
        .map(amount => Number(amount))
        .filter(amount => Number.isFinite(amount) && amount > 0)
        .map(amount => Math.round(amount))
      : []

    if (customAmounts.length > maxMartin) {
      maxMartin = customAmounts.length
    }

    if (customAmounts.length === 0) {
      customAmounts = Array(maxMartin).fill(baseAmount)
    } else if (customAmounts.length < maxMartin) {
      const fillAmount = customAmounts[customAmounts.length - 1] ?? baseAmount
      customAmounts = [
        ...customAmounts,
        ...Array(maxMartin - customAmounts.length).fill(fillAmount),
      ]
    }

    this.settings.maxMartin = maxMartin
    this.settings.globalMaxConsecutiveLosses = maxMartin
    this.settings.customBetAmounts = customAmounts
  }

  // Kept in the public hook shape for compatibility. Tie-auto no longer excludes
  // rooms after a win; matching rooms can re-enter when a slot is available.
  private state: Omit<AutoModeState, 'settings' | 'tieAutoCompletedRoomIds'> = {
    totalWins: 0,
    totalLosses: 0,
    totalBetAmount: 0,
    cumulativeProfit: 0,
    maxProfit: 0,
    maxLoss: 0,
    roomStates: new Map(),
    statusMessage: '대기 중',
    lastEventTime: null,
    startTime: null,
    startBalance: 0,
  }

  /** 🆕 2026-09-05 가상/실제 손익·승패 분리(사용자: "가상과 실제 손익이 공유됨"). 지금 모드가 아닌 쪽의 통계를
   *  여기 보관했다가 모드가 바뀌면 state의 6개 필드와 맞바꾼다. 통계 초기화는 현재 모드만 지운다. */
  private inactiveModeStats = { totalWins: 0, totalLosses: 0, totalBetAmount: 0, cumulativeProfit: 0, maxProfit: 0, maxLoss: 0 }

  private clearInactiveModeStats(): void {
    this.inactiveModeStats = { totalWins: 0, totalLosses: 0, totalBetAmount: 0, cumulativeProfit: 0, maxProfit: 0, maxLoss: 0 }
  }

  private swapModeStats(): void {
    const active = {
      totalWins: this.state.totalWins, totalLosses: this.state.totalLosses, totalBetAmount: this.state.totalBetAmount,
      cumulativeProfit: this.state.cumulativeProfit, maxProfit: this.state.maxProfit, maxLoss: this.state.maxLoss,
    }
    Object.assign(this.state, this.inactiveModeStats)
    this.inactiveModeStats = active
    console.log(`[AutoMode] 🔀 모드 전환 — 통계 맞바꿈 (현재 모드 손익 ${this.state.cumulativeProfit}, 보관 ${active.cumulativeProfit})`)
  }

  private stateManager = new CallbackManager<StateChangeCallback>('AutoMode')
  private betLogManager = new CallbackManager<BetLogCallback>('AutoMode')
  private adapterUnsubscribers: Array<() => void> = []
  private lastDecisionKeyByRoom: Map<string, string> = new Map()

  // 🆕 v3.7.0: 실제 사용자 잔액 추적
  private realBalance: number | null = null
  // 🆕 실배팅 손익 기준선(세션 시작 시 실잔액). getRealNetProfit() = (현재잔액 - 기준선) + 실배팅 pending.
  private realStartBalance: number | null = null

  // 🆕 v2.24: 동시배팅 제한은 사용자 설정으로 이동 (settings.maxConcurrentBets)
  // 0 = 무제한 (예측모드처럼), 1~N = 제한

  // 현재 슬롯을 점유한 방 수 (waitingForResult + bettingInProgress + martin>0)
  // - waitingForResult: 결과 대기 중인 방
  // - bettingInProgress: 현재 배팅 진행 중인 방 (예측/배팅 처리 중)
  // - martinLevel > 0: 마틴 사이클 진행 중 (라운드 사이 잠시 쉬는 방도 슬롯 점유)
  //
  // 정책: "한 방에 들어가면 승리(또는 마틴 종료)까지 그 방이 슬롯을 잡는다."
  // 라운드 사이라고 슬롯을 다른 신규 방에 양보하면, 마틴 방이 돌아왔을 때 동시 상한을 초과한다.
  private getActiveBettingCount(): number {
    // 🐞 라이브락 수정(2026-05-31): bettingInProgress(예측 진행 락)를 슬롯 카운트에서 제외한다.
    //    예전엔 락도 셌는데, 예측(getPatternBasedPrediction await)이 수초 걸리는 동안 방 2개가
    //    락만 잡고 나머지를 전부 막았다. 그 2개가 shouldBet=false로 스킵하면 배팅 없이 락만 풀고,
    //    다음 2개도 또 스킵 → waitingForResult가 영영 0 = "배팅 자체를 안 함"(슬롯 2/2 lock:2 고착).
    //    이제 슬롯은 '실제 배팅'(waitingForResult)·'마틴 진행'(martinLevel>0)만 점유한다.
    //    동시 배팅 상한은 placeBet 직전 재확인으로 원자적으로 보장한다(예측 락은 방별 재진입 방지용).
    const activeRoomIds = new Set<string>()
    this.state.roomStates.forEach(state => {
      if (state.waitingForResult) activeRoomIds.add(state.roomId)
      if (state.martinLevel > 0) activeRoomIds.add(state.roomId)
      if (CustomStrategyRuntime.isProgressionActive(state.roomId)) activeRoomIds.add(state.roomId)
    })
    return activeRoomIds.size
  }

  private isCustomStrategyFilter(filter: RoomFilterType | 'all' = this.currentPatternFilter): boolean {
    return filter !== 'all' && CustomStrategyService.isStrategyFilter(filter)
  }

  private isProgressionActive(roomId: string, state?: RoomBettingState): boolean {
    const roomState = state ?? this.state.roomStates.get(roomId)
    return Boolean(
      roomState?.waitingForResult ||
      (roomState?.martinLevel ?? 0) > 0 ||
      CustomStrategyRuntime.isProgressionActive(roomId)
    )
  }

  private syncCustomStrategyState(roomId: string, state: RoomBettingState): void {
    const session = CustomStrategyRuntime.getSessionForRoom(roomId)
    if (!session) {
      state.customStrategyId = undefined
      state.customStrategyStage = undefined
      state.customStrategyAttempt = undefined
      state.customStrategyStatus = undefined
      return
    }
    state.customStrategyId = session.strategyId
    state.customStrategyStage = session.stageIndex + 1
    state.customStrategyAttempt = session.attemptIndex + 1
    state.customStrategyStatus = session.status
  }

  // Lazy-loaded dependencies
  private _casinoAdapter: ICasinoAdapter | null = null
  private _multiRoomPredictionPort: IMultiRoomPredictionPort | null = null

  // ==================== Extracted Modules ====================
  private martingaleManager: IMartingaleManager = getMartingaleManager()
  private bettingDecisionService: IBettingDecisionService = createBettingDecisionService(
    this.martingaleManager
  )
  private _patternPredictionService: IPatternPredictionService | null = null
  private repository: IAutoModeRepository = getAutoModeRepository()

  /**
   * 방 조회를 제공자별로 분기한다. DI의 casinoAdapter는 에볼루션 전용이라 프라그마틱 방을 모른다 —
   * 그 상태로는 자동배팅이 프라그마틱 방을 "없는 방"으로 보고 전부 건너뛴다(2026-09-03).
   */
  private resolveRoom(roomId: string): Room | null {
    if (roomId.startsWith(PRAGMATIC_PREFIX)) {
      const raw = PragmaticAdapter.getRoom(roomId.slice(PRAGMATIC_PREFIX.length))
      return raw ? { ...raw, id: roomId, provider: 'pragmatic' } : null
    }
    return this.casinoAdapter.getRoom(roomId)
  }

  private allRoomIds(): string[] {
    const evo = Array.from(this.casinoAdapter.getRooms().keys())
    const prag = Array.from(PragmaticAdapter.getRooms().keys()).map((id) => `${PRAGMATIC_PREFIX}${id}`)
    return [...evo, ...prag]
  }

  private get casinoAdapter(): ICasinoAdapter {
    if (!this._casinoAdapter) {
      this._casinoAdapter = container.get('casinoAdapter')
    }
    return this._casinoAdapter
  }

  private get multiRoomPredictionPort(): IMultiRoomPredictionPort {
    if (!this._multiRoomPredictionPort) {
      this._multiRoomPredictionPort = container.get('multiRoomPredictionPort')
    }
    return this._multiRoomPredictionPort
  }

  private get patternPredictionService(): IPatternPredictionService {
    if (!this._patternPredictionService) {
      this._patternPredictionService = createPatternPredictionService(this.multiRoomPredictionPort)
    }
    return this._patternPredictionService
  }

  // ==================== Initialization ====================

  initialize(): void {
    this.cleanupAdapterSubscriptions()

    // 베팅 페이즈 구독
    const unsubBetting = this.casinoAdapter.onBettingPhase((event) => {
      console.log(`[AutoMode] 📥 BettingPhase event received: ${event.roomId}, phase: ${event.phase}`)
      // void를 사용하여 async 함수의 Promise 에러가 unhandled rejection이 되지 않도록 함
      void this.onBettingPhase(event)
    })
    this.adapterUnsubscribers.push(unsubBetting)

    // 🎲 프라그마틱(브릿지) 이벤트도 같은 파이프라인으로 — roomId는 prefix를 붙여 UI/설정과 맞춘다.
    const prefix = PRAGMATIC_PREFIX
    this.adapterUnsubscribers.push(PragmaticAdapter.onBettingPhase((event) => {
      void this.onBettingPhase({ ...event, roomId: `${prefix}${event.roomId}` })
    }))
    this.adapterUnsubscribers.push(PragmaticAdapter.onGameResult((event) => {
      this.onGameResult({ ...event, roomId: `${prefix}${event.roomId}` })
    }))

    // 게임 결과 구독
    const unsubResult = this.casinoAdapter.onGameResult((event) => {
      console.log(`[AutoMode] 📥 GameResult event received: ${event.roomId}, winner: ${event.winner}`)
      this.onGameResult(event)
    })
    this.adapterUnsubscribers.push(unsubResult)

    const unsubHistory = this.casinoAdapter.onHistoryUpdate((roomId, history) => {
      this.onHistoryUpdate(roomId, history)
    })
    this.adapterUnsubscribers.push(unsubHistory)

    // 슈 변경 구독
    const unsubShoe = this.casinoAdapter.onShoeChange?.((roomId: string) => {
      this.onShoeChange(roomId)
    })
    if (unsubShoe) this.adapterUnsubscribers.push(unsubShoe)

    // 🆕 v3.7.0: 실제 잔액 업데이트 구독
    const unsubBalance = this.casinoAdapter.onBalanceUpdate?.((balance) => this.onRealBalanceUpdate(balance))
    if (unsubBalance) this.adapterUnsubscribers.push(unsubBalance)

    // 🎲 프라그마틱 실보유금(클라이언트 DOM "보유잔액" 스캔)도 같은 실잔액 파이프라인으로.
    this.adapterUnsubscribers.push(PragmaticAdapter.onBalanceUpdate((balance) => this.onRealBalanceUpdate(balance)))

    // 🛡️ 초기화 시 AutoBettingService 가상모드 동기화
    // localStorage에서 로드한 설정과 동기화 (start() 전에도 일관성 유지)
    AutoBettingService.setVirtualMode(this.settings.isVirtualMode)
    console.log(`[AutoMode] 🛡️ AutoBettingService virtual mode synced on init: ${this.settings.isVirtualMode}`)

    console.log('[AutoMode] ✅ Service initialized - subscribed to betting phase and game result events')
  }

  // 🆕 실잔액 갱신 공통 처리(에볼 중계 + 프라그마틱 DOM 스캔 공유).
  private onRealBalanceUpdate(balance: number): void {
    this.realBalance = balance
    // 실배팅 시작 후 첫 실잔액을 기준선으로 캡처(시작 시점에 잔액을 아직 못 받은 경우 대비).
    // 🆕 2026-06-23: 중계 실잔액이 늦게(베팅 몇 판 후) 처음 도착할 수 있으므로, 그 시점의 누적손익·
    //   진행중배팅을 역산해 기준선을 잡는다 → 표시잔고(getRealDisplayBalance=기준선+누적−pending)가
    //   캡처 순간 실잔액과 정확히 일치(이중계산 방지). 이후엔 베팅 결과로 즉시 투영(중계 지연 회피).
    if (!this.settings.isVirtualMode && this.settings.enabled
      && this.realStartBalance === null && typeof balance === 'number' && balance > 0) {
      this.realStartBalance = balance - this.state.cumulativeProfit + this.getRealPendingBetAmount()
      console.log(`[AutoMode] 💰 실배팅 기준선 캡처: 실잔액 ${balance.toLocaleString()} → 기준선 ${this.realStartBalance.toLocaleString()}원`)
    }
    console.log(`[AutoMode] 💰 Balance updated: ${balance?.toLocaleString()}원`)
    // 실잔액이 정산될 때마다 실배팅 윈컷/로스컷을 '진짜 돈' 기준으로 재확인(자체 추정 아님).
    this.checkRealBalanceCuts()
  }

  private cleanupAdapterSubscriptions(): void {
    this.adapterUnsubscribers.forEach(unsub => unsub())
    this.adapterUnsubscribers = []
    this.realBalance = null // 🆕 잔액 추적 초기화
  }

  // ==================== Getters ====================

  // Fresh-Shoe 프리셋용: 외부에서 BettingDecisionService에 게이트 주입
  setFreshShoeGates(stoppedRoomsChecker: (roomId: string) => boolean, onMartinCap: (roomId: string) => void): void {
    // bettingDecisionService는 Task 8에서 setters가 추가된 concrete BettingDecisionService 인스턴스
    const svc = this.bettingDecisionService as { setStoppedRoomsChecker?: (fn: (id: string) => boolean) => void; setOnMartinCap?: (fn: (id: string) => void) => void }
    svc.setStoppedRoomsChecker?.(stoppedRoomsChecker)
    svc.setOnMartinCap?.(onMartinCap)
  }

  getState(): AutoModeState {
    return {
      settings: { ...this.settings },
      ...this.state,
      roomStates: new Map(this.state.roomStates),
      tieAutoCompletedRoomIds: Array.from(this.tieAutoCompletedRoomIds),
      // 🆕 실배팅 실잔액 기반 손익(가상/미수신 시 null) — UI가 '진짜 돈' 손익을 표시할 수 있게 노출.
      realNetProfit: this.getRealNetProfit(),
      // 🆕 실모드 표시용 보유금(배팅 즉시 차감 반영). UI 보유금 pod가 이 값을 쓴다.
      realDisplayBalance: this.getRealDisplayBalance(),
      modeStats: (() => {
        const active: ModeSessionStats = {
          totalWins: this.state.totalWins, totalLosses: this.state.totalLosses, totalBetAmount: this.state.totalBetAmount,
          cumulativeProfit: this.state.cumulativeProfit, maxProfit: this.state.maxProfit, maxLoss: this.state.maxLoss,
        }
        const other: ModeSessionStats = { ...this.inactiveModeStats }
        return this.settings.isVirtualMode ? { virtual: active, real: other } : { virtual: other, real: active }
      })(),
    }
  }

  isEnabled(): boolean {
    return this.settings.enabled
  }

  getSettings(): AutoModeSettings {
    return { ...this.settings }
  }

  getRoomState(roomId: string): RoomBettingState | null {
    return this.state.roomStates.get(roomId) || null
  }

  // ==================== Actions ====================

  toggle(realBalance?: number): void {
    if (this.settings.enabled) {
      this.stop()
    } else {
      this.start(realBalance)
    }
  }

  start(realBalance?: number): void {
    this.settings.enabled = true
    this.state.statusMessage = '배팅 시작'
    this.state.lastEventTime = Date.now()
    this.state.startTime = Date.now()

    // 🆕 v2.2: 서버에 autoMode=true 전달하도록 설정
    MultiRoomPredictionService.setAutoMode(true)

    // 시작 잔액 스냅샷 (가상: 설정값, 실제: 전달받은 값)
    // NOTE: 가상모드는 start() 시 VirtualBettingService.reset()이 호출되므로 initialBalance가 시작금액이 됨
    this.state.startBalance = this.settings.isVirtualMode
      ? VirtualBettingService.getSettings().initialBalance
      : (realBalance || 0)

    // 🆕 실배팅 손익 기준선: 전달받은 시작 잔액 → 추적 중 실잔액 순으로 캡처(둘 다 없으면
    // onBalanceUpdate에서 첫 실잔액을 기준선으로 잡는다). 가상모드는 사용 안 함(null).
    this.realStartBalance = this.settings.isVirtualMode
      ? null
      : ((realBalance && realBalance > 0) ? realBalance : (this.realBalance ?? null))

    // 🛡️ AutoBettingService 가상모드 동기화 - 시작 시 즉시 설정
    AutoBettingService.setVirtualMode(this.settings.isVirtualMode)

    // VirtualBettingService 활성화 (가상모드일 때)
    if (this.settings.isVirtualMode) {
      // ✅ 설정 동기화 후 활성화
      // 먼저 설정을 동기화하여 올바른 baseAmount가 적용되도록 함
      // 🔥 FIX: initialBalance는 VirtualBettingService에서 이미 관리됨 (AutoModeSettingsDialog에서 설정)
      const currentVS = VirtualBettingService.getSettings()
      VirtualBettingService.updateSettings({
        martingale: {
          ...currentVS.martingale,
          baseAmount: this.settings.baseBetAmount,
          maxLevel: this.settings.maxMartin,
        }
      })

      // 🛡️ 이전 세션의 pending 베팅이 잘못된 금액으로 남아있을 수 있으므로 리셋
      // (Predict모드에서 10,000원 기본값으로 배팅 후 AutoMode로 전환 시 문제 방지)
      VirtualBettingService.reset()
      console.log(`[AutoMode] VirtualBettingService reset됨 - initialBalance: ${currentVS.initialBalance}`)

      VirtualBettingService.enable()
      console.log(`[AutoMode] VirtualBettingService 활성화됨 - enabled: ${VirtualBettingService.isEnabled()}, balance: ${VirtualBettingService.getGlobalBalance()}, baseAmount: ${this.settings.baseBetAmount}`)
    }

    console.log(`[AutoMode] Started - isVirtualMode: ${this.settings.isVirtualMode}, activeBettingRoomIds: ${this.activeBettingRoomIds.size}개, filter: ${this.currentPatternFilter}`)
    console.log(`[AutoMode] Active rooms: [${Array.from(this.activeBettingRoomIds).slice(0, 5).join(', ')}${this.activeBettingRoomIds.size > 5 ? '...' : ''}]`)

    // 🆕 v2.24: 진단 타이머 시작 (30초마다 상태 요약)
    this.startDiagnosticTimer()

    // 🆕 v2.24: 연속 배팅 타이머 시작 (2초마다 배팅 가능한 방 체크)
    this.startContinuousBettingTimer()

    // ✅ ON을 "배팅 페이즈 진행 중"에 눌러도 즉시 배팅할 수 있도록, 현재 상태의 방들을 한 번 스캔
    this.tryBetOnCurrentBettingWindows()

    this.emitStateChange()
  }

  stop(): void {
    this.settings.enabled = false
    this.state.startTime = null // 정지 시 초기화

    // 🆕 v2.24: 타이머들 정지
    this.stopDiagnosticTimer()
    this.stopContinuousBettingTimer()

    // 🆕 v2.2: 서버에 autoMode=false 전달하도록 설정
    MultiRoomPredictionService.setAutoMode(false)

    // 🛡️ AutoBettingService 가상모드 해제 - 정지 시 다른 서비스가 배팅 가능하도록
    AutoBettingService.setVirtualMode(false)

    // 접수 완료된 실베팅은 서버의 실제 Undo 확인 없이 취소할 수 없다.
    // 정지는 신규 베팅만 막고, 해당 라운드의 결과 추적 상태는 그대로 보존한다.
    let pendingRealBetCount = 0

    // 중지 시 마틴 리셋 옵션이 활성화되어 있으면 안전하게 정리 가능한 방만 초기화
    if (this.settings.resetMartinOnStop) {
      this.state.roomStates.forEach((rs, roomId) => {
        if (rs.waitingForResult && rs.wasVirtualBet !== true) {
          pendingRealBetCount++
          return
        }

        if (rs.waitingForResult && rs.wasVirtualBet === true) {
          VirtualBettingService.cancelPendingBet(roomId)
          CustomStrategyRuntime.releasePending(roomId, '사용자 정지로 가상 베팅 취소')
        }

        this.martingaleManager.resetLevel(roomId)
        rs.waitingForResult = false
        rs.lastPrediction = null
        rs.martinRecoveryPrediction = null
        rs.martinRecoveryStrategy = null
        rs.lastBetHistoryLength = null
        rs.wasVirtualBet = undefined
        rs.placementStatus = undefined
      })
      console.log('[AutoMode] Stopped - 마틴 레벨 리셋됨')
    } else {
      this.state.roomStates.forEach((rs) => {
        if (rs.waitingForResult && rs.wasVirtualBet !== true) {
          pendingRealBetCount++
        }
      })
      console.log('[AutoMode] Stopped - 마틴 레벨 유지됨')
    }

    CustomStrategyRuntime.stopNonPendingSessions()
    this.state.roomStates.forEach((roomState, roomId) => this.syncCustomStrategyState(roomId, roomState))

    this.state.statusMessage = pendingRealBetCount > 0
      ? `정지됨 (실베팅 ${pendingRealBetCount}건 결과 대기)`
      : '정지됨'
    this.emitStateChange()
  }

  // 🆕 v2.24: 진단 타이머 시작 (30초마다 상태 요약 출력)
  private startDiagnosticTimer(): void {
    this.stopDiagnosticTimer()  // 기존 타이머가 있으면 먼저 정리
    this.diagnosticTimerId = setInterval(() => {
      this.logDiagnosticStatus()
    }, 10000)  // 10초마다 (슬롯 점유 진단)
    // 시작 즉시 한번 출력
    this.logDiagnosticStatus()
  }

  private stopDiagnosticTimer(): void {
    if (this.diagnosticTimerId) {
      clearInterval(this.diagnosticTimerId)
      this.diagnosticTimerId = null
    }
  }

  // 🆕 v2.25: 연속 배팅 타이머 - 1초마다 배팅 가능한 방 체크 + 결과 추론
  private startContinuousBettingTimer(): void {
    this.stopContinuousBettingTimer()
    this.continuousBettingTimerId = setInterval(() => {
      if (this.settings.enabled) {
        // 1. 결과 대기 중인 방들의 히스토리 기반 결과 추론 시도
        this.tryInferPendingResults()
        // 2. 배팅 가능한 방 체크
        this.tryBetOnCurrentBettingWindows()
      }
    }, 1000)  // 🆕 2초 → 1초로 단축
  }

  // 🆕 v2.25: 결과 대기 중인 방들에 대해 히스토리 기반 결과 추론
  private tryInferPendingResults(): void {
    // 🆕 stale bettingInProgress 락 강제 해제(2026-05-31): 락을 건 뒤 finally가 안 돈
    //    (예측 await 무응답/행 등) 락이 영구 남으면 동시배팅 슬롯이 고착돼 "승리해도 슬롯
    //    초기화 안 됨/새 배팅 안 됨"이 된다. 1초 타이머라 12초 넘게 잡힌 락을 확실히 회수한다.
    //    (정상 배팅은 락을 수초 내 해제하므로 12초면 hung만 잡힘)
    const nowTs = Date.now()
    this.bettingInProgressSince.forEach((since, roomId) => {
      if (nowTs - since > 12000) {
        console.warn(`[AutoMode] ⏰ 배팅 진행 락 강제 해제 (${Math.round((nowTs - since) / 1000)}s 고착) - ${roomId}`)
        this.bettingInProgress.delete(roomId)
        this.bettingInProgressSince.delete(roomId)
      }
    })

    // Progression rooms are never age-reclaimed here. Martingale/custom chains
    // keep their slot until a confirmed result advances or completes the chain.

    let inferredCount = 0
    this.state.roomStates.forEach((roomState, roomId) => {
      if (!roomState.waitingForResult) return

      const room = this.resolveRoom(roomId)
      if (!room) return

      const inferredWinner = this.getPendingBetResultWinnerFromHistory(room, roomState)
      if (inferredWinner) {
        console.log(`[AutoMode] 🔄 타이머 결과 추론 성공 - ${room.koreanName}: ${inferredWinner}`)
        this.handleGameResult(roomId, inferredWinner)
        inferredCount++
        return
      }
      // Only synthetic virtual bets can be refunded and safely reclaimed.
      // Unknown legacy state is treated as real until proven otherwise.
      if (roomState.wasVirtualBet !== true) {
        return
      }
      // Flat bets may be swept when a feed stalls, but martingale/custom
      // progressions keep the slot from the first pending bet until a confirmed
      // result advances or completes the chain.
      const slotAge = roomState.lastBetTime ? Date.now() - roomState.lastBetTime : Infinity
      const sweepThreshold = 15000
      const locksUntilWin =
        roomState.martinRecoveryStrategy === 'martingale' ||
        roomState.martinRecoveryStrategy === 'custom' ||
        CustomStrategyRuntime.isProgressionActive(roomId)
      if (slotAge > sweepThreshold && (roomState.martinLevel ?? 0) === 0 && !locksUntilWin) {
        console.warn(`[AutoMode] ⏰ 슬롯 강제 반환 (${Math.round(slotAge / 1000)}s 결과 미확인) - ${room.koreanName}`)
        this.feDiag(`SWEEP-CLEAR room=${room.koreanName} age=${Math.round(slotAge / 1000)}s wasV=${roomState.wasVirtualBet}`)
        if (roomState.wasVirtualBet) {
          VirtualBettingService.cancelPendingBet(roomId)
        }
        roomState.waitingForResult = false
        roomState.lastPrediction = null
        roomState.martinRecoveryPrediction = null
        roomState.martinRecoveryStrategy = null
        roomState.lastBetHistoryLength = null
        roomState.wasVirtualBet = undefined
        roomState.resultInferenceRetries = 0
        this.emitStateChange()
      }
    })
    if (inferredCount > 0) {
      console.log(`[AutoMode] ⚡ ${inferredCount}개 방 결과 추론 완료`)
    }
  }

  private stopContinuousBettingTimer(): void {
    if (this.continuousBettingTimerId) {
      clearInterval(this.continuousBettingTimerId)
      this.continuousBettingTimerId = null
    }
  }

  private logDiagnosticStatus(): void {
    if (!this.settings.enabled) return

    const activeRoomCount = this.activeBettingRoomIds.size
    const bettingPhaseCount = this.lastBettingPhaseByRoom.size
    const inProgressCount = this.bettingInProgress.size

    // 슬롯 점유 방 전수 조사(getActiveBettingCount와 동일 기준): waiting / martin>0 / lock + 사유·경과
    const now = Date.now()
    let waitingCount = 0
    let martinCount = 0
    const holders: string[] = []
    this.state.roomStates.forEach((s, roomId) => {
      const waiting = !!s.waitingForResult
      const martin = (s.martinLevel ?? 0) > 0
      const lock = this.bettingInProgress.has(roomId)
      if (waiting || martin || lock) {
        if (waiting) waitingCount++
        if (martin) martinCount++
        const room = this.resolveRoom(roomId)
        const age = s.lastBetTime ? Math.round((now - s.lastBetTime) / 1000) : -1
        holders.push(`${room?.koreanName || roomId}{w:${waiting ? 'Y' : 'N'},m:${s.martinLevel ?? 0},lock:${lock ? 'Y' : 'N'},${age}s}`)
      }
    })

    const currentBetCount = this.getActiveBettingCount()
    const maxBets = this.settings.maxConcurrentBets
    const maxDisplay = maxBets > 0 ? maxBets : '∞'

    // 🆕 실제 락 나이(2026-05-31): bettingInProgressSince 기준 가장 오래된 락의 경과초.
    //    예측이 빠르면 작게(<2s), 느리면/포화면 크게(12s 근처, sweep 상한). 점유 표시의 'Ns'는
    //    lastBetTime 경과라 락 나이와 무관 — 이 oldestLock이 예측 부하의 진짜 지표다.
    let oldestLockAge = 0
    this.bettingInProgressSince.forEach((since) => {
      const a = now - since
      if (a > oldestLockAge) oldestLockAge = a
    })
    const oldestLockSec = Math.round(oldestLockAge / 1000)

    // 🆕 한 줄로 출력(2026-05-31): 여러 줄이면 콘솔 필터('상태진단')에 헤더만 잡혀 상세가 누락된다.
    const holderStr = `${holders.slice(0, 6).join(' | ')}${holders.length > 6 ? ` …(+${holders.length - 6})` : ''}`
    const diagLine = `📊 상태진단 — 슬롯 ${currentBetCount}/${maxDisplay} (waiting:${waitingCount} martin>0:${martinCount} lock:${inProgressCount} 락최고:${oldestLockSec}s) | 대상 ${activeRoomCount}개/페이즈 ${bettingPhaseCount}개 | 점유: ${holderStr || '없음'}`
    console.log(`[AutoMode] ${diagLine}`)
    this.feDiag(diagLine)
  }

  /** 🔬 [임시 진단] 프론트 콘솔은 Tauri 웹뷰에만 떠 파일에 안 남으므로, 슬롯/정산 핵심 결정을
   *  Rust(fe_diag)로 포워딩해 bcr-runtime.log에 남긴다(실시간 슬롯 흐름 디버그용, 확정 후 제거).
   *  테스트/비-Tauri 환경에선 import/invoke가 실패해 조용히 no-op. */
  private feDiag(line: string): void {
    try {
      import('@tauri-apps/api/core')
        .then((m) => m.invoke('fe_diag', { line }).catch(() => {}))
        .catch(() => {})
    } catch { /* ignore */ }
  }

  updateSettings(newSettings: Partial<AutoModeSettings>): void {
    const prevVirtualMode = this.settings.isVirtualMode

    this.settings = { ...this.settings, ...newSettings }
    const maxMartinBeforeNormalization = this.settings.maxMartin
    this.normalizeCustomBetSettings()
    const normalizedMaxMartinChanged = this.settings.maxMartin !== maxMartinBeforeNormalization

    // 🆕 2026-07-08 (적대적 검증 확정): 배팅전략을 라이브로 바꾸면(예: martingale→custom)
    // 진행중 방에 캡처된 stale martinRecoveryStrategy를 비워, 다음 배팅부터 즉시 새 전략이
    // 반영되게 한다. 안 그러면 resolveRoomProgressionStrategy가 stale 값에 단락되어 전환이
    // 씹힌다(그 방들은 다음 타이 적중 전까지 옛 전략으로 계속 배팅).
    if (newSettings.betStrategy !== undefined) {
      this.state.roomStates.forEach((rs) => {
        rs.martinRecoveryStrategy = null
      })
    }

    // ✅ VirtualBettingService와 설정 동기화
    if (
      newSettings.baseBetAmount !== undefined ||
      newSettings.maxMartin !== undefined ||
      newSettings.customBetAmounts !== undefined ||
      newSettings.betStrategy !== undefined ||
      normalizedMaxMartinChanged
    ) {
      const currentVS = VirtualBettingService.getSettings()
      VirtualBettingService.updateSettings({
        martingale: {
          ...currentVS.martingale,
          baseAmount: this.settings.baseBetAmount,
          maxLevel: this.settings.maxMartin,
        }
      })
    }

    // 🔧 Bug Fix: maxMartin 변경 시 globalMaxConsecutiveLosses도 동기화 (하위 호환)
    if (
      newSettings.maxMartin !== undefined ||
      newSettings.customBetAmounts !== undefined ||
      newSettings.betStrategy !== undefined ||
      normalizedMaxMartinChanged
    ) {
      this.settings.globalMaxConsecutiveLosses = this.settings.maxMartin
      // MartingaleManager 내부 cap도 같이 갱신 — 안 그러면 recordLoss가
      // 내부 기본값에서 막혀 사용자가 설정한 단계까지 못 올라간다.
      this.martingaleManager.setMaxLevel(this.settings.maxMartin)
    }

    // 🆕 2026-07-08 (적대적 검증 확정): 커스텀 전략은 사용자가 정의한 단계 수
    // (customBetAmounts.length)가 곧 마틴 깊이다. maxMartin이 배열보다 짧으면 마틴 레벨이
    // maxMartin-1에서 캡되어 상위 티어(예: 8~16단계=이만원)에 절대 도달하지 못한다.
    // 두 UI(고급 다이얼로그 vs 타이-자동 카드)가 maxMartin을 따로 쓰다 어긋나도, 커스텀일 때는
    // 배열 길이까지 상한을 끌어올려 모든 티어가 나가게 보장한다(내리지는 않음).
    if (
      this.settings.betStrategy === 'custom' &&
      this.settings.customBetAmounts &&
      this.settings.customBetAmounts.length > this.settings.maxMartin
    ) {
      this.settings.maxMartin = this.settings.customBetAmounts.length
      this.settings.globalMaxConsecutiveLosses = this.settings.maxMartin
      this.martingaleManager.setMaxLevel(this.settings.maxMartin)
    }

    // 🛡️ AutoBettingService 가상모드 동기화 - 실제 소켓 전송 차단
    // Bug Fix: 항상 현재 설정값으로 동기화 (undefined 체크 제거)
    // 이전에는 newSettings.isVirtualMode가 undefined면 동기화가 안 되어 불일치 발생 가능
    const currentVirtualMode = this.settings.isVirtualMode
    if (AutoBettingService.isVirtualMode() !== currentVirtualMode) {
      AutoBettingService.setVirtualMode(currentVirtualMode)
      console.log(`[AutoMode] 🛡️ AutoBettingService virtual mode synced: ${currentVirtualMode}`)
    }

    // Bug Fix: 모드 전환 시 pending 배팅 정리 + 가상/실제 통계 맞바꿈(각 모드의 손익·승패는 따로 쌓인다)
    if (newSettings.isVirtualMode !== undefined && prevVirtualMode !== newSettings.isVirtualMode) {
      this.cleanupPendingBetsForModeChange(prevVirtualMode, newSettings.isVirtualMode)
      this.swapModeStats()
    }

    this.saveToStorage()
    this.emitStateChange()
  }

  /**
   * 모드 전환 시 pending 배팅 정리
   * - 가상→실제: VirtualBettingService의 pending을 취소하고 환불
   * - 실제→가상: AutoBettingService의 pending은 결과 대기 (wasVirtualBet으로 추적)
   */
  private cleanupPendingBetsForModeChange(prevVirtualMode: boolean, newVirtualMode: boolean): void {
    console.log(`[AutoMode] 🔄 Mode change: ${prevVirtualMode ? 'virtual' : 'real'} → ${newVirtualMode ? 'virtual' : 'real'}`)

    // 가상→실제 전환: 가상 배팅 pending 정리
    if (prevVirtualMode && !newVirtualMode) {
      let cancelledCount = 0
      this.state.roomStates.forEach((roomState, roomId) => {
        if (roomState.waitingForResult && roomState.wasVirtualBet === true) {
          // VirtualBettingService에서 pending 취소 및 환불
          VirtualBettingService.cancelPendingBet(roomId)
          roomState.waitingForResult = false
          roomState.lastPrediction = null
          roomState.martinRecoveryPrediction = null
          roomState.martinRecoveryStrategy = null
          roomState.lastBetHistoryLength = null
          roomState.wasVirtualBet = undefined
          roomState.placementStatus = undefined
          cancelledCount++
          console.log(`[AutoMode] ↩️ Virtual pending cancelled for ${roomState.roomName}`)
        }
      })
      if (cancelledCount > 0) {
        console.log(`[AutoMode] ✅ Cancelled ${cancelledCount} virtual pending bets during mode change`)
      }
    }

    // 실제→가상 전환: 실제 배팅 pending은 그대로 유지 (wasVirtualBet=false로 결과 추적)
    // handleGameResult()에서 wasVirtualBet을 보고 올바른 서비스로 결과 처리함
    if (!prevVirtualMode && newVirtualMode) {
      let pendingRealCount = 0
      this.state.roomStates.forEach((roomState) => {
        if (roomState.waitingForResult && roomState.wasVirtualBet === false) {
          pendingRealCount++
        }
      })
      if (pendingRealCount > 0) {
        console.log(`[AutoMode] ⏳ ${pendingRealCount} real pending bets will be tracked with wasVirtualBet=false`)
      }
    }
  }

  // ==================== Storage Methods (delegated to repository) ====================

  private loadFromStorage(): Partial<AutoModeSettings> | null {
    return this.repository.loadSettings()
  }

  private saveToStorage(): void {
    this.repository.saveSettings(this.settings)
  }

  /** @param options.allModes true면 지금 모드뿐 아니라 보관 중인 다른 모드(가상↔실제) 통계도 지운다 — '전체 세션 초기화'용 */
  resetStats(options?: { allModes?: boolean }): void {
    const pendingRealBetCount = Array.from(this.state.roomStates.values())
      .filter(rs => rs.waitingForResult && rs.wasVirtualBet !== true)
      .length
    if (pendingRealBetCount > 0) {
      this.state.statusMessage = `통계 초기화 보류 (실베팅 ${pendingRealBetCount}건 결과 대기)`
      this.emitStateChange()
      return
    }

    // 1. 글로벌 통계 리셋
    this.state.totalWins = 0
    this.state.totalLosses = 0
    this.state.totalBetAmount = 0
    this.state.cumulativeProfit = 0
    this.state.maxProfit = 0
    this.state.maxLoss = 0
    if (options?.allModes) this.clearInactiveModeStats()

    // ✅ MartingaleManager 전체 리셋 (Single Source of Truth)
    this.martingaleManager.resetAllLevels()
    CustomStrategyRuntime.resetAll()

    // 2. 방별 통계 및 상태 완전 리셋
    this.state.roomStates.forEach((rs, roomId) => {
      rs.totalBets = 0
      rs.totalWins = 0
      rs.totalLosses = 0
      rs.totalProfit = 0

      // Bug Fix: pending 상태도 리셋 (이전에 누락됨)
      // 가상 배팅 pending이 있으면 취소 및 환불
      if (rs.waitingForResult && rs.wasVirtualBet === true) {
        VirtualBettingService.cancelPendingBet(roomId)
      }
      rs.waitingForResult = false
      rs.lastPrediction = null
      rs.martinRecoveryPrediction = null
      rs.martinRecoveryStrategy = null
      rs.lastBetAmount = 0
      rs.lastBetTime = null
      rs.lastBetHistoryLength = null
      rs.lastResultTime = null
      rs.wasVirtualBet = undefined
      rs.placementStatus = undefined

      // Bug Fix: 결과 추론 재시도 상태 리셋
      rs.resultInferenceRetries = 0
      rs.lastInferenceRetryTime = null
    })

    // 3. VirtualBettingService 리셋 (가상 모드일 경우)
    if (this.settings.isVirtualMode) {
      VirtualBettingService.reset()
      console.log('[AutoMode] VirtualBettingService도 함께 리셋됨')
    }

    console.log('[AutoMode] 📊 통계 완전 리셋 완료 (pending 상태 포함)')
    this.emitStateChange()
  }

  // ==================== Room Management ====================

  private getOrCreateRoomState(roomId: string, roomName: string): RoomBettingState {
    let roomState = this.state.roomStates.get(roomId)
    if (!roomState) {
      const base = {
        roomId,
        roomName,
        totalBets: 0,
        totalWins: 0,
        totalLosses: 0,
        totalProfit: 0,
        lastPrediction: null,
        martinRecoveryPrediction: null,
        martinRecoveryStrategy: null,
        lastBetAmount: 0,
        waitingForResult: false,
        lastBetTime: null,
        lastBetHistoryLength: null,
        lastResultTime: null,
        resultInferenceRetries: 0,
        lastInferenceRetryTime: null,
      }

      // 마틴 상태는 MartingaleManager가 유일한 소스다. 예전에는 이 객체에 값을 복사해두고
      // 매 변경마다 수동 동기화 메서드를 호출해 맞췄는데, 그 호출을 한 번이라도 빠뜨리면
      // stale 레벨이 calculateBetAmount(roomState.martinLevel)로 흘러들어가 배팅 금액이
      // 틀어졌다. 읽을 때마다 매니저에서 끌어오면 애초에 어긋날 수가 없다.
      Object.defineProperties(base, {
        martinLevel: {
          get: () => this.martingaleManager.getLevel(roomId),
          enumerable: true,
        },
        consecutiveLosses: {
          get: () => this.martingaleManager.getState(roomId)?.consecutiveLosses ?? 0,
          enumerable: true,
        },
        consecutiveWins: {
          get: () => this.martingaleManager.getState(roomId)?.consecutiveWins ?? 0,
          enumerable: true,
        },
      })

      roomState = base as RoomBettingState
      this.state.roomStates.set(roomId, roomState)
    }
    return roomState
  }

  // 외부에서 설정한 배팅 가능 방 ID 목록 (패턴 필터 적용 결과)
  private activeBettingRoomIds: Set<string> = new Set()
  private hasReceivedActiveRoomList = false
  private tieAutoCompletedRoomIds: Set<string> = new Set()

  // 현재 선택된 패턴 필터 (예: 'long_streak', 'short_streak', 'all')
  private currentPatternFilter: RoomFilterType | 'all' = 'all'
  private lastBettingPhaseByRoom: Map<string, { startedAt: number; initialSeconds: number; deadlineAt?: number }> = new Map()

  // 방별 배팅 진행 중 락 (동시 배팅 방지)
  private bettingInProgress: Set<string> = new Set()
  /** roomId → bettingInProgress 락을 건 시각. 배팅 진행 중 await(예측요청 등)가 멈춰 finally가
   *  안 돌면 락이 영구 누수→슬롯 고착→"승리해도 슬롯 초기화 안 됨/배팅 안 함"이 된다.
   *  1초 타이머에서 일정 시간 지난 락을 강제 해제하는 데 사용. */
  private bettingInProgressSince: Map<string, number> = new Map()

  // Bug 4 Fix: 필터 전환 락 (race condition 방지)
  private isFilterTransitioning: boolean = false
  private filterTransitionTimeout: ReturnType<typeof setTimeout> | null = null
  private filterTransitionStartTime: number = 0  // Safety: track when transition started
  private readonly FILTER_TRANSITION_DEBOUNCE_MS = 150
  private readonly FILTER_TRANSITION_MAX_MS = 1000  // Safety: max transition lock duration

  // 🆕 v2.24: 진단 타이머 (30초마다 상태 요약 출력)
  private diagnosticTimerId: ReturnType<typeof setInterval> | null = null

  // 🆕 동시배팅 상한 초과 로그 throttle (3초당 1회) — 콘솔 노이즈 억제
  private lastCapLogAt = 0

  // 🆕 v2.24: 연속 배팅 타이머 (2초마다 배팅 가능한 방 체크)
  private continuousBettingTimerId: ReturnType<typeof setInterval> | null = null

  // 패턴 필터링된 방 목록 설정 (AutoModePanel에서 호출)
  setActiveBettingRooms(roomIds: string[], patternFilter?: RoomFilterType | 'all'): void {
    const requestedFilter = patternFilter ?? this.currentPatternFilter
    const lockedMartinRoomIds = this.getLockedMartinRoomIds(requestedFilter)
    const allowedRoomIds = roomIds.filter(roomId => !this.isTieAutoCompletedRoom(roomId, requestedFilter))
    const mergedRoomIds = Array.from(new Set([...lockedMartinRoomIds, ...allowedRoomIds]))
    const effectiveRoomIds = mergedRoomIds
    const nextRoomIds = new Set(effectiveRoomIds)
    const prevRoomIds = this.activeBettingRoomIds
    const prevFilter = this.currentPatternFilter

    // 🆕 v2.23: 방 목록이 실제로 변경됐는지 확인 (불필요한 전환 락 방지)
    const isSameRoomList = effectiveRoomIds.length === prevRoomIds.size &&
      effectiveRoomIds.every(id => prevRoomIds.has(id))
    const isSameFilter = patternFilter === undefined || patternFilter === prevFilter

    if (isSameRoomList && isSameFilter) {
      // 변경 없음 - 전환 락 없이 스킵
      return
    }

    // Bug 4 Fix: 이전 전환 타임아웃 클리어
    if (this.filterTransitionTimeout) {
      clearTimeout(this.filterTransitionTimeout)
      this.filterTransitionTimeout = null
    }

    // 전환 락 설정 with timestamp for safety
    this.isFilterTransitioning = true
    this.filterTransitionStartTime = Date.now()

    this.activeBettingRoomIds = nextRoomIds
    this.hasReceivedActiveRoomList = true
    if (patternFilter !== undefined) {
      this.currentPatternFilter = patternFilter
      // isTieOnlyFilter에 해당하는 필터가 활성화되면 betDirection을 'T'로 동기화
      // 사용자가 "타이 자동 켜기" 대신 필터 체크박스로 직접 활성화한 경우에도
      // PatternBettingService의 stale 'ai' 방향이 Tie 배팅을 차단하지 않도록 보장
      if (this.isTieOnlyFilter(patternFilter) && patternFilter !== 'all') {
        const currentDirection = PatternBettingService.getBetDirection(patternFilter as RoomFilterType)
        if (currentDirection !== 'T') {
          PatternBettingService.setBetDirection(patternFilter as RoomFilterType, 'T')
          console.log(`[AutoMode] 🔧 Tie-only 필터 betDirection 동기화: ${patternFilter} → T (was: ${currentDirection})`)
        }
      }
    }
    console.log(`[AutoMode] 🏠 Active betting rooms updated: ${effectiveRoomIds.length} rooms [${effectiveRoomIds.slice(0, 3).join(', ')}${effectiveRoomIds.length > 3 ? '...' : ''}], filter: ${this.currentPatternFilter}${lockedMartinRoomIds.length > 0 ? ` (martin locked: ${lockedMartinRoomIds.length})` : ''}`)

    // Bug 4 Fix: 디바운스된 배팅 트리거 (전환 완료 후)
    this.filterTransitionTimeout = setTimeout(() => {
      this.isFilterTransitioning = false
      this.filterTransitionTimeout = null
      this.filterTransitionStartTime = 0

      // 오토 ON 상태에서 패턴/방 목록이 바뀌면, 현재 진행 중인 배팅 페이즈도 즉시 한 번 처리
      if (this.settings.enabled) {
        const filterChanged = patternFilter !== undefined && prevFilter !== this.currentPatternFilter
        const newlyAdded = filterChanged
          ? Array.from(nextRoomIds)
          : Array.from(nextRoomIds).filter(id => !prevRoomIds.has(id))

        if (newlyAdded.length > 0) {
          this.tryBetOnCurrentBettingWindows(newlyAdded)
        }
      }
    }, this.FILTER_TRANSITION_DEBOUNCE_MS)
  }

  isRoomEnabled(roomId: string): boolean {
    const lockedMartinRoomIds = this.getLockedMartinRoomIds()
    if (lockedMartinRoomIds.includes(roomId)) {
      return true
    }

    if (this.isTieAutoCompletedRoom(roomId)) {
      return false
    }

    // Bug 4 Fix: 필터 전환 중에는 모든 방 비활성화
    // Safety: auto-release lock if held too long (prevents stuck state)
    if (this.isFilterTransitioning) {
      const transitionDuration = Date.now() - this.filterTransitionStartTime
      if (transitionDuration > this.FILTER_TRANSITION_MAX_MS) {
        console.warn(`[AutoMode] ⚠️ Filter transition lock held too long (${transitionDuration}ms), auto-releasing`)
        this.isFilterTransitioning = false
        this.filterTransitionStartTime = 0
        if (this.filterTransitionTimeout) {
          clearTimeout(this.filterTransitionTimeout)
          this.filterTransitionTimeout = null
        }
      } else {
        return false
      }
    }

    // 1) 사용자 방 선택 우선: 선택이 있으면 그 밖의 방은 추천필터에 떠도 배팅하지 않는다.
    //    (이전 버그: 추천필터(activeBettingRoomIds) 방이 이 체크를 우회(return true)해서
    //     사용자가 고르지 않은 방에도 배팅됨 — "방 선택 무시" 증상의 원인. 마틴 진행 중인 방은
    //     위 getLockedMartinRoomIds 분기에서 이미 통과하므로 선택/필터와 무관하게 끝까지 간다.)
    const configuredRoomIds = new Set(
      (this.settings.roomConfigs || [])
        .filter(c => c.enabled)
        .map(c => c.roomId)
    )
    if (configuredRoomIds.size > 0 && !configuredRoomIds.has(roomId)) {
      return false
    }

    // 2) 추천필터(실시간 매칭) 목록이 있으면 그 안에서만 허용.
    //    사용자 선택이 있으면 위 1)을 이미 통과했으므로 결과적으로 (선택 ∩ 추천)으로 동작한다.
    if (this.activeBettingRoomIds.size > 0) {
      return this.activeBettingRoomIds.has(roomId)
    }

    // 3) 패턴 필터가 걸려 있는데(=all 아님) 매칭 방이 0개면 전체 OFF로 취급
    if (this.currentPatternFilter !== 'all') {
      return false
    }

    // 4) 기본: 설정된 방이 없으면 전체 허용 (테스트/초기 상태 호환)
    return true
  }

  toggleRoom(roomId: string): void {
    const configs = [...this.settings.roomConfigs]
    const index = configs.findIndex(c => c.roomId === roomId)

    if (index >= 0) {
      configs[index] = { ...configs[index], enabled: !configs[index].enabled }
    } else {
      configs.push({
        roomId,
        enabled: true,
        maxConsecutiveLosses: this.settings.maxMartin,
      })
    }

    this.settings.roomConfigs = configs
    this.emitStateChange()
  }

  // ==================== Martingale Continuation Locks ====================

  // Only in-flight rooms are locked: waiting for a result or carrying a
  // martingale/custom progression level.
  private getLockedMartinRoomIds(_filter: RoomFilterType | 'all' = this.currentPatternFilter): string[] {
    const lockedRoomIds = new Set<string>(CustomStrategyRuntime.getActiveRoomIds())
    for (const [roomId, state] of this.state.roomStates) {
      if (state.waitingForResult || state.martinLevel > 0 || CustomStrategyRuntime.isProgressionActive(roomId)) {
        lockedRoomIds.add(roomId)
      }
    }

    return Array.from(lockedRoomIds)
  }

  private getMissingLockedMartinRoom(roomId: string, remainingSeconds = 0): Room | null {
    const state = this.state.roomStates.get(roomId)
    if (!state || !this.isProgressionActive(roomId, state) || state.waitingForResult) return null

    const roomName = state.roomName || roomId
    return {
      id: roomId,
      name: roomName,
      koreanName: roomName,
      history: [],
      gameCount: 0,
      remainingSeconds,
      phase: 'betting',
      gameState: {
        playerHand: { score: 0, cards: [] },
        bankerHand: { score: 0, cards: [] },
      },
    }
  }

  private getPendingMartinRoomIds(excludeRoomId?: string): string[] {
    const pendingRoomIds: string[] = []
    for (const [roomId, state] of this.state.roomStates) {
      if (roomId === excludeRoomId) continue
      if (this.isProgressionActive(roomId, state) && !state.waitingForResult && !this.bettingInProgress.has(roomId)) {
        pendingRoomIds.push(roomId)
      }
    }

    return pendingRoomIds
  }

  private prioritizeMartinRoomIds(roomIds: string[], requestedFirst = false): string[] {
    const pendingMartinRoomIds = this.getPendingMartinRoomIds()
    const lockedRoomIds = this.getLockedMartinRoomIds()
    const prioritizedRoomIds = requestedFirst
      ? [...roomIds, ...pendingMartinRoomIds, ...lockedRoomIds]
      : [...pendingMartinRoomIds, ...lockedRoomIds, ...roomIds]

    return Array.from(new Set(prioritizedRoomIds))
  }

  private isZeroTieFrequentFilter(filter: RoomFilterType | 'all' = this.currentPatternFilter): boolean {
    if (filter !== 'tie_frequent') return false
    const { tieFrequentMinCount, tieFrequentMaxCount } = FilterThresholdsService.get()
    return tieFrequentMinCount === 0 && tieFrequentMaxCount === 0
  }

  private isTieAutoCompletedRoom(roomId: string, filter: RoomFilterType | 'all' = this.currentPatternFilter): boolean {
    return this.isZeroTieFrequentFilter(filter) && this.tieAutoCompletedRoomIds.has(roomId)
  }

  private markTieAutoCompletedRoom(roomId: string, roomName: string, winner: Winner): boolean {
    if (winner !== 'T' || !this.isZeroTieFrequentFilter()) return false

    this.tieAutoCompletedRoomIds.add(roomId)
    this.activeBettingRoomIds.delete(roomId)
    this.lastBettingPhaseByRoom.delete(roomId)
    console.log(`[AutoMode] Tie-auto no-tie room completed and removed: ${roomName}`)
    this.feDiag(`TIE-AUTO-COMPLETE room=${roomName} filter=${this.currentPatternFilter}`)
    return true
  }

  // ==================== Event Handlers ====================

  private async onBettingPhase(event: BettingPhaseEvent, source: 'adapter' | 'poll' = 'adapter'): Promise<void> {
    const { roomId, phase, remainingSeconds } = event
    const roomForDebug = this.resolveRoom(roomId)
    const roomNameForDebug = roomForDebug?.koreanName || roomId

    // ✅ 오토 OFF 상태에서도 "현재 배팅 페이즈" 스냅샷을 저장해,
    // ON/필터 변경을 배팅 창 중간에 눌러도 즉시 배팅 가능하도록 한다.
    if (phase === 'start' && remainingSeconds > 0) {
      // 마감 절대시각을 함께 보관한다 — 이후 남은 시간 계산은 전부 이 값으로(초 감산 금지).
      //   우선순위: 이벤트의 서버 마감 시각 → 방의 서버 마감 시각 → (둘 다 없으면) 이벤트 수신 시각 + 남은 초.
      const deadlineAt = event.deadlineAt
        ?? this.resolveRoom(roomId)?.bettingDeadlineAt
        ?? (Date.now() + remainingSeconds * 1000)
      this.lastBettingPhaseByRoom.set(roomId, { startedAt: Date.now(), initialSeconds: remainingSeconds, deadlineAt })
      if (this.settings.enabled && this.isRoomEnabled(roomId)) {
        this.feDiag(`PHASE-START room=${roomNameForDebug} src=${source} remain=${remainingSeconds}s deadlineIn=${deadlineAt !== undefined ? deadlineAt - Date.now() : 'n/a'}ms`)
      }
    } else if (phase === 'end' || remainingSeconds <= 0) {
      this.lastBettingPhaseByRoom.delete(roomId)
    }

    // 🔥 DEBUG: 모든 BettingPhase 이벤트 로깅
    const activeBetCount = this.getActiveBettingCount()
    const maxBetsDebug = this.settings.maxConcurrentBets > 0 ? this.settings.maxConcurrentBets : '∞'
    console.log(`[AutoMode] 🎯 onBettingPhase - room: ${roomNameForDebug}, phase: ${phase}, remainingSeconds: ${remainingSeconds}, enabled: ${this.settings.enabled}, isVirtual: ${this.settings.isVirtualMode}, activeRooms: ${this.activeBettingRoomIds.size}, filter: ${this.currentPatternFilter}, 동시배팅: ${activeBetCount}/${maxBetsDebug}`)

    if (!this.settings.enabled) {
      console.log(`[AutoMode] ❌ 배팅 OFF - 스킵`)
      return
    }

    // Bug 4 Fix: 필터 전환 중 배팅 스킵
    // 단, 마틴 회복 중이거나 결과 대기 중인 방은 예외 — 한 번 들어간 방은
    // 필터 전환과 무관하게 승리·마틴 종료까지 계속 배팅해야 함.
    if (this.isFilterTransitioning) {
      const existingState = this.state.roomStates.get(roomId)
      const isInProgressionOrWaiting = existingState && this.isProgressionActive(roomId, existingState)
      if (!isInProgressionOrWaiting) {
        console.log(`[AutoMode] ❌ 필터 전환 중 - ${roomNameForDebug} 스킵`)
        return
      }
      console.log(`[AutoMode] ⚡ 필터 전환 중이지만 마틴/결과대기 방이므로 진행: ${roomNameForDebug} (마틴 ${existingState.martinLevel}단)`)
    }

    // 배팅 진행 중 락 체크 및 즉시 설정 (동시 배팅 방지 - atomic check-and-set)
    if (this.bettingInProgress.has(roomId)) {
      console.log(`[AutoMode] ❌ 배팅 진행 중 - ${roomNameForDebug} 스킵 (동시 배팅 방지)`)
      return
    }

    // 🆕 예측 동시 실행 제한(2026-05-31): 락을 슬롯 상한에서 뺀 뒤(라이브락 수정) 베팅창에 든
    //    방 20여 개가 동시에 예측을 돌려 백엔드가 포화 → 예측이 안 끝나 빈 슬롯이 있어도 배팅이
    //    안 되는 역증상(슬롯 0/2 lock:21 waiting:0)이 생겼다. 동시 예측 수를 배팅 슬롯보다 약간
    //    크게(스킵 많아도 배팅 후보가 굶지 않도록) 제한해 폭주를 막는다. 배팅 슬롯 상한은
    //    placeBet 직전 재확인에서 별도로 보장하므로, 이 제한은 순수 '예측 부하' 제어용이다.
    //    마틴 이어치기/결과 대기 방은 자기 슬롯이므로 제한에서 예외(반드시 이어쳐야 함).
    const existingForThrottle = this.state.roomStates.get(roomId)
    const isMartinOrWaitingRebet = !!existingForThrottle && this.isProgressionActive(roomId, existingForThrottle)
    const PREDICTION_CONCURRENCY = Math.max(this.settings.maxConcurrentBets + 6, 8)
    if (!isMartinOrWaitingRebet && this.bettingInProgress.size >= PREDICTION_CONCURRENCY) {
      // 다음 페이즈/1초 연속배팅 타이머에서 재시도된다(슬롯이 비고 예측 부하가 내려가면 진입).
      const nowThrottle = Date.now()
      if (nowThrottle - this.lastCapLogAt > 3000) {
        this.lastCapLogAt = nowThrottle
        console.log(`[AutoMode] ⏸ 예측 동시 실행 제한 (${this.bettingInProgress.size}/${PREDICTION_CONCURRENCY}) — 부하 제어, 3초당 1회만 표시`)
      }
      return
    }

    // 즉시 락 설정 (race condition 방지)
    this.bettingInProgress.add(roomId)
    this.bettingInProgressSince.set(roomId, Date.now())

    // 이후 모든 코드는 try-finally로 감싸서 어떤 경로로든 락이 해제되도록 함
    try {
      // ========== Bug Fix: waitingForResult 타임아웃 체크를 isRoomEnabled보다 먼저 실행 ==========
      // 방이 비활성화되어도 stuck 상태를 해제할 수 있도록 함
      const liveRoom = this.resolveRoom(roomId)
      const room = liveRoom || this.getMissingLockedMartinRoom(roomId, remainingSeconds)
      if (!room) return
      const hasReliableHistory = !!liveRoom

      const roomState = this.getOrCreateRoomState(roomId, room.koreanName || room.name)
      const isInMartinRecovery = roomState.martinLevel > 0
      const isInProgressionRecovery = this.isProgressionActive(roomId, roomState)
      const minRequiredSeconds = isInProgressionRecovery ? 2 : 3

      // phase 체크 완화: 마틴 회복 중인 타이 자동 방은 놓치지 않도록 2초까지 재시도한다.
      if (remainingSeconds < minRequiredSeconds) {
        console.log(`[AutoMode] ❌ remainingSeconds=${remainingSeconds} < ${minRequiredSeconds} - 스킵`)
        return
      }

      // Bug 2 Fix: 결과 대기 중이면, 히스토리 기반으로 결과를 재시도하여 처리
      // (이벤트 순서가 뒤바뀌거나 결과 이벤트 누락 시에도 다음 라운드로 진행 가능하도록)
      // NOTE: 이 체크는 isRoomEnabled보다 먼저 실행되어야 함 (방이 비활성화되어도 stuck 해제 가능)
      if (roomState.waitingForResult) {
        const baseLength = roomState.lastBetHistoryLength
        const currentLength = room.history.length

        // ✅ Bug Fix: lastBetTime null 방어 - waitingForResult가 true인데 lastBetTime이 없으면 상태 불일치
        if (roomState.lastBetTime === null) {
          console.warn(`[AutoMode] ⚠️ 상태 불일치 감지: waitingForResult=true but lastBetTime=null - ${roomNameForDebug}`)
          if (roomState.wasVirtualBet === true) {
            VirtualBettingService.cancelPendingBet(roomId)
          }
          roomState.waitingForResult = false
          roomState.lastPrediction = null
          roomState.martinRecoveryPrediction = null
          roomState.martinRecoveryStrategy = null
          roomState.lastBetHistoryLength = null
          roomState.wasVirtualBet = undefined
          this.emitStateChange()
          // 상태 정리 후 계속 진행
        }

        const waitingTime = Date.now() - (roomState.lastBetTime || Date.now())  // ✅ null일 때 현재 시간 사용 (0초 대기로 처리)
        // ✅ Bug Fix: resultInferenceRetries undefined 방어 (이전 버전 roomState 호환)
        roomState.resultInferenceRetries = (roomState.resultInferenceRetries ?? 0) + 1
        roomState.lastInferenceRetryTime = Date.now()

        console.log(`[AutoMode] ⏳ 결과 대기 중 - ${roomNameForDebug}: betHistoryLen=${baseLength}, currentLen=${currentLength}, retry=${roomState.resultInferenceRetries}`)

        // 최신 room 데이터로 다시 시도
        const freshRoom = this.resolveRoom(roomId)
        const targetRoom = freshRoom || room

        const inferredWinner = this.getPendingBetResultWinnerFromHistory(targetRoom, roomState)
        if (inferredWinner) {
          console.log(`[AutoMode] 🔄 결과 확인됨 (retry ${roomState.resultInferenceRetries}) - ${roomNameForDebug}: ${inferredWinner}`)
          roomState.resultInferenceRetries = 0
          roomState.lastInferenceRetryTime = null
          this.handleGameResult(roomId, inferredWinner)
        } else {
          // 🆕 v2.25: 타임아웃 단축 (45초 → 15초) - 더 빠른 슬롯 회수
          // 🆕 2026-06-23: 실배팅은 결과(resolved)가 라운드 종료(~30-45s) 후에 오므로 15초면 결과 도착 전에
          //   강제리셋→정산 유실(졌는데 손익 미반영, 보유금이 차감됐다 7만으로 복귀)된다. 실배팅만 60초로
          //   늘려 결과를 기다린다(가상은 15초 유지 — 환불되므로 무해). tryInferPendingResults sweep(60s)과 일관.
          const isRealPending = roomState.wasVirtualBet === false
          const EXTENDED_TIMEOUT_MS = isRealPending ? 60000 : 15000
          const MAX_RETRIES = 5

          if (isRealPending) {
            if (waitingTime > EXTENDED_TIMEOUT_MS && roomState.resultInferenceRetries % MAX_RETRIES === 0) {
              console.warn(`[AutoMode] Real pending result still waiting (${Math.round(waitingTime / 1000)}s, retry=${roomState.resultInferenceRetries}) - ${roomNameForDebug}`)
              this.feDiag(`REAL-PENDING-WAIT room=${roomNameForDebug} waited=${Math.round(waitingTime / 1000)}s retries=${roomState.resultInferenceRetries}`)
            }
            return
          }

          if (waitingTime > EXTENDED_TIMEOUT_MS || roomState.resultInferenceRetries >= MAX_RETRIES) {
            console.warn(`[AutoMode] ⚠️ 결과 대기 타임아웃 (${Math.round(waitingTime / 1000)}초, ${roomState.resultInferenceRetries}회 재시도) - ${roomNameForDebug}, 강제 리셋`)
            if (isRealPending) this.feDiag(`REAL-FORCE-RESET room=${roomNameForDebug} waited=${Math.round(waitingTime / 1000)}s retries=${roomState.resultInferenceRetries} — 정산 유실 위험`)
            // 🧹 가상 pending은 VirtualBettingService에서도 환불·정리한다(2026-09-05). 종전엔 AutoMode만 리셋해
            //   VBS에 pending이 남아 보유금 유령 차감 + 이후 45초간 duplicate_bet으로 이 방 배팅이 조용히 실패했다.
            if (roomState.wasVirtualBet === true) {
              VirtualBettingService.cancelPendingBet(roomId)
            }
            roomState.wasVirtualBet = undefined
            roomState.waitingForResult = false
            roomState.lastPrediction = null
            roomState.martinRecoveryPrediction = null
            roomState.martinRecoveryStrategy = null
            roomState.lastBetHistoryLength = null
            roomState.resultInferenceRetries = 0
            roomState.lastInferenceRetryTime = null
            this.emitStateChange()
            // 리셋 후 계속 진행 (return 하지 않음)
          } else {
            console.log(`[AutoMode] ❌ 결과 대기 중, 히스토리 증가 없음 - ${roomNameForDebug} 스킵 (${Math.round(waitingTime / 1000)}초 대기 중, retry=${roomState.resultInferenceRetries})`)
            return
          }
        }
      }

      // 방이 활성화되어 있는지 확인 (waitingForResult 체크 후에 실행)
      if (!this.isRoomEnabled(roomId)) {
        console.log(`[AutoMode] ❌ 방 ${roomNameForDebug} 비활성화 (activeRooms: ${this.activeBettingRoomIds.size}개, 포함여부: ${this.activeBettingRoomIds.has(roomId)})`)
        return
      }

      // 🆕 [실배팅 안전] '결과를 받는 테이블에만 신규 베팅'(2026-06-02, 라이브로 근본원인 확정):
      // 결과(히스토리)가 들어오지 않는 테이블에 베팅하면 정산이 안 돼(히스토리 미증가 → 15초
      // 타임아웃 강제리셋) "배팅됨"에 영영 멈추고, UI(앱이 추적 중인 방)와 히스토리(실제 베팅한 방)가
      // 어긋난다. Top6 방은 히스토리 체크를 우회해 결과 안 오는 방에도 베팅하던 게 원인.
      // → 실제 모드에서는 '최근 결과 활동(room.lastResultTime)'이 있는 방에만 신규 베팅한다.
      // 마틴 이어치기(martinLevel>0)는 자기 슬롯이라 예외(이길 때까지 그 방 고정). 가상 모드는 무영향.
      if (!this.settings.isVirtualMode && !isInProgressionRecovery) {
        const lastResultAge = Date.now() - (room.lastResultTime ?? 0)
        const RESULT_FRESHNESS_MS = 90000
        if (lastResultAge > RESULT_FRESHNESS_MS) {
          console.log(`[AutoMode] ⏭ 실배팅 스킵 — ${roomNameForDebug}: 최근 결과 없음(${Math.round(lastResultAge / 1000)}s) → 정산 불가 방 회피('결과 받는 방만' 정책)`)
          return
        }
      }

      console.log(`[AutoMode] ✅ 방 ${roomNameForDebug} 활성화됨, 배팅 진행 시작...`)

      // 🆕 v2.25: Top6 (activeBettingRoomIds) 방은 히스토리 체크 우회
      // Top6 필터에서 이미 히스토리 기반으로 선정했으므로, 멀티위젯 소켓 지연 문제 해결
      const isTop6Room = this.activeBettingRoomIds.has(roomId)

      if (!isTop6Room) {
        // Top6가 아닌 방만 히스토리 체크
        const playerCards = room.gameState?.playerHand?.cards?.length || 0
        const bankerCards = room.gameState?.bankerHand?.cards?.length || 0
        const hasVisibleCards = Boolean(playerCards || bankerCards)
        const hasMinimalHistory = room.history.length >= 1

        if (!hasVisibleCards && !hasMinimalHistory) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'no_cards',
            level: 'info',
            message: '히스토리 데이터 없음 - 스킵',
          })
          return
        }
      } else {
        console.log(`[AutoMode] ✅ Top6 방 - 히스토리 체크 우회: ${roomNameForDebug} (history=${room.history.length})`)
      }

      // ========== 안전장치 체크 ==========

      // 1. 윈컷/로스컷 체크 (BettingDecisionService 위임)
      // NOTE: checkCutConditions는 winCutAmount/lossCutAmount만 사용 (Codex 피드백)
      // 실배팅은 실잔액 기반 손익으로, 가상은 자체 추정으로 판정(getEffectiveProfit).
      // 베팅 직전이라 직전 라운드 잔액 정산이 끝난 상태 → 실잔액 기준이 안전(레이스 없음).
      const profitForCut = this.getEffectiveProfit()
      const cutConditions = this.bettingDecisionService.checkCutConditions(
        profitForCut,
        this.settings
      )

      if (cutConditions.winCutReached) {
        console.log(`[AutoMode] 윈컷 도달! 목표: ${this.settings.winCutAmount}, 현재: ${profitForCut}`)
        this.stop()
        this.state.statusMessage = `윈컷 도달 (+${profitForCut.toLocaleString()}원)`
        this.emitStateChange()
        return
      }

      if (cutConditions.lossCutReached) {
        console.log(`[AutoMode] 로스컷 도달! 한도: -${this.settings.lossCutAmount}, 현재: ${profitForCut}`)
        this.stop()
        this.state.statusMessage = `로스컷 도달 (${profitForCut.toLocaleString()}원)`
        this.emitStateChange()
        return
      }

      // 동시배팅 제한 체크 (사용자 설정 기반)
      // 정책:
      //   - 마틴 진행 중인 방은 동시 상한과 무관하게 항상 이어친다 (자기 슬롯).
      //   - 슬롯 점유 = waitingForResult OR bettingInProgress OR martinLevel>0
      //     (즉, 한 번 들어간 방은 승리·마틴 종료 전까지 슬롯을 계속 잡는다.)
      //   - 신규 방은 점유된 슬롯 수가 maxConcurrentBets 미만일 때만 진입.
      const currentBetCount = this.getActiveBettingCount()
      const maxBets = this.settings.maxConcurrentBets
      const isCurrentlyInMartin = isInProgressionRecovery

      // 게이트 기준 변경(2026-05-31): getActiveBettingCount가 락(자기 자신)을 더 이상 세지 않으므로
      //    '>' → '>='로 바꾼다. count=실제 배팅 중인 다른 방 수. 그 수가 상한 이상이면 신규 진입 차단.
      //    (이건 예측 전 조기 차단일 뿐이고, 최종 보장은 placeBet 직전 재확인에서 한다.)
      if (!isCurrentlyInMartin && maxBets > 0 && currentBetCount >= maxBets) {
        // 노이즈 억제(2026-05-31): 상한이 차면 매 방·매 페이즈마다 찍혀 콘솔을 뒤덮어
        //    실제 배팅 로그가 안 보였다. 3초당 1회만 출력(점유 현황은 📊 상태진단에 있음).
        const nowCap = Date.now()
        if (nowCap - this.lastCapLogAt > 3000) {
          this.lastCapLogAt = nowCap
          console.log(`[AutoMode] 🚫 동시배팅 상한 (배팅중=${currentBetCount}/${maxBets}) — 차단 방 다수, 3초당 1회만 표시`)
        }
        return
      }

      const maxDisplay = maxBets > 0 ? maxBets : '∞'
      console.log(`[AutoMode] ✅ 배팅 진행: ${room.koreanName} (현재=${currentBetCount}/${maxDisplay}개, 마틴회복=${isInMartinRecovery})`)

      try {
        // 사용자가 설정한 패턴과 배팅 방향에 따라 예측 생성
        // PatternBettingService에서 betDirection 확인:
        // - 'B'/'P': 해당 방향으로 고정 배팅
        // - 'skip': 배팅 안 함
        // - 'ai': AI 서버 예측 또는 스마트 로직
        const customStrategyDecision = CustomStrategyRuntime.prepareDecision(
          String(this.currentPatternFilter),
          room,
          source === 'adapter',
        )
        this.syncCustomStrategyState(roomId, roomState)
        const usesCustomStrategy = this.isCustomStrategyFilter() || CustomStrategyRuntime.isProgressionActive(roomId)
        if (usesCustomStrategy && !customStrategyDecision) {
          const session = CustomStrategyRuntime.getSessionForRoom(roomId)
          console.log(`[AutoMode] 커스텀 전략 대기 - ${room.koreanName}: ${session?.reason || session?.status || '조건/트리거 대기'}`)
          return
        }

        // 🔒 패턴 묶음 마틴(기본): 패턴 필터가 걸려 있으면 마틴 중에도 '고정 방향 이어치기'를 쓰지 않고
        //    매판 패턴 예측을 다시 돌린다 → 패턴이 안 맞는 판은 스킵(단계 유지), 맞는 판에만 다음 단계 금액.
        //    타이 자동(타이 계열 필터)은 "타이가 나올 때까지 T 이어치기"가 기능 자체라 이 옵션과 무관하게 이어친다.
        //    판정 기준 패턴 = 체인을 시작한 필터(사용자가 체인 중 필터를 바꿔도 그 방은 자기 패턴으로 이어간다).
        const chainFilter: RoomFilterType | 'all' = (isInMartinRecovery && roomState.martinChainFilter)
          ? roomState.martinChainFilter
          : this.currentPatternFilter
        const martinKeepsDirection = isInMartinRecovery
          && (this.settings.martinRequiresPattern === false
            || chainFilter === 'all'
            || this.isTieOnlyFilter(chainFilter))
        const martinWaitsForPattern = isInMartinRecovery && !martinKeepsDirection
        const storedRecoveryPrediction = martinKeepsDirection ? roomState.martinRecoveryPrediction : null
        // 같은 마틴 이어치기 reasoning이 라운드마다 누적되지 않도록 매번 베이스에서 한 번만 붙인다.
        const MARTIN_KEEP_SUFFIX = ' / 승리 전까지 같은 방향 유지'
        const baseReasoning = (storedRecoveryPrediction?.reasoning || '마틴 이어치기')
          .replace(new RegExp(`(${MARTIN_KEEP_SUFFIX.replace(/[/]/g, '\\/')})+$`), '')
        const recoveryPrediction: Prediction | null = storedRecoveryPrediction?.prediction
          ? {
            ...storedRecoveryPrediction,
            reasoning: `${baseReasoning}${MARTIN_KEEP_SUFFIX}`,
            timestamp: Date.now(),
          }
          : null

        if (recoveryPrediction) {
          console.log(`[AutoMode] ${room.koreanName} - 마틴 이어치기 고정 방향 사용: ${recoveryPrediction.prediction}`)
        } else if (martinWaitsForPattern) {
          console.log(`[AutoMode] ${room.koreanName} - 마틴 ${roomState.martinLevel + 1}단계 대기: 패턴(${String(chainFilter)})이 다시 맞는 판에만 배팅`)
        } else if (isInMartinRecovery && this.isTieOnlyFilter(this.currentPatternFilter)) {
          // 마틴 회복 중 + 타이 계열 필터: 패턴 매칭 우회하여 즉시 T 배팅 유지
          console.log(`[AutoMode] ${room.koreanName} - 마틴 회복 중 타이 필터 강제 T 배팅`)
        } else {
          console.log(`[AutoMode] getPatternBasedPrediction 호출: ${room.koreanName}`)
        }

        const customStrategyPrediction: Prediction | null = customStrategyDecision
          ? {
            roomId,
            prediction: customStrategyDecision.direction,
            confidence: 1,
            reasoning: `[전략] ${customStrategyDecision.strategyName} · ${customStrategyDecision.stageIndex + 1}단계 ${customStrategyDecision.attemptIndex + 1}차`,
            isSkip: false,
            timestamp: Date.now(),
          }
          : null

        const predictStartedAt = Date.now()
        const prediction = customStrategyPrediction ?? recoveryPrediction
          ?? (martinKeepsDirection && this.isTieOnlyFilter(chainFilter)
            ? { roomId, prediction: 'T' as const, confidence: 90, reasoning: '마틴 회복 (타이 유지)', isSkip: false, timestamp: Date.now() }
            : await this.getPatternBasedPrediction(room, remainingSeconds, martinWaitsForPattern ? chainFilter : undefined))
        // ⏱️ 예측에 걸린 시간 — 7초 창(슈퍼 스피드) 테이블에서 마감 전 전송 여부를 좌우한다.
        this.feDiag(`PREDICT-DONE room=${room.koreanName} ms=${Date.now() - predictStartedAt} src=${customStrategyPrediction ? 'strategy' : recoveryPrediction ? 'martin-keep' : 'api'} result=${prediction?.prediction ?? 'null'}`)

        // 🔒 패턴 묶음 마틴: 이번 판 패턴 미매칭이면 카드에 '패턴 대기'로 보이게 플래그를 켠다(바뀔 때만 알림).
        const nextPatternWait = martinWaitsForPattern && (!prediction || prediction.isSkip === true)
        if ((roomState.patternWait ?? false) !== nextPatternWait) {
          roomState.patternWait = nextPatternWait
          this.emitStateChange()
        }

        // 예측 없음 (shouldBet 호출 전 체크 - null 예측은 shouldBet에서 처리 불가)
        if (!prediction) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'no_prediction',
            level: 'info',
            status: 'pass',
            message: '예측 생성 실패 - 스킵',
          })
          console.log(`[AutoMode] 예측 결과 없음 (null) - 스킵`)
          return
        }

        // BettingDecisionService.shouldBet()에 위임하여 배팅 결정
        // RoomBettingState → RoomContext 변환
        // 현재 활성 필터에 per-filter 전략이 있으면 settings의 전략을 그것으로 교체해서 전달
        const roomContext: RoomContext = fromRoomBettingState(roomState)
        const effectiveSettings = this.getSettingsForActiveFilter(roomState)
        const betDecision = this.bettingDecisionService.shouldBet(
          roomId,
          prediction,
          effectiveSettings,
          roomContext
        )

        if (customStrategyDecision && betDecision.shouldBet) {
          betDecision.betAmount = customStrategyDecision.amount
          betDecision.betType = customStrategyDecision.direction === 'P'
            ? 'Player'
            : customStrategyDecision.direction === 'B'
              ? 'Banker'
              : 'Tie'
        }

        if (!betDecision.shouldBet) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'decision_skip',
            level: 'info',
            status: 'pass',
            message: martinWaitsForPattern && prediction.isSkip
              ? `마틴 ${roomState.martinLevel + 1}단계 대기 — ${prediction.reasoning || '패턴 미매칭'}`
              : (betDecision.skipReason || prediction.reasoning || '스킵'),
          })
          console.log(`[AutoMode] shouldBet=false: ${betDecision.skipReason} - 스킵`)
          return
        }

        if (!betDecision.betType || typeof betDecision.betAmount !== 'number') {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'decision_incomplete',
            level: 'error',
            status: 'failed',
            message: '배팅 결정값 누락 - 스킵',
          })
          console.warn(`[AutoMode] 배팅 결정값 누락: betType=${betDecision.betType}, betAmount=${betDecision.betAmount}`)
          return
        }

        // 🛡️ 테이블 최대 한도 캡 적용
        // 사용자 요구: 마틴 카운트가 100단까지 가도록 두되, 실제 금액은 테이블이 받는 한도까지만 올린다.
        // 한도를 넘어가면 AutoBettingService에서 'Above max limit'으로 실패하여 무한 실패 루프가 됨.
        // Tie는 Evolution 테이블에서 별도 한도가 있지만 CDP에 합쳐서 들어와 알 수 없으므로
        // 사용자 설정 tieMaxBetLimit를 우선 적용한다.
        const cappedAmount = this.applyBetCap(
          roomId,
          betDecision.betAmount,
          betDecision.betType,
          roomState.martinLevel,
          room.koreanName,
        )
        if (customStrategyDecision && cappedAmount !== betDecision.betAmount) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'custom_strategy_amount_over_limit',
            level: 'error',
            status: 'failed',
            message: `전략 금액 ${betDecision.betAmount.toLocaleString()}원이 테이블 한도를 초과하여 베팅을 차단했습니다.`,
          })
          return
        }
        if (cappedAmount !== betDecision.betAmount) {
          betDecision.betAmount = cappedAmount
        }

        const actualPrediction = this.applyDecisionBetType(prediction, betDecision.betType)

        console.log(`[AutoMode] ${room.koreanName} -> ${actualPrediction.prediction} (${actualPrediction.reasoning})`)

        // 예측 로그 emit
        this.emitBetLog({
          type: 'prediction',
          roomId,
          roomName: room.koreanName,
          prediction: actualPrediction.prediction as ('B' | 'P' | 'T' | null),
          confidence: actualPrediction.confidence,
          reasoning: actualPrediction.reasoning,
          martinLevel: roomState.martinLevel,
          timestamp: Date.now(),
        })

        // 🆕 원자적 상한 재확인(2026-05-31): 예측 await 동안 다른 방들이 먼저 배팅을 커밋했을 수
        //    있다. 락은 더 이상 슬롯으로 안 세므로(라이브락 수정), 실제 커밋 직전 여기서 한 번 더
        //    waiting+martin 수를 확인해 동시 배팅 상한을 원자적으로 보장한다(이 지점~waitingForResult
        //    설정까지 await 없이 동기 진행되므로 race 없음). 마틴 이어치기는 자기 슬롯이라 예외.
        const recheckCount = this.getActiveBettingCount()
        if (!isCurrentlyInMartin && !customStrategyDecision && maxBets > 0 && recheckCount >= maxBets) {
          console.log(`[AutoMode] 🚫 배팅 직전 상한 재확인 차단: ${room.koreanName} (배팅중=${recheckCount}/${maxBets})`)
          roomState.lastPrediction = null
          return
        }

        roomState.lastPrediction = actualPrediction
        this.state.lastEventTime = Date.now()

        // 바로 배팅 실행. shouldBet()이 확정한 금액/방향을 그대로 사용한다.
        await this.placeBet(
          roomId,
          room,
          actualPrediction,
          roomState,
          betDecision,
          effectiveSettings.betStrategy,
          hasReliableHistory,
          customStrategyDecision,
        )

      } catch (error) {
        console.error(`[AutoMode] Prediction failed for ${room.koreanName}:`, error)
        this.emitDecisionOnce({
          roomId,
          roomName: room.koreanName,
          martinLevel: roomState.martinLevel,
          historyLength: room.history.length,
          code: 'prediction_error',
          level: 'error',
          message: '예측 처리 중 오류 - 스킵',
        })
      }
    } finally {
      // 락 해제 (placeBet에서도 해제하지만, early return 경로를 위해 여기서도 해제)
      // Set.delete()는 이미 삭제된 요소에 대해 안전하게 동작
      this.bettingInProgress.delete(roomId)
      this.bettingInProgressSince.delete(roomId)
    }
  }

  private emitDecisionOnce(args: {
    roomId: string
    roomName: string
    martinLevel: number
    historyLength: number
    code: string
    message: string
    level?: 'info' | 'error'
    status?: 'pass' | 'failed' | 'pending'
  }): void {
    // 패스는 히스토리에 표시하지 않음
    if (args.status === 'pass') {
      return
    }

    const key = `${args.historyLength}:${args.code}`
    if (this.lastDecisionKeyByRoom.get(args.roomId) === key) return
    this.lastDecisionKeyByRoom.set(args.roomId, key)

    // Memory leak fix: limit map size to prevent unbounded growth
    const MAX_DECISION_CACHE_SIZE = 100
    if (this.lastDecisionKeyByRoom.size > MAX_DECISION_CACHE_SIZE) {
      // Remove oldest entries (first 20% of the map)
      const keysToRemove = Array.from(this.lastDecisionKeyByRoom.keys()).slice(0, Math.floor(MAX_DECISION_CACHE_SIZE * 0.2))
      keysToRemove.forEach(k => this.lastDecisionKeyByRoom.delete(k))
      console.log(`[AutoMode] 🧹 Cleaned up decision cache: removed ${keysToRemove.length} old entries`)
    }

    this.emitBetLog({
      type: 'bet_result',
      roomId: args.roomId,
      roomName: args.roomName,
      martinLevel: args.martinLevel,
      level: args.level || 'info',
      status: args.status,
      reasoning: args.message,
      timestamp: Date.now(),
    })
  }

  private predictionToBetType(prediction: Prediction): BetType {
    return prediction.prediction === 'B' ? 'Banker' :
      prediction.prediction === 'P' ? 'Player' : 'Tie'
  }

  private betTypeToPrediction(betType: BetType): 'B' | 'P' | 'T' {
    return betType === 'Banker' ? 'B' : betType === 'Player' ? 'P' : 'T'
  }

  private applyDecisionBetType(prediction: Prediction, betType: BetType): Prediction {
    const actual = this.betTypeToPrediction(betType)
    if (prediction.prediction === actual) return prediction

    return {
      ...prediction,
      prediction: actual,
      reasoning: prediction.reasoning
        ? `${prediction.reasoning} / 설정 적용: ${actual}`
        : `설정 적용: ${actual}`,
    }
  }

  private async placeBet(
    roomId: string,
    room: Room,
    prediction: Prediction,
    roomState: RoomBettingState,
    decision?: BetDecision,
    progressionStrategy?: AutoModeSettings['betStrategy'],
    hasReliableHistory = true,
    customStrategyDecision?: CustomStrategyBetDecision | null,
  ): Promise<void> {
    // NOTE: 락은 onBettingPhase에서 이미 설정됨 (bettingInProgress.add)
    // placeBet는 try-finally로 락 해제만 담당

    const betAmount = decision?.betAmount ?? this.calculateBetAmount(roomState.martinLevel)
    const betType: BetType = decision?.betType ?? this.predictionToBetType(prediction)
    const betCode = this.betTypeToPrediction(betType)

    console.log(`[AutoMode] placeBet 시작 - room: ${room.koreanName}, betType: ${betType}, prediction: ${betCode}, amount: ${betAmount}, isVirtual: ${this.settings.isVirtualMode}`)

    try {
      // ✅ 가상 모드 잔액 부족 시: 해당 방만 스킵 (전체 OFF 하지 않음)
      if (this.settings.isVirtualMode) {
        // ✅ FIX: UI와 동일한 방식으로 가용 잔액 계산
        // 가용 잔액 = 초기잔액 + 세션손익 - 현재 pending 배팅금액
        const initialBalance = VirtualBettingService.getSettings().initialBalance
        const currentPendingAmount = this.getCurrentPendingBetAmount()
        const availableBalance = initialBalance + this.state.cumulativeProfit - currentPendingAmount

        if (availableBalance < betAmount) {
          this.emitBetLog({
            type: 'bet_result',
            roomId,
            roomName: room.koreanName,
            prediction: prediction.prediction,
            betType,
            betAmount,
            martinLevel: roomState.martinLevel,
            status: 'failed',
            level: 'info',
            reasoning: `잔액 부족으로 스킵 (${availableBalance.toLocaleString()}원 < ${betAmount.toLocaleString()}원)`,
            timestamp: Date.now(),
          })
          // ✅ FIX: 전체 OFF 대신 해당 방만 스킵 - 다른 방들은 계속 배팅 가능
          console.log(`[AutoMode] ⚠️ 잔액 부족으로 ${room.koreanName} 스킵 - availableBalance: ${availableBalance}, required: ${betAmount}`)
          return
        }
        // 외부에서 가상배팅이 disable 된 경우 대비
        if (!VirtualBettingService.isEnabled()) {
          VirtualBettingService.enable()
        }
      }

      roomState.lastBetAmount = betAmount
      roomState.waitingForResult = true
      roomState.patternWait = false
      if (roomState.martinLevel === 0 || !roomState.martinChainFilter) roomState.martinChainFilter = this.currentPatternFilter
      roomState.lastBetTime = Date.now()
      roomState.lastBetHistoryLength = hasReliableHistory ? room.history.length : null
      roomState.martinRecoveryPrediction = prediction
      roomState.martinRecoveryStrategy = roomState.martinRecoveryStrategy ?? progressionStrategy ?? this.resolveActiveFilterStrategy()
      // Bug Fix: 배팅 시점의 모드 저장 (결과 처리 시 모드 불일치 방지)
      roomState.wasVirtualBet = this.settings.isVirtualMode
      roomState.placementStatus = undefined

      const maxBetsLog = this.settings.maxConcurrentBets > 0 ? this.settings.maxConcurrentBets : '∞'
      console.log(`[AutoMode] 🎰 배팅 시작: ${room.koreanName} (활성=${this.getActiveBettingCount()}/${maxBetsLog}개)`)
      // 🔬 커스텀 금액 검증용: 실제 적용된 전략·단계·금액을 남긴다(전략=custom인데 금액이 시퀀스와 다르면 배열 확인).
      this.feDiag(`BET-AMT room=${room.koreanName} strat=${this.resolveRoomProgressionStrategy(roomState)} lv=${roomState.martinLevel} amt=${betAmount} custom=[${(this.settings.customBetAmounts ?? []).slice(0, 16).join(',')}]`)

      // ⏱️ 배팅창 마감 판정 입력(가상·실제 공통): 서버 마감 절대시각(bettingDeadlineAt) 기준.
      const REAL_BET_MIN_LEAD_MS = 1000
      const liveRoomForGuard = this.resolveRoom(roomId)
      const guardDeadlineAt = liveRoomForGuard?.bettingDeadlineAt ?? this.lastBettingPhaseByRoom.get(roomId)?.deadlineAt
      const guardMsLeft = guardDeadlineAt !== undefined ? guardDeadlineAt - Date.now() : null
      const guardWindowClosed = !!liveRoomForGuard && (liveRoomForGuard.phase === 'dealing' || liveRoomForGuard.phase === 'result')

      if (this.settings.isVirtualMode) {
        // ⏱️ 가상도 실제와 같은 마감 규칙으로 판정한다(2026-09-05, 사용자: "가상때 불일치"). 마감 뒤 가상 배팅은
        //   실제라면 서버가 무시할 판을 '체결'로 쳐 승패·손익이 실전과 어긋난다(화면은 이미 딜링 중인데 프로그램만
        //   배팅). 마감 시각을 모르면(미수신/테스트) 가상은 허용(무해) — 실제는 아래처럼 fail-closed 그대로.
        const virtualTooLate = guardMsLeft !== null && guardMsLeft < REAL_BET_MIN_LEAD_MS
        if (guardWindowClosed || virtualTooLate) {
          const why = guardWindowClosed ? `phase=${liveRoomForGuard?.phase}` : `msLeft=${guardMsLeft}`
          console.warn(`[AutoMode] ⏱️ 배팅창 마감/타이밍 부족 — 가상배팅 스킵: ${room.koreanName} (${why})`)
          this.feDiag(`SKIP-WINDOW-CLOSED room=${room.koreanName} ${why} martin=${roomState.martinLevel} betType=${betType} virtual=1`)
          roomState.waitingForResult = false
          roomState.wasVirtualBet = undefined
          return
        }

        // 🧹 AutoMode는 이 방에 pending이 없다고 보는데 VirtualBettingService엔 pending이 남아 있으면(타임아웃
        //   강제리셋 등으로 양쪽 상태가 어긋난 잔재) 먼저 환불·정리한다. 안 그러면 duplicate_bet으로 최대 45초간
        //   이 방 배팅이 조용히 실패하고 보유금엔 유령 차감이 남는다.
        const staleVirtual = VirtualBettingService.getRoomState(roomId)
        if (staleVirtual?.lastBetResult === 'pending') {
          console.warn(`[AutoMode] ⚠️ VirtualBetting pending 잔재 정리(환불) — ${room.koreanName}: ${staleVirtual.currentBetAmount}원`)
          VirtualBettingService.cancelPendingBet(roomId)
        }

        // 🔥 VirtualBettingService 잔액 동기화 — 다른 방 pending을 반영한 값으로(이 방 금액은 곧 placeBetWithAmount가 차감).
        this.syncVirtualBalanceFor(roomId)

        // 가상 배팅 - AutoModeService 설정 기반 금액 사용 (실제 배팅과 동일한 동작)
        console.log(`[AutoMode] 가상 배팅 실행: ${room.koreanName} -> ${betCode} (${betAmount}원)`)
        if (customStrategyDecision && !CustomStrategyRuntime.markPending(customStrategyDecision)) {
          roomState.waitingForResult = false
          throw new Error('커스텀 전략 상태가 변경되어 베팅을 안전하게 취소했습니다.')
        }
        const result = VirtualBettingService.placeBetWithAmount(roomId, room.koreanName, betCode, betAmount)

        // 실패 처리 - 새로운 반환 형식 지원 (boolean | { success: false, reason: string })
        const isFailed = result !== true && (result === false || (typeof result === 'object' && !result.success))
        if (isFailed) {
          const failReason = typeof result === 'object' ? result.reason : 'unknown'
          const balance = VirtualBettingService.getGlobalBalance()

          // 오류 메시지 생성
          let reasonText: string
          switch (failReason) {
            case 'duplicate_bet':
              reasonText = '중복 배팅 방지 (결과 대기 중)'
              break
            case 'insufficient_balance':
              reasonText = `잔액 부족 (${balance.toLocaleString()}원)`
              break
            case 'disabled':
              reasonText = '가상 배팅 비활성화'
              break
            case 'no_prediction':
              reasonText = '예측 없음'
              break
            default:
              reasonText = `가상 배팅 실패 (${failReason})`
          }

          console.log(`[AutoMode] Virtual betting failed - reason: ${failReason}, balance: ${balance}`)
          roomState.waitingForResult = false
          if (customStrategyDecision) CustomStrategyRuntime.releasePending(roomId, reasonText)

          // ✅ FIX: 중복 배팅은 내부 로그만 (히스토리에 표시 안 함)
          if (failReason === 'duplicate_bet') {
            console.log(`[AutoMode] 중복 배팅 방지`)
            return
          }

          // 그 외 실패는 히스토리에 표시
          this.emitBetLog({
            type: 'bet_result',
            roomId,
            roomName: room.koreanName,
            prediction: prediction.prediction,
            betType,
            betAmount,
            martinLevel: roomState.martinLevel,
            status: 'failed',
            level: 'error',
            reasoning: reasonText,
            timestamp: Date.now(),
          })

          console.log(`[AutoMode] 가상배팅 실패`)
          return
        }
        console.log(`[AutoMode] 가상 배팅 성공!`)
      } else {
        // 실제 배팅 - 가상 배팅과 동일한 로직, 실제 메시지만 전송
        console.log(`[AutoMode] 실제 배팅 실행: ${room.koreanName} -> ${betType} (${betAmount}원)`)

        // ⏱️ [실배팅 타이밍 가드] 예측/처리 지연 동안 베팅창이 닫히면(BetsClosed→phase 'dealing'/'result')
        //   베팅이 마감 후 도착해 Evolution이 조용히 무시한다(라이브 확인 2026-06-23: 닫힌 뒤 전송→미등록,
        //   HasBet:false). 전송 직전 실시간 방 상태를 재확인해 '명확히 닫힌' 경우만 이번 판 스킵한다.
        //   (phase 미상/betting이면 진행 — 과차단으로 "배팅 안 함" 회귀 방지.)
        //   2026-09-02 추가: 페이즈만으론 부족하다. 서버 마감 절대시각(bettingDeadlineAt) 기준으로 전송·처리
        //   지연분(REAL_BET_MIN_LEAD_MS)만큼 여유가 없거나, 마감 시각을 모르면(BetsOpen 프레임 미수신) 보내지 않는다.
        //   마감 뒤 도착한 베팅은 Evolution이 응답 없이 무시해 '체결 미확인'만 남긴다(3차 라이브: 7초 창, 마감 10초 뒤 전송).
        const liveRoom = liveRoomForGuard
        const msLeft = guardMsLeft
        const windowClosed = guardWindowClosed
        const tooLate = msLeft === null || msLeft < REAL_BET_MIN_LEAD_MS
        if (windowClosed || tooLate) {
          const why = windowClosed ? `phase=${liveRoom?.phase}` : msLeft === null ? 'deadline=unknown' : `msLeft=${msLeft}`
          console.warn(`[AutoMode] ⏱️ 배팅창 마감/타이밍 부족 — 실배팅 스킵: ${room.koreanName} (${why})`)
          this.feDiag(`SKIP-WINDOW-CLOSED room=${room.koreanName} ${why} martin=${roomState.martinLevel} betType=${betType}`)
          roomState.waitingForResult = false
          return
        }
        this.feDiag(`BET-GUARD-PASS room=${room.koreanName} msLeft=${msLeft} martin=${roomState.martinLevel} betType=${betType} amount=${betAmount}`)

        // 🛡️ 실제 배팅 직전 동기화 재확인 (최종 안전장치)
        // AutoBettingService의 virtualModeEnabled가 true면 소켓 전송이 차단되므로
        // 실제 배팅 시점에 한 번 더 동기화하여 불일치 방지
        if (AutoBettingService.isVirtualMode() !== this.settings.isVirtualMode) {
          console.warn(`[AutoMode] ⚠️ VirtualMode 불일치 감지! AutoBettingService: ${AutoBettingService.isVirtualMode()}, settings: ${this.settings.isVirtualMode}`)
          AutoBettingService.setVirtualMode(this.settings.isVirtualMode)
          console.log(`[AutoMode] 🛡️ AutoBettingService virtual mode 재동기화: ${this.settings.isVirtualMode}`)
        }

        if (customStrategyDecision && !CustomStrategyRuntime.markPending(customStrategyDecision)) {
          roomState.waitingForResult = false
          throw new Error('커스텀 전략 상태가 변경되어 실베팅을 안전하게 취소했습니다.')
        }

        const result = await AutoBettingService.placeBet(
          roomId,
          betType,
          betAmount,
          undefined,
          true  // isRealBetting: 실제 메시지 전송
        )
        if (!result.success && result.placementStatus !== 'unknown') {
          const err = result.error || '실제 배팅 실패'
          console.warn(`[AutoMode] 실제배팅 실패/스킵: ${err}`)
          roomState.waitingForResult = false
          if (customStrategyDecision) CustomStrategyRuntime.releasePending(roomId, err)
          roomState.placementStatus = result.placementStatus

          // 🛑 잔액 부족 = 더 이상 베팅 불가 → 자동 정지(히스토리 도배 대신 한 번만 알리고 멈춤). 사용자 요청 2026-06-23.
          if (err.includes('잔액이 부족') || err.includes('Insufficient')) {
            console.warn(`[AutoMode] 🛑 잔액 부족 — 자동 정지: ${err}`)
            this.emitBetLog({
              type: 'bet_result', roomId, roomName: room.koreanName,
              prediction: prediction.prediction, betType, betAmount,
              martinLevel: roomState.martinLevel, status: 'failed', level: 'error',
              reasoning: `잔액 부족 — 자동 정지 (${err})`, timestamp: Date.now(),
            })
            this.stop()
            this.state.statusMessage = '잔액 부족으로 자동 정지'
            this.emitStateChange()
            return
          }

          // 🆕 v2.23: 슬롯 추적은 waitingForResult + bettingInProgress 기반 (Single Source of Truth)
          // 일시적 스킵(중복 베팅·게임정보 대기)은 결과 대기 중 1초 타이머 재시도마다 반복 발생하므로
          // 히스토리에 도배하지 않고 콘솔만 남긴다(사용자 보고 "이미 배팅됨 연속으로 나옴"). 진짜 오류만 히스토리 표시.
          const isTransientSkip = err.includes('이미 배팅') || err.includes('게임 정보를 받는 중')
          if (!isTransientSkip) {
            this.emitBetLog({
              type: 'bet_result',
              roomId,
              roomName: room.koreanName,
              prediction: prediction.prediction,
              betType,
              betAmount,
              martinLevel: roomState.martinLevel,
              status: 'failed',
              level: 'error',
              reasoning: err,
              timestamp: Date.now(),
            })
          }
          console.log(`[AutoMode] 실제배팅 실패/스킵, 슬롯 반환`)
          return
        }
        roomState.placementStatus = result.placementStatus
        if (result.placementStatus === 'unknown') {
          console.warn('[AutoMode] 실제배팅 체결 미확정 — 재전송하지 않고 resolved 결과를 기다립니다')
        } else {
          console.log(`[AutoMode] 실제 배팅 성공!`)
        }
        this.feDiag(`BET-SENT room=${room.koreanName} betType=${betType} amount=${betAmount} gid=${AutoBettingService.getPendingBet(roomId)?.gameId ?? '?'}`)
      }

      if (customStrategyDecision) this.syncCustomStrategyState(roomId, roomState)

      // 배팅 실행 로그 — 락 해제 전에 emit해서 락 풀린 사이 같은 방으로 재진입이
      //   발생하더라도 같은 bet_placed 가 중복 emit 되지 않도록 한다.
      this.emitBetLog({
        type: 'bet_placed',
        roomId,
        roomName: room.koreanName,
        prediction: betCode,
        betType,
        betAmount,
        martinLevel: roomState.martinLevel,
        status: 'pending',
        reasoning: prediction.reasoning,  // 패턴 정보 전달
        cumulativeProfit: this.state.cumulativeProfit,
        timestamp: Date.now(),
        customStrategyId: customStrategyDecision?.strategyId,
        customStrategyStage: customStrategyDecision ? customStrategyDecision.stageIndex + 1 : undefined,
        customStrategyAttempt: customStrategyDecision ? customStrategyDecision.attemptIndex + 1 : undefined,
      })

      const prevTotal = this.state.totalBetAmount
      this.state.totalBetAmount += betAmount
      console.log(`[AutoMode] 💵 totalBetAmount: ${prevTotal.toLocaleString()} → ${this.state.totalBetAmount.toLocaleString()}원 (+${betAmount.toLocaleString()}) | room: ${room.koreanName}`)
      this.emitStateChange()
    } finally {
      // 동시 배팅 방지: 락 해제 (emit 이후에 해제해서 중복 진입 차단)
      this.bettingInProgress.delete(roomId)
      this.bettingInProgressSince.delete(roomId)
    }
  }

  /**
   * 오토 ON / 필터 변경 시점에 이미 "배팅 페이즈"가 진행 중인 방이 있으면
   * 이벤트를 기다리지 않고 즉시 배팅 로직을 한 번 실행한다.
   *
   * 이유: 사용자가 카운트다운(예: 8s) 중에 ON/필터를 바꾸면,
   * BettingPhase 이벤트는 이미 지나갔을 수 있어 다음 라운드까지 배팅이 안 되는 문제가 발생할 수 있음.
   */
  private tryBetOnCurrentBettingWindows(roomIds?: string[], options?: { requestedFirst?: boolean }): void {
    if (!this.settings.enabled) return

    const baseTargets = (() => {
      if (Array.isArray(roomIds) && roomIds.length > 0) return roomIds

      // 패턴 필터가 걸려 있고, 매칭된 방 목록이 0개면 아무 것도 하지 않는다.
      if (this.currentPatternFilter !== 'all' && this.activeBettingRoomIds.size === 0 && this.hasReceivedActiveRoomList) {
        return []
      }

      if (this.activeBettingRoomIds.size > 0) return Array.from(this.activeBettingRoomIds)

      // UI에서 방을 선택한 경우 그 방만
      const configured = (this.settings.roomConfigs || []).filter(c => c.enabled).map(c => c.roomId)
      if (configured.length > 0) return configured

      // 마지막 fallback: 모든 방
      return this.allRoomIds()
    })()

    // 🔒 마틴 진행 중(martinLevel>0 / waitingForResult)인 방은 필터/activeBettingRoomIds에서
    // 빠져도 "이길 때까지" 이어쳐야 한다(사용자 핵심 요구). 연속배팅 타이머(1초)의 후보를
    // activeBettingRoomIds로만 만들면, 필터에서 빠진 락 방을 놓쳐 마틴이 중단(버려짐)된다.
    // → 항상 락 방을 후보에 union한다. 다운스트림 가드는 이미 안전: isRoomEnabled가 락 방을
    //    허용(881-883), maxConcurrentBets도 마틴 방은 면제(1192-1197). 베이스가 []여도 락 방은 이어침.
    const lockedMartin = this.getLockedMartinRoomIds()
    const mergedTargets = lockedMartin.length > 0
      ? Array.from(new Set([...baseTargets, ...lockedMartin]))
      : baseTargets

    const targetIds = this.prioritizeMartinRoomIds(mergedTargets, options?.requestedFirst === true)

    if (targetIds.length === 0) return

    let triggeredCount = 0
    targetIds.forEach((roomId) => {
      try {
        if (!this.isRoomEnabled(roomId)) return

        // 🆕 v2.24: 실시간 방 데이터에서 배팅 가능 여부 확인 (스냅샷보다 우선)
        const roomState = this.state.roomStates.get(roomId)
        const room = this.resolveRoom(roomId)
        const missingLockedMartinRoom = !room ? this.getMissingLockedMartinRoom(roomId) : null
        if (!room && !missingLockedMartinRoom) return

        // ⏱️ 남은 시간은 서버 마감 절대시각(deadline)으로만 잰다. 정적 remainingSeconds는 프레임이 온
        //   순간의 값이라 시간이 흘러도 줄지 않아, 마감 뒤에도 "배팅 가능"으로 보여 늦은 배팅을 만들었다.
        const nowMs = Date.now()
        const phaseSnapshot = this.lastBettingPhaseByRoom.get(roomId)
        const liveRoomData = room || missingLockedMartinRoom
        // 최후 폴백: 마감 시각이 어디에도 없고 방 데이터의 남은 초만 있으면 지금 기준으로 마감 시각을 만든다.
        //   (운영에선 BetsOpen이 항상 마감 시각을 채우고 BetsClosed가 남은 초를 0으로 만들어 여기까지 오지 않는다.)
        const staticRemaining = liveRoomData?.remainingSeconds ?? 0
        const deadlineAt = liveRoomData?.bettingDeadlineAt
          ?? phaseSnapshot?.deadlineAt
          ?? (phaseSnapshot ? phaseSnapshot.startedAt + phaseSnapshot.initialSeconds * 1000 : undefined)
          ?? (staticRemaining > 0 ? nowMs + staticRemaining * 1000 : undefined)
        const remainingSeconds = deadlineAt !== undefined ? Math.floor((deadlineAt - nowMs) / 1000) : 0
        if (remainingSeconds <= 0) {
          this.lastBettingPhaseByRoom.delete(roomId)
          return
        }

        // 이미 배팅 진행 중이면 스킵 (중복 배팅 방지)
        if (this.bettingInProgress.has(roomId)) return

        if (roomState?.waitingForResult) return

        const minRequiredSeconds = this.isProgressionActive(roomId, roomState) ? 2 : 3
        if (remainingSeconds < minRequiredSeconds) return

        // 기존 이벤트 핸들러 재사용 (동일한 안전장치/로직 적용)
        void this.onBettingPhase({ roomId, remainingSeconds, phase: 'start', deadlineAt }, 'poll')
        triggeredCount++
      } catch (e) {
        console.error('[AutoMode] tryBetOnCurrentBettingWindows error:', e)
      }
    })

    if (triggeredCount > 0) {
      console.log(`[AutoMode] 🔄 즉시 배팅 시도: ${triggeredCount}개 방`)
    }
  }

  /**
   * pending bet(결과 대기 중)일 때, 베팅 시점 대비 증가한 히스토리 길이를 기반으로
   * 해당 베팅의 실제 결과 winner를 추론한다.
   *
   * history는 newest-first이며, 베팅 시점의 history length = N
   * 결과가 1번 추가되면 length = N+1 이고 결과는 history[0]
   * 결과가 d번 추가되면 length = N+d 이고, 베팅 결과는 history[d-1]
   */
  private getPendingBetResultWinnerFromHistory(room: Room, roomState: RoomBettingState, fromConfirmedResult = false): Winner | null {
    const baseLength = roomState.lastBetHistoryLength
    // ✅ Bug Fix: baseLength 타입 및 값 방어
    if (typeof baseLength !== 'number' || baseLength < 0) return null

    const currentLength = room.history.length
    if (currentLength <= baseLength) return null

    // 🐞 타이 적중 유실 수정(2026-07-07): baseLength===0(빈 방 = '새 슈 첫 판부터' 배팅,
    // 사용자 fresh-shoe/타이 전략의 정상 경로)에서 결과가 배치로 2개 이상 한꺼번에 들어온 경우.
    //  - fromConfirmedResult=true (실제 GameResult 이벤트로 확정된 정산): 배팅은 '히스토리가
    //    빈 상태'에서 걸었으므로 새로 관측된 결과 중 가장 오래된 것(history[currentLength-1]
    //    = 아래 idx=delta-1)이 바로 그 배팅 라운드다 → 그 결과로 정산한다. 종전엔 무조건
    //    null을 반환해 타이 적중을 놓쳤고(→ handleGameResult가 winnerFromEvent=최신 B/P로
    //    폴백·오판) '타이를 먹었는데 승리가 패배로 정산'되는 근본 원인이었다.
    //  - fromConfirmedResult=false (수동적 스냅샷/타임아웃 추론): 갑자기 나타난 다판 스냅샷을
    //    오판(가짜 정산)하지 않도록 종전대로 보수적으로 건너뛴다.
    if (baseLength === 0 && currentLength > 1 && !fromConfirmedResult) {
      console.warn(`[AutoMode] Ambiguous first-hand history snapshot ignored - ${room.koreanName || room.id}: baseLen=0, currentLen=${currentLength}`)
      return null
    }

    const delta = currentLength - baseLength
    // ✅ Bug Fix: 음수 인덱스 방어 (delta가 0 이하면 위에서 이미 반환됨, 추가 안전장치)
    if (delta <= 0) return null

    const idx = delta - 1
    // ✅ Bug Fix: 인덱스 범위 체크 (히스토리 배열 범위 초과 방지)
    if (idx < 0 || idx >= room.history.length) {
      console.warn(`[AutoMode] ⚠️ History index out of bounds: idx=${idx}, historyLength=${room.history.length}`)
      return null
    }

    const result = room.history[idx]?.winner
    return result || null
  }

  private onHistoryUpdate(roomId: string, history: RoadResult[]): void {
    const roomState = this.state.roomStates.get(roomId)
    if (!roomState?.waitingForResult) return

    const baseLength = roomState.lastBetHistoryLength
    if (typeof baseLength !== 'number' || baseLength < 0) return

    if (history.length <= baseLength) return

    if (baseLength === 0 && history.length > 1) {
      const roomName = roomState.roomName || roomId
      console.warn(`[AutoMode] Ambiguous first-hand history snapshot ignored - ${roomName}: baseLen=0, currentLen=${history.length}`)
      return
    }

    const resultIndex = history.length - baseLength - 1
    const result = history[resultIndex]
    if (!result?.winner) return

    const roomName = roomState.roomName || roomId
    console.log(`[AutoMode] HistoryUpdate result detected - ${roomName}: winner=${result.winner}, baseLen=${baseLength}, currentLen=${history.length}`)
    this.handleGameResult(
      roomId,
      result.winner,
      result.playerScore,
      result.bankerScore
    )
  }

  private handleGameResult(roomId: string, winnerFromEvent: Winner, eventPlayerScore?: number, eventBankerScore?: number, betOutcome?: BetOutcome): void {
    const roomState = this.state.roomStates.get(roomId)
    const room = this.resolveRoom(roomId)
    const roomName = room?.koreanName || roomState?.roomName || roomId

    console.log(`[AutoMode] handleGameResult - room: ${roomName}, winner: ${winnerFromEvent}, waitingForResult: ${roomState?.waitingForResult}, lastPrediction: ${roomState?.lastPrediction?.prediction}`)
    this.feDiag(`RESULT room=${roomName} winner=${winnerFromEvent} waiting=${roomState?.waitingForResult} wasV=${roomState?.wasVirtualBet} betHL=${roomState?.lastBetHistoryLength} curHL=${room?.history.length}`)

    // 🆕 v2.23: 슬롯 추적은 waitingForResult 기반 Single Source of Truth
    // 결과 처리 후 waitingForResult = false로 설정되어 자동으로 슬롯이 반환됨

    if (!roomState || !roomState.waitingForResult) {
      console.log(`[AutoMode] 결과 무시 - waitingForResult: ${roomState?.waitingForResult}`)
      this.feDiag(`RESULT-ignore room=${roomName} reason=not-waiting(${roomState?.waitingForResult})`)
      return
    }

    // 🐞 슬롯 누수 수정(2026-05-31): waitingForResult=true인데 lastPrediction이 비어 있는 경우
    // (예측 2초 클리어 타이머/새 예측 사이클과 결과 도착의 비동기 틈) — 예전엔 여기서 그냥 return해
    // 슬롯(waitingForResult)을 반환하지 않아, 그 방이 동시배팅 슬롯을 영구 점유했다. 그러면
    // maxConcurrentBets(특히 1)에서 "🚫 동시배팅 상한 초과(점유=2/1)"로 모든 신규 배팅이 멈춘다.
    // → 결과가 온 이상 슬롯은 반드시 반환한다(가상 pending도 환불).
    if (!roomState.lastPrediction) {
      console.log(`[AutoMode] ⚠️ lastPrediction 없음 — 슬롯 반환(누수 방지): ${roomName}`)
      if (roomState.wasVirtualBet) {
        VirtualBettingService.cancelPendingBet(roomId)
      }
      CustomStrategyRuntime.releasePending(roomId, '결과는 왔지만 예측 정보가 없어 같은 차수를 유지합니다.')
      roomState.waitingForResult = false
      roomState.lastBetHistoryLength = null
      roomState.wasVirtualBet = undefined
      this.emitStateChange()
      return
    }

    // ✅ FIX: pending 상태가 45초 이상 지속되면 stale로 간주하고 강제 해제
    // ✅ Bug Fix: lastBetTime null 방어 - null이면 현재 시간 사용 (0초 대기로 처리, stale 아님)
    const pendingDuration = roomState.lastBetTime !== null
      ? Date.now() - roomState.lastBetTime
      : 0
    const isStale = pendingDuration > 45000

    // 히스토리가 베팅 이후로 증가하지 않았다면, 이 결과 이벤트는 현재 pending bet과 무관할 수 있음
    // (예: BettingPhase가 먼저 들어와서 다음 라운드 베팅이 잡힌 뒤, 이전 라운드 GameResult가 늦게 도착하는 경우)
    if (room && typeof roomState.lastBetHistoryLength === 'number') {
      if (room.history.length <= roomState.lastBetHistoryLength) {
        const acceptZeroTieResultBeforeHistory = winnerFromEvent === 'T' && this.isZeroTieFrequentFilter()
        if (acceptZeroTieResultBeforeHistory) {
          console.log(`[AutoMode] Accepting zero-tie filter Tie result before history growth - ${roomName}`)
          this.feDiag(`RESULT-accept-zero-tie-before-history room=${roomName} betHL=${roomState.lastBetHistoryLength} curHL=${room.history.length}`)
        } else {
          // A result event is only actionable after the room history grows past
          // the recorded bet history length. Age alone must not release the slot.
          console.log(`[AutoMode] 결과 무시 - 히스토리 증가 없음 (betHistory=${roomState.lastBetHistoryLength}, currentHistory=${room.history.length})`)
          this.feDiag(`RESULT-ignore room=${roomName} reason=hist-not-grown betHL=${roomState.lastBetHistoryLength} curHL=${room.history.length} stale=${isStale}`)
          return
        }
    }
    }

    const inferredWinner = room ? this.getPendingBetResultWinnerFromHistory(room, roomState, true) : null
    const winner = inferredWinner || winnerFromEvent

    if (inferredWinner && inferredWinner !== winnerFromEvent) {
      console.warn(`[AutoMode] ⚠️ GameResult winner mismatch - event=${winnerFromEvent}, inferred=${inferredWinner}, using inferred`)
    }

    const predResult = roomState.lastPrediction.prediction
    if (!predResult) {
      console.warn(`[AutoMode] 결과 처리 불가 - lastPrediction.prediction 없음 (${roomName})`)
      if (roomState.wasVirtualBet === true) {
        VirtualBettingService.cancelPendingBet(roomId)
      }
      roomState.wasVirtualBet = undefined
      roomState.waitingForResult = false
      roomState.lastPrediction = null
      roomState.martinRecoveryPrediction = null
      roomState.martinRecoveryStrategy = null
      roomState.lastBetHistoryLength = null
      this.emitStateChange()
      return
    }

    const betAmount = roomState.lastBetAmount
    // 배팅 시점의 마틴 레벨 캡처 (결과 처리로 변경되기 전의 값)
    const betTimeMartinLevel = roomState.martinLevel

    const historyIndex = (() => {
      if (!room || typeof roomState.lastBetHistoryLength !== 'number') return undefined
      const delta = room.history.length - roomState.lastBetHistoryLength
      if (delta <= 0) return undefined
      return delta - 1
    })()
    const customSessionAtBet = CustomStrategyRuntime.getSessionForRoom(roomId)
    const customStrategyStageAtBet = customSessionAtBet?.stageIndex !== undefined
      ? customSessionAtBet.stageIndex + 1
      : undefined
    const customStrategyAttemptAtBet = customSessionAtBet?.attemptIndex !== undefined
      ? customSessionAtBet.attemptIndex + 1
      : undefined
    const customResultKey = betOutcome?.gameId
      || `${roomId}:${roomState.lastBetHistoryLength ?? 'unknown'}:${historyIndex ?? 'event'}:${winner}:${roomState.lastBetTime ?? 'time'}`

    // 카드 점수 추출 (이벤트 → 히스토리 → gameState 순으로 폴백)
    const latestResult = room?.history[0]
    const playerScore = eventPlayerScore ?? latestResult?.playerScore ?? room?.gameState?.playerHand?.score
    const bankerScore = eventBankerScore ?? latestResult?.bankerScore ?? room?.gameState?.bankerHand?.score

    // Bug Fix: 배팅 시점의 모드를 사용 (현재 설정이 아닌 배팅 당시 모드)
    // ✅ Bug Fix: wasVirtualBet undefined 시 폴백 사용 경고 (이전 버전 호환)
    if (roomState.wasVirtualBet === undefined) {
      console.warn(`[AutoMode] ⚠️ wasVirtualBet undefined - fallback to current setting: ${this.settings.isVirtualMode} (${roomName})`)
    }
    const wasVirtualBet = roomState.wasVirtualBet ?? this.settings.isVirtualMode

    // A confirmation timeout means the request may still have been accepted. Do not
    // infer a financial result from shoe history alone; wait for authoritative
    // baccarat.resolved acceptedBets/rejectedBets for this exact round and spot.
    if (!wasVirtualBet && roomState.placementStatus === 'unknown') {
      const pendingBet = AutoBettingService.getPendingBet(roomId)
      if (betOutcome?.gameId && pendingBet?.gameId && betOutcome.gameId !== pendingBet.gameId) {
        console.warn(`[AutoMode] 체결 미확정 결과 무시 — gameId 불일치 (${roomName})`)
        return
      }

      if (!betOutcome) {
        console.warn(`[AutoMode] 체결 미확정 결과 보류 — authoritative resolved 대기 (${roomName})`)
        return
      }

      const accepted = isBetAccepted(betOutcome, predResult as Winner)
      const { rejected } = isBetRejected(betOutcome, predResult as Winner)
      if (!accepted && !rejected) {
        const spot = predResultToSpot(predResult as Winner)
        console.warn(`[AutoMode] 체결 내역 없음 — 정산 제외: ${roomName} spot=${spot}`)
        this.emitBetLog({
          type: 'bet_result',
          roomId,
          roomName,
          prediction: predResult,
          betType: spot,
          betAmount,
          martinLevel: roomState.martinLevel,
          status: 'failed',
          level: 'error',
          reasoning: '서버 체결 내역 없음 — 손익/마틴 정산 제외',
          timestamp: Date.now(),
        })
        AutoBettingService.onGameResult(roomId)
        CustomStrategyRuntime.releasePending(roomId, '서버 체결 내역 없음')
        roomState.waitingForResult = false
        roomState.lastPrediction = null
        roomState.lastBetHistoryLength = null
        roomState.wasVirtualBet = undefined
        roomState.placementStatus = undefined
        roomState.lastResultTime = Date.now()
        this.state.lastEventTime = Date.now()
        this.emitStateChange()
        if (this.settings.enabled) this.tryBetOnCurrentBettingWindows()
        return
      }
    }

    // 🎯 실배팅 거절 정산 제외(2026-06-23): Evolution이 거절한 베팅(rejectedBets, 예 '1013'=최소금액 미달)은
    // 지갑이 움직이지 않았으므로 손익/마틴에 반영하지 않는다 — "돈만 나가고 이겨도 안 들어옴"의 근본 원인인
    // 가짜 정산(phantom)을 막는다. betOutcome은 baccarat.resolved에서만 옴(없으면 아래 기존 정산으로 폴백).
    if (!wasVirtualBet) {
      const { rejected, errorCode } = isBetRejected(betOutcome, predResult as Winner)
      if (rejected) {
        const spot = predResultToSpot(predResult as Winner)
        console.warn(`[AutoMode] 🚫 실배팅 거절 — 정산 제외: ${roomName} spot=${spot} error=${errorCode ?? '?'}`)
        this.feDiag(`SETTLE-SKIP-REJECTED room=${roomName} spot=${spot} err=${errorCode ?? '?'}`)
        this.emitBetLog({
          type: 'bet_result',
          roomId,
          roomName,
          prediction: predResult,
          betType: spot,
          betAmount,
          martinLevel: roomState.martinLevel,
          status: 'failed',
          level: 'error',
          reasoning: errorCode === '1013'
            ? '최소 배팅금액 미달로 거절됨 — 정산 제외 (돈 안 빠짐)'
            : `배팅 거절(${errorCode ?? '?'}) — 정산 제외`,
          timestamp: Date.now(),
        })
        // 거절은 손실이 아니므로 마틴 단계를 올리지 않는다. 상태만 정리하고 슬롯 반환.
        AutoBettingService.onGameResult(roomId)
        CustomStrategyRuntime.releasePending(roomId, `배팅 거절(${errorCode ?? '?'})`)
        roomState.waitingForResult = false
        roomState.lastPrediction = null
        roomState.lastBetHistoryLength = null
        roomState.wasVirtualBet = undefined
        roomState.placementStatus = undefined
        roomState.lastResultTime = Date.now()
        this.state.lastEventTime = Date.now()
        this.emitStateChange()
        if (this.settings.enabled) this.tryBetOnCurrentBettingWindows()
        return
      }
    }

    // 타이 처리 (push) - 손익/마틴 변화 없음, 환불 처리
    // 단, predResult가 'T'인 경우는 Tie 배팅이 적중한 경우이므로 일반 승리 처리(아래로) 진행
    if (winner === 'T' && predResult !== 'T') {
      const customTransition = CustomStrategyRuntime.settle(roomId, 'push', customResultKey)
      if (customTransition.handled) this.syncCustomStrategyState(roomId, roomState)
      if (wasVirtualBet) {
        VirtualBettingService.resolveBet(roomId, roomName, predResult, 'T')
        // ✅ 결과 처리 후 잔액 동기화 (Single Source of Truth: cumulativeProfit, 다른 방 pending 반영)
        this.syncVirtualBalanceFor(roomId)
      } else {
        // Bug Fix: 실제 배팅이었으면 AutoBettingService 상태도 정리
        AutoBettingService.onGameResult(roomId)
      }
      // 실제 모드: 타이 시 환불은 Evolution WebSocket에서 자동 처리됨
      // 수동으로 setBalance 호출하지 않음 (동기화 문제 방지)

      roomState.waitingForResult = false
      roomState.lastPrediction = null
      if (roomState.martinLevel === 0) {
        roomState.martinRecoveryPrediction = null
        roomState.martinRecoveryStrategy = null
      }
      roomState.lastBetHistoryLength = null
      roomState.wasVirtualBet = undefined  // Bug Fix: 모드 정보 초기화
      roomState.placementStatus = undefined
      roomState.lastResultTime = Date.now()
      this.state.lastEventTime = Date.now()
      this.markTieAutoCompletedRoom(roomId, roomName, 'T')

      this.emitBetLog({
        type: 'bet_result',
        roomId,
        roomName,
        prediction: predResult,
        winner: 'T',
        won: null,
        status: 'tie',
        historyIndex,
        profit: 0,
        betAmount,
        cumulativeProfit: this.state.cumulativeProfit,
        martinLevel: roomState.martinLevel,
        timestamp: Date.now(),
        playerScore,
        bankerScore,
        customStrategyId: customSessionAtBet?.strategyId,
        customStrategyStage: customStrategyStageAtBet,
        customStrategyAttempt: customStrategyAttemptAtBet,
      })

      this.emitStateChange()

      // 🆕 v2.24: 타이 결과 후에도 즉시 다른 방 배팅 시도
      if (this.settings.enabled) {
        if (this.isProgressionActive(roomId, roomState)) {
          this.tryBetOnCurrentBettingWindows([roomId], { requestedFirst: true })
        }
        this.tryBetOnCurrentBettingWindows()
      }
      return
    }

    const won = predResult === winner

    // 손익은 단일 페이아웃 정책(domain/betting/payout.winProfit)으로 계산 — 엔진 간 반올림
    // 드리프트 방지(dup-1). 여기 도달 시 타이 PUSH(B/P 베팅 + T 결과)는 이미 위에서 환불 처리됨.
    const profit = won
      ? winProfit(predResult as 'B' | 'P' | 'T', betAmount)
      : -betAmount

    // 통계 업데이트
    roomState.totalBets++
    roomState.totalProfit += profit
    roomState.lastResultTime = Date.now()
    const customTransition = CustomStrategyRuntime.settle(roomId, won ? 'win' : 'loss', customResultKey)
    if (customTransition.handled) this.syncCustomStrategyState(roomId, roomState)

    if (won) {
      // ========== 승리 처리 ==========
      roomState.totalWins++
      this.state.totalWins++

      if (customTransition.handled) {
        roomState.martinRecoveryPrediction = null
        roomState.martinRecoveryStrategy = null
        console.log(`[AutoMode] ${roomName} - 커스텀 전략 승리! ${customTransition.stageIndex + 1}단계 ${customTransition.attemptIndex + 1}차 상태=${customTransition.status}`)
      } else {
        // ✅ MartingaleManager를 Single Source of Truth로 사용
        // recordWin은 level=0, consecutiveWins++, consecutiveLosses=0 처리
        this.martingaleManager.recordWin(roomId)
        roomState.martinRecoveryPrediction = null
        roomState.martinRecoveryStrategy = null
        console.log(`[AutoMode] ${roomName} - 승리! 마틴 리셋, 손익: +${profit.toLocaleString()}원`)
      }
      this.feDiag(`SETTLE-WIN room=${roomName} winner=${winner} profit=${profit} cum=${this.state.cumulativeProfit + profit}`)
    } else {
      // ========== 패배 처리 ==========
      roomState.totalLosses++
      this.state.totalLosses++

      // 🆕 2026-06-23: 레벨 상승은 '진행형 전략'에서만. flat(플랫)은 패배해도 레벨 0을 유지한다 —
      //   안 그러면 phantom martinLevel>0로 방이 '마틴 락'(슬롯 점유·동시배팅 상한 면제·같은 방/방향
      //   고착)이 돼 사용자의 flat·동시배팅 설정을 위반한다(레벨 0 = 슬롯 반환 → 다음 매칭 방으로 회전).
      const effectiveStrategy = this.resolveRoomProgressionStrategy(roomState)
      if (customTransition.handled) {
        roomState.martinRecoveryPrediction = null
        roomState.martinRecoveryStrategy = null
        console.log(`[AutoMode] ${roomName} - 커스텀 전략 패배! 상태=${customTransition.status}, 다음 ${customTransition.stageIndex + 1}단계 ${customTransition.attemptIndex + 1}차`)
      } else if (effectiveStrategy === 'flat') {
        this.martingaleManager.recordLoss(roomId, false) // 연패 카운트만, 레벨 미상승
        roomState.martinRecoveryPrediction = null
        roomState.martinRecoveryStrategy = null
        console.log(`[AutoMode] ${roomName} - 패배(flat, 레벨 0 유지 → 슬롯 반환·회전), 손익: ${profit.toLocaleString()}원`)
      } else {
        // 마틴 레벨 증가 (다음 배팅용)
        // martinLevel은 0-indexed: 0=1단계, 1=2단계, 2=3단계
        // maxMartin=3 설정 시:
        //   - martinLevel=0(1단계) 패배 → martinLevel=1(2단계)
        //   - martinLevel=1(2단계) 패배 → martinLevel=2(3단계)
        //   - martinLevel=2(3단계, 최대) 패배 → 레벨0으로 리셋해 1단계부터 다시 진행
        const maxMartin = this.settings.maxMartin
        const currentLevel = this.martingaleManager.getLevel(roomId)

        if (currentLevel >= maxMartin - 1) {
          // 🆕 2026-09-03(사용자 지시): 최대 마틴 단계 소진 시 '최고액 무한 유지'를 중단하고
          //   레벨 0으로 리셋해 처음부터(base 금액) 새 진행을 시작한다. 방향 잠금(recovery)도 해제해
          //   다음 라운드는 예측/패턴을 새로 매칭한다. 세션 중지는 로스컷/윈컷(checkCutConditions)이 담당.
          //   승리처럼 지속하지 않으므로, 설정한 마틴 단계만큼만 진행 후 사이클이 재시작된다.
          this.martingaleManager.resetLevel(roomId)
          roomState.martinRecoveryPrediction = null
          roomState.martinRecoveryStrategy = null
          console.log(`[AutoMode] ${roomName} - 패배! 마틴 ${maxMartin}단계 소진 → 레벨0 리셋(처음부터 재시작), 손익: ${profit.toLocaleString()}원`)
        } else {
          // 최대 단계 미만에서 패배 → 레벨 증가
          // ✅ MartingaleManager를 Single Source of Truth로 사용
          // recordLoss는 level++, consecutiveLosses++, consecutiveWins=0 처리
          this.martingaleManager.recordLoss(roomId)
          console.log(`[AutoMode] ${roomName} - 패배! 마틴 ${roomState.martinLevel + 1}/${maxMartin}단계, 손익: ${profit.toLocaleString()}원`)
        }
      }
    }

    // profit은 이미 반올림된 정수이므로 다시 반올림하지 않음 (누적 오차 방지)
    this.state.cumulativeProfit += profit

    // 🆕 손실도 SETTLE-WIN과 대칭으로 로그(2026-06-23) — 종전엔 패배가 feDiag에 안 남아 "졌을때 계산"이
    // 로그상 안 보였다. 이제 한 런으로 패배 차감(cum 감소)을 확인 가능.
    if (!won) {
      this.feDiag(`SETTLE-LOSS room=${roomName} winner=${winner} profit=${profit} cum=${this.state.cumulativeProfit}`)
    }

    // 최대 수익/손실 갱신
    if (this.state.cumulativeProfit > this.state.maxProfit) {
      this.state.maxProfit = this.state.cumulativeProfit
    }
    if (this.state.cumulativeProfit < this.state.maxLoss) {
      this.state.maxLoss = this.state.cumulativeProfit
    }

    this.state.lastEventTime = Date.now()

    // Bug Fix: 배팅 시점의 모드에 따라 결과 처리 (현재 설정이 아닌 배팅 당시 모드)
    if (wasVirtualBet) {
      // 가상 배팅 결과 처리 (lastPrediction을 null로 만들기 전에 처리)
      VirtualBettingService.resolveBet(roomId, roomName, predResult, winner)
      // ✅ 결과 처리 후 잔액 동기화 (Single Source of Truth: cumulativeProfit, 다른 방 pending 반영)
      // cumulativeProfit이 이미 업데이트된 후이므로 정확한 잔액으로 동기화됨
      this.syncVirtualBalanceFor(roomId)
    } else {
      // Bug Fix: 실제 배팅이었으면 AutoBettingService 상태 정리
      AutoBettingService.onGameResult(roomId)
    }
    // 실제 모드: 잔액은 Evolution WebSocket에서 자동 업데이트됨
    // 수동으로 setBalance 호출하지 않음 (동기화 문제 방지)

    roomState.waitingForResult = false
    roomState.lastPrediction = null
    roomState.lastBetHistoryLength = null
    this.markTieAutoCompletedRoom(roomId, roomName, winner)
    roomState.wasVirtualBet = undefined  // Bug Fix: 모드 정보 초기화
    roomState.placementStatus = undefined

    // 결과 로그 — 배팅 시점의 마틴 레벨을 사용해 히스토리 표시와 일치시킴
    this.emitBetLog({
      type: 'bet_result',
      roomId,
      roomName,
      prediction: predResult,
      winner,
      won,
      status: won ? 'win' : 'loss',
      historyIndex,
      profit,
      betAmount,
      cumulativeProfit: this.state.cumulativeProfit,
      martinLevel: betTimeMartinLevel,
      timestamp: Date.now(),
      playerScore,
      bankerScore,
      customStrategyId: customSessionAtBet?.strategyId,
      customStrategyStage: customStrategyStageAtBet,
      customStrategyAttempt: customStrategyAttemptAtBet,
    })

    // ========== 결과 후 윈컷/로스컷 체크 ==========
    // 가상모드: 자체 손익(cumulativeProfit)이 정확하므로 결과 시점에 즉시 판정.
    // 실배팅모드: 자체 추정은 무효처리/거부된 베팅을 '승리'로 잘못 셀 수 있어(가짜 P&L) 여기서
    //   판정하지 않는다. 대신 실잔액이 정산되는 onBalanceUpdate(checkRealBalanceCuts) +
    //   다음 베팅 직전 게이트(getEffectiveProfit)에서 '진짜 돈' 기준으로 판정한다.
    if (this.settings.isVirtualMode) {
      if (this.settings.winCutAmount > 0 && this.state.cumulativeProfit >= this.settings.winCutAmount) {
        console.log(`[AutoMode] 🎉 윈컷 도달! 목표: ${this.settings.winCutAmount.toLocaleString()}원, 달성: ${this.state.cumulativeProfit.toLocaleString()}원`)
        this.stop()
        this.state.statusMessage = `윈컷 달성! +${this.state.cumulativeProfit.toLocaleString()}원`
      }
      if (this.settings.lossCutAmount > 0 && this.state.cumulativeProfit <= -this.settings.lossCutAmount) {
        console.log(`[AutoMode] ⛔ 로스컷 도달! 한도: -${this.settings.lossCutAmount.toLocaleString()}원, 현재: ${this.state.cumulativeProfit.toLocaleString()}원`)
        this.stop()
        this.state.statusMessage = `로스컷 도달! ${this.state.cumulativeProfit.toLocaleString()}원`
      }
    } else {
      // 실배팅: 표시(자체 추정)와 실잔액 손익이 크게 어긋나면 무효처리/거부 의심 → 경고로 표면화.
      const realNet = this.getRealNetProfit()
      if (realNet !== null && Math.abs(realNet - this.state.cumulativeProfit) > Math.max(this.settings.baseBetAmount, 1)) {
        console.warn(`[AutoMode] ⚠️ 손익 불일치 — 표시(추정)=${this.state.cumulativeProfit.toLocaleString()}원 vs 실잔액기준=${realNet.toLocaleString()}원. 베팅이 무효처리/거부됐을 수 있습니다.`)
      }
    }

    this.emitStateChange()

    // 🆕 v2.24: 결과 처리 후 즉시 다른 방 배팅 시도 (슬롯이 비었으므로)
    // 윈컷/로스컷으로 정지되지 않았으면 실행
    if (this.settings.enabled) {
      if (this.isProgressionActive(roomId, roomState)) {
        this.tryBetOnCurrentBettingWindows([roomId], { requestedFirst: true })
      }
      this.tryBetOnCurrentBettingWindows()
    }
  }

  private onGameResult(event: GameResultEvent): void {
    const { roomId, winner, playerScore, bankerScore } = event
    this.handleGameResult(roomId, winner, playerScore, bankerScore, event.betOutcome)
  }

  private onShoeChange(roomId: string): void {
    this.tieAutoCompletedRoomIds.delete(roomId)
    CustomStrategyRuntime.resetRoom(roomId)
    const roomState = this.state.roomStates.get(roomId)
    if (!roomState) return

    const isInMartin = roomState.martinLevel > 0 || roomState.waitingForResult

    if (isInMartin) {
      // 마틴 진행 중: 마틴 레벨·방향 유지, 슈 변경과 무관하게 이어치기
      // pending bet이 있으면 히스토리가 리셋되므로 결과 추론이 불가 → 정리
      if (roomState.waitingForResult) {
        roomState.lastBetHistoryLength = null
        if (roomState.wasVirtualBet) {
          VirtualBettingService.cancelPendingBet(roomId)
          roomState.waitingForResult = false
          roomState.lastPrediction = null
          roomState.wasVirtualBet = undefined
        }
        // 실제 배팅: waitingForResult 유지 → GameResult 이벤트로 결과 처리
        // lastBetHistoryLength=null이면 handleGameResult가 winnerFromEvent 직접 사용
      }
      console.log(`[AutoMode] Shoe change for ${roomState.roomName}, martin level KEPT at ${roomState.martinLevel}`)
    } else {
      // 마틴 아님: 완전 초기화
      this.martingaleManager.resetLevel(roomId)
      roomState.waitingForResult = false
      roomState.lastPrediction = null
      roomState.martinRecoveryPrediction = null
      roomState.martinRecoveryStrategy = null
      roomState.lastBetHistoryLength = null
      if (this.settings.isVirtualMode) {
        VirtualBettingService.cancelPendingBet(roomId)
      }
      console.log(`[AutoMode] Shoe change for ${roomState.roomName}, resetting state`)
    }
    this.syncCustomStrategyState(roomId, roomState)
    this.emitStateChange()
  }

  // ==================== Utilities ====================

  /**
   * 현재 pending 상태인 가상 배팅의 총 금액 계산
   * UI와 동일한 방식으로 가용 잔액을 계산하기 위해 사용
   */
  private getCurrentPendingBetAmount(): number {
    let pendingAmount = 0
    this.state.roomStates.forEach(rs => {
      if (rs.waitingForResult && rs.wasVirtualBet === true) {
        // Guard against undefined/NaN (Codex recommendation)
        pendingAmount += rs.lastBetAmount ?? 0
      }
    })
    return pendingAmount
  }

  /**
   * 🆕 2026-09-05 가상 보유금 동기화(pending 반영) — 사용자: "가상때 불일치".
   * VirtualBettingService.globalBalance를 '초기잔액 + 누적손익 − (이 방을 제외한) 가상 pending 합계'로 맞춘다.
   *   - 배팅 직전: 이 방 금액은 곧 placeBetWithAmount가 차감하므로 제외.
   *   - 정산 직후: 이 방은 resolveBet으로 이미 정산(환불/지급)됐으므로 제외(waitingForResult는 아직 true).
   * 종전엔 pending을 전혀 빼지 않아(초기+손익만) 동시배팅(2방 이상)마다 다른 방 pending이 되살아났고,
   * 그래서 VBS 잔액(헤더/로그 balance)이 패널의 '초기+손익−현재배팅'과 다른 값으로 오락가락했다.
   */
  private syncVirtualBalanceFor(roomId: string): void {
    let otherPending = 0
    this.state.roomStates.forEach((rs, id) => {
      if (id === roomId) return
      if (rs.waitingForResult && rs.wasVirtualBet === true) otherPending += rs.lastBetAmount ?? 0
    })
    const syncBalance = VirtualBettingService.getSettings().initialBalance + this.state.cumulativeProfit - otherPending
    VirtualBettingService.syncGlobalBalance(syncBalance)
  }

  /** 현재 테이블에 걸린 '실배팅' pending 합계(결과 대기 중, 실모드). getRealNetProfit 보정용. */
  private getRealPendingBetAmount(): number {
    let pendingAmount = 0
    this.state.roomStates.forEach(rs => {
      if (rs.waitingForResult && rs.wasVirtualBet === false) {
        pendingAmount += rs.lastBetAmount ?? 0
      }
    })
    return pendingAmount
  }

  /**
   * 실배팅 모드의 '진짜 돈' 누적 손익. Evolution 실잔액 델타 기반(자체 추정 cumulativeProfit 아님).
   *   = (현재 실잔액 - 시작 실잔액) + 현재 실배팅 pending 합계
   * pending을 더해 '베팅~정산 사이 잔액 하락분'을 보정 → 정산된 순손익만 남는다(타이밍에 강건).
   * 가상모드이거나 실잔액/기준선을 모르면 null(확정 불가 → 호출부가 자체 추정으로 폴백).
   */
  private getRealNetProfit(): number | null {
    if (this.settings.isVirtualMode) return null
    if (this.realBalance === null) return null
    if (this.realStartBalance === null || this.realStartBalance <= 0) return null
    return (this.realBalance - this.realStartBalance) + this.getRealPendingBetAmount()
  }

  /**
   * 실모드 표시용 보유금(2026-06-23 사용자 요청). Evolution 실잔액 프레임은 배팅을 placement에 차감하지만
   * UI 갱신 타이밍이 불안정해 "배팅해도 안 빠짐/졌을때 안 빠짐"으로 보였다. 그래서 가상모드와 동일한 모델로
   * 지갑을 투영한다:  시작 실잔액 + 누적손익 − 현재 실배팅 pending.
   *   - 배팅 거는 즉시: pending↑ → 보유금↓ (7만→6만, 승패 오기 전에)
   *   - 승리: 누적손익↑ → 올라감 / 패배: 누적손익↓·pending↓ → 6만 유지(안 되돌아옴)
   * 자체손익이 거절(1013) 제외 후 정확하므로 실지갑과 수렴. 기준선 미확보 시 realBalance로 폴백.
   */
  private getRealDisplayBalance(): number | null {
    if (this.settings.isVirtualMode) return null
    // 🆕 2026-07-08 실잔액 기준 통일(사용자: "실잔액 -6만인데 프로그램 -4만 불일치"):
    // 종전엔 자체추정(cumulativeProfit)으로 보유금을 투영했는데, 실배팅 정산 유실(force-reset로
    // 결과 미정산)이 있으면 실제와 어긋난다(2판 손실 누락 → -4만으로 과소표시). 이제 '진짜 돈'인
    // 실잔액 기반 손익(getRealNetProfit)으로 투영해 실제 지갑과 맞춘다(= 실잔액 그 자체).
    const net = this.getRealNetProfit()
    if (net !== null && this.realStartBalance !== null && this.realStartBalance > 0) {
      return this.realStartBalance + net - this.getRealPendingBetAmount()
    }
    return this.realBalance
  }

  /** 윈컷/로스컷·표시에 쓸 손익: 실배팅은 실잔액 기반(getRealNetProfit), 불가 시 자체 추정으로 폴백. */
  private getEffectiveProfit(): number {
    const real = this.getRealNetProfit()
    return real !== null ? real : this.state.cumulativeProfit
  }

  /**
   * 실배팅 윈컷/로스컷을 '진짜 돈'(실잔액 정산) 기준으로 판정. onBalanceUpdate에서 호출 —
   * 결과 시점이 아니라 실잔액이 실제로 갱신된 시점이라 승리 입금 타이밍 레이스가 없다.
   */
  private checkRealBalanceCuts(): void {
    if (!this.settings.enabled || this.settings.isVirtualMode) return
    const real = this.getRealNetProfit()
    if (real === null) return

    if (this.settings.winCutAmount > 0 && real >= this.settings.winCutAmount) {
      console.log(`[AutoMode] 🎉 윈컷 도달(실잔액 기준)! 목표: ${this.settings.winCutAmount.toLocaleString()}원, 실손익: +${real.toLocaleString()}원`)
      this.stop()
      this.state.statusMessage = `윈컷 달성! +${real.toLocaleString()}원`
      this.emitStateChange()
    } else if (this.settings.lossCutAmount > 0 && real <= -this.settings.lossCutAmount) {
      console.log(`[AutoMode] ⛔ 로스컷 도달(실잔액 기준)! 한도: -${this.settings.lossCutAmount.toLocaleString()}원, 실손익: ${real.toLocaleString()}원`)
      this.stop()
      this.state.statusMessage = `로스컷 도달! ${real.toLocaleString()}원`
      this.emitStateChange()
    }
  }

  private calculateBetAmount(martinLevel: number): number {
    // 사용자가 설정한 maxMartin 단계를 절대 초과하지 않음
    // martinLevel은 0-indexed이므로 maxMartin-1이 최대 레벨
    const effectiveLevel = Math.min(martinLevel, this.settings.maxMartin - 1)

    // 활성 필터의 per-filter 전략을 적용 (없으면 글로벌 전략)
    const effectiveStrategy = this.resolveActiveFilterStrategy()

    // MartingaleManager에 위임 (Codex 피드백: 배팅 금액 계산 로직 통합)
    return this.martingaleManager.calculateBetAmount(
      effectiveLevel,
      this.settings.baseBetAmount,
      effectiveStrategy,
      this.settings.customBetAmounts
    )
  }

  /**
   * 계산된 배팅 금액을 테이블 한도(+ Tie 별도 한도)로 캡.
   *
   * 우선순위:
   *   1) betType === 'Tie' && settings.tieMaxBetLimit > 0 → tieMaxBetLimit
   *   2) tableMaxLimit (CDP에서 캡처된 경우)
   *   3) 캡 없음 (AutoBettingService가 마지막에 한 번 더 검증)
   *
   * 한도를 모르거나 캡처 안 됐으면 캡 없이 반환한다.
   */
  private applyBetCap(
    roomId: string,
    amount: number,
    betType: BetType,
    martinLevel: number,
    roomName: string,
  ): number {
    // Tie 별도 한도 (Evolution은 CDP에 Tie 한도를 합쳐 보내지 않으므로 사용자 설정으로 보정)
    const tieCap = betType === 'Tie' ? (this.settings.tieMaxBetLimit ?? 0) : 0

    // 테이블 최대 한도
    const adapter = this.casinoAdapter as unknown as {
      getTableConfig?: (id: string) => { tableMaxLimit?: number } | undefined
      hasCapturedConfig?: (id: string) => boolean
    }
    const cfg = adapter.getTableConfig?.(roomId)
    const hasCaptured = adapter.hasCapturedConfig?.(roomId) ?? false
    const tableCap = hasCaptured ? (cfg?.tableMaxLimit ?? 0) : 0

    // 적용할 캡: Tie 캡과 테이블 캡 중 더 작은(=더 엄격한) 값. 둘 다 0이면 캡 없음.
    let effectiveCap = 0
    if (tieCap > 0) effectiveCap = tieCap
    if (tableCap > 0) effectiveCap = effectiveCap > 0 ? Math.min(effectiveCap, tableCap) : tableCap

    if (effectiveCap <= 0 || amount <= effectiveCap) return amount

    console.log(
      `[AutoMode] 💰 베팅 캡 적용: ${roomName} [${betType}] ${amount.toLocaleString()}원 → ${effectiveCap.toLocaleString()}원 (마틴 ${martinLevel + 1}단계)`
    )
    this.feDiag(`BET-CAP room=${roomName} betType=${betType} lv=${martinLevel} raw=${amount} cap=${effectiveCap} tieCap=${tieCap} tableCap=${tableCap}`)
    return effectiveCap
  }

  /**
   * Resolve the effective bet strategy for the currently active pattern filter.
   * Falls back to the global `settings.betStrategy` when no filter is active or
   * the filter has no per-filter override.
   */
  private resolveActiveFilterStrategy() {
    // 🆕 2026-07-08 (사용자 요청 "배팅전략을 커스텀으로 하면 거기에 맞게 배팅돼야 함"):
    // 전역 전략이 '커스텀'(단계별 직접 금액)이면 그게 최우선이다. 커스텀은 사용자가 명시적으로
    // 정한 '돈 계획'이라, 필터별 전략 오버라이드(예: 타이 필터 세부설정이 martingale로 잡혀 있어도)가
    // 이 커스텀 시퀀스를 조용히 무시(→ base×2^단계로 폭주)하면 안 된다.
    if (this.settings.betStrategy === 'custom') return 'custom'
    if (this.currentPatternFilter === 'all') return this.settings.betStrategy
    return PatternBettingService.resolveBetStrategy(
      this.currentPatternFilter as RoomFilterType,
      this.settings.betStrategy
    )
  }

  private resolveRoomProgressionStrategy(roomState?: RoomBettingState): AutoModeSettings['betStrategy'] {
    // 🆕 2026-07-08 (적대적 검증 확정): 커스텀은 사용자가 명시한 '돈 계획'이라 진행중 방에
    // 캡처된 stale martinRecoveryStrategy보다 항상 우선한다. 이 단락이 없으면 아래 `??`가
    // 좌변(예: 첫 배팅에서 굳은 'martingale')에서 단락되어 커스텀 시퀀스를 무시하고
    // base×2^단계로 폭주한다. resolveActiveFilterStrategy 내부의 동일 가드는 바로 이 `??`
    // 때문에 호출조차 되지 않았다 — 실제 배팅금액 경로(getSettingsForActiveFilter)가 부르는
    // 함수는 resolveActiveFilterStrategy가 아니라 이 함수다.
    if (this.settings.betStrategy === 'custom') return 'custom'
    return roomState?.martinRecoveryStrategy ?? this.resolveActiveFilterStrategy()
  }

  // 필터가 Tie 방향만 의미를 갖는지 — Tie 계열 필터는 stale localStorage의
  // betDirection='ai' 등으로 일반 B/P 배팅이 새는 것을 막기 위해 항상 Tie로
  // 강제한다.
  private isTieOnlyFilter(filter: RoomFilterType | 'all'): boolean {
    return (
      filter === 'tie_frequent' ||
      filter === 'tie_drought' ||
      filter === 'no_tie_room' ||
      filter === 'fresh_room' ||
      filter === 'fresh_shoe'
    )
  }

  /**
   * Return a shallow-copied settings object whose `betStrategy` reflects the
   * per-filter override (if any). When no override applies, returns the live
   * settings reference to avoid unnecessary allocation.
   */
  private getSettingsForActiveFilter(roomState?: RoomBettingState) {
    const effective = this.resolveRoomProgressionStrategy(roomState)
    // 🐞 stale tie_only 누수 차단: '전체(all)'는 AI 자동(betDirection 'ai')이라 Tie 강제가
    // 있을 수 없다. Fresh-Shoe 타이 프리셋은 켜질 때 항상 fresh_shoe 필터를 활성화하므로
    // 필터가 'all'이면 프리셋이 활성이 아닌 것 — 그런데도 settings.forceBetDirection이
    // 'tie_only'면, 프리셋 비활성 시 복원이 누락된 stale 상태다(restore snapshot이 메모리에만
    // 있어 앱 재시작 후 applyDisable이 복원을 건너뜀 → forceBetDirection이 'tie_only'에 고착).
    // 이 경우 '전체 AI'인데도 모든 방이 예측을 무시하고 Tie로 새므로, all에서는 auto로 본다.
    const staleTieUnderAll =
      this.currentPatternFilter === 'all' && this.settings.forceBetDirection === 'tie_only'
    const tieOnlyOverride =
      this.isTieOnlyFilter(this.currentPatternFilter) &&
      this.settings.forceBetDirection !== 'tie_only'
    const effectiveForce: 'auto' | 'tie_only' | undefined =
      staleTieUnderAll ? 'auto' : tieOnlyOverride ? 'tie_only' : this.settings.forceBetDirection
    const forceChanged = effectiveForce !== this.settings.forceBetDirection
    if (effective === this.settings.betStrategy && !forceChanged) return this.settings
    return {
      ...this.settings,
      betStrategy: effective,
      forceBetDirection: effectiveForce,
    }
  }

  /**
   * 패턴 기반 예측 생성 (PatternPredictionService에 위임)
   * @param room 방 정보
   * @param remainingSeconds 남은 배팅 시간
   */
  private async getPatternBasedPrediction(
    room: Room,
    remainingSeconds: number,
    filterOverride?: RoomFilterType | 'all',
  ): Promise<Prediction | null> {
    // 방의 예측 상태(연승/연패 stats)를 함께 넘긴다. 디스플레이(AutoModePanel)가 매칭 판정에 쓰는
    // 것과 동일한 MultiRoomPredictionService 상태를 사용해야 연승/연패 필터에서 "보이는 방은
    // 매칭인데 봇은 스킵" 불일치가 사라진다(pattern-streak-1).
    const predictionState = MultiRoomPredictionService.getRoomState(room.id)
    return this.patternPredictionService.getPatternBasedPrediction(
      room,
      remainingSeconds,
      filterOverride ?? this.currentPatternFilter,
      {
        maxMartin: this.settings.maxMartin,
        // per-filter 전략이 있으면 그것을 PatternPredictionService에도 전달
        betStrategy: this.resolveActiveFilterStrategy(),
        minConfidence: undefined, // 서버 동적 최적화 사용
        realBalance: this.realBalance, // 🆕 v3.7.0: 실제 잔액 전달
      },
      predictionState
    )
  }

  // ==================== Subscriptions ====================

  onStateChange(callback: StateChangeCallback): () => void {
    return this.stateManager.subscribe(callback)
  }

  onBetLog(callback: BetLogCallback): () => void {
    return this.betLogManager.subscribe(callback)
  }

  private emitStateChange(): void {
    this.stateManager.emit(this.getState())
  }

  private emitBetLog(event: AutoModeBetLogEvent): void {
    this.betLogManager.emit(event)
  }

  // ==================== Cleanup ====================

  dispose(): void {
    this.settings.enabled = false
    this.stopDiagnosticTimer()
    this.stopContinuousBettingTimer()
    this.cleanupAdapterSubscriptions()
    this.stateManager.clear()
    this.betLogManager.clear()
    this.state.roomStates.clear()
    this.activeBettingRoomIds.clear()
    this.tieAutoCompletedRoomIds.clear()
    this.hasReceivedActiveRoomList = false
    this.currentPatternFilter = 'all'
    CustomStrategyRuntime.resetAll()
    this.lastBettingPhaseByRoom.clear()
    this.lastDecisionKeyByRoom.clear()
    this.bettingInProgress.clear()  // 배팅 진행 락 초기화
    this.bettingInProgressSince.clear()
    // Bug 4 Fix: 필터 전환 타임아웃 정리
    if (this.filterTransitionTimeout) {
      clearTimeout(this.filterTransitionTimeout)
      this.filterTransitionTimeout = null
    }
    this.isFilterTransitioning = false
    this._casinoAdapter = null
    this._multiRoomPredictionPort = null
    this._patternPredictionService = null
    // 세션 통계(활성 + 보관 중인 다른 모드) 해체 — 다음 initialize/updateSettings의 모드 전환이 이전 세션 손익을 물려받지 않게.
    // dispose는 앱 코드에서 부르지 않고 테스트 해체에서만 쓴다(2026-09-05 기준).
    this.state.totalWins = 0
    this.state.totalLosses = 0
    this.state.totalBetAmount = 0
    this.state.cumulativeProfit = 0
    this.state.maxProfit = 0
    this.state.maxLoss = 0
    this.clearInactiveModeStats()
  }
}

export const AutoModeService = new AutoModeServiceImpl()
export default AutoModeService
