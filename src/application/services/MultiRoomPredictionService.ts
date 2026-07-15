// Multi-Room Prediction Service - Manages predictions for all rooms
// Clean Architecture: Application Layer - Uses DI Container for dependencies

import type {
  Room,
  RoadResult,
  Winner,
  Prediction,
  PredictionStats,
  RoomPredictionState,
  MultiRoomPredictionState,
  GameResultEvent,
  BettingPhaseEvent,
} from '../../domain/entities'
import type {
  ICasinoAdapter,
  IMultiRoomPredictionPort,
  IRoomFilterUseCase,
  IVirtualBettingUseCase,
} from '../../domain/interfaces'
import { container } from '../di'
import { CallbackManager } from '../utils'

type StateChangeCallback = (state: MultiRoomPredictionState) => void
type PredictionCallback = (roomId: string, prediction: Prediction) => void
type ResultCallback = (roomId: string, winner: Winner, won: boolean, isReplay?: boolean) => void

const INITIAL_STATS: PredictionStats = {
  total: 0,
  correct: 0,
  winRate: 0,
  consecutiveWins: 0,
  consecutiveLosses: 0,
  maxConsecutiveWins: 0,
  maxConsecutiveLosses: 0,
}

const PREDICT_MODE_MAX_HISTORY = 5000

class MultiRoomPredictionServiceImpl {
  private state: MultiRoomPredictionState = {
    autoMode: false,  // ⚠️ 기본값 false - 사용자가 시작 버튼 누를때만 활성화
    activeFilters: [],
    roomStates: new Map(),
    globalStats: { ...INITIAL_STATS },
  }

  private stateManager = new CallbackManager<StateChangeCallback>('MultiRoomPrediction')
  private predictionManager = new CallbackManager<PredictionCallback>('MultiRoomPrediction')
  private resultManager = new CallbackManager<ResultCallback>('MultiRoomPrediction')

  // Pending predictions waiting for results
  private pendingPredictions: Map<string, Prediction> = new Map()

  // Full history tracking for predict mode (fixed-length history 보완)
  private fullHistories: Map<string, RoadResult[]> = new Map()

  // Explicit adapter shoe-change signals. Short history alone is not proof of a new shoe.
  private shoeChangeDetectedAtByRoom: Map<string, number> = new Map()

  // Timer management for cleanup
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set()

  // ✅ FIX: 방별 클리어 타이머 관리 - 새 예측 시 취소 가능하도록
  private clearTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  // Dirty tracking for optimized getState() - only deep-copy rooms that changed
  private dirtyRooms = new Set<string>()
  private _lastEmittedState: MultiRoomPredictionState | null = null
  private _topLevelDirty = false  // Invalidate cache on autoMode/activeFilters/globalStats changes

  // Subscription cleanup functions
  private subscriptions: Array<() => void> = []

  // 🆕 v3.7.0: 실제 사용자 잔액 추적
  private realBalance: number | null = null

  // 🔥 포커스 모드: 해당 방은 autoMode 상관없이 항상 예측 요청
  private focusedRoomId: string | null = null

  // 🔥 예측 모드: autoMode와 별개로 모든 방에 대해 예측 요청 (실제 배팅 없음)
  private predictModeActive: boolean = false

  // 🔥 상태 변경 디바운싱 - UI 업데이트 최적화
  private stateChangeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly STATE_CHANGE_DEBOUNCE_MS = 100 // 100ms 디바운싱

  // Lazy-loaded dependencies (from DI container)
  private _casinoAdapter: ICasinoAdapter | null = null
  private _multiRoomPredictionPort: IMultiRoomPredictionPort | null = null
  private _roomFilterUseCase: IRoomFilterUseCase | null = null
  private _virtualBettingUseCase: IVirtualBettingUseCase | null = null

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

  private get virtualBettingUseCase(): IVirtualBettingUseCase {
    if (!this._virtualBettingUseCase) {
      this._virtualBettingUseCase = container.get('virtualBettingUseCase')
    }
    return this._virtualBettingUseCase
  }

  private historySliceEqual(
    a: RoadResult[],
    aStart: number,
    b: RoadResult[],
    bStart: number,
    length: number
  ): boolean {
    for (let i = 0; i < length; i++) {
      const x = a[aStart + i]
      const y = b[bStart + i]
      if (!x || !y) return false
      if (
        x.winner !== y.winner ||
        x.isPlayerPair !== y.isPlayerPair ||
        x.isBankerPair !== y.isBankerPair
      ) {
        return false
      }
    }
    return true
  }

