// SemiAutoService - Semi-automatic prediction with auto room selection
// Clean Architecture: Application Layer
//
// ⛔ CRITICAL ARCHITECTURE RULE ⛔
// 이벤트 기반 아키텍처:
// - 예측 요청: onBettingPhase()에서만 (베팅 페이즈 시작 시)
// - 결과 비교: onGameResult()에서만 (게임 결과 수신 시)
// - 데이터 소스: 멀티소켓 (widget.resolved, game.result)
//
// 주요 기능:
// 1. 멀티소켓 기반 게임 결과 감지
// 2. 지속적 방 필터링 - 모든 방 스캔하며 최적의 방 찾기
// 3. N승 후 방 이동 - 설정에 따라 자동 이동
// 4. 마틴 한도 도달 시 방 이동
// 5. Chrome CDP 탭 이동 연동 (하나의 탭에서 방 이동)

import type { Room, Winner, Prediction, BettingPhaseEvent, RoomPredictionState, RoadResult } from '../../domain/entities'
import { calculateBetAmount } from '../../domain/entities'
import { winProfit } from '../../domain/betting/payout'
import type {
  ICasinoAdapter,
  IMultiRoomPredictionPort,
  IRoomFilterUseCase,
  ISoundPort,
  ICdpPort,
} from '../../domain/interfaces'
import { container } from '../di'
import { invoke } from '@tauri-apps/api/core'
import { toWinnerArray } from '../../domain/utils/converters'
import { SemiAutoSettings, SemiAutoSettingsManager } from './semiauto/SemiAutoSettingsManager'
import { SemiAutoStatsManager } from './semiauto/SemiAutoStatsManager'
import { AutoBettingService } from './AutoBettingService'
import { MultiRoomPredictionService } from './MultiRoomPredictionService'
import { CallbackManager } from '../utils'

// Export Settings for consumers
export type { SemiAutoSettings }

export interface SemiAutoState {
  settings: SemiAutoSettings
  // Current room state
  currentRoomId: string | null
  currentRoomName: string | null
  currentRoomProvider: 'evolution' | 'pragmatic' | null
  // Prediction state
  lastPrediction: Prediction | null
  waitingForResult: boolean
  waitingForPrediction: boolean // 예측 API 응답 대기 중
  isFirstRound: boolean
  predictionMadeForRound: boolean // 현재 라운드에 이미 예측함
  // Stats
  martin: number // 연패 카운트
  displayMartin: number // UI 표시용 마틴 (최근값 유지)
  winCount: number // 현재 방에서 총 승리 횟수 (이동 승수 달성시 방 이동)
  totalWins: number
  totalLosses: number
  // History for current room
  roomHistory: Winner[]
  // Virtual Betting Stats
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
  // Status message
  statusMessage: string
  // Auto Betting State (실제 배팅)
  realBalance: number | null // 실제 잔액 (null = 연결 필요)
  currentBetAmount: number // 현재 배팅액 (마틴 적용)
  pendingBet: boolean // 배팅 전송 대기 중
  // Room navigation
  isNavigating: boolean // 방 이동 중
  // Betting timer (UI용)
  bettingTimer: number // 베팅 남은 시간 (초)
  // ✅ DEBUG: 디버깅용 - 마지막 수신 이벤트 정보
  lastEventRoomId: string | null // 마지막 이벤트의 roomId
  lastEventType: string | null // 마지막 이벤트 타입 (betting/result/history)
  // ✅ DEBUG: 베팅 페이즈 수신 카운트
  bettingPhaseCount: number // 베팅 페이즈 이벤트 수신 횟수
  // ✅ DEBUG: 예측 차단 이유
  lastBlockReason: string | null // 마지막 예측 차단 이유
}

type StateChangeCallback = (state: SemiAutoState) => void
type PredictionCallback = (prediction: Prediction) => void
// ResultCallback now includes current stats to avoid stale closure issues in React
type ResultCallback = (won: boolean, shouldMove: boolean, stats: { winCount: number; martin: number; totalWins: number; totalLosses: number }) => void
type RoomChangeCallback = (reason: string) => void
type AutoEnterRoomCallback = (room: Room) => void
type NavigateRoomCallback = (roomId: string, roomName: string, url: string) => void

// 배팅 로그 이벤트 타입
export interface BetLogEvent {
  type: 'placed' | 'result'
  roomId: string
  roomName: string
  betType: 'Banker' | 'Player' | 'Tie'
  amount: number
  won?: boolean
  profit?: number
  martinLevel: number
  timestamp: number
}
type BetLogCallback = (event: BetLogEvent) => void

// Internal state structure (excluding managed fields)
interface InternalState {
  currentRoomId: string | null
  currentRoomName: string | null
  lastPrediction: Prediction | null
  waitingForResult: boolean
  waitingForPrediction: boolean
  predictionMadeForRound: boolean
  roomHistory: Winner[]
  totalBetAmount: number
  cumulativeProfit: number
  maxProfit: number
  maxLoss: number
  statusMessage: string
  realBalance: number | null
  currentBetAmount: number
  pendingBet: boolean
  isNavigating: boolean
  currentRoomProvider: 'evolution' | 'pragmatic' | null
  bettingTimer: number
  lastEventRoomId: string | null
  lastEventType: string | null
  bettingPhaseCount: number
  lastBlockReason: string | null
}

class SemiAutoServiceImpl {
  private settingsManager = new SemiAutoSettingsManager()
  private statsManager = new SemiAutoStatsManager()

  private internalState: InternalState = {
    currentRoomId: null,
    currentRoomName: null,
    lastPrediction: null,
    waitingForResult: false,
    waitingForPrediction: false,
    predictionMadeForRound: false,
    roomHistory: [],
    totalBetAmount: 0,
    cumulativeProfit: 0,
    maxProfit: 0,
    maxLoss: 0,
    statusMessage: '대기 중',
    realBalance: null,
    currentBetAmount: 10000,
    pendingBet: false,
    isNavigating: false,
    bettingTimer: 0,
    lastEventRoomId: null,
    lastEventType: null,
    bettingPhaseCount: 0,
    lastBlockReason: null,
    currentRoomProvider: null,
  }

  // 이전에 선택했던 방 ID 목록 (중복 방지)
  private previousRoomIds: Set<string> = new Set()

  // 🔥 분석 대상 방 ID 목록 (선택된 방만 이동)
  private selectedRoomIds: Set<string> = new Set()

  // ✅ Timeout Recovery: waitingForResult 시작 시간
  private waitingForResultTimestamp: number = 0
  private readonly WAITING_RESULT_TIMEOUT_MS = 45000 // 45초 후 자동 복구

  private stateManager = new CallbackManager<StateChangeCallback>('SemiAuto')
  private predictionManager = new CallbackManager<PredictionCallback>('SemiAuto')
  private resultManager = new CallbackManager<ResultCallback>('SemiAuto')
  private roomChangeManager = new CallbackManager<RoomChangeCallback>('SemiAuto')
  private autoEnterRoomManager = new CallbackManager<AutoEnterRoomCallback>('SemiAuto')
  private navigateRoomManager = new CallbackManager<NavigateRoomCallback>('SemiAuto')
  private betLogManager = new CallbackManager<BetLogCallback>('SemiAuto')

  // 중복 방지용 플래그
  private lastComparedResult: string | null = null
  private lastComparedRound = -1
  private predictionRequestRoom: string | null = null // 예측 요청한 방 ID (비동기 레이스 방지)
  private isComparingResult = false // 결과 비교 중 플래그 (중복 호출 방지)
  private lastResultTimestamp = 0 // 마지막 결과 처리 시간 (디바운싱)
  private isRoomSelectionInFlight = false
  private lastRoomSelectionAt = 0

  private availableRooms: Map<string, Room> = new Map()
  private roomPredictionStats: Map<string, { wins: number; losses: number }> = new Map()
  private lastHistoryLengths: Map<string, number> = new Map()

  // Timer management
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set()
  private searchIntervalId: ReturnType<typeof setInterval> | null = null
  private bettingTimerInterval: ReturnType<typeof setInterval> | null = null

