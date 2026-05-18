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
  BetType,
  RoomBetConfig,
  RoomFilterType,
  PatternBetConfig,
  Winner,
} from '../../domain/entities'
import { TIE_PAYOUT_MULTIPLIER } from '../../domain/entities'
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
  getRestPeriodManager,
  createBettingDecisionService,
  createPatternPredictionService,
  getAutoModeRepository,
  fromRoomBettingState,
  type IMartingaleManager,
  type IRestPeriodManager,
  type IBettingDecisionService,
  type IPatternPredictionService,
  type IAutoModeRepository,
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
  restDurationMinutes: number     // 연패 휴식 시간 (분)
  patternConfigs: PatternBetConfig[] // 패턴별 배팅 설정
  // 휴식 설정 (BettingDecisionService 호환)
  enableRestAfterLoss: boolean    // 연패 후 휴식 활성화
  restAfterLossCount: number      // 휴식 시작 연패 횟수
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
  lastBetAmount: number
  waitingForResult: boolean
  lastBetTime: number | null
  /** History length snapshot at bet placement time (newest-first history) */
  lastBetHistoryLength: number | null
  lastResultTime: number | null
  // 휴식 상태 (5연패 후)
  restingUntil: number | null  // 휴식 종료 시각 (timestamp), null이면 휴식 중 아님
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
  restDurationMinutes: 10,
  patternConfigs: [],
  // 휴식 설정 (BettingDecisionService 호환)
  enableRestAfterLoss: true,
  restAfterLossCount: 5,       // maxMartin과 동일하게 기본값 설정
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

    console.log('[AutoMode] Settings loaded, enabled forced to false for safety')
  }

  private state: Omit<AutoModeState, 'settings'> = {
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

  // 현재 활성 배팅 수 계산 (waitingForResult + bettingInProgress - Single Source of Truth)
  // waitingForResult: 결과 대기 중인 방
  // bettingInProgress: 현재 배팅 진행 중인 방 (예측/배팅 처리 중, waitingForResult 전)
  private getActiveBettingCount(): number {
    let count = 0
    this.state.roomStates.forEach(state => {
      if (state.waitingForResult) count++
    })
    // 배팅 진행 중인 방 추가 (아직 waitingForResult 안 됨)
    count += this.bettingInProgress.size
    return count
  }

  // Lazy-loaded dependencies
  private _casinoAdapter: ICasinoAdapter | null = null
  private _multiRoomPredictionPort: IMultiRoomPredictionPort | null = null

  // ==================== Extracted Modules ====================
  private martingaleManager: IMartingaleManager = getMartingaleManager()
  private restPeriodManager: IRestPeriodManager = getRestPeriodManager()
  private bettingDecisionService: IBettingDecisionService = createBettingDecisionService(
    this.martingaleManager,
    this.restPeriodManager
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

    // 🔧 Bug Fix: maxMartin 변경 시 globalMaxConsecutiveLosses도 동기화
    // UI에서 "최대 단계"를 변경하면 휴식 기준도 같이 변경되어야 함
    // maxMartin 변경 시 globalMaxConsecutiveLosses도 동기화 (하위 호환)
    if (newSettings.maxMartin !== undefined) {
      this.settings.globalMaxConsecutiveLosses = newSettings.maxMartin
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

  // ==================== Rest Period Persistence (Bug 3 Fix) ====================

  /** Load rest periods from repository */
  private loadRestPeriods(): Map<string, number> {
    return this.repository.loadRestPeriods()
  }

  /** Save rest periods to repository */
  private saveRestPeriods(): void {
    this.repository.saveRestPeriods(this.state.roomStates)
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
      rs.lastBetAmount = 0
      rs.lastBetTime = null
      rs.lastBetHistoryLength = null
      rs.lastResultTime = null
      rs.wasVirtualBet = undefined

      // Bug Fix: 휴식 상태도 리셋
      rs.restingUntil = null

      // Bug Fix: 결과 추론 재시도 상태 리셋
      rs.resultInferenceRetries = 0
      rs.lastInferenceRetryTime = null
    })

    // 3. RestPeriodManager 동기화
    this.restPeriodManager.clearAllRests()

    // 4. 휴식 기간 저장소 클리어
    this.repository.clearRestPeriods()

    // 5. VirtualBettingService 리셋 (가상 모드일 경우)
    if (this.settings.isVirtualMode) {
      VirtualBettingService.reset()
      console.log('[AutoMode] VirtualBettingService도 함께 리셋됨')
    }

    console.log('[AutoMode] 📊 통계 완전 리셋 완료 (pending 상태, 휴식 기간 포함)')
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
      // 저장된 휴식 기간이 있는지 확인
      const restPeriods = this.loadRestPeriods()
      const persistedResting = restPeriods.get(roomId)

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
        lastBetAmount: 0,
        waitingForResult: false,
        lastBetTime: null,
        lastBetHistoryLength: null,
        lastResultTime: null,
        restingUntil: persistedResting && persistedResting > Date.now() ? persistedResting : null,
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
    const nextRoomIds = new Set(roomIds)
    const prevRoomIds = this.activeBettingRoomIds
    const prevFilter = this.currentPatternFilter

    // 🆕 v2.23: 방 목록이 실제로 변경됐는지 확인 (불필요한 전환 락 방지)
    const isSameRoomList = roomIds.length === prevRoomIds.size &&
      roomIds.every(id => prevRoomIds.has(id))
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
    }
    console.log(`[AutoMode] 🏠 Active betting rooms updated: ${roomIds.length} rooms [${roomIds.slice(0, 3).join(', ')}${roomIds.length > 3 ? '...' : ''}], filter: ${this.currentPatternFilter}`)

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
    if (this.isFilterTransitioning) {
      console.log(`[AutoMode] ❌ 필터 전환 중 - ${roomNameForDebug} 스킵`)
      return
    }

    // 배팅 진행 중 락 체크 및 즉시 설정 (동시 배팅 방지 - atomic check-and-set)
    if (this.bettingInProgress.has(roomId)) {
      console.log(`[AutoMode] ❌ 배팅 진행 중 - ${roomNameForDebug} 스킵 (동시 배팅 방지)`)
      return
    }
    // 즉시 락 설정 (race condition 방지)
    this.bettingInProgress.add(roomId)

    // phase 체크 완화: 'start'가 아니어도 remainingSeconds가 있으면 처리
    if (remainingSeconds < 3) {
      console.log(`[AutoMode] ❌ remainingSeconds=${remainingSeconds} < 3 - 스킵`)
      this.bettingInProgress.delete(roomId)  // 락 해제
      return
    }

    // 이후 모든 코드는 try-finally로 감싸서 어떤 경로로든 락이 해제되도록 함
    try {
      // ========== Bug Fix: waitingForResult 타임아웃 체크를 isRoomEnabled보다 먼저 실행 ==========
      // 방이 비활성화되어도 stuck 상태를 해제할 수 있도록 함
      const room = this.casinoAdapter.getRoom(roomId)
      if (!room) return

      const roomState = this.getOrCreateRoomState(roomId, room.koreanName || room.name)

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

      // 1. 휴식 중인지 체크 (RestPeriodManager + roomState 통합)
      const isRestingByManager = this.restPeriodManager.isResting(roomId)
      const isRestingByState = roomState.restingUntil && Date.now() < roomState.restingUntil

      if (isRestingByManager || isRestingByState) {
        // 아직 휴식 중 - 배팅 안 함
        const remainingMs = isRestingByManager
          ? this.restPeriodManager.getRemainingTime(roomId)
          : (roomState.restingUntil! - Date.now())
        const remainingMin = Math.ceil(remainingMs / 60000)
        console.log(`[AutoMode] ${room.koreanName} - 휴식 중 (${remainingMin}분 남음)`)
        return
      } else if (roomState.restingUntil) {
        // 휴식 종료 - 마틴 리셋하고 재개
        roomState.restingUntil = null
        // ✅ MartingaleManager를 통해 리셋 (Single Source of Truth)
        this.martingaleManager.resetLevel(roomId)
        this.syncMartinLevelFromManager(roomId, roomState)
        this.restPeriodManager.clearRest(roomId)  // RestPeriodManager 동기화
        this.saveRestPeriods()  // Bug 3 Fix: 휴식 해제 저장
        console.log(`[AutoMode] ${room.koreanName} - 휴식 종료, 마틴 리셋, 배팅 재개`)
        this.emitBetLog({
          type: 'bet_result',
          roomId,
          roomName: room.koreanName,
          martinLevel: 0,
          reasoning: '휴식 종료, 배팅 재개',
          timestamp: Date.now(),
        })
      }

      // 2. 윈컷/로스컷 체크 (BettingDecisionService 위임)
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

      // 4. 연패 휴식 기준 체크 (안전장치)
      // NOTE: 실제 휴식 시작은 handleGameResult()에서 처리됨
      // 여기서는 이미 최대 마틴 단계에 도달한 상태에서 결과 이벤트가 누락된 경우를 대비한 안전장치
      // martinLevel은 0-indexed: 0=1단계, 1=2단계, 2=3단계
      // maxMartin=3 설정 시 martinLevel=2(3단계)에서 배팅은 허용, 패배 시 handleGameResult에서 리셋+휴식
      // (이 체크는 handleGameResult에서 이미 처리되므로 일반적으로 통과됨)

      // 🆕 v2.24: 동시배팅 제한 체크 (사용자 설정 기반)
      // maxConcurrentBets = 0이면 무제한 (예측모드처럼 동작)
      const isInMartinRecovery = roomState.martinLevel > 0
      const currentBetCount = this.getActiveBettingCount()
      const maxBets = this.settings.maxConcurrentBets

      // 0이 아닌 경우에만 제한 체크
      if (maxBets > 0) {
        // 절대 상한선: maxBets * 2 (마틴 회복 포함)
        const absoluteMax = maxBets * 2
        if (currentBetCount >= absoluteMax) {
          console.log(`[AutoMode] 🚫 절대 상한 초과: ${room.koreanName} (현재=${currentBetCount}/${absoluteMax}개)`)
          return
        }

        // 일반 배팅 제한 (마틴 회복은 우회)
        if (!isInMartinRecovery && currentBetCount >= maxBets) {
          console.log(`[AutoMode] 📊 동시배팅 제한: ${room.koreanName} (현재=${currentBetCount}/${maxBets}개)`)
          return
        }
      }

      const maxDisplay = maxBets > 0 ? maxBets : '∞'
      console.log(`[AutoMode] ✅ 배팅 진행: ${room.koreanName} (현재=${currentBetCount}/${maxDisplay}개, 마틴회복=${isInMartinRecovery})`)

      try {
        // 사용자가 설정한 패턴과 배팅 방향에 따라 예측 생성
        // PatternBettingService에서 betDirection 확인:
        // - 'B'/'P': 해당 방향으로 고정 배팅
        // - 'skip': 배팅 안 함
        // - 'ai': AI 서버 예측 또는 스마트 로직
        console.log(`[AutoMode] getPatternBasedPrediction 호출: ${room.koreanName}`)
        const prediction = await this.getPatternBasedPrediction(room, remainingSeconds)

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

        // 🆕 v2.26: 모든 배팅에 신뢰도 체크 (승률 향상)
        // 균형형: 마틴 0 (첫 배팅) 50%, 이후 +5%씩
        const BASE_CONFIDENCE = 0.50  // 첫 배팅 최소 기준 (0~1 범위) - 50%로 낮춤
        const MARTIN_CONFIDENCE_STEP = 0.05  // 마틴당 추가 기준
        const dynamicMinConfidence = BASE_CONFIDENCE + (roomState.martinLevel * MARTIN_CONFIDENCE_STEP)
        const predictionConfidence = prediction.confidence ?? 0
        const confidencePercent = Math.round(predictionConfidence * 100)
        const minConfidencePercent = Math.round(dynamicMinConfidence * 100)

        if (predictionConfidence < dynamicMinConfidence) {
          this.emitDecisionOnce({
            roomId,
            roomName: room.koreanName,
            martinLevel: roomState.martinLevel,
            historyLength: room.history.length,
            code: 'low_confidence',
            level: 'info',
            status: 'pass',
            message: `신뢰도 부족 (${confidencePercent}% < ${minConfidencePercent}%) - ${roomState.martinLevel > 0 ? `마틴${roomState.martinLevel}` : '첫배팅'} 스킵`,
          })
          console.log(`[AutoMode] ⚠️ 신뢰도 부족: ${room.koreanName} - ${confidencePercent}% < ${minConfidencePercent}% (마틴${roomState.martinLevel})`)
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

        console.log(`[AutoMode] ${room.koreanName} -> ${prediction.prediction} (${prediction.reasoning})`)

        // 예측 로그 emit
        this.emitBetLog({
          type: 'prediction',
          roomId,
          roomName: room.koreanName,
          prediction: prediction.prediction as ('B' | 'P' | null),
          confidence: prediction.confidence,
          reasoning: prediction.reasoning,
          martinLevel: roomState.martinLevel,
          timestamp: Date.now(),
        })

        roomState.lastPrediction = prediction
        this.state.lastEventTime = Date.now()

        // 바로 배팅 실행
        await this.placeBet(roomId, room, prediction, roomState)

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

  private async placeBet(
    roomId: string,
    room: Room,
    prediction: Prediction,
    roomState: RoomBettingState
  ): Promise<void> {
    // NOTE: 락은 onBettingPhase에서 이미 설정됨 (bettingInProgress.add)
    // placeBet는 try-finally로 락 해제만 담당

    const betAmount = this.calculateBetAmount(roomState.martinLevel)
    const betType: BetType =
      prediction.prediction === 'B' ? 'Banker' :
      prediction.prediction === 'P' ? 'Player' : 'Tie'

    console.log(`[AutoMode] placeBet 시작 - room: ${room.koreanName}, prediction: ${prediction.prediction}, amount: ${betAmount}, isVirtual: ${this.settings.isVirtualMode}`)

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
        console.log(`[AutoMode] 가상 배팅 실행: ${room.koreanName} -> ${prediction.prediction} (${betAmount}원)`)
        const result = VirtualBettingService.placeBetWithAmount(roomId, room.koreanName, prediction.prediction!, betAmount)

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
    } finally {
      // 동시 배팅 방지: 락 해제
      this.bettingInProgress.delete(roomId)
    }

    // 배팅 실행 로그
    this.emitBetLog({
      type: 'bet_placed',
      roomId,
      roomName: room.koreanName,
      prediction: prediction.prediction,
      betType,
      betAmount,
      martinLevel: roomState.martinLevel,
      status: 'pending',
      reasoning: prediction.reasoning,  // 패턴 정보 전달
      timestamp: Date.now(),
    })

    const prevTotal = this.state.totalBetAmount
    this.state.totalBetAmount += betAmount
    console.log(`[AutoMode] 💵 totalBetAmount: ${prevTotal.toLocaleString()} → ${this.state.totalBetAmount.toLocaleString()}원 (+${betAmount.toLocaleString()}) | room: ${room.koreanName}`)
    this.emitStateChange()
  }

  /**
   * 오토 ON / 필터 변경 시점에 이미 "배팅 페이즈"가 진행 중인 방이 있으면
   * 이벤트를 기다리지 않고 즉시 배팅 로직을 한 번 실행한다.
   *
   * 이유: 사용자가 카운트다운(예: 8s) 중에 ON/필터를 바꾸면,
   * BettingPhase 이벤트는 이미 지나갔을 수 있어 다음 라운드까지 배팅이 안 되는 문제가 발생할 수 있음.
   */
  private tryBetOnCurrentBettingWindows(roomIds?: string[]): void {
    if (!this.settings.enabled) return

    const targetIds = (() => {
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
    })()

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

        if (remainingSeconds < 3) return

        // 이미 배팅 진행 중이면 스킵 (중복 배팅 방지)
        if (this.bettingInProgress.has(roomId)) return

        const roomState = this.state.roomStates.get(roomId)
        if (roomState?.waitingForResult) return

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
      roomState.lastBetHistoryLength = null
      this.emitStateChange()
      return
    }

    const betAmount = roomState.lastBetAmount

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
        this.tryBetOnCurrentBettingWindows()
      }
      return
    }

    const won = predResult === winner

    // 뱅커 커미션 계산 (정수 연산으로 누적 오차 방지)
    const BANKER_COMMISSION = 0.05
    // 손익 계산 시 반올림하지 않고 정확한 값 유지
    const rawProfit = won
      ? (predResult === 'B' ? betAmount * (1 - BANKER_COMMISSION)
        : predResult === 'T' ? betAmount * TIE_PAYOUT_MULTIPLIER
        : betAmount)
      : -betAmount
    // 개별 손익은 반올림하여 표시용으로 사용
    const profit = Math.round(rawProfit)

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

      if (roomState.restingUntil) {
        roomState.restingUntil = null  // 휴식 해제
        this.saveRestPeriods()  // Bug 3 Fix: 휴식 해제 저장
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
      //   - martinLevel=2(3단계) 패배 → 리셋 + 휴식 시작 (martinLevel=0)
      const maxMartin = this.settings.maxMartin
      const currentLevel = this.martingaleManager.getLevel(roomId)

      if (currentLevel >= maxMartin - 1) {
        // 최대 단계에서 패배 → 리셋 + 휴식 시작
        const previousMartin = currentLevel
        const restMinutes = this.settings.restDurationMinutes ?? 10

        // ✅ MartingaleManager를 Single Source of Truth로 사용
        this.martingaleManager.resetLevel(roomId)
        this.syncMartinLevelFromManager(roomId, roomState)

        // 휴식 시간이 0보다 클 때만 휴식 적용
        if (restMinutes > 0) {
          roomState.restingUntil = Date.now() + (restMinutes * 60 * 1000)
          this.saveRestPeriods()
          console.log(`[AutoMode] ${roomName} - 패배! 마틴 ${previousMartin + 1}/${maxMartin}단계 (최대), ${restMinutes}분 휴식 시작, 손익: ${profit.toLocaleString()}원`)
        } else {
          console.log(`[AutoMode] ${roomName} - 패배! 마틴 ${previousMartin + 1}/${maxMartin}단계 (최대), 리셋됨, 손익: ${profit.toLocaleString()}원`)
        }
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

    // 결과 로그
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
      martinLevel: roomState.martinLevel,
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
      this.tryBetOnCurrentBettingWindows()
    }
  }

  private onGameResult(event: GameResultEvent): void {
    const { roomId, winner, playerScore, bankerScore } = event
    this.handleGameResult(roomId, winner, playerScore, bankerScore)
  }

  private onShoeChange(roomId: string): void {
    const roomState = this.state.roomStates.get(roomId)
    if (roomState) {
      // ✅ MartingaleManager를 Single Source of Truth로 사용
      this.martingaleManager.resetLevel(roomId)
      this.syncMartinLevelFromManager(roomId, roomState)

      roomState.waitingForResult = false
      roomState.lastPrediction = null
      roomState.lastBetHistoryLength = null

      // ✅ 가상 배팅 중이었으면 취소 및 환불
      if (this.settings.isVirtualMode) {
        VirtualBettingService.cancelPendingBet(roomId)
      }

      console.log(`[AutoMode] Shoe change for ${roomState.roomName}, resetting state`)
      this.emitStateChange()
    }
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

  /**
   * Return a shallow-copied settings object whose `betStrategy` reflects the
   * per-filter override (if any). When no override applies, returns the live
   * settings reference to avoid unnecessary allocation.
   */
  private getSettingsForActiveFilter() {
    const effective = this.resolveActiveFilterStrategy()
    if (effective === this.settings.betStrategy) return this.settings
    return { ...this.settings, betStrategy: effective }
  }

  /**
   * 패턴 기반 예측 생성 (PatternPredictionService에 위임)
   * @param room 방 정보
   * @param remainingSeconds 남은 배팅 시간
   */
  private async getPatternBasedPrediction(room: Room, remainingSeconds: number): Promise<Prediction | null> {
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
      }
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
  }
}

export const AutoModeService = new AutoModeServiceImpl()
export default AutoModeService