  private mergeFullHistory(roomId: string, newHistory: RoadResult[]): RoadResult[] {
    if (!newHistory || newHistory.length === 0) {
      this.fullHistories.set(roomId, [])
      return []
    }

    const existing = this.fullHistories.get(roomId)
    if (!existing || existing.length === 0) {
      const initial = [...newHistory]
      this.fullHistories.set(roomId, initial)
      return initial
    }

    const maxOverlap = Math.min(newHistory.length, existing.length)
    let overlapSize = 0
    for (let size = maxOverlap; size >= 1; size--) {
      const newStart = newHistory.length - size
      if (this.historySliceEqual(newHistory, newStart, existing, 0, size)) {
        overlapSize = size
        break
      }
    }

    if (overlapSize === 0) {
      const reset = [...newHistory]
      this.fullHistories.set(roomId, reset)
      return reset
    }

    const newPrefix = newHistory.slice(0, newHistory.length - overlapSize)
    if (newPrefix.length === 0) {
      return existing
    }

    const merged = [...newPrefix, ...existing].slice(0, PREDICT_MODE_MAX_HISTORY)
    this.fullHistories.set(roomId, merged)
    return merged
  }

  private getPredictionHistory(room: Room): RoadResult[] {
    if (this.state.autoMode) {
      return room.history
    }
    return this.mergeFullHistory(room.id, room.history)
  }

  /**
   * Initialize subscriptions - call after DI container is set up
   */
  initialize(): void {
    // Clean up existing subscriptions to prevent duplicates
    this.cleanupSubscriptions()

    // Subscribe to filter changes
    const unsubFilter = this.roomFilterUseCase.onFilterChange((filters) => {
      this.state.activeFilters = filters
      this._topLevelDirty = true
      this.emitStateChange(true) // 필터 변경은 즉시 반영
    })
    this.subscriptions.push(unsubFilter)

    // Subscribe to shoe change events to clear pending predictions
    const unsubShoe = this.casinoAdapter.onShoeChange?.((roomId: string, _koreanName: string) => {
      this.onShoeChange(roomId)
    })
    if (unsubShoe) {
      this.subscriptions.push(unsubShoe)
    }

    // 🆕 v3.7.0: 실제 잔액 업데이트 구독
    const unsubBalance = this.casinoAdapter.onBalanceUpdate?.((balance) => {
      this.realBalance = balance
    })
    if (unsubBalance) {
      this.subscriptions.push(unsubBalance)
    }
  }

  /**
   * Clean up subscriptions
   */
  private cleanupSubscriptions(): void {
    this.subscriptions.forEach(unsub => unsub())
    this.subscriptions = []
    this.realBalance = null // 🆕 잔액 추적 초기화
  }

  /**
   * Handle shoe change - clear predictions and reset room state
   */
  private onShoeChange(roomId: string): void {
    const detectedAt = Date.now()
    this.shoeChangeDetectedAtByRoom.set(roomId, detectedAt)

    // Clear pending prediction for this room
    this.pendingPredictions.delete(roomId)
    this.fullHistories.delete(roomId)

    // Reset room state prediction and history
    const roomState = this.state.roomStates.get(roomId)
    if (roomState) {
      this.dirtyRooms.add(roomId)
      roomState.lastPrediction = null
      // Keep stats but reset consecutive counters
      roomState.stats.consecutiveWins = 0
      roomState.stats.consecutiveLosses = 0
      // ✅ Clear prediction history for new shoe
      roomState.history = []
      // 🔥 슈 초기화 상태 설정 - UI가 즉시 오버레이 표시
      roomState.isShoeReset = true
      roomState.shoeChangeDetectedAt = detectedAt
    }

    // Also reset virtual betting state for this room
    this.virtualBettingUseCase.resetRoom(roomId)

    this.emitStateChange()
  }