  // Reentrance guards
  private isToggling = false
  private isStarting = false

  // Cleanup functions for adapter subscriptions
  private adapterUnsubscribers: Array<() => void> = []

  // Lazy-loaded dependencies
  private _casinoAdapter: ICasinoAdapter | null = null
  private _multiRoomPredictionPort: IMultiRoomPredictionPort | null = null
  private _roomFilterUseCase: IRoomFilterUseCase | null = null
  private _soundPort: ISoundPort | null = null
  private _cdpPort: ICdpPort | null = null

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

  private get roomFilterUseCase(): IRoomFilterUseCase {
    if (!this._roomFilterUseCase) {
      this._roomFilterUseCase = container.get('roomFilterUseCase')
    }
    return this._roomFilterUseCase
  }

  private get soundPort(): ISoundPort {
    if (!this._soundPort) {
      this._soundPort = container.get('soundPort')
    }
    return this._soundPort
  }

  private get cdpPort(): ICdpPort {
    if (!this._cdpPort) {
      this._cdpPort = container.get('cdpPort')
    }
    return this._cdpPort
  }

  /**
   * Initialize subscriptions via DI ports (Clean Architecture)
   * Called after DI container is set up
   */
  initialize(): void {
    // Clean up any existing subscriptions first
    this.cleanupAdapterSubscriptions()

    // Subscribe to shoe change via ICasinoAdapter port
    const unsubShoe = this.casinoAdapter.onShoeChange?.((roomId: string) => {
      if (roomId === this.internalState.currentRoomId) {
        this.resetRoomState()
        this.setStatus('새 슈 시작')
      }
    })
    if (unsubShoe) this.adapterUnsubscribers.push(unsubShoe)

    // Subscribe to history updates - DATA SYNC ONLY (예측/비교 X)
    const unsubHistory = this.casinoAdapter.onHistoryUpdate((roomId: string, history: RoadResult[]) => {
      this.handleHistoryUpdate(roomId, history)
    })
    this.adapterUnsubscribers.push(unsubHistory)

    // Subscribe to ALL game results, filter inside handler
    const unsubResult = this.casinoAdapter.onGameResult((event) => {
      if (event.roomId === this.internalState.currentRoomId) {
        this.internalState.lastEventRoomId = event.roomId
        this.internalState.lastEventType = 'result'
      }
      this.onGameResult(event.roomId, event.winner, this.internalState.roomHistory)
    })
    this.adapterUnsubscribers.push(unsubResult)

    // Subscribe to ALL betting phase events, filter inside handler
    const unsubBetting = this.casinoAdapter.onBettingPhase((event) => {
      if (event.roomId === this.internalState.currentRoomId) {
        this.internalState.lastEventRoomId = event.roomId
        this.internalState.lastEventType = 'betting'
        this.internalState.bettingPhaseCount++
      }
      this.onBettingPhase(event)
    })
    this.adapterUnsubscribers.push(unsubBetting)

    // ✅ Subscribe to balance updates
    if (this.casinoAdapter.onBalanceUpdate) {
      const unsubBalance = this.casinoAdapter.onBalanceUpdate((balance) => {
        this.updateRealBalance(balance)
      })
      this.adapterUnsubscribers.push(unsubBalance)
    }
  }

  /**
   * Cleanup adapter subscriptions
   */
  private cleanupAdapterSubscriptions(): void {
    this.adapterUnsubscribers.forEach(unsub => unsub())
    this.adapterUnsubscribers = []
    this.internalState.realBalance = null // 🆕 잔액 추적 초기화
  }

  // ==================== Getters ====================
  getState(): SemiAutoState {
    return {
      settings: this.settingsManager.getSettings(),
      ...this.internalState,
      currentRoomProvider: this.internalState.currentRoomProvider,
      // Managed stats
      martin: this.statsManager.martin,
      displayMartin: this.statsManager.displayMartin,
      winCount: this.statsManager.winCount,
      totalWins: this.statsManager.totalWins,
      totalLosses: this.statsManager.totalLosses,
      isFirstRound: this.statsManager.isFirstRound,
    }
  }

  isEnabled(): boolean {
    return this.settingsManager.isEnabled()
  }

  getCurrentRoom(): { id: string; name: string } | null {
    if (this.internalState.currentRoomId && this.internalState.currentRoomName) {
      return { id: this.internalState.currentRoomId, name: this.internalState.currentRoomName }
    }
    return null
  }

  // ==================== Core Actions ====================

  /**
   * ✅ Clear all prediction-related state when changing rooms
   * bcrstore의 clearPredictionState() 참조
   */
  private clearPredictionState(): void {

    this.internalState.lastPrediction = null
    this.internalState.waitingForResult = false
    this.internalState.waitingForPrediction = false
    this.internalState.predictionMadeForRound = false
    this.internalState.currentRoomProvider = null
    this.waitingForResultTimestamp = 0  // ✅ 타임스탬프 리셋
    this.predictionRequestRoom = null
    this.lastComparedResult = null
    this.lastComparedRound = -1

    // Reset counters for new room (fresh start)
    // keepTotalStats=true: preserve total wins/losses because this is just clearing room state
    this.statsManager.resetRoomStats(true)

    // Reset betting timer
    this.stopBettingTimer()
    this.internalState.bettingTimer = 0

    // Update bet amount
    this.updateCurrentBetAmount()
  }

  /**
   * Toggle semi-auto mode
   */
  toggle(): void {
    if (this.isToggling) return
    this.isToggling = true

    try {
      if (this.settingsManager.isEnabled()) {
        this.stop()
        this.settingsManager.setEnabled(false)
      } else {
        this.settingsManager.setEnabled(true)
        this.start()
      }
      this.emitStateChange()
    } finally {
      this.isToggling = false
    }
  }

  /**
   * Start semi-auto
   */
  start(): void {
    if (this.isStarting) return
    this.isStarting = true

    try {
      this.setStatus('시작 중...')
      this.clearPredictionState()
      this.statsManager.isFirstRound = true

      // 🔥 사운드 초기화 보장 - 예측 사운드 재생을 위해
      if (this.settingsManager.getSettings().soundEnabled) {
        this.soundPort.init().catch(() => {
          // Silent fail - 사운드 초기화 실패해도 계속 진행
        })
      }

      // ✅ Enable multi-room prediction service
      MultiRoomPredictionService.setAutoMode(true)

      if (this.settingsManager.autoFindRoom) {
        this.autoSelectBestRoom()
      }
      if (this.settingsManager.continuousSearch) {
        this.startContinuousSearch()
      }
    } finally {
      this.isStarting = false
    }
  }

  /**
   * Stop semi-auto
   * 현재 방 정보는 유지하고 예측만 중지
   */
  stop(): void {
    this.setStatus('정지됨')
    this.clearPredictionState()
    this.statsManager.isFirstRound = true
    this.stopContinuousSearch()

    // ✅ Disable multi-room prediction service
    MultiRoomPredictionService.setAutoMode(false)
  }

  /**
   * Update settings
   */
  updateSettings(settings: Partial<SemiAutoSettings>): void {
    this.settingsManager.updateSettings(settings)
    this.emitStateChange()
  }

  // ==================== Room Management ====================

  /**
   * Enter a room - 방 입장 시 상태 초기화
   */
  enterRoom(room: Room): void {
    if (this.internalState.currentRoomId === room.id) {
      // 이미 같은 방에 있는 경우라도, navigateToRoom 말미에서 호출되어 들어온 것일 수 있다.
      // 여기서 조기 반환하더라도 isNavigating 플래그는 반드시 정리해야 한다.
      // (정리하지 않으면 isNavigating이 true로 묶여 이후 수동/자동 방 이동이 모두 차단됨)
      if (this.internalState.isNavigating) {
        this.internalState.isNavigating = false
        this.emitStateChange()
      }
      return
    }

    // 방 정보 즉시 스냅샷
    const roomId = room.id
    const roomName = room.koreanName
    const roomHistory = toWinnerArray(room.history)
    const score = this.calculateRoomScore(room)

    this.clearPredictionState()

    // Set new room
    this.internalState.currentRoomId = roomId
    this.internalState.currentRoomName = roomName
    this.internalState.currentRoomProvider = room.provider || 'evolution'
    this.internalState.roomHistory = roomHistory
    this.statsManager.isFirstRound = this.settingsManager.skipFirstRound
    this.internalState.isNavigating = false
    this.statsManager.resetFirstRoundBettingCount()
    this.lastHistoryLengths.set(roomId, roomHistory.length)

    this.setStatus(`${roomName} (점수: ${score.toFixed(0)})`)
    this.emitStateChange()
  }

