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
} from '../../domain/entities'
import { winProfit } from '../../domain/betting/payout'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di'
import { CallbackManager } from '../utils'
import { VirtualBettingService } from './VirtualBettingService'
import { AutoBettingService } from './AutoBettingService'
import { MultiRoomPredictionService } from './MultiRoomPredictionService'
import { PatternBettingService } from './PatternBettingService'

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
  // 🆕 Tie 베팅 전용 최대 한도 (Evolution 테이블은 Tie를 별도로 낮게 제한하지만 CDP 캡처에는
  //   tableMaxLimit 하나만 들어옴). 0 = 사용 안 함 (tableMaxLimit로만 캡).
  tieMaxBetLimit?: number
}

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
  /** First bet in the current martingale chain. Kept after a loss so recovery bets use the same direction. */
  martinRecoveryPrediction: Prediction | null
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
  tieAutoCompletedRoomIds: string[]
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

    // globalMaxConsecutiveLosses는 maxMartin과 항상 동일하게 유지 (하위 호환)
    this.settings.globalMaxConsecutiveLosses = this.settings.maxMartin

    // MartingaleManager 내부 cap을 사용자 설정과 동기화 — 그렇지 않으면 recordLoss가
    // 내부 기본값(5)에서 막혀 100단 설정해도 level이 5에서 더 안 올라간다.
    this.martingaleManager.setMaxLevel(this.settings.maxMartin)

    console.log('[AutoMode] Settings loaded, enabled forced to false for safety, maxMartin synced:', this.settings.maxMartin)
  }

  // tieAutoCompletedRoomIds는 derived (this.tieAutoCompletedRooms에서 매번 스냅샷),
  // 그래서 state에 보관하지 않고 getState에서 합쳐서 노출한다.
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

  private stateManager = new CallbackManager<StateChangeCallback>('AutoMode')
  private betLogManager = new CallbackManager<BetLogCallback>('AutoMode')
  private adapterUnsubscribers: Array<() => void> = []
  private lastDecisionKeyByRoom: Map<string, string> = new Map()

  // 🆕 v3.7.0: 실제 사용자 잔액 추적
  private realBalance: number | null = null

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
    const activeRoomIds = new Set<string>()
    this.state.roomStates.forEach(state => {
      if (state.waitingForResult) activeRoomIds.add(state.roomId)
      if (state.martinLevel > 0) activeRoomIds.add(state.roomId)
    })
    this.bettingInProgress.forEach(roomId => activeRoomIds.add(roomId))
    return activeRoomIds.size
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
    const unsubBalance = this.casinoAdapter.onBalanceUpdate?.((balance) => {
      this.realBalance = balance
      console.log(`[AutoMode] 💰 Balance updated: ${balance?.toLocaleString()}원`)
    })
    if (unsubBalance) this.adapterUnsubscribers.push(unsubBalance)

    // 🛡️ 초기화 시 AutoBettingService 가상모드 동기화
    // localStorage에서 로드한 설정과 동기화 (start() 전에도 일관성 유지)
    AutoBettingService.setVirtualMode(this.settings.isVirtualMode)
    console.log(`[AutoMode] 🛡️ AutoBettingService virtual mode synced on init: ${this.settings.isVirtualMode}`)

    console.log('[AutoMode] ✅ Service initialized - subscribed to betting phase and game result events')
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
      tieAutoCompletedRoomIds: Array.from(this.tieAutoCompletedRooms),
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
    this.state.statusMessage = '정지됨'
    this.state.startTime = null // 정지 시 초기화

    // 🆕 v2.24: 타이머들 정지
    this.stopDiagnosticTimer()
    this.stopContinuousBettingTimer()

    // 🆕 v2.2: 서버에 autoMode=false 전달하도록 설정
    MultiRoomPredictionService.setAutoMode(false)

    // 🛡️ AutoBettingService 가상모드 해제 - 정지 시 다른 서비스가 배팅 가능하도록
    AutoBettingService.setVirtualMode(false)

    // 중지 시 마틴 리셋 옵션이 활성화되어 있으면 모든 방의 마틴 레벨 초기화
    if (this.settings.resetMartinOnStop) {
      // ✅ MartingaleManager를 통해 모든 레벨 리셋 (Single Source of Truth)
      this.martingaleManager.resetAllLevels()
      this.state.roomStates.forEach((rs, roomId) => {
        this.syncMartinLevelFromManager(roomId, rs)
        rs.waitingForResult = false
        rs.lastPrediction = null
        rs.martinRecoveryPrediction = null
      })
      console.log('[AutoMode] Stopped - 마틴 레벨 리셋됨')
    } else {
      console.log('[AutoMode] Stopped - 마틴 레벨 유지됨')
    }

    // 긴급 정지 시 진행 중인 실배팅이 있으면 즉시 취소 시도
    this.cancelPendingRealBet()
    this.emitStateChange()
  }

  // 🆕 v2.24: 진단 타이머 시작 (30초마다 상태 요약 출력)
  private startDiagnosticTimer(): void {
    this.stopDiagnosticTimer()  // 기존 타이머가 있으면 먼저 정리
    this.diagnosticTimerId = setInterval(() => {
      this.logDiagnosticStatus()
    }, 30000)  // 30초마다
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
    let inferredCount = 0
    this.state.roomStates.forEach((roomState, roomId) => {
      if (!roomState.waitingForResult) return

      const room = this.casinoAdapter.getRoom(roomId)
      if (!room) return

      const inferredWinner = this.getPendingBetResultWinnerFromHistory(room, roomState)
      if (inferredWinner) {
        console.log(`[AutoMode] 🔄 타이머 결과 추론 성공 - ${room.koreanName}: ${inferredWinner}`)
        this.handleGameResult(roomId, inferredWinner)
        inferredCount++
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

    let waitingForResultCount = 0
    let readyToBetCount = 0
    const waitingRooms: string[] = []

    this.activeBettingRoomIds.forEach(roomId => {
      const roomState = this.state.roomStates.get(roomId)
      const room = this.casinoAdapter.getRoom(roomId)
      if (roomState?.waitingForResult) {
        waitingForResultCount++
        waitingRooms.push(room?.koreanName || roomId)
      } else if (this.lastBettingPhaseByRoom.has(roomId)) {
        readyToBetCount++
      }
    })

    const currentBetCount = this.getActiveBettingCount()

    const maxBets = this.settings.maxConcurrentBets
    const maxDisplay = maxBets > 0 ? maxBets : '∞'

    console.log(`[AutoMode] 📊 상태진단 ===`)
    console.log(`  - 대상 방: ${activeRoomCount}개 (Top6+마틴)`)
    console.log(`  - 배팅 페이즈 중: ${bettingPhaseCount}개`)
    console.log(`  - 결과 대기 중: ${waitingForResultCount}개 ${waitingRooms.length > 0 ? `[${waitingRooms.slice(0, 3).join(', ')}${waitingRooms.length > 3 ? '...' : ''}]` : ''}`)
    console.log(`  - 배팅 진행 락: ${inProgressCount}개`)
    console.log(`  - 동시배팅 슬롯: ${currentBetCount}/${maxDisplay}`)
    console.log(`  - 배팅 가능: ${readyToBetCount}개`)
    console.log(`[AutoMode] ===============`)
  }

  updateSettings(newSettings: Partial<AutoModeSettings>): void {
    const prevVirtualMode = this.settings.isVirtualMode

    this.settings = { ...this.settings, ...newSettings }

    // ✅ VirtualBettingService와 설정 동기화
    if (newSettings.baseBetAmount !== undefined || newSettings.maxMartin !== undefined) {
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
    if (newSettings.maxMartin !== undefined) {
      this.settings.globalMaxConsecutiveLosses = newSettings.maxMartin
      // MartingaleManager 내부 cap도 같이 갱신 — 안 그러면 recordLoss가
      // 내부 기본값에서 막혀 사용자가 설정한 단계까지 못 올라간다.
      this.martingaleManager.setMaxLevel(newSettings.maxMartin)
    }

    // 🛡️ AutoBettingService 가상모드 동기화 - 실제 소켓 전송 차단
    // Bug Fix: 항상 현재 설정값으로 동기화 (undefined 체크 제거)
    // 이전에는 newSettings.isVirtualMode가 undefined면 동기화가 안 되어 불일치 발생 가능
    const currentVirtualMode = this.settings.isVirtualMode
    if (AutoBettingService.isVirtualMode() !== currentVirtualMode) {
      AutoBettingService.setVirtualMode(currentVirtualMode)
      console.log(`[AutoMode] 🛡️ AutoBettingService virtual mode synced: ${currentVirtualMode}`)
    }

    // Bug Fix: 모드 전환 시 pending 배팅 정리
    if (newSettings.isVirtualMode !== undefined && prevVirtualMode !== newSettings.isVirtualMode) {
      this.cleanupPendingBetsForModeChange(prevVirtualMode, newSettings.isVirtualMode)
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
          roomState.lastBetHistoryLength = null
          roomState.wasVirtualBet = undefined
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

  resetStats(): void {
    // 1. 글로벌 통계 리셋
    this.state.totalWins = 0
    this.state.totalLosses = 0
    this.state.totalBetAmount = 0
    this.state.cumulativeProfit = 0
    this.state.maxProfit = 0
    this.state.maxLoss = 0

    // ✅ MartingaleManager 전체 리셋 (Single Source of Truth)
    this.martingaleManager.resetAllLevels()

    // 2. 방별 통계 및 상태 완전 리셋
    this.state.roomStates.forEach((rs, roomId) => {
      // ✅ MartingaleManager에서 동기화 (직접 수정 제거)
      this.syncMartinLevelFromManager(roomId, rs)
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
      rs.lastBetAmount = 0
      rs.lastBetTime = null
      rs.lastBetHistoryLength = null
      rs.lastResultTime = null
      rs.wasVirtualBet = undefined

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

  /** 진행 중인 모든 실배팅(Undo) 취소 시도 (멀티룸 지원) */
  private cancelPendingRealBet(): void {
    const pendingCount = AutoBettingService.getPendingBetCount()
    if (pendingCount === 0) return

    console.log(`[AutoMode] 🛑 긴급정지: ${pendingCount}개의 pending bet 취소 시도...`)

    AutoBettingService.cancelAllBets()
      .then((res) => {
        if (res.success) {
          console.log(`[AutoMode] ✅ 긴급정지: 모든 pending bet 취소 완료 (${res.cancelled}개)`)
        } else {
          console.warn(`[AutoMode] ⚠️ 긴급정지: 일부 취소 실패 (성공: ${res.cancelled}, 실패: ${res.failed})`)
        }
      })
      .catch((e) => {
        console.warn('[AutoMode] ⚠️ 긴급정지: 취소 중 오류', e)
      })
  }

  // ==================== Room Management ====================

  private getOrCreateRoomState(roomId: string, roomName: string): RoomBettingState {
    let roomState = this.state.roomStates.get(roomId)
    if (!roomState) {
      // MartingaleManager에서 기존 상태 가져오기 (있으면)
      const martinState = this.martingaleManager.getState(roomId)

      roomState = {
        roomId,
        roomName,
        martinLevel: martinState?.level ?? 0,
        consecutiveLosses: martinState?.consecutiveLosses ?? 0,
        consecutiveWins: martinState?.consecutiveWins ?? 0,
        totalBets: 0,
        totalWins: 0,
        totalLosses: 0,
        totalProfit: 0,
        lastPrediction: null,
        martinRecoveryPrediction: null,
        lastBetAmount: 0,
        waitingForResult: false,
        lastBetTime: null,
        lastBetHistoryLength: null,
        lastResultTime: null,
        resultInferenceRetries: 0,
        lastInferenceRetryTime: null,
      }
      this.state.roomStates.set(roomId, roomState)
    }
    return roomState
  }

  /**
   * MartingaleManager의 상태를 RoomBettingState에 동기화
   * 마틴 레벨 변경 시 항상 MartingaleManager를 통해 변경 후 이 메서드 호출
   */
  private syncMartinLevelFromManager(roomId: string, roomState: RoomBettingState): void {
    const martinState = this.martingaleManager.getState(roomId)
    if (martinState) {
      roomState.martinLevel = martinState.level
      roomState.consecutiveLosses = martinState.consecutiveLosses
      roomState.consecutiveWins = martinState.consecutiveWins
    }
  }

  // 외부에서 설정한 배팅 가능 방 ID 목록 (패턴 필터 적용 결과)
  private activeBettingRoomIds: Set<string> = new Set()
  private hasReceivedActiveRoomList = false

  // 현재 선택된 패턴 필터 (예: 'long_streak', 'short_streak', 'all')
  private currentPatternFilter: RoomFilterType | 'all' = 'all'
  private lastBettingPhaseByRoom: Map<string, { startedAt: number; initialSeconds: number }> = new Map()

  // 방별 배팅 진행 중 락 (동시 배팅 방지)
  private bettingInProgress: Set<string> = new Set()

  // Bug 4 Fix: 필터 전환 락 (race condition 방지)
  private isFilterTransitioning: boolean = false
  private filterTransitionTimeout: ReturnType<typeof setTimeout> | null = null
  private filterTransitionStartTime: number = 0  // Safety: track when transition started
  private readonly FILTER_TRANSITION_DEBOUNCE_MS = 150
  private readonly FILTER_TRANSITION_MAX_MS = 1000  // Safety: max transition lock duration

  // 🆕 v2.24: 진단 타이머 (30초마다 상태 요약 출력)
  private diagnosticTimerId: ReturnType<typeof setInterval> | null = null

  // 🆕 v2.24: 연속 배팅 타이머 (2초마다 배팅 가능한 방 체크)
  private continuousBettingTimerId: ReturnType<typeof setInterval> | null = null

  // 패턴 필터링된 방 목록 설정 (AutoModePanel에서 호출)
  setActiveBettingRooms(roomIds: string[], patternFilter?: RoomFilterType | 'all'): void {
    const requestedFilter = patternFilter ?? this.currentPatternFilter
    const lockedMartinRoomIds = this.getLockedMartinRoomIds(requestedFilter)
    const mergedRoomIds = Array.from(new Set([...lockedMartinRoomIds, ...roomIds]))
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

    // 🆕 v2.23: 추천필터 방은 roomConfigs 체크 우회
    // 추천필터(activeBettingRoomIds)에 포함된 방은 무조건 배팅 허용
    if (this.activeBettingRoomIds.size > 0 && this.activeBettingRoomIds.has(roomId)) {
      return true
    }

    // 1) 사용자가 방을 선택했다면 그 방만 허용
    const configuredRoomIds = new Set(
      (this.settings.roomConfigs || [])
        .filter(c => c.enabled)
        .map(c => c.roomId)
    )
    if (configuredRoomIds.size > 0 && !configuredRoomIds.has(roomId)) {
      return false
    }

    // 2) AutoModePanel에서 패턴 필터 결과(실시간) 목록이 왔다면 그 목록만 허용
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

  // tie_frequent 프리셋의 트리거(예: 0-0)는 슈 처음 N판만 보므로, 한 번
  // 적중하거나 마틴 한도에 도달해도 그 룸의 트리거 자체는 그대로 유지된다.
  // 그래서 별도로 "이 슈에서는 끝난 방" 집합을 두고 같은 슈 안에서는
  // 재선택하지 못하도록 한다. 슈가 바뀌면 자동으로 초기화 (onShoeChange).
  private tieAutoCompletedRooms: Set<string> = new Set()

  private getLockedMartinRoomIds(_filter: RoomFilterType | 'all' = this.currentPatternFilter): string[] {
    const lockedRoomIds: string[] = []
    for (const [roomId, state] of this.state.roomStates) {
      if (state.waitingForResult || state.martinLevel > 0) {
        lockedRoomIds.push(roomId)
      }
    }

    return lockedRoomIds
  }

  private getPendingMartinRoomIds(excludeRoomId?: string): string[] {
    const pendingRoomIds: string[] = []
    for (const [roomId, state] of this.state.roomStates) {
      if (roomId === excludeRoomId) continue
      if (state.martinLevel > 0 && !state.waitingForResult && !this.bettingInProgress.has(roomId)) {
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

  private isTieAutoMode(): boolean {
    return this.currentPatternFilter === 'tie_frequent'
  }

  // 한 방의 시퀀스가 끝났는지 여부 (적중 or 마틴 한도 도달).
  // tie_frequent 프리셋일 때만 의미가 있고, 같은 슈 안에서는 재진입 금지.
  private isTieAutoCompleted(roomId: string): boolean {
    if (this.currentPatternFilter !== 'tie_frequent') return false
    return this.tieAutoCompletedRooms.has(roomId)
  }

  // ==================== Event Handlers ====================

  private async onBettingPhase(event: BettingPhaseEvent): Promise<void> {
    const { roomId, phase, remainingSeconds } = event
    const roomForDebug = this.casinoAdapter.getRoom(roomId)
    const roomNameForDebug = roomForDebug?.koreanName || roomId

    // ✅ 오토 OFF 상태에서도 "현재 배팅 페이즈" 스냅샷을 저장해,
    // ON/필터 변경을 배팅 창 중간에 눌러도 즉시 배팅 가능하도록 한다.
    if (phase === 'start' && remainingSeconds > 0) {
      this.lastBettingPhaseByRoom.set(roomId, { startedAt: Date.now(), initialSeconds: remainingSeconds })
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
      const isInMartinOrWaiting = existingState && (existingState.martinLevel > 0 || existingState.waitingForResult)
      if (!isInMartinOrWaiting) {
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
    // 즉시 락 설정 (race condition 방지)
    this.bettingInProgress.add(roomId)

    // 이후 모든 코드는 try-finally로 감싸서 어떤 경로로든 락이 해제되도록 함
    try {
      // ========== Bug Fix: waitingForResult 타임아웃 체크를 isRoomEnabled보다 먼저 실행 ==========
      // 방이 비활성화되어도 stuck 상태를 해제할 수 있도록 함
      const room = this.casinoAdapter.getRoom(roomId)
      if (!room) return

      const roomState = this.getOrCreateRoomState(roomId, room.koreanName || room.name)
      const isInMartinRecovery = roomState.martinLevel > 0
      const minRequiredSeconds = isInMartinRecovery ? 2 : 3

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
          roomState.waitingForResult = false
          roomState.lastPrediction = null
          roomState.martinRecoveryPrediction = null
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
        const freshRoom = this.casinoAdapter.getRoom(roomId)
        const targetRoom = freshRoom || room

        const inferredWinner = this.getPendingBetResultWinnerFromHistory(targetRoom, roomState)
        if (inferredWinner) {
          console.log(`[AutoMode] 🔄 결과 확인됨 (retry ${roomState.resultInferenceRetries}) - ${roomNameForDebug}: ${inferredWinner}`)
          roomState.resultInferenceRetries = 0
          roomState.lastInferenceRetryTime = null
          this.handleGameResult(roomId, inferredWinner)
        } else {
          // 🆕 v2.25: 타임아웃 단축 (45초 → 15초) - 더 빠른 슬롯 회수
          const EXTENDED_TIMEOUT_MS = 15000
          const MAX_RETRIES = 5

          if (waitingTime > EXTENDED_TIMEOUT_MS || roomState.resultInferenceRetries >= MAX_RETRIES) {
            console.warn(`[AutoMode] ⚠️ 결과 대기 타임아웃 (${Math.round(waitingTime / 1000)}초, ${roomState.resultInferenceRetries}회 재시도) - ${roomNameForDebug}, 강제 리셋`)
            roomState.waitingForResult = false
            roomState.lastPrediction = null
            roomState.martinRecoveryPrediction = null
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
      const cutConditions = this.bettingDecisionService.checkCutConditions(
        this.state.cumulativeProfit,
        this.settings
      )

      if (cutConditions.winCutReached) {
        console.log(`[AutoMode] 윈컷 도달! 목표: ${this.settings.winCutAmount}, 현재: ${this.state.cumulativeProfit}`)
        this.stop()
        this.state.statusMessage = `윈컷 도달 (+${this.state.cumulativeProfit.toLocaleString()}원)`
        this.emitStateChange()
        return
      }

      if (cutConditions.lossCutReached) {
        console.log(`[AutoMode] 로스컷 도달! 한도: -${this.settings.lossCutAmount}, 현재: ${this.state.cumulativeProfit}`)
        this.stop()
        this.state.statusMessage = `로스컷 도달 (${this.state.cumulativeProfit.toLocaleString()}원)`
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
      const isCurrentlyInMartin = roomState.martinLevel > 0

      if (!isCurrentlyInMartin && maxBets > 0 && currentBetCount > maxBets) {
        console.log(`[AutoMode] 🚫 동시배팅 상한 초과: ${room.koreanName} (점유=${currentBetCount}/${maxBets})`)
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
        const storedRecoveryPrediction = isInMartinRecovery ? roomState.martinRecoveryPrediction : null
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
        } else if (isInMartinRecovery && this.isTieOnlyFilter(this.currentPatternFilter)) {
          // 마틴 회복 중 + 타이 계열 필터: 패턴 매칭 우회하여 즉시 T 배팅 유지
          console.log(`[AutoMode] ${room.koreanName} - 마틴 회복 중 타이 필터 강제 T 배팅`)
        } else {
          console.log(`[AutoMode] getPatternBasedPrediction 호출: ${room.koreanName}`)
        }

        const prediction = recoveryPrediction
          ?? (isInMartinRecovery && this.isTieOnlyFilter(this.currentPatternFilter)
            ? { roomId, prediction: 'T' as const, confidence: 90, reasoning: '마틴 회복 (타이 유지)', isSkip: false, timestamp: Date.now() }
            : await this.getPatternBasedPrediction(room, remainingSeconds))

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

        // 타이 자동: 이 슈에서 이미 한 번 끝난 방은 재진입 금지
        if (!isInMartinRecovery && this.isTieAutoCompleted(roomId)) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'tie_auto_room_done',
            level: 'info',
            status: 'pass',
            message: '타이 자동: 이 슈에서 이미 종료된 방',
          })
          return
        }

        // BettingDecisionService.shouldBet()에 위임하여 배팅 결정
        // RoomBettingState → RoomContext 변환
        // 현재 활성 필터에 per-filter 전략이 있으면 settings의 전략을 그것으로 교체해서 전달
        const roomContext: RoomContext = fromRoomBettingState(roomState)
        const effectiveSettings = this.getSettingsForActiveFilter()
        const betDecision = this.bettingDecisionService.shouldBet(
          roomId,
          prediction,
          effectiveSettings,
          roomContext
        )

        if (!betDecision.shouldBet) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'decision_skip',
            level: 'info',
            status: 'pass',
            message: betDecision.skipReason || prediction.reasoning || '스킵',
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

        roomState.lastPrediction = actualPrediction
        this.state.lastEventTime = Date.now()

        // 바로 배팅 실행. shouldBet()이 확정한 금액/방향을 그대로 사용한다.
        await this.placeBet(roomId, room, actualPrediction, roomState, betDecision)

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
    decision?: BetDecision
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
      roomState.lastBetTime = Date.now()
      roomState.lastBetHistoryLength = room.history.length
      roomState.martinRecoveryPrediction = prediction
      // Bug Fix: 배팅 시점의 모드 저장 (결과 처리 시 모드 불일치 방지)
      roomState.wasVirtualBet = this.settings.isVirtualMode

      const maxBetsLog = this.settings.maxConcurrentBets > 0 ? this.settings.maxConcurrentBets : '∞'
      console.log(`[AutoMode] 🎰 배팅 시작: ${room.koreanName} (활성=${this.getActiveBettingCount()}/${maxBetsLog}개)`)

      if (this.settings.isVirtualMode) {
        // 🔥 FIX: VirtualBettingService 잔액 동기화 (두 시스템 간 잔액 불일치 해결)
        // AutoModeService가 계산한 가용 잔액으로 VirtualBettingService를 동기화
        const syncBalance = VirtualBettingService.getSettings().initialBalance + this.state.cumulativeProfit
        VirtualBettingService.syncGlobalBalance(syncBalance)

        // 가상 배팅 - AutoModeService 설정 기반 금액 사용 (실제 배팅과 동일한 동작)
        console.log(`[AutoMode] 가상 배팅 실행: ${room.koreanName} -> ${betCode} (${betAmount}원)`)
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

        // 🛡️ 실제 배팅 직전 동기화 재확인 (최종 안전장치)
        // AutoBettingService의 virtualModeEnabled가 true면 소켓 전송이 차단되므로
        // 실제 배팅 시점에 한 번 더 동기화하여 불일치 방지
        if (AutoBettingService.isVirtualMode() !== this.settings.isVirtualMode) {
          console.warn(`[AutoMode] ⚠️ VirtualMode 불일치 감지! AutoBettingService: ${AutoBettingService.isVirtualMode()}, settings: ${this.settings.isVirtualMode}`)
          AutoBettingService.setVirtualMode(this.settings.isVirtualMode)
          console.log(`[AutoMode] 🛡️ AutoBettingService virtual mode 재동기화: ${this.settings.isVirtualMode}`)
        }

        const result = await AutoBettingService.placeBet(
          roomId,
          betType,
          betAmount,
          undefined,
          true  // isRealBetting: 실제 메시지 전송
        )
        if (!result.success) {
          console.error(`[AutoMode] Real betting failed: ${result.error}`)
          roomState.waitingForResult = false
          // 🆕 v2.23: 슬롯 추적은 waitingForResult + bettingInProgress 기반 (Single Source of Truth)
          // waitingForResult = false 설정으로 자동 슬롯 반환됨
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
            reasoning: result.error || '실제 배팅 실패',
            timestamp: Date.now(),
          })
          console.log(`[AutoMode] 실제배팅 실패, 슬롯 반환`)
          return
        }
        console.log(`[AutoMode] 실제 배팅 성공!`)
      }

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
      })

      const prevTotal = this.state.totalBetAmount
      this.state.totalBetAmount += betAmount
      console.log(`[AutoMode] 💵 totalBetAmount: ${prevTotal.toLocaleString()} → ${this.state.totalBetAmount.toLocaleString()}원 (+${betAmount.toLocaleString()}) | room: ${room.koreanName}`)
      this.emitStateChange()
    } finally {
      // 동시 배팅 방지: 락 해제 (emit 이후에 해제해서 중복 진입 차단)
      this.bettingInProgress.delete(roomId)
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

    const targetIds = this.prioritizeMartinRoomIds((() => {
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
      return Array.from(this.casinoAdapter.getRooms().keys())
    })(), options?.requestedFirst === true)

    if (targetIds.length === 0) return

    let triggeredCount = 0
    targetIds.forEach((roomId) => {
      try {
        if (!this.isRoomEnabled(roomId)) return

        // 🆕 v2.24: 실시간 방 데이터에서 배팅 가능 여부 확인 (스냅샷보다 우선)
        const room = this.casinoAdapter.getRoom(roomId)
        if (!room) return

        let remainingSeconds = 0

        // 방법 1: 캐시된 스냅샷 사용
        const phaseSnapshot = this.lastBettingPhaseByRoom.get(roomId)
        if (phaseSnapshot) {
          const elapsed = Math.floor((Date.now() - phaseSnapshot.startedAt) / 1000)
          remainingSeconds = Math.max(0, phaseSnapshot.initialSeconds - elapsed)
          if (remainingSeconds <= 0) {
            this.lastBettingPhaseByRoom.delete(roomId)
          }
        }

        // 방법 2: 스냅샷 없거나 만료됐으면 실시간 데이터 사용
        if (remainingSeconds <= 0) {
          remainingSeconds = room.remainingSeconds ?? 0
          // 🆕 phase 체크 완화: remainingSeconds > 0이면 배팅 가능으로 간주
          if (remainingSeconds <= 0) return
        }

        // 이미 배팅 진행 중이면 스킵 (중복 배팅 방지)
        if (this.bettingInProgress.has(roomId)) return

        const roomState = this.state.roomStates.get(roomId)
        if (roomState?.waitingForResult) return

        const minRequiredSeconds = this.isTieAutoMode() && (roomState?.martinLevel ?? 0) > 0 ? 2 : 3
        if (remainingSeconds < minRequiredSeconds) return

        // 기존 이벤트 핸들러 재사용 (동일한 안전장치/로직 적용)
        void this.onBettingPhase({ roomId, remainingSeconds, phase: 'start' })
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
  private getPendingBetResultWinnerFromHistory(room: Room, roomState: RoomBettingState): Winner | null {
    const baseLength = roomState.lastBetHistoryLength
    // ✅ Bug Fix: baseLength 타입 및 값 방어
    if (typeof baseLength !== 'number' || baseLength < 0) return null

    const currentLength = room.history.length
    if (currentLength <= baseLength) return null

    if (baseLength === 0 && currentLength > 1) {
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

  private handleGameResult(roomId: string, winnerFromEvent: Winner, eventPlayerScore?: number, eventBankerScore?: number): void {
    const roomState = this.state.roomStates.get(roomId)
    const room = this.casinoAdapter.getRoom(roomId)
    const roomName = room?.koreanName || roomState?.roomName || roomId

    console.log(`[AutoMode] handleGameResult - room: ${roomName}, winner: ${winnerFromEvent}, waitingForResult: ${roomState?.waitingForResult}, lastPrediction: ${roomState?.lastPrediction?.prediction}`)

    // 🆕 v2.23: 슬롯 추적은 waitingForResult 기반 Single Source of Truth
    // 결과 처리 후 waitingForResult = false로 설정되어 자동으로 슬롯이 반환됨

    if (!roomState || !roomState.waitingForResult || !roomState.lastPrediction) {
      console.log(`[AutoMode] 결과 무시 - waitingForResult: ${roomState?.waitingForResult}, hasLastPrediction: ${!!roomState?.lastPrediction}`)
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
        // ✅ FIX: stale이면 강제로 pending 해제 (VirtualBettingService도 환불 처리)
        if (isStale) {
          console.log(`[AutoMode] ⚠️ Stale pending 강제 해제 (${Math.floor(pendingDuration / 1000)}s) - ${roomName}`)
          if (roomState.wasVirtualBet) {
            VirtualBettingService.cancelPendingBet(roomId)
          }
          roomState.waitingForResult = false
          roomState.lastPrediction = null
          roomState.martinRecoveryPrediction = null
          roomState.lastBetHistoryLength = null
          roomState.wasVirtualBet = undefined
          this.emitStateChange()
        } else {
          console.log(`[AutoMode] 결과 무시 - 히스토리 증가 없음 (betHistory=${roomState.lastBetHistoryLength}, currentHistory=${room.history.length})`)
        }
        return
      }
    }

    const inferredWinner = room ? this.getPendingBetResultWinnerFromHistory(room, roomState) : null
    const winner = inferredWinner || winnerFromEvent

    if (inferredWinner && inferredWinner !== winnerFromEvent) {
      console.warn(`[AutoMode] ⚠️ GameResult winner mismatch - event=${winnerFromEvent}, inferred=${inferredWinner}, using inferred`)
    }

    const predResult = roomState.lastPrediction.prediction
    if (!predResult) {
      console.warn(`[AutoMode] 결과 처리 불가 - lastPrediction.prediction 없음 (${roomName})`)
      roomState.waitingForResult = false
      roomState.lastPrediction = null
      roomState.martinRecoveryPrediction = null
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

    // 타이 처리 (push) - 손익/마틴 변화 없음, 환불 처리
    // 단, predResult가 'T'인 경우는 Tie 배팅이 적중한 경우이므로 일반 승리 처리(아래로) 진행
    if (winner === 'T' && predResult !== 'T') {
      if (wasVirtualBet) {
        VirtualBettingService.resolveBet(roomId, roomName, predResult, 'T')
        // ✅ 결과 처리 후 잔액 동기화 (Single Source of Truth: cumulativeProfit)
        const syncBalance = VirtualBettingService.getSettings().initialBalance + this.state.cumulativeProfit
        VirtualBettingService.syncGlobalBalance(syncBalance)
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
      }
      roomState.lastBetHistoryLength = null
      roomState.wasVirtualBet = undefined  // Bug Fix: 모드 정보 초기화
      roomState.lastResultTime = Date.now()
      this.state.lastEventTime = Date.now()

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
      })

      this.emitStateChange()

      // 🆕 v2.24: 타이 결과 후에도 즉시 다른 방 배팅 시도
      if (this.settings.enabled) {
        if (roomState.martinLevel > 0) {
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

    if (won) {
      // ========== 승리 처리 ==========
      roomState.totalWins++
      this.state.totalWins++

      // ✅ MartingaleManager를 Single Source of Truth로 사용
      // recordWin은 level=0, consecutiveWins++, consecutiveLosses=0 처리
      this.martingaleManager.recordWin(roomId)
      this.syncMartinLevelFromManager(roomId, roomState)
      roomState.martinRecoveryPrediction = null

      // 타이 자동: 적중한 방은 이 슈에서는 끝 → 다음 매칭 방으로 이동
      if (this.currentPatternFilter === 'tie_frequent') {
        this.tieAutoCompletedRooms.add(roomId)
      }

      console.log(`[AutoMode] ${roomName} - 승리! 마틴 리셋, 손익: +${profit.toLocaleString()}원`)
    } else {
      // ========== 패배 처리 ==========
      roomState.totalLosses++
      this.state.totalLosses++

      // 마틴 레벨 증가 (다음 배팅용)
      // martinLevel은 0-indexed: 0=1단계, 1=2단계, 2=3단계
      // maxMartin=3 설정 시:
      //   - martinLevel=0(1단계) 패배 → martinLevel=1(2단계)
      //   - martinLevel=1(2단계) 패배 → martinLevel=2(3단계)
      //   - martinLevel=2(3단계) 패배 → 같은 최대 금액으로 계속 진행
      const maxMartin = this.settings.maxMartin
      const currentLevel = this.martingaleManager.getLevel(roomId)

      if (currentLevel >= maxMartin - 1) {
        // 최대 단계에서 패배 → 최대 금액 유지
        const previousMartin = currentLevel

        // 한 번 진입한 마틴은 승리 전까지 같은 방/같은 방향으로 계속 간다.
        // 최대 단계에서는 금액만 cap으로 유지하고, 방 종료/리셋은 하지 않는다.
        this.martingaleManager.recordLoss(roomId)
        this.martingaleManager.decrementLevel(roomId)
        this.syncMartinLevelFromManager(roomId, roomState)
        console.log(`[AutoMode] ${roomName} - 패배! 마틴 ${previousMartin + 1}/${maxMartin}단계 (최대 유지), 승리까지 같은 방향으로 계속 진행, 손익: ${profit.toLocaleString()}원`)
      } else {
        // 최대 단계 미만에서 패배 → 레벨 증가
        // ✅ MartingaleManager를 Single Source of Truth로 사용
        // recordLoss는 level++, consecutiveLosses++, consecutiveWins=0 처리
        this.martingaleManager.recordLoss(roomId)
        this.syncMartinLevelFromManager(roomId, roomState)
        console.log(`[AutoMode] ${roomName} - 패배! 마틴 ${roomState.martinLevel + 1}/${maxMartin}단계, 손익: ${profit.toLocaleString()}원`)
      }
    }

    // profit은 이미 반올림된 정수이므로 다시 반올림하지 않음 (누적 오차 방지)
    this.state.cumulativeProfit += profit

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
      // ✅ 결과 처리 후 잔액 동기화 (Single Source of Truth: cumulativeProfit)
      // cumulativeProfit이 이미 업데이트된 후이므로 정확한 잔액으로 동기화됨
      const syncBalance = VirtualBettingService.getSettings().initialBalance + this.state.cumulativeProfit
      VirtualBettingService.syncGlobalBalance(syncBalance)
    } else {
      // Bug Fix: 실제 배팅이었으면 AutoBettingService 상태 정리
      AutoBettingService.onGameResult(roomId)
    }
    // 실제 모드: 잔액은 Evolution WebSocket에서 자동 업데이트됨
    // 수동으로 setBalance 호출하지 않음 (동기화 문제 방지)

    roomState.waitingForResult = false
    roomState.lastPrediction = null
    roomState.lastBetHistoryLength = null
    roomState.wasVirtualBet = undefined  // Bug Fix: 모드 정보 초기화

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
    })

    // ========== 결과 후 윈컷/로스컷 체크 ==========
    // 윈컷 도달 시 자동 정지
    if (this.settings.winCutAmount > 0 && this.state.cumulativeProfit >= this.settings.winCutAmount) {
      console.log(`[AutoMode] 🎉 윈컷 도달! 목표: ${this.settings.winCutAmount.toLocaleString()}원, 달성: ${this.state.cumulativeProfit.toLocaleString()}원`)
      this.stop()
      this.state.statusMessage = `윈컷 달성! +${this.state.cumulativeProfit.toLocaleString()}원`
    }

    // 로스컷 도달 시 자동 정지
    if (this.settings.lossCutAmount > 0 && this.state.cumulativeProfit <= -this.settings.lossCutAmount) {
      console.log(`[AutoMode] ⛔ 로스컷 도달! 한도: -${this.settings.lossCutAmount.toLocaleString()}원, 현재: ${this.state.cumulativeProfit.toLocaleString()}원`)
      this.stop()
      this.state.statusMessage = `로스컷 도달! ${this.state.cumulativeProfit.toLocaleString()}원`
    }

    this.emitStateChange()

    // 🆕 v2.24: 결과 처리 후 즉시 다른 방 배팅 시도 (슬롯이 비었으므로)
    // 윈컷/로스컷으로 정지되지 않았으면 실행
    if (this.settings.enabled) {
      if (!won && roomState.martinLevel > 0) {
        this.tryBetOnCurrentBettingWindows([roomId], { requestedFirst: true })
      }
      this.tryBetOnCurrentBettingWindows()
    }
  }

  private onGameResult(event: GameResultEvent): void {
    const { roomId, winner, playerScore, bankerScore } = event
    this.handleGameResult(roomId, winner, playerScore, bankerScore)
  }

  private onShoeChange(roomId: string): void {
    // 새 슈 시작 → 타이 자동의 "이 슈에서 끝난 방" 마킹 해제
    this.tieAutoCompletedRooms.delete(roomId)

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
      this.syncMartinLevelFromManager(roomId, roomState)
      roomState.waitingForResult = false
      roomState.lastPrediction = null
      roomState.martinRecoveryPrediction = null
      roomState.lastBetHistoryLength = null
      if (this.settings.isVirtualMode) {
        VirtualBettingService.cancelPendingBet(roomId)
      }
      console.log(`[AutoMode] Shoe change for ${roomState.roomName}, resetting state`)
    }
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
    return effectiveCap
  }

  /**
   * Resolve the effective bet strategy for the currently active pattern filter.
   * Falls back to the global `settings.betStrategy` when no filter is active or
   * the filter has no per-filter override.
   */
  private resolveActiveFilterStrategy() {
    if (this.currentPatternFilter === 'all') return this.settings.betStrategy
    return PatternBettingService.resolveBetStrategy(
      this.currentPatternFilter as RoomFilterType,
      this.settings.betStrategy
    )
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
  private getSettingsForActiveFilter() {
    const effective = this.resolveActiveFilterStrategy()
    const tieOnlyOverride =
      this.isTieOnlyFilter(this.currentPatternFilter) &&
      this.settings.forceBetDirection !== 'tie_only'
    if (effective === this.settings.betStrategy && !tieOnlyOverride) return this.settings
    return {
      ...this.settings,
      betStrategy: effective,
      forceBetDirection: tieOnlyOverride ? 'tie_only' : this.settings.forceBetDirection,
    }
  }

  /**
   * 패턴 기반 예측 생성 (PatternPredictionService에 위임)
   * @param room 방 정보
   * @param remainingSeconds 남은 배팅 시간
   */
  private async getPatternBasedPrediction(room: Room, remainingSeconds: number): Promise<Prediction | null> {
    // 방의 예측 상태(연승/연패 stats)를 함께 넘긴다. 디스플레이(AutoModePanel)가 매칭 판정에 쓰는
    // 것과 동일한 MultiRoomPredictionService 상태를 사용해야 연승/연패 필터에서 "보이는 방은
    // 매칭인데 봇은 스킵" 불일치가 사라진다(pattern-streak-1).
    const predictionState = MultiRoomPredictionService.getRoomState(room.id)
    return this.patternPredictionService.getPatternBasedPrediction(
      room,
      remainingSeconds,
      this.currentPatternFilter,
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
    this.cleanupAdapterSubscriptions()
    this.stateManager.clear()
    this.betLogManager.clear()
    this.state.roomStates.clear()
    this.activeBettingRoomIds.clear()
    this.hasReceivedActiveRoomList = false
    this.currentPatternFilter = 'all'
    this.lastBettingPhaseByRoom.clear()
    this.lastDecisionKeyByRoom.clear()
    this.bettingInProgress.clear()  // 배팅 진행 락 초기화
    // Bug 4 Fix: 필터 전환 타임아웃 정리
    if (this.filterTransitionTimeout) {
      clearTimeout(this.filterTransitionTimeout)
      this.filterTransitionTimeout = null
    }
    this.isFilterTransitioning = false
    this._casinoAdapter = null
    this._multiRoomPredictionPort = null
    this._patternPredictionService = null
  }
}

export const AutoModeService = new AutoModeServiceImpl()
export default AutoModeService