  // Getters
  // ✅ OPT: Only deep-copy rooms in dirtyRooms; reuse references for unchanged rooms
  getState(): MultiRoomPredictionState {
    if (this.dirtyRooms.size === 0 && !this._topLevelDirty && this._lastEmittedState) {
      return this._lastEmittedState
    }

    const newRoomStates = new Map<string, RoomPredictionState>()
    this.state.roomStates.forEach((state, key) => {
      if (this.dirtyRooms.has(key) || !this._lastEmittedState) {
        newRoomStates.set(key, {
          ...state,
          stats: { ...state.stats },
          lastPrediction: state.lastPrediction ? { ...state.lastPrediction } : null,
          history: [...state.history],
        })
      } else {
        const prev = this._lastEmittedState.roomStates.get(key)
        newRoomStates.set(key, prev ?? {
          ...state,
          stats: { ...state.stats },
          lastPrediction: state.lastPrediction ? { ...state.lastPrediction } : null,
          history: [...state.history],
        })
      }
    })

    this.dirtyRooms.clear()
    this._topLevelDirty = false
    this._lastEmittedState = {
      ...this.state,
      roomStates: newRoomStates,
      globalStats: { ...this.state.globalStats },
    }
    return this._lastEmittedState
  }

  isAutoMode(): boolean {
    return this.state.autoMode
  }

  getRoomState(roomId: string): RoomPredictionState | null {
    return this.state.roomStates.get(roomId) || null
  }

  getGlobalStats(): PredictionStats {
    return { ...this.state.globalStats }
  }

  getAllRoomStates(): Map<string, RoomPredictionState> {
    return new Map(this.state.roomStates)
  }

  // Actions
  setAutoMode(enabled: boolean): void {
    this.state.autoMode = enabled
    this._topLevelDirty = true

    // ⚠️ CRITICAL: When turning OFF, clear all predictions immediately
    if (!enabled) {
      this.pendingPredictions.clear()
      this.state.roomStates.forEach((_, id) => this.dirtyRooms.add(id))
      this.state.roomStates.forEach(roomState => {
        roomState.lastPrediction = null
      })
      // Also clear pending timers to prevent delayed predictions
      this.pendingTimers.forEach(timer => clearTimeout(timer))
      this.pendingTimers.clear()
      this.clearTimers.forEach(timer => clearTimeout(timer))
      this.clearTimers.clear()
    }

    this.emitStateChange(true) // 사용자 액션 - 즉시 반영
  }

  toggleAutoMode(): void {
    this.state.autoMode = !this.state.autoMode
    this._topLevelDirty = true
    this.emitStateChange(true) // 사용자 액션 - 즉시 반영
  }

  /**
   * Initialize or update room state
   */
  initRoom(room: Room): void {
    if (!this.state.roomStates.has(room.id)) {
      const pattern = this.roomFilterUseCase.detectPattern(room.history)
      this.dirtyRooms.add(room.id)
      this.state.roomStates.set(room.id, {
        roomId: room.id,
        roomName: room.koreanName,
        lastPrediction: null,
        stats: { ...INITIAL_STATS },
        pattern,
        isFiltered: false, // ✅ Fixed duplicate property
        predictionCount: 0,
        history: [], // ✅ Initialize empty history
        shoeChangeDetectedAt: this.shoeChangeDetectedAtByRoom.get(room.id),
      })
    } else {
      // Update pattern
      const roomState = this.state.roomStates.get(room.id)!
      this.dirtyRooms.add(room.id)
      roomState.pattern = this.roomFilterUseCase.detectPattern(room.history)
      roomState.roomName = room.koreanName
    }
  }

  // 🔥 최소 히스토리 길이 (이 미만이면 예측하지 않음)
  private static readonly MIN_HISTORY_LENGTH = 5