  // Fresh-Shoe 프리셋용 — 현재 CDP가 가리키는 방의 id (MoveOnTieListener scope filter)
  getCurrentRoomId(): string | null {
    return this.internalState.currentRoomId
  }

  // Fresh-Shoe 프리셋 트리거 처리: 후보 fresh-shoe 방 선택 → CDP navigate
  async handlePresetTrigger(currentRoomId: string, reason: import('./freshshoe').TriggerReason): Promise<void> {
    // 후보 방 산출 — 테스트 훅이 있으면 그것, 아니면 production fallback (현재는 빈 배열, Task 11에서 와이어링)
    const provider = this.candidatesProvider
    const candidates: any[] = provider ? provider() : await this.collectFreshShoeCandidates()
    const next = candidates.find(r => r && r.id !== currentRoomId)

    if (!next) {
      console.log('[SemiAuto] handlePresetTrigger: no fresh-shoe candidate, staying', { currentRoomId, reason })
      return
    }

    await this.navigateToRoom(next)
  }

  // RoomFilterService 통해 fresh_shoe 방 후보 산출 — Task 11에서 와이어링.
  private async collectFreshShoeCandidates(): Promise<any[]> {
    return []
  }

  // 테스트 전용 훅
  private candidatesProvider: (() => any[]) | null = null
  __testSetCandidatesProvider(provider: (() => any[]) | null): void {
    this.candidatesProvider = provider
  }

  resetForTest(): void {
    this.candidatesProvider = null
    this.internalState.currentRoomId = null
    this.internalState.currentRoomName = null
  }

  /**
   * Navigate to a room via CDP (하나의 탭에서 방 이동)
   */
  async navigateToRoom(room: Room): Promise<void> {
    if (this.internalState.isNavigating) return

    // 네비게이션 시작 전 방 정보 스냅샷
    const navigationRoomId = room.id
    const navigationRoomName = room.koreanName
    const navigationRoomHistory = [...room.history]
    const wasEnabled = this.settingsManager.isEnabled()
    const previousRoomId = this.internalState.currentRoomId

    this.internalState.isNavigating = true
    this.setStatus(`${navigationRoomName} 이동 중...`)
    if (this.settingsManager.getSettings().soundEnabled) {
      this.soundPort.playMove()
    }
    this.emitStateChange()

    this.clearPredictionState()

    // 🎲 Pragmatic 방은 별도 처리 (캡처된 런처 URL 기반)
    if (room.provider === 'pragmatic') {
      console.log('[SemiAutoService] 🎲 Navigating to Pragmatic room:', room.id)

      try {
        const newUrl = await invoke<string>('navigate_pragmatic_room', { roomId: room.id })
        console.log('[SemiAutoService] 🎲 Pragmatic navigation success:', newUrl.substring(0, 80))

        if (!this.settingsManager.isEnabled() && wasEnabled) {
          this.internalState.isNavigating = false
          this.emitStateChange()
          return
        }

        this.emitNavigateRoom(navigationRoomId, navigationRoomName, newUrl)
      } catch (error) {
        console.error('[SemiAutoService] 🎲 Pragmatic navigation failed:', error)
        this.internalState.isNavigating = false
        this.setStatus('프라그마틱 방 이동 실패')
        this.emitStateChange()
        return
      }
    } else {
      // Evolution 방 처리
      const baseUrl = this.settingsManager.baseUrl
      if (!baseUrl) {
        this.internalState.isNavigating = false
        this.setStatus('카지노 URL 미설정')
        this.emitStateChange()
        return
      }

      const roomUrl = this.buildRoomUrl(baseUrl, room.id)

      try {
        // 🔧 CDP로 기존 탭에서 방 이동 (수동 입장과 동일한 방식)
        await this.cdpPort.navigateToRoom(roomUrl)

        // 🔧 방 입장 후 해당 테이블 재구독 요청 (useCasino.enterRoom과 동일)
        try {
          await invoke('resubscribe_evolution_table', { tableId: room.id })
          console.log('[SemiAutoService] 🔄 Resubscribed to table after room entry:', room.id)
        } catch (resubErr) {
          console.warn('[SemiAutoService] Failed to resubscribe table:', resubErr)
        }
      } catch (cdpError) {
        console.warn('[SemiAutoService] CDP navigate failed, trying normal Chrome:', cdpError)
        try {
          // 🔧 CDP 실패 시 일반 Chrome으로 폴백 (윈도우 등 CDP 미사용 환경)
          await this.cdpPort.openInChromeNormal(roomUrl)
        } catch (fallbackError) {
          console.error('[SemiAutoService] Failed to open room:', fallbackError)
          this.internalState.isNavigating = false
          this.setStatus('방 이동 실패')
          this.emitStateChange()
          return
        }
      }

      if (!this.settingsManager.isEnabled() && wasEnabled) {
        this.internalState.isNavigating = false
        this.emitStateChange()
        return
      }

      this.emitNavigateRoom(navigationRoomId, navigationRoomName, roomUrl)
    }

    // Race condition 체크
    if (this.internalState.currentRoomId !== previousRoomId) {
      this.internalState.isNavigating = false
      this.emitStateChange()
      return
    }

    const roomSnapshot: Room = {
      id: navigationRoomId,
      koreanName: navigationRoomName,
      name: navigationRoomName,
      history: navigationRoomHistory,
      gameCount: navigationRoomHistory.length,
    }
    this.enterRoom(roomSnapshot)
  }

  /**
   * Build room URL (Evolution Gaming format)
   */
  private buildRoomUrl(baseUrl: string, roomId: string): string {
    const randomLaunchId = crypto.randomUUID?.() || Math.random().toString(36).substring(2).padEnd(32, '0')
    // Evolution Gaming URL format: /frontend/evo/r2/#category=baccarat&game=baccarat&table_id=...
    return `${baseUrl}/frontend/evo/r2/#category=baccarat&game=baccarat&table_id=${roomId}&lobby_launch_id=${randomLaunchId}`
  }

  /**
   * Exit room
   */
  exitRoom(): void {
    this.clearPredictionState()
    this.internalState.currentRoomId = null
    this.internalState.currentRoomName = null
    this.internalState.currentRoomProvider = null
    this.statsManager.isFirstRound = true
    this.setStatus('방 선택 필요')
    this.emitStateChange()
  }

  /**
   * Update available rooms
   */
  updateAvailableRooms(rooms: Map<string, Room>): void {
    this.availableRooms = rooms

    // Update history lengths for change detection
    rooms.forEach((room, id) => {
      if (!this.lastHistoryLengths.has(id)) {
        this.lastHistoryLengths.set(id, room.history.length)
      }
    })
  }

  /**
   * 🔥 분석 대상 방 ID 목록 설정 (선택된 방만 이동)
   */
  setSelectedRoomIds(roomIds: Set<string>): void {
    this.selectedRoomIds = roomIds
  }