  /**
   * Request prediction for a specific room
   * ✅ 히스토리 길이 기반 중복 체크 - 같은 히스토리면 스킵, 다르면 새 예측 허용
   * 🆕 betType: 베팅 전략 타입 (martingale, fibonacci, paroli, flat, custom)
   */
  async requestPrediction(room: Room, betType?: string): Promise<Prediction | null> {
    const predictionHistory = this.getPredictionHistory(room)
    const historyLength = predictionHistory.length || 0

    // Initialize room if needed
    this.initRoom(room)

    // 🔥 히스토리 5개 미만이면 예측하지 않음 (슈 초기화 상태)
    const roomState = this.state.roomStates.get(room.id)
    if (historyLength < MultiRoomPredictionServiceImpl.MIN_HISTORY_LENGTH) {

      // isShoeReset 상태 업데이트
      if (roomState && !roomState.isShoeReset) {
        this.dirtyRooms.add(room.id)
        this.state.roomStates.set(room.id, {
          ...roomState,
          isShoeReset: true,
          lastPrediction: null,
        })
        this.emitStateChange()
      }
      return null
    }

    // 슈 리셋 상태 해제
    if (roomState?.isShoeReset) {
      this.dirtyRooms.add(room.id)
      this.state.roomStates.set(room.id, {
        ...roomState,
        isShoeReset: false,
      })
      this.emitStateChange()
    }

    if (!roomState) {
      return null
    }

    // ✅ 개선된 중복 체크: 같은 히스토리 길이에 대한 pending만 스킵
    // 새 결과가 들어와서 히스토리가 변경되면 새 예측 허용
    const existingPrediction = this.pendingPredictions.get(room.id)
    if (existingPrediction) {
      // 이전 예측과 현재 히스토리 길이 비교
      const prevHistoryLength = (existingPrediction as any)._historyLength || 0
      if (prevHistoryLength === historyLength) {
        return null
      }
      // 히스토리가 변경됨 - 이전 pending 클리어하고 새 예측 진행
      this.pendingPredictions.delete(room.id)
    }

    try {
      // ✅ Request prediction with actual roomName, remainingSeconds, and betType
      // 🆕 v3.8.0: 예측 모드도 서버 자율 - minConfidence 전달하지 않음
      // 서버가 자체 동적 로직으로 SKIP 결정 (예측 모드: maxSkipRounds=3, ML임계값=0.52로 관대함)
      const minConfidence = undefined

      // 🆕 v3.7.0: 실제 잔액 추적 - 모든 모드에서 실제 잔액 전달
      const userTracking = this.realBalance != null
        ? { currentBalance: this.realBalance }
        : undefined

      const prediction = await this.multiRoomPredictionPort.requestPredictionForRoom(
        room.id,
        predictionHistory,
        room.koreanName,
        room.remainingSeconds ?? 15,
        betType, // 🆕 베팅 전략 타입 전달
        undefined,
        minConfidence,
        this.state.autoMode,
        userTracking // 🆕 v3.7.0: 사용자 잔액 추적
      )

      if (prediction) {
        // ✅ FIX: 새 예측이 들어오면 기존 클리어 타이머 취소
        const existingClearTimer = this.clearTimers.get(room.id)
        if (existingClearTimer) {
          clearTimeout(existingClearTimer)
          this.clearTimers.delete(room.id)
        }

        this.dirtyRooms.add(room.id)
        roomState.lastPrediction = prediction
        roomState.predictionCount++ // Increment for visual feedback (even if same prediction)

        // 예측모드에서는 클라이언트가 자체적으로 마틴 레벨 추적 (서버 동기화 안 함)
        // 오토모드에서만 서버 streak_tracking 정보로 동기화
        if (this.state.autoMode && prediction.streakTracking) {
          const serverStats = prediction.streakTracking
          roomState.stats.consecutiveLosses = serverStats.consecutiveLosses
          roomState.stats.consecutiveWins = serverStats.consecutiveWins
          roomState.stats.total = serverStats.totalPredictions
          roomState.stats.correct = serverStats.totalWins
          roomState.stats.winRate = serverStats.winRate * 100 // 서버는 0-1, 클라이언트는 0-100

        }

        // ✅ 히스토리 길이 저장 (중복 체크용)
        ; (prediction as any)._historyLength = historyLength

          // 🆕 SKIP 예측도 pendingPredictions에 저장 (ML 데이터 신뢰성 강화)
          // wasBetPlaced 플래그로 배팅 여부 구분
          ; (prediction as any)._wasBetPlaced = !prediction.isSkip
        this.pendingPredictions.set(room.id, prediction)

        // If SKIP prediction, don't place bet but still track for result
        if (prediction.isSkip) {
          this.emitStateChange(true) // 예측 결과 - 즉시 반영
          this.emitPrediction(room.id, prediction)
          return prediction
        }

        // Normal prediction - place bet

        // Place virtual bet if enabled (only for non-skip predictions)
        // NOTE: AutoModeService has its own betting logic with placeBetWithAmount()
        // This is for Predict Mode (예측모드) where users can manually enable virtual betting
        // ✅ FIX: 예측모드에서 가상배팅이 비활성화되어 있으면 자동 활성화
        // 예측모드는 가상배팅으로 마틴 레벨을 추적해야 SKIP 후에도 레벨이 유지됨
        if (!this.virtualBettingUseCase.isEnabled()) {
          this.virtualBettingUseCase.enable()
        }

        // 예측모드에서는 클라이언트가 자체적으로 마틴 레벨 추적
        // 오토모드에서만 서버 연패 정보를 VirtualBetting에 동기화
        if (this.state.autoMode && prediction.streakTracking && prediction.streakTracking.consecutiveLosses > 0) {
          this.virtualBettingUseCase.syncMartingaleLevelFromServer(
            room.id,
            prediction.streakTracking.consecutiveLosses
          )
        }

        this.virtualBettingUseCase.placeBet(room.id, room.koreanName, prediction.prediction)
        this.emitStateChange(true) // 예측 결과 - 즉시 반영
        this.emitPrediction(room.id, prediction)

      }

      return prediction
    } catch (error) {
      return null
    }
  }

  /**
   * Handle game result for a room
   * In lobby mode, also triggers prediction for next round if auto mode is ON
   */
  async onGameResult(event: GameResultEvent, room: Room): Promise<void> {
    const { roomId, winner } = event
    this.dirtyRooms.add(roomId)

    // Fetch latest room data from adapter (room param might be stale due to RAF batching)
    const latestRoom = this.casinoAdapter.getRoom(roomId) || room
    const roomName = latestRoom.koreanName


    // Initialize room state if needed
    this.initRoom(latestRoom)

    // Get pending prediction for this room
    const prediction = this.pendingPredictions.get(roomId)

    if (prediction) {
      // Clear pending prediction
      this.pendingPredictions.delete(roomId)

      // SKIP 예측은 승률 계산에서 제외 (패스는 배팅하지 않았으므로)
      const isSkipPrediction = prediction.isSkip || !prediction.prediction

      // Skip ties and SKIP predictions for win/loss calculation
      if (winner !== 'T' && !isSkipPrediction) {
        const won = prediction.prediction === winner

        // Update room stats
        const roomState = this.state.roomStates.get(roomId)
        if (roomState) {
          // ✅ 예측 결과를 2초간 유지 후 클리어 (즉시 클리어하지 않음)
          // 사용자가 예측 결과를 볼 시간 확보
          roomState.stats.total++
          if (won) {
            roomState.stats.correct++
            roomState.stats.consecutiveWins++
            roomState.stats.consecutiveLosses = 0
            // 최대 연승 기록 갱신
            if (roomState.stats.consecutiveWins > roomState.stats.maxConsecutiveWins) {
              roomState.stats.maxConsecutiveWins = roomState.stats.consecutiveWins
            }
          } else {
            roomState.stats.consecutiveLosses++
            roomState.stats.consecutiveWins = 0
            // 최대 연패 기록 갱신
            if (roomState.stats.consecutiveLosses > roomState.stats.maxConsecutiveLosses) {
              roomState.stats.maxConsecutiveLosses = roomState.stats.consecutiveLosses
            }
          }

          // ✅ Add to prediction history
          roomState.history.unshift({
            result: won ? 'WIN' : 'LOSS',
            prediction: (prediction.prediction as Winner) || 'T', // Cast or fallback. Since we checked winner != 'T' and !isSkip, prediction should be B or P ideally.
            actual: winner,
            timestamp: Date.now(),
            playerScore: event.playerScore,
            bankerScore: event.bankerScore,
          })
          // ✅ 슈 체인지까지 무제한 누적 (슈 체인지 시 onShoeChange에서 리셋)

          roomState.stats.winRate = roomState.stats.total > 0
            ? (roomState.stats.correct / roomState.stats.total) * 100
            : 0

          // ✅ 2초 후 lastPrediction 클리어 (새 예측이 들어오면 취소됨)
          const capturedRoomId = roomId

          // 기존 클리어 타이머가 있으면 먼저 취소
          const existingTimer = this.clearTimers.get(capturedRoomId)
          if (existingTimer) {
            clearTimeout(existingTimer)
            this.pendingTimers.delete(existingTimer)
          }

          const clearTimer = setTimeout(() => {
            this.pendingTimers.delete(clearTimer)
            this.clearTimers.delete(capturedRoomId)
            const state = this.state.roomStates.get(capturedRoomId)
            if (state) {
              this.dirtyRooms.add(capturedRoomId)
              state.lastPrediction = null
              this.emitStateChange()
            }
          }, 2000)
          this.pendingTimers.add(clearTimer)
          this.clearTimers.set(capturedRoomId, clearTimer)
        }

        // Update global stats
        this.state.globalStats.total++
        if (won) {
          this.state.globalStats.correct++
          this.state.globalStats.consecutiveWins++
          this.state.globalStats.consecutiveLosses = 0
          // 전체 최대 연승 기록 갱신
          if (this.state.globalStats.consecutiveWins > this.state.globalStats.maxConsecutiveWins) {
            this.state.globalStats.maxConsecutiveWins = this.state.globalStats.consecutiveWins
          }
        } else {
          this.state.globalStats.consecutiveLosses++
          this.state.globalStats.consecutiveWins = 0
          // 전체 최대 연패 기록 갱신
          if (this.state.globalStats.consecutiveLosses > this.state.globalStats.maxConsecutiveLosses) {
            this.state.globalStats.maxConsecutiveLosses = this.state.globalStats.consecutiveLosses
          }
        }
        this.state.globalStats.winRate = this.state.globalStats.total > 0
          ? (this.state.globalStats.correct / this.state.globalStats.total) * 100
          : 0

        // Resolve virtual bet
        this.virtualBettingUseCase.resolveBet(roomId, roomName, prediction.prediction, winner)
        this.emitResult(roomId, winner, won, event.isReplay)
      } else {
        // ✅ Tie or Skip result tracking
        const roomState = this.state.roomStates.get(roomId)
        if (roomState && !isSkipPrediction) {
          // Tie occurred on a valid prediction
          roomState.history.unshift({
            result: 'TIE',
            prediction: (prediction.prediction as Winner) || 'T',
            actual: winner,
            timestamp: Date.now(),
            playerScore: event.playerScore,
            bankerScore: event.bankerScore,
          })
        } else if (roomState && isSkipPrediction) {
          // Track SKIP result if needed, or just ignore for O/X view
          // For now, let's track it as SKIP so we can show it if desired
          roomState.history.unshift({
            result: 'SKIP',
            prediction: (prediction.prediction as Winner) || 'T', // Might be null/undefined logic
            actual: winner,
            timestamp: Date.now(),
            playerScore: event.playerScore,
            bankerScore: event.bankerScore,
          })
        }

        // ✅ Tie: push(환불) 처리 - pending bet이 남아있으면 다음 배팅이 막힐 수 있음
        this.virtualBettingUseCase.resolveBet(roomId, roomName, prediction.prediction, winner)
      }
    } else {
      // ✅ 예측이 없어도 히스토리에 SKIP 추가하여 room.history와 동기화 유지
      const roomState = this.state.roomStates.get(roomId)
      if (roomState) {
        roomState.history.unshift({
          result: 'SKIP',
          prediction: 'T', // 예측 없음
          actual: winner,
          timestamp: Date.now(),
          playerScore: event.playerScore,
          bankerScore: event.bankerScore,
        })
      }
    }

    this.emitStateChange(true) // 게임 결과 - 즉시 반영

    // ========== LOBBY MODE: Always predict for next round after result ==========
    // This enables predictions in BOTH predict mode and auto mode
    // The "autoMode" flag is only used for UI (showing "배팅중" status) not for prediction logic
    const capturedRoomId = roomId  // Capture roomId for closure
    const capturedRoom = latestRoom  // Capture room for Pragmatic (not in casinoAdapter)
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timer)