  /**
   * Auto select best room and navigate
   */
  autoSelectBestRoom(): void {
    if (this.availableRooms.size === 0) {
      this.setStatus('방 대기 중...')
      return
    }

    if (this.internalState.isNavigating) {
      return
    }

    if (this.settingsManager.useAiPrediction) {
      this.setStatus('서버 추천 방 선택 중...')
      void this.selectBestRoomFromServer()
      return
    }

    const bestRoom = this.findBestRoom()
    if (bestRoom) {
      const roomSnapshot: Room = {
        id: bestRoom.id,
        koreanName: bestRoom.koreanName,
        name: bestRoom.name ?? bestRoom.koreanName,
        history: [...bestRoom.history],
        gameCount: bestRoom.gameCount,
        lastResultTime: bestRoom.lastResultTime,
        phase: bestRoom.phase,
      }
      this.emitAutoEnterRoom(roomSnapshot)
      this.navigateToRoom(bestRoom)
    } else {
      this.setStatus('적합한 방 없음')
    }
  }

  private async selectBestRoomFromServer(): Promise<void> {
    if (this.isRoomSelectionInFlight) return
    const now = Date.now()
    if (now - this.lastRoomSelectionAt < SemiAutoServiceImpl.ROOM_SELECTION_COOLDOWN_MS) return

    this.isRoomSelectionInFlight = true
    this.lastRoomSelectionAt = now

    try {
      const candidates = this.buildServerCandidates()
      if (candidates.length === 0) {
        this.fallbackToLocalSelection('서버 후보 없음')
        return
      }

      const settings = this.settingsManager.getSettings()
      const response = await this.multiRoomPredictionPort.requestBestRoomSelection(candidates, {
        betType: settings.betStrategy,
        martinLevel: settings.maxMartin,
        maxResults: 1,
        includeSkipped: true,
      })

      if (!response || !response.bestRoomId) {
        this.fallbackToLocalSelection('서버 추천 없음')
        return
      }

      const bestRoom = this.availableRooms.get(response.bestRoomId)
      if (!bestRoom) {
        this.fallbackToLocalSelection('추천 방 미존재')
        return
      }

      const roomSnapshot: Room = {
        id: bestRoom.id,
        koreanName: bestRoom.koreanName,
        name: bestRoom.name ?? bestRoom.koreanName,
        history: [...bestRoom.history],
        gameCount: bestRoom.gameCount,
        lastResultTime: bestRoom.lastResultTime,
        phase: bestRoom.phase,
      }
      this.emitAutoEnterRoom(roomSnapshot)
      await this.navigateToRoom(bestRoom)
    } catch (error) {
      console.error('[SemiAuto] Server room selection failed:', error)
      this.fallbackToLocalSelection('서버 오류')
    } finally {
      this.isRoomSelectionInFlight = false
    }
  }

  private buildServerCandidates(): Room[] {
    const candidates: Array<{ room: Room; score: number }> = []
    const activeFilters = this.roomFilterUseCase.getActiveFilters()
    const hasActiveFilters = activeFilters.length > 0
    const hasSelectedRooms = this.selectedRoomIds.size > 0

    for (const room of this.availableRooms.values()) {
      // 🔥 선택된 방이 있으면 해당 방만 이동 대상
      if (hasSelectedRooms && !this.selectedRoomIds.has(room.id)) {
        continue
      }

      // 라운드 범위 체크 (5~35 라운드만 허용)
      const historyLen = room.history.length
      if (historyLen < this.settingsManager.minRounds || historyLen > this.settingsManager.maxRounds) continue
      if (room.id === this.internalState.currentRoomId) continue
      if (this.previousRoomIds.has(room.id)) continue
      if (!this.settingsManager.isRoomEnabled(room.id)) continue
      if (this.settingsManager.isRoomResting(room.id)) continue

      if (hasActiveFilters) {
        const predictionState = this.getRoomPredictionState(room)
        const matchesAnyFilter = activeFilters.some(filterType =>
          this.roomFilterUseCase.matchesFilter(room, predictionState, filterType)
        )
        if (!matchesAnyFilter) continue
      }

      const score = this.calculateRoomScore(room)
      if (score > 0) {
        candidates.push({ room, score })
      }
    }

    if (candidates.length === 0 && this.previousRoomIds.size > 0) {
      this.previousRoomIds.clear()
      return this.buildServerCandidates()
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, SemiAutoServiceImpl.MAX_SERVER_CANDIDATES).map(c => c.room)
  }

  private fallbackToLocalSelection(reason: string): void {
    console.warn(`[SemiAuto] Server selection fallback: ${reason}`)
    const bestRoom = this.findBestRoom()
    if (bestRoom) {
      const roomSnapshot: Room = {
        id: bestRoom.id,
        koreanName: bestRoom.koreanName,
        name: bestRoom.name ?? bestRoom.koreanName,
        history: [...bestRoom.history],
        gameCount: bestRoom.gameCount,
        lastResultTime: bestRoom.lastResultTime,
        phase: bestRoom.phase,
      }
      this.emitAutoEnterRoom(roomSnapshot)
      void this.navigateToRoom(bestRoom)
    } else {
      this.setStatus('적합한 방 없음')
    }
  }

  // ==================== Event Handlers ====================

  /**
   * ✅ Handle history update - LOBBY MODE (데이터 동기화 전용)
   */
  private handleHistoryUpdate(roomId: string, history: RoadResult[]): void {
    // 비활성화면 무시
    if (!this.settingsManager.isEnabled()) return

    // ✅ CRITICAL: 현재 방만 처리 (bcrstore처럼)
    if (!this.internalState.currentRoomId || roomId !== this.internalState.currentRoomId) return

    const prevLength = this.lastHistoryLengths.get(roomId) || 0
    const newLength = history.length

    // 변화 없으면 무시
    if (newLength <= prevLength) return

    // 중복 이벤트 방지 (hash 비교)
    const resultHash = history.map(r => r.winner).join('')
    if (this.lastProcessedHash === resultHash) return
    this.lastProcessedHash = resultHash

    // 길이 업데이트
    this.lastHistoryLengths.set(roomId, newLength)

    // 히스토리 동기화만 수행
    this.internalState.roomHistory = toWinnerArray(history)

    // 첫 라운드: 데이터 수집 완료 표시
    if (this.statsManager.isFirstRound) {
      this.internalState.isNavigating = false
      this.emitStateChange()
    }
  }

  // 중복 이벤트 방지용 hash
  private lastProcessedHash: string = ''

  /**
   * ✅ Handle betting phase - PREDICTION REQUEST
   */
  async onBettingPhase(event: BettingPhaseEvent): Promise<void> {
    // ✅ 타이머는 항상 업데이트
    if (event.roomId === this.internalState.currentRoomId) {
      if (event.phase === 'start') {
        this.startBettingTimer(event.remainingSeconds)
      } else if (event.phase === 'end') {
        this.stopBettingTimer()
        this.internalState.bettingTimer = 0
      } else {
        this.internalState.bettingTimer = event.remainingSeconds
      }
      this.emitStateChange()
    }

    if (!this.settingsManager.isEnabled()) {
      this.internalState.lastBlockReason = 'disabled'
      return
    }

    // ✅ 로깅 최소화 (성능 최적화)

    // Auto-detect room if not set
    if (!this.internalState.currentRoomId && event.roomId) {
      const room = this.availableRooms.get(event.roomId)
      // 라운드 범위 체크 (5~35 라운드만 허용)
      const historyLen = room?.history.length ?? 0
      if (room && historyLen >= this.settingsManager.minRounds && historyLen <= this.settingsManager.maxRounds) {
        const roomSnapshot: Room = {
          id: room.id,
          koreanName: room.koreanName,
          name: room.koreanName,
          history: [...room.history],
          gameCount: room.history.length,
        }
        this.enterRoom(roomSnapshot)
        this.statsManager.resetFirstRoundBettingCount()
      } else {
        this.internalState.lastBlockReason = 'no-room'
        return
      }
    }

    // Only process current room
    if (event.roomId !== this.internalState.currentRoomId) {
      return
    }

    // ✅ 베팅 페이즈 종료 - 다음 라운드 준비
    if (event.phase === 'end') {
      this.internalState.predictionMadeForRound = false
      this.internalState.lastBlockReason = 'phase-end'
      if (this.statsManager.isFirstRound) {
        this.setStatus('첫 라운드 대기')
      }
      this.emitStateChange()
      return
    }

    // Check betting phase conditions
    if (event.phase !== 'start' || event.remainingSeconds < 5) {
      this.internalState.lastBlockReason = `phase=${event.phase},time=${event.remainingSeconds}s`
      return
    }

    // 첫 라운드 처리 - 첫 베팅 페이즈에서 바로 예측 시작
    if (this.statsManager.isFirstRound) {
      this.statsManager.isFirstRound = false
      this.internalState.isNavigating = false
      this.statsManager.resetFirstRoundBettingCount()
      this.setStatus('예측 시작')
      this.emitStateChange()
      // 첫 라운드 이후 바로 예측 진행 (return 하지 않음)
    }

    // 이미 이번 라운드에 예측했으면 스킵
    if (this.internalState.predictionMadeForRound) {
      this.internalState.lastBlockReason = 'already-predicted'
      return
    }

    // 예측 응답 대기 중이면 스킵
    if (this.internalState.waitingForPrediction) {
      this.internalState.lastBlockReason = 'waiting-prediction'
      return
    }

    // 결과 대기 중이면 스킵 (단, 타임아웃 복구 체크)
    if (this.internalState.waitingForResult) {
      const waitingTime = Date.now() - this.waitingForResultTimestamp
      if (waitingTime > this.WAITING_RESULT_TIMEOUT_MS) {
        // Timeout Recovery
        this.internalState.waitingForResult = false
        this.internalState.predictionMadeForRound = false
        this.internalState.lastPrediction = null
        this.waitingForResultTimestamp = 0
        this.setStatus('타임아웃 복구 - 예측 재개')
      } else {
        this.internalState.lastBlockReason = 'waiting-result'
        return
      }
    }

    // 예측 전 히스토리 동기화
    const currentRoom = this.availableRooms.get(this.internalState.currentRoomId!)
    if (currentRoom && currentRoom.history.length > 0) {
      const latestHistory = toWinnerArray(currentRoom.history)
      if (latestHistory.length > this.internalState.roomHistory.length) {
        this.internalState.roomHistory = latestHistory
      }
    }

    // Request prediction
    this.internalState.lastBlockReason = 'requesting...'
    this.emitStateChange()
    await this.requestPrediction()
    // 예측 완료 후 차단 이유 클리어
    if (this.internalState.lastBlockReason === 'requesting...') {
      this.internalState.lastBlockReason = null
    }
  }

  /**
   * Handle game result - RESULT COMPARISON
   */
  onGameResult(roomId: string, winner: Winner, history: Winner[]): void {
    if (!this.settingsManager.isEnabled()) return

    // Auto-detect room
    if (!this.internalState.currentRoomId && roomId) {
      const room = this.availableRooms.get(roomId)
      // 라운드 범위 체크 (5~35 라운드만 허용)
      const historyLen = room?.history.length ?? 0
      if (room && historyLen >= this.settingsManager.minRounds && historyLen <= this.settingsManager.maxRounds) {
        const roomSnapshot: Room = {
          id: room.id,
          koreanName: room.koreanName,
          name: room.koreanName,
          history: [...room.history],
          gameCount: room.history.length,
        }
        this.enterRoom(roomSnapshot)
      }
      return
    }

    // Only process current room
    if (roomId !== this.internalState.currentRoomId) return

    // Prevent duplicate processing
    // BUG FIX: 히스토리 업데이트가 늦게 오는 경우에도 결과 처리를 허용
    // waitingForResult가 true면 결과를 기다리고 있으므로 중복 체크를 건너뜀
    const resultKey = `${winner}-${history.length}`
    const isDuplicate = this.lastComparedResult === resultKey && this.lastComparedRound === history.length
    if (isDuplicate && !this.internalState.waitingForResult) {
      return
    }
    this.lastComparedResult = resultKey
    this.lastComparedRound = history.length

    // Update room history
    this.internalState.roomHistory = history

    // Compare with prediction (첫 라운드도 포함)
    if (this.internalState.lastPrediction && this.internalState.waitingForResult) {
      this.compareResult(winner)
    }

    // 첫 라운드 후속 처리
    if (this.statsManager.isFirstRound) {
      this.internalState.isNavigating = false
      this.statsManager.isFirstRound = false
      this.statsManager.resetFirstRoundBettingCount()
      this.setStatus('예측 준비 완료')
    }

    // Reset prediction flag for next round
    this.internalState.predictionMadeForRound = false
    this.emitStateChange()
  }

  // ==================== Stats Management ====================

  /**
   * Reset stats
   */
  resetStats(): void {
    this.statsManager.resetRoomStats(false) // Clear all stats including totals
    this.internalState.totalBetAmount = 0
    this.internalState.cumulativeProfit = 0
    this.internalState.maxProfit = 0
    this.internalState.maxLoss = 0
    this.internalState.currentBetAmount = this.settingsManager.getSettings().baseBetAmount
    this.roomPredictionStats.clear()
    this.previousRoomIds.clear()
    this.emitStateChange()
  }

  /**
   * Clear previous room history
   */
  clearPreviousRooms(): void {
    this.previousRoomIds.clear()
  }

  /**
   * Update real balance
   */
  updateRealBalance(balance: number): void {
    this.internalState.realBalance = balance
    this.emitStateChange()
  }

  /**
   * Calculate current bet amount
   */
  calculateCurrentBetAmount(): number {
    return calculateBetAmount(
      this.settingsManager.getSettings().betStrategy,
      this.settingsManager.getSettings().baseBetAmount,
      this.statsManager.martin
    )
  }

  /**
   * Update current bet amount
   */
  private updateCurrentBetAmount(): void {
    this.internalState.currentBetAmount = this.calculateCurrentBetAmount()
  }

  // ==================== Private Methods ====================

  private setStatus(message: string): void {
    this.internalState.statusMessage = message
  }