      // Fetch latest room data from adapter to get updated history
      // Pragmatic rooms are not in casinoAdapter, so use captured room as fallback
      const roomFromAdapter = this.casinoAdapter.getRoom(capturedRoomId) || capturedRoom
      if (roomFromAdapter) {
        try {
          await this.requestPrediction(roomFromAdapter)
        } catch (error) {
        }
      } else {
      }
    }, 300)
    this.pendingTimers.add(timer)
  }

  /**
   * 🔥 포커스 모드 설정 - 해당 방은 autoMode 상관없이 항상 예측 요청
   */
  setFocusedRoomId(roomId: string | null): void {
    this.focusedRoomId = roomId
  }

  /**
   * 🔥 예측 모드 활성화/비활성화 - autoMode와 별개로 모든 방에 대해 예측 요청
   * 실제 배팅 로직(AutoModeService)에는 영향 없음
   */
  setPredictModeActive(active: boolean): void {
    this.predictModeActive = active
  }

  /**
   * Handle betting phase - trigger predictions for all rooms if auto mode or predict mode
   * 🔥 포커스 모드: 포커스된 방은 autoMode 상관없이 항상 예측 요청
   * 🔥 예측 모드: predictModeActive가 true면 모든 방에 대해 예측 요청
   */
  async onBettingPhase(event: BettingPhaseEvent, rooms: Map<string, Room>): Promise<void> {
    // Only predict at start of betting phase with enough time (5초 미만이면 스킵)
    if (event.phase !== 'start' || event.remainingSeconds < 5) return

    const room = rooms.get(event.roomId)
    if (!room) return

    // 🔥 포커스 모드: 포커스된 방은 autoMode 상관없이 항상 예측 요청
    const isFocusedRoom = this.focusedRoomId === event.roomId


    // autoMode, predictModeActive, 포커스된 방 중 하나라도 해당되면 예측 진행
    if (!this.state.autoMode && !this.predictModeActive && !isFocusedRoom) {
      return
    }

    // Initialize room
    this.initRoom(room)

    // Check if room passes active filters (포커스 모드는 필터 무시)
    if (!isFocusedRoom) {
      const roomState = this.state.roomStates.get(room.id)
      if (this.state.activeFilters.length > 0) {
        // Check if room matches any active filter
        const matchesAnyFilter = this.state.activeFilters.some(filterType =>
          this.roomFilterUseCase.matchesFilter(room, roomState || null, filterType)
        )
        if (!matchesAnyFilter) {
          // Room doesn't match any active filter
          return
        }
      }
    }

    // Request prediction for this room
    if (isFocusedRoom) {
    }
    await this.requestPrediction(room)
  }

  /**
   * Reset all stats
   */
  resetStats(): void {
    this.state.roomStates.forEach((_, id) => this.dirtyRooms.add(id))
    this.state.globalStats = { ...INITIAL_STATS }
    this.state.roomStates.forEach(roomState => {
      roomState.stats = { ...INITIAL_STATS }
      roomState.lastPrediction = null
      roomState.predictionCount = 0
      roomState.history = [] // ✅ Reset history
    })
    this.pendingPredictions.clear()
    this.fullHistories.clear()
    this.emitStateChange(true) // 사용자 액션 - 즉시 반영
  }

  /**
   * Clear all prediction histories (for reconnection)
   * 재연결 시 히스토리만 초기화 - 통계는 유지
   */
  clearAllHistories(): void {
    this.state.roomStates.forEach((_, id) => this.dirtyRooms.add(id))

    // Clear pending predictions
    this.pendingPredictions.clear()

    // Clear full histories
    this.fullHistories.clear()

    // Clear all pending/clear timers
    this.pendingTimers.forEach(timer => clearTimeout(timer))
    this.pendingTimers.clear()
    this.clearTimers.forEach(timer => clearTimeout(timer))
    this.clearTimers.clear()

    // Clear room prediction histories and current predictions
    this.state.roomStates.forEach(roomState => {
      roomState.lastPrediction = null
      roomState.history = []
      // 연승/연패도 초기화 (새 세션이므로)
      roomState.stats.consecutiveWins = 0
      roomState.stats.consecutiveLosses = 0
    })

    this.emitStateChange(true) // 재연결 - 즉시 반영
  }

  // Subscriptions
  onStateChange(callback: StateChangeCallback): () => void {
    return this.stateManager.subscribe(callback)
  }

  onPrediction(callback: PredictionCallback): () => void {
    return this.predictionManager.subscribe(callback)
  }

  onResult(callback: ResultCallback): () => void {
    return this.resultManager.subscribe(callback)
  }

  /**
   * 🔥 디바운싱된 상태 변경 emit
   * - 빠른 연속 업데이트를 100ms 단위로 배칭
   * - immediate=true면 즉시 emit (예측/결과 등 중요한 업데이트)
   */
  private emitStateChange(immediate?: boolean): void {
    // 즉시 emit이 필요한 경우 (예측 결과, autoMode 토글 등)
    if (immediate) {
      if (this.stateChangeDebounceTimer) {
        clearTimeout(this.stateChangeDebounceTimer)
        this.stateChangeDebounceTimer = null
      }
      this.stateManager.emit(this.getState())
      return
    }

    // 디바운싱: 이미 타이머가 있으면 무시 (마지막 emit에서 최신 상태 전달)
    if (this.stateChangeDebounceTimer) {
      return
    }

    this.stateChangeDebounceTimer = setTimeout(() => {
      this.stateChangeDebounceTimer = null
      this.stateManager.emit(this.getState())
    }, MultiRoomPredictionServiceImpl.STATE_CHANGE_DEBOUNCE_MS)
  }

  private emitPrediction(roomId: string, prediction: Prediction): void {
    this.predictionManager.emit(roomId, prediction)
  }

  private emitResult(roomId: string, winner: Winner, won: boolean, isReplay?: boolean): void {
    this.resultManager.emit(roomId, winner, won, isReplay)
  }

  /**
   * 🧹 Lane F3 (perf-plan): Evict per-room state for rooms that are no longer active.
   *
   * Call this after the active room set (subscribed/visible rooms) changes so the
   * service's internal Maps do not grow unbounded as users navigate between rooms
   * or disconnect/reconnect. Only entries whose key is NOT in `activeRoomIds`
   * are removed.
   *
   * Maps cleaned:
   *  - fullHistories
   *  - pendingPredictions
   *  - dirtyRooms
   *  - state.roomStates
   *  - clearTimers (timeouts are cleared before deletion)
   *
   * Idempotent: repeated calls with the same set are no-ops. When nothing is
   * evicted no state-change callback is emitted, avoiding spurious re-renders.
   *
   * Public API addition — non-breaking. Existing method names and shapes are
   * preserved.
   */
  syncActiveRooms(activeRoomIds: Set<string>): void {
    let evicted = 0

    this.fullHistories.forEach((_, id) => {
      if (!activeRoomIds.has(id)) {
        this.fullHistories.delete(id)
        evicted++
      }
    })

    this.pendingPredictions.forEach((_, id) => {
      if (!activeRoomIds.has(id)) {
        this.pendingPredictions.delete(id)
        evicted++
      }
    })

    this.dirtyRooms.forEach((id) => {
      if (!activeRoomIds.has(id)) {
        this.dirtyRooms.delete(id)
        evicted++
      }
    })

    this.state.roomStates.forEach((_, id) => {
      if (!activeRoomIds.has(id)) {
        this.state.roomStates.delete(id)
        evicted++
      }
    })

    this.clearTimers.forEach((timer, id) => {
      if (!activeRoomIds.has(id)) {
        clearTimeout(timer)
        this.pendingTimers.delete(timer)
        this.clearTimers.delete(id)
        evicted++
      }
    })

    if (evicted > 0) {
      // Invalidate memoized state and notify subscribers so UI can drop stale rows.
      this._topLevelDirty = true
      this._lastEmittedState = null
      this.emitStateChange(true)
    }
  }

  /**
   * Clear all pending timers (memory leak prevention)
   */
  clearPendingTimers(): void {
    this.pendingTimers.forEach((timer) => clearTimeout(timer))
    this.pendingTimers.clear()
  }

  /**
   * Cleanup service resources
   */
  dispose(): void {
    this.cleanupSubscriptions()
    this.clearPendingTimers()
    // ✅ clearTimers도 정리
    this.clearTimers.forEach((timer) => clearTimeout(timer))
    this.clearTimers.clear()
    // 🔥 디바운스 타이머 정리
    if (this.stateChangeDebounceTimer) {
      clearTimeout(this.stateChangeDebounceTimer)
      this.stateChangeDebounceTimer = null
    }
    this.stateManager.clear()
    this.predictionManager.clear()
    this.resultManager.clear()
    this.pendingPredictions.clear()
    this.state.roomStates.clear()
    this.fullHistories.clear()
    this.shoeChangeDetectedAtByRoom.clear()
    this.dirtyRooms.clear()
    this._topLevelDirty = false
    this._lastEmittedState = null
  }
}

export const MultiRoomPredictionService = new MultiRoomPredictionServiceImpl()
export default MultiRoomPredictionService