  private scheduleTimer(callback: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer)
      callback()
    }, delay)
    this.pendingTimers.add(timer)
  }

  private startContinuousSearch(): void {
    if (this.searchIntervalId) return

    this.searchIntervalId = setInterval(() => {
      if (!this.settingsManager.isEnabled()) return
      if (!this.settingsManager.continuousSearch) return
      if (this.internalState.waitingForResult) return
      if (this.internalState.isNavigating) return

      const currentRoom = this.internalState.currentRoomId ? this.availableRooms.get(this.internalState.currentRoomId) : null
      const currentScore = currentRoom ? this.calculateRoomScore(currentRoom) : 0

      const bestRoom = this.findBestRoom()
      if (bestRoom && bestRoom.id !== this.internalState.currentRoomId) {
        const bestScore = this.calculateRoomScore(bestRoom)

        if (bestScore > currentScore + 20) {
          console.log(`[SemiAuto] 📊 Better room available: ${bestRoom.koreanName} (${bestScore.toFixed(1)} vs ${currentScore.toFixed(1)}) - NOT auto-moving`)
        }
      }
    }, 30000)
  }

  private stopContinuousSearch(): void {
    if (this.searchIntervalId) {
      clearInterval(this.searchIntervalId)
      this.searchIntervalId = null
    }
  }

  // 방 선택 점수 범위 상수
  private static readonly MIN_ROOM_SCORE = 20
  private static readonly MAX_ROOM_SCORE = 40
  private static readonly SCORE_TOLERANCE = 10
  private static readonly MAX_SERVER_CANDIDATES = 8
  private static readonly ROOM_SELECTION_COOLDOWN_MS = 5000

  private findBestRoom(): Room | null {
    const candidates: Array<{ room: Room; score: number }> = []
    const activeFilters = this.roomFilterUseCase.getActiveFilters()
    const hasActiveFilters = activeFilters.length > 0
    const hasSelectedRooms = this.selectedRoomIds.size > 0

    for (const room of this.availableRooms.values()) {
      // 🔥 선택된 방이 있으면 해당 방만 이동 대상
      if (hasSelectedRooms && !this.selectedRoomIds.has(room.id)) {
        continue
      }

      // 라운드 범위 체크 (5~35 라운드만 허용)
      const historyLen = room.history.length
      if (historyLen < this.settingsManager.minRounds || historyLen > this.settingsManager.maxRounds) continue
      if (room.id === this.internalState.currentRoomId) continue

      // Skip previous rooms
      if (this.previousRoomIds.has(room.id)) {
        continue
      }

      // Check filters
      if (hasActiveFilters) {
        const predictionState = this.getRoomPredictionState(room)
        const matchesAnyFilter = activeFilters.some(filterType =>
          this.roomFilterUseCase.matchesFilter(room, predictionState, filterType)
        )
        if (!matchesAnyFilter) continue
      }

      const score = this.calculateRoomScore(room)
      if (score > 0) {
        candidates.push({ room, score })
      }
    }

    // If no candidates, clear previous rooms and retry
    if (candidates.length === 0 && this.previousRoomIds.size > 0) {
      this.previousRoomIds.clear()
      return this.findBestRoom()
    }

    if (candidates.length === 0) return null

    // 점수 범위 기반 필터링 (20~40점 우선)
    const MIN_SCORE = SemiAutoServiceImpl.MIN_ROOM_SCORE
    const MAX_SCORE = SemiAutoServiceImpl.MAX_ROOM_SCORE
    const TOLERANCE = SemiAutoServiceImpl.SCORE_TOLERANCE

    let filtered = candidates.filter(c => c.score >= MIN_SCORE && c.score <= MAX_SCORE)

    if (filtered.length === 0) {
      const extendedMin = MIN_SCORE - TOLERANCE
      const extendedMax = MAX_SCORE + TOLERANCE
      filtered = candidates.filter(c => c.score >= extendedMin && c.score <= extendedMax)

      if (filtered.length === 0) {
        const TARGET_SCORE = (MIN_SCORE + MAX_SCORE) / 2
        candidates.sort((a, b) => Math.abs(a.score - TARGET_SCORE) - Math.abs(b.score - TARGET_SCORE))
        return candidates[0].room
      }
    }

    const TARGET_SCORE = (MIN_SCORE + MAX_SCORE) / 2
    filtered.sort((a, b) => Math.abs(a.score - TARGET_SCORE) - Math.abs(b.score - TARGET_SCORE))
    return filtered[0].room
  }

  private getRoomPredictionState(room: Room): RoomPredictionState | null {
    const stats = this.roomPredictionStats.get(room.id)
    if (!stats) return null

    const total = stats.wins + stats.losses
    return {
      roomId: room.id,
      roomName: room.koreanName || room.name,
      lastPrediction: null,
      stats: {
        total,
        correct: stats.wins,
        winRate: total > 0 ? stats.wins / total : 0,
        consecutiveWins: 0,
        consecutiveLosses: 0,
        maxConsecutiveWins: 0,
        maxConsecutiveLosses: 0,
      },
      pattern: this.roomFilterUseCase.detectPattern(room.history),
      isFiltered: true,
      predictionCount: 0,
      history: [], // ✅ Fix TS Error
    }
  }

  /**
   * 방 점수 계산 (20~40점 범위 최적화)
   */
  private calculateRoomScore(room: Room): number {
    const winners = toWinnerArray(room.history)
    const history = winners.filter(h => h !== 'T').slice(0, 20)
    if (history.length < 5) return 0

    // 베이스 점수 (최소 점수 보장)
    let score = 15

    // Alternating pattern (퐁당)
    let alternatingCount = 0
    for (let i = 0; i < Math.min(6, history.length - 1); i++) {
      if (history[i] !== history[i + 1]) alternatingCount++
    }
    if (alternatingCount >= 5) score += 12
    else if (alternatingCount >= 4) score += 8
    else if (alternatingCount >= 3) score += 4

    // Streak pattern (장줄)
    let streakLength = 1
    for (let i = 1; i < history.length; i++) {
      if (history[i] === history[0]) streakLength++
      else break
    }
    if (streakLength >= 5) score += 10
    else if (streakLength >= 4) score += 7
    else if (streakLength >= 3) score += 4

    // 1-2 pattern
    if (history.length >= 6) {
      const pattern = history.slice(0, 6).join('')
      if (pattern.match(/^(BP|PB){3}/) || pattern.match(/^(BBP|PPB|BPP|PBB)/)) {
        score += 5
      }
    }

    // History length bonus
    score += Math.min(room.history.length / 10, 3)

    // Previous prediction stats
    const stats = this.roomPredictionStats.get(room.id)
    if (stats && stats.wins + stats.losses >= 3) {
      const winRate = stats.wins / (stats.wins + stats.losses)
      if (winRate >= 0.7) score += 5
      else if (winRate >= 0.6) score += 3
      else if (winRate < 0.4) score -= 5
      else if (winRate < 0.5) score -= 2
    }

    return score
  }

  /**
   * Request prediction from server
   */
  private async requestPrediction(): Promise<void> {
    if (!this.internalState.currentRoomId) return
    if (this.internalState.predictionMadeForRound) return
    if (this.internalState.waitingForPrediction) return

    this.setStatus('예측 중...')

    this.internalState.waitingForPrediction = true
    this.predictionRequestRoom = this.internalState.currentRoomId
    this.emitStateChange()

    try {
      // ✅ roomName, remainingSeconds, betStrategy 전달
      const betStrategy = this.settingsManager.getSettings().betStrategy

      // 🆕 v3.7.0: 실제 잔액 추적 - 모든 모드에서 실제 잔액 전달
      const userTracking = this.internalState.realBalance != null
        ? { currentBalance: this.internalState.realBalance }
        : undefined

      let prediction = await this.multiRoomPredictionPort.requestPredictionForRoom(
        this.internalState.currentRoomId,
        this.internalState.roomHistory,
        this.internalState.currentRoomName || undefined,
        this.internalState.bettingTimer,
        betStrategy, // 🆕 베팅 전략 타입 전달
        undefined, // martinLevel
        undefined, // minConfidence
        undefined, // autoMode
        userTracking // 🆕 v3.7.0: 사용자 잔액 추적
      )

      this.internalState.waitingForPrediction = false

      if (this.predictionRequestRoom !== this.internalState.currentRoomId) {
        this.predictionRequestRoom = null
        return
      }
      this.predictionRequestRoom = null

      if (!prediction) {
        prediction = this.createRosePragmaticPrediction('server-no-response')
      }

      if (prediction) {
        this.internalState.lastPrediction = prediction
        this.internalState.predictionMadeForRound = true
        this.internalState.lastBlockReason = null

        if (prediction.isSkip) {
          this.internalState.waitingForResult = false
          // 패스 시 마틴 유지 - 승리 시에만 리셋됨 (recordWin에서 처리)
          // this.statsManager.resetMartin()  // 삭제: 패스 후 다음 예측에서 마틴 이어감
          this.updateCurrentBetAmount()
          this.setStatus('패스 (연패 회복)')
          if (this.settingsManager.getSettings().soundEnabled) {
            this.soundPort.playTie()
          }
        } else {
          this.internalState.waitingForResult = true
          this.waitingForResultTimestamp = Date.now()
          const pred = prediction.prediction === 'B' ? '뱅커' : '플레이어'
          this.setStatus(`예측: ${pred} (${Math.round(prediction.confidence * 100)}%)`)
          if (prediction.prediction === 'B' || prediction.prediction === 'P') {
            if (this.settingsManager.getSettings().soundEnabled) {
              this.soundPort.playPrediction(prediction.prediction)
            }
          }

          // ✅ 자동 배팅: autoBetting 설정이 활성화되어 있으면 배팅 실행
          if (this.settingsManager.getSettings().autoBetting && this.internalState.currentRoomId) {
            this.executeAutoBetting(prediction)
          }
        }

        this.emitPrediction(prediction)
        this.emitStateChange()
      } else {
        this.internalState.lastBlockReason = 'server-no-response'
        this.setStatus('예측 실패')
        this.emitStateChange()
      }
    } catch (error) {
      this.internalState.waitingForPrediction = false
      this.predictionRequestRoom = null

      const errorMsg = error instanceof Error ? error.message : 'unknown'
      const fallback = this.createRosePragmaticPrediction(errorMsg)
      if (fallback) {
        this.internalState.lastPrediction = fallback
        this.internalState.predictionMadeForRound = true
        this.internalState.lastBlockReason = null
        this.internalState.waitingForResult = true
        this.waitingForResultTimestamp = Date.now()

        const pred = fallback.prediction === 'B' ? '뱅커' : '플레이어'
        this.setStatus(`ROSE 예측: ${pred} (${Math.round(fallback.confidence * 100)}%)`)
        if (fallback.prediction === 'B' || fallback.prediction === 'P') {
          if (this.settingsManager.getSettings().soundEnabled) {
            this.soundPort.playPrediction(fallback.prediction)
          }
        }
        if (this.settingsManager.getSettings().autoBetting && this.internalState.currentRoomId) {
          this.executeAutoBetting(fallback)
        }

        this.emitPrediction(fallback)
        this.emitStateChange()
        return
      }
      this.internalState.lastBlockReason = errorMsg

      const statusMap: Record<string, string> = {
        'no-auth-config': '로그인 필요',
        'token-expired': '토큰 만료 - 재로그인 필요',
        'server-timeout': '서버 타임아웃',
        'network-error': '네트워크 오류',
        'history-insufficient': '히스토리 부족',
        'server-null-response': '서버 응답 없음',
      }
      const status = statusMap[errorMsg] || `예측 실패 (${errorMsg})`
      this.setStatus(status)
      this.emitStateChange()
    }
  }

  private createRosePragmaticPrediction(reason: string): Prediction | null {
    if (this.internalState.currentRoomProvider !== 'pragmatic') return null
    if (!this.internalState.currentRoomId) return null
    if (this.internalState.roomHistory.length === 0) return null

    const seed = `ROSE_Analysis_V1|${this.internalState.currentRoomId}|${this.internalState.roomHistory.length}`
    let hash = 2166136261
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }

    return {
      roomId: this.internalState.currentRoomId,
      prediction: (hash >>> 0) % 2 === 0 ? 'B' : 'P',
      confidence: 0.52 + (((hash >>> 8) % 18) / 100),
      reasoning: `ROSE local seed fallback: ${reason}`,
      isSkip: false,
      timestamp: Date.now(),
    }
  }

  /**
   * Execute auto betting via AutoBettingService
   */
  private async executeAutoBetting(prediction: Prediction): Promise<void> {
    if (!this.internalState.currentRoomId) return
    // Skip only when there is no prediction at all. Tie ('T') is a valid bet
    // direction when the user's custom pattern explicitly chose it.
    if (!prediction.prediction) return

    const betAmount = this.internalState.currentBetAmount
    if (betAmount <= 0) {
      console.log('[SemiAuto] ⚠️ Auto betting skipped: invalid bet amount', betAmount)
      return
    }

    this.internalState.pendingBet = true
    this.emitStateChange()

    const betType: 'Banker' | 'Player' | 'Tie' =
      prediction.prediction === 'B' ? 'Banker' :
      prediction.prediction === 'P' ? 'Player' : 'Tie'
    const result = this.internalState.currentRoomProvider === 'pragmatic'
      ? await this.placePragmaticBet(this.internalState.currentRoomId, betType, betAmount)
      : await AutoBettingService.placeBetForPrediction(
        prediction,
        this.internalState.currentRoomId,
        betAmount
      )

    if (result.success) {
      const pred = prediction.prediction === 'B' ? '뱅커' : prediction.prediction === 'P' ? '플레이어' : '타이'
      this.setStatus(`✅ 배팅: ${pred} ${betAmount.toLocaleString()}`)
      console.log(`[SemiAuto] ✅ Auto bet placed: ${pred} ${betAmount}`)

      // 배팅 실행 로그 emit
      this.emitBetLog({
        type: 'placed',
        roomId: this.internalState.currentRoomId,
        roomName: this.internalState.currentRoomName || '알 수 없음',
        betType,
        amount: betAmount,
        martinLevel: this.statsManager.martin,
        timestamp: Date.now(),
      })
    } else {
      this.setStatus(`⚠️ 배팅 실패: ${result.error || 'unknown'}`)
      console.log(`[SemiAuto] ❌ Auto bet failed: ${result.error}`)
    }

    this.internalState.pendingBet = false
    this.emitStateChange()
  }

  private async placePragmaticBet(
    roomId: string,
    betType: 'Banker' | 'Player' | 'Tie',
    amount: number
  ): Promise<{ success: boolean; error?: string }> {
    const tableId = roomId.replace(/^pragmatic:/, '')

    try {
      await invoke('place_pragmatic_bet', {
        tableId,
        betType,
        amount: Math.trunc(amount),
      })
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: message }
    }
  }

  /**
   * Compare result with prediction
   */
  private compareResult(winner: Winner): void {
    if (this.isComparingResult) return

    const now = Date.now()
    if (now - this.lastResultTimestamp < 100) return

    const prediction = this.internalState.lastPrediction
    if (!prediction) return

    // Handle Tie outcome
    //   - If the user did NOT bet on Tie, the bet is a push (refunded — fall
    //     through is the existing behavior: clear prediction state, no win/loss).
    //   - If the user DID bet on Tie, this is a win at the Tie payout (8x net),
    //     so we let the normal win path handle it.
    if (winner === 'T' && prediction.prediction !== 'T') {
      if (this.settingsManager.getSettings().soundEnabled) {
        this.soundPort.playTie()
      }
      this.setStatus('타이 - 다음 라운드 예측')

      this.internalState.lastPrediction = null
      this.internalState.waitingForResult = false
      this.internalState.predictionMadeForRound = false
      this.waitingForResultTimestamp = 0
      this.isComparingResult = false
      this.emitStateChange()
      return
    }

    this.isComparingResult = true
    this.lastResultTimestamp = now

    const won = prediction.prediction === winner

    // DEBUG: 승패 비교 로깅
    console.log(`[SemiAuto] 🎯 결과 비교: prediction=${prediction.prediction}, winner=${winner}, won=${won}`)

    const betAmount = this.settingsManager.getSettings().baseBetAmount * Math.pow(2, this.statsManager.martin)
    this.internalState.totalBetAmount += betAmount

    if (won) {
      // WIN — 단일 페이아웃 정책(domain/betting/payout.winProfit)으로 계산(dup-1):
      // 플레이어 1:1 / 뱅커 0.95:1 / 타이 8:1, 반올림 통일
      const profit = winProfit(prediction.prediction as 'B' | 'P' | 'T', betAmount)
      this.internalState.cumulativeProfit += profit

      console.log(`[SemiAuto] ✅ 승리! recordWin() 호출 전: martin=${this.statsManager.martin}, wins=${this.statsManager.totalWins}`)
      this.statsManager.recordWin()
      console.log(`[SemiAuto] ✅ 승리! recordWin() 호출 후: martin=${this.statsManager.martin}, wins=${this.statsManager.totalWins}`)

      // 배팅 결과 로그 emit (승리)
      this.emitBetLog({
        type: 'result',
        roomId: this.internalState.currentRoomId || '',
        roomName: this.internalState.currentRoomName || '알 수 없음',
        betType: prediction.prediction === 'B' ? 'Banker' : prediction.prediction === 'P' ? 'Player' : 'Tie',
        amount: betAmount,
        won: true,
        profit,
        martinLevel: this.statsManager.martin,
        timestamp: Date.now(),
      })

      const winThreshold = this.settingsManager.winThreshold
      const shouldMove = winThreshold > 0 && this.statsManager.winCount >= winThreshold

      if (shouldMove) {
        this.setStatus(`${winThreshold}승 달성 - 방 이동`)
        this.emitResult(true, true)
        this.statsManager.resetRoomStats(true)
        this.triggerRoomChange(`${winThreshold}승 달성`)
      } else {
        this.setStatus(`적중! (${this.statsManager.winCount}/${winThreshold || '∞'})`)
        this.emitResult(true, false)
      }

      this.updateRoomStats(true)
    } else {
      // LOSS
      const lossAmount = -betAmount
      this.internalState.cumulativeProfit -= betAmount
      console.log(`[SemiAuto] ❌ 패배! recordLoss() 호출 전: martin=${this.statsManager.martin}, losses=${this.statsManager.totalLosses}`)
      this.statsManager.recordLoss()
      console.log(`[SemiAuto] ❌ 패배! recordLoss() 호출 후: martin=${this.statsManager.martin}, losses=${this.statsManager.totalLosses}`)

      // 배팅 결과 로그 emit (패배)
      this.emitBetLog({
        type: 'result',
        roomId: this.internalState.currentRoomId || '',
        roomName: this.internalState.currentRoomName || '알 수 없음',
        betType: prediction.prediction === 'B' ? 'Banker' : prediction.prediction === 'P' ? 'Player' : 'Tie',
        amount: betAmount,
        won: false,
        profit: lossAmount,
        martinLevel: this.statsManager.martin,
        timestamp: Date.now(),
      })

      const lossThreshold = this.settingsManager.lossThreshold
      const shouldMoveOnLoss = lossThreshold > 0 && this.statsManager.martin >= lossThreshold
      const maxMartin = this.settingsManager.maxMartin

      // ✅ FIX: allowRoomChange 조건 제거 - 패배 후 martin은 항상 >= 1이므로 잘못된 조건이었음
      if (shouldMoveOnLoss) {
        this.setStatus(`${lossThreshold}연패 달성 - 방 이동`)
        this.emitResult(false, true)
        this.statsManager.resetRoomStats(true)
        this.triggerRoomChange(`${lossThreshold}연패 달성`)
      } else if (this.statsManager.martin >= maxMartin) {
        this.setStatus(`${maxMartin}마틴 - 방 이동`)
        this.emitResult(false, true)
        this.statsManager.resetRoomStats(true)
        this.triggerRoomChange(`${maxMartin}마틴 도달`)
      } else {
        this.setStatus(`실패 (마틴 ${this.statsManager.martin})`)
        this.emitResult(false, false)
      }

      this.updateRoomStats(false)
    }

    if (this.internalState.cumulativeProfit > this.internalState.maxProfit) {
      this.internalState.maxProfit = this.internalState.cumulativeProfit
    }
    if (this.internalState.cumulativeProfit < this.internalState.maxLoss) {
      this.internalState.maxLoss = this.internalState.cumulativeProfit
    }

    this.updateCurrentBetAmount()

    // ✅ 자동 배팅 상태 리셋
    if (this.internalState.currentRoomId) {
      AutoBettingService.onGameResult(this.internalState.currentRoomId)
    }

    this.internalState.lastPrediction = null
    this.internalState.waitingForResult = false
    this.internalState.predictionMadeForRound = false
    this.waitingForResultTimestamp = 0  // ✅ 타임스탬프 리셋

    this.isComparingResult = false
    this.emitStateChange()
  }

  /**
   * Trigger room change (방 이동)
   */
  private triggerRoomChange(reason: string): void {
    this.emitRoomChange(reason)

    if (this.settingsManager.autoFindRoom) {
      if (this.internalState.currentRoomId) {
        this.previousRoomIds.add(this.internalState.currentRoomId)
      }

      this.internalState.currentRoomId = null
      this.internalState.currentRoomName = null
      this.emitStateChange()

      this.scheduleTimer(() => {
        this.autoSelectBestRoom()
      }, 500)
    }
  }

  private updateRoomStats(won: boolean): void {
    if (!this.internalState.currentRoomId) return
    const stats = this.roomPredictionStats.get(this.internalState.currentRoomId) || { wins: 0, losses: 0 }
    if (won) stats.wins++
    else stats.losses++
    this.roomPredictionStats.set(this.internalState.currentRoomId, stats)
  }

  private resetRoomState(): void {
    this.statsManager.isFirstRound = true
    this.internalState.lastPrediction = null
    this.internalState.waitingForResult = false
    this.internalState.waitingForPrediction = false
    this.internalState.predictionMadeForRound = false
    this.waitingForResultTimestamp = 0
    this.statsManager.resetFirstRoundBettingCount()
    this.lastComparedResult = null
    this.lastComparedRound = -1
    this.lastProcessedHash = ''
    this.stopBettingTimer()
    this.internalState.bettingTimer = 0
    this.emitStateChange()
  }

  // ==================== Subscriptions ====================
  onStateChange(callback: StateChangeCallback): () => void {
    return this.stateManager.subscribe(callback)
  }

  onPrediction(callback: PredictionCallback): () => void {
    return this.predictionManager.subscribe(callback)
  }

  onResult(callback: ResultCallback): () => void {
    return this.resultManager.subscribe(callback)
  }

  onRoomChange(callback: RoomChangeCallback): () => void {
    return this.roomChangeManager.subscribe(callback)
  }

  onAutoEnterRoom(callback: AutoEnterRoomCallback): () => void {
    return this.autoEnterRoomManager.subscribe(callback)
  }

  onNavigateRoom(callback: NavigateRoomCallback): () => void {
    return this.navigateRoomManager.subscribe(callback)
  }

  /**
   * 배팅 로그 이벤트 구독 (배팅 실행, 배팅 결과)
   */
  onBetLog(callback: BetLogCallback): () => void {
    return this.betLogManager.subscribe(callback)
  }

  private emitStateChange(): void {
    this.stateManager.emit(this.getState())
  }

  private emitPrediction(prediction: Prediction): void {
    this.predictionManager.emit(prediction)
  }

  private emitResult(won: boolean, shouldMove: boolean): void {
    const stats = {
      winCount: this.statsManager.winCount,
      martin: this.statsManager.martin,
      totalWins: this.statsManager.totalWins,
      totalLosses: this.statsManager.totalLosses,
    }
    this.resultManager.emit(won, shouldMove, stats)
  }

  private emitRoomChange(reason: string): void {
    this.roomChangeManager.emit(reason)
  }

  private emitAutoEnterRoom(room: Room): void {
    this.autoEnterRoomManager.emit(room)
  }

  private emitNavigateRoom(roomId: string, roomName: string, url: string): void {
    this.navigateRoomManager.emit(roomId, roomName, url)
  }

  /**
   * 배팅 로그 이벤트 emit
   */
  private emitBetLog(event: BetLogEvent): void {
    console.log('[SemiAuto] 📝 Emitting bet log:', event)
    this.betLogManager.emit(event)
  }

  private startBettingTimer(seconds: number): void {
    // Always reset current timer
    this.stopBettingTimer()
    this.internalState.bettingTimer = seconds

    if (seconds <= 0) return

    this.bettingTimerInterval = setInterval(() => {
      if (this.internalState.bettingTimer <= 0) {
        this.stopBettingTimer()
        return
      }
      this.internalState.bettingTimer -= 1
      this.emitStateChange()
    }, 1000)
  }

  private stopBettingTimer(): void {
    if (this.bettingTimerInterval) {
      clearInterval(this.bettingTimerInterval)
      this.bettingTimerInterval = null
    }
  }

  // ==================== Cleanup ====================
  clearPendingTimers(): void {
    this.pendingTimers.forEach(timer => clearTimeout(timer))
    this.pendingTimers.clear()
    this.stopBettingTimer()
  }

  dispose(): void {
    this.clearPendingTimers()
    this.stopContinuousSearch()
    this.cleanupAdapterSubscriptions()
    this.stateManager.clear()
    this.predictionManager.clear()
    this.resultManager.clear()
    this.roomChangeManager.clear()
    this.autoEnterRoomManager.clear()
    this.navigateRoomManager.clear()
    this.betLogManager.clear()
    this.availableRooms.clear()
    this.roomPredictionStats.clear()
    this.lastHistoryLengths.clear()
    this.previousRoomIds.clear()
  }
}

export const SemiAutoService = new SemiAutoServiceImpl()
export default SemiAutoService
