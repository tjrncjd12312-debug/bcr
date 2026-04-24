// Domain Interfaces (Ports) - Clean Architecture
// These define contracts that infrastructure layer must implement
// Following Interface Segregation Principle (ISP) - small, focused interfaces

import type {
  Room,
  Prediction,
  Winner,
  RoadResult,
  GameResultEvent,
  BettingPhaseEvent,
  VirtualBetState,
  VirtualBetSettings,
  VirtualBetLog,
  RoomPattern,
  RoomFilterType,
  RoomPredictionState,
  RoomSelectionOptions,
  RoomSelectionResponse,
  SessionStatus,
} from '../entities'

// ==================== Infrastructure Ports (Driven) ====================
// These are implemented by infrastructure adapters

/**
 * Authentication Port - handles user authentication
 * Implemented by: TauriAuthAdapter
 */
export interface IAuthPort {
  login(username: string, password: string): Promise<AuthResult>
  logout(): Promise<void>
  restoreSession(): Promise<AuthResult | null>
  isLoggedIn(): Promise<boolean>
  getCurrentUser(): Promise<UserInfo | null>

  // Session management (정액 시간 + 중복 로그인)
  validateSession(): Promise<SessionStatus>
  getRemainingSeconds(): Promise<number | null>
  isSessionExpired(): Promise<boolean>
  exitApp(): Promise<void>
}

export interface AuthResult {
  success: boolean
  user?: UserInfo
  error?: string
  /** 정액 시간 (초) */
  remainingSeconds?: number
}

export interface UserInfo {
  username: string
  token: string
  siteUrl?: string
}

/**
 * CDP (Chrome DevTools Protocol) Port - handles browser automation
 * Implemented by: TauriCdpAdapter
 */
export interface ICdpPort {
  openInChrome(url: string): Promise<void>
  navigateChrome(url: string): Promise<void>
  startMonitoring(): Promise<void>
  stopMonitoring(): Promise<void>
  killChrome(): Promise<void>
  openNewTab(url: string): Promise<void>
  /** Open URL in a new Chrome window (non-CDP, keeps lobby CDP connection) */
  openInChromeNormal(url: string): Promise<void>
  /** Refresh the lobby page to keep connection alive */
  refreshLobbyPage(): Promise<boolean>
  /** Navigate to room with WebSocket blocking (reuses existing tab) */
  navigateToRoom(url: string): Promise<void>
}

/**
 * Window Port - handles application window management
 * Implemented by: TauriWindowAdapter
 */
export interface IWindowPort {
  setSize(width: number, height: number): Promise<void>
  center(): Promise<void>
  getSize(): Promise<{ width: number; height: number }>
  setPosition(x: number, y: number): Promise<void>
  setSemiAutoMode(): Promise<void>
  setNormalMode(): Promise<void>
  setFocusedMode(): Promise<void>
}

// ==================== Application Ports (Driver) ====================
// These define the use cases that application layer exposes

/**
 * Virtual Betting Use Case Port
 */
export interface IVirtualBettingUseCase {
  // State
  isEnabled(): boolean
  getGlobalBalance(): number
  getRoomState(roomId: string): VirtualBetState | null
  getSettings(): VirtualBetSettings
  getRecentLogs(count?: number): VirtualBetLog[]

  // Actions
  enable(): void
  disable(): void
  toggle(): void
  reset(): void
  resetRoom(roomId: string): void
  cancelPendingBet(roomId: string): void
  updateSettings(settings: Partial<VirtualBetSettings>): void
  syncMartingaleLevelFromServer(roomId: string, serverConsecutiveLosses: number): void

  // Betting
  placeBet(roomId: string, roomName: string, prediction: Winner | null): boolean
  resolveBet(roomId: string, roomName: string, prediction: Winner | null, result: Winner): VirtualBetLog | null
}

/**
 * Room Filter Use Case Port
 */
export interface IRoomFilterUseCase {
  getActiveFilters(): RoomFilterType[]
  toggleFilter(filterType: RoomFilterType): void
  setFilters(filterTypes: RoomFilterType[]): void
  clearFilters(): void
  detectPattern(history: RoadResult[] | Winner[]): RoomPattern | null
  matchesFilter(room: Room, predictionState: RoomPredictionState | null, filterType: RoomFilterType): boolean
  onFilterChange(callback: (filters: RoomFilterType[]) => void): () => void
}

// ==================== Utility Types ====================

export type UnsubscribeFn = () => void

// ==================== Sound Port ====================

/**
 * Sound Port - handles audio playback
 * Implemented by: SoundManager
 */
export interface ISoundPort {
  /** Initialize AudioContext - MUST be called from user gesture (click/tap) */
  init(): Promise<void>
  setEnabled(enabled: boolean): void
  isEnabled(): boolean
  play(type: 'banker' | 'player' | 'move' | 'data' | 'tie'): void
  playPrediction(prediction: 'B' | 'P' | null): void
  playMove(): void
  playData(): void
  playTie(): void
  preload(): void
  /** 완전한 리소스 해제 (AudioContext 닫기, 버퍼 정리) */
  dispose(): Promise<void>
  /** dispose 후 다시 사용하려면 호출 */
  reinitialize?(): Promise<void>
}

// ==================== Multi-Room Prediction Port ====================

/** 🆕 v3.7.0: 사용자 잔액 추적 옵션 */
export interface UserBalanceTracking {
  currentBalance?: number  // 실제 사용자 잔액
}

/**
 * Multi-Room Prediction Port - handles prediction for multiple rooms
 * Implemented by: TauriAdapter.requestPredictionForRoom
 * 🆕 betType: 베팅 전략 타입 (martingale, fibonacci, paroli, flat, custom)
 * 🆕 martinLevel: 마틴 레벨 (SKIP 임계값 조정용)
 * 🆕 minConfidence: 최소 신뢰도 (프론트 설정 우선 적용)
 * 🆕 userTracking: 사용자 잔액 추적 (실제 잔액 전달)
 */
export interface IMultiRoomPredictionPort {
  requestPredictionForRoom(
    roomId: string,
    history: Winner[] | RoadResult[],
    roomName?: string,
    remainingSeconds?: number,
    betType?: string, // 🆕 베팅 전략 타입
    martinLevel?: number, // 🆕 마틴 레벨
    minConfidence?: number, // 🆕 최소 신뢰도
    autoMode?: boolean, // 🆕 오토모드 여부 (동시방 제한 적용)
    userTracking?: UserBalanceTracking // 🆕 v3.7.0: 사용자 잔액 추적
  ): Promise<Prediction | null>

  requestBestRoomSelection(
    rooms: Room[],
    options?: RoomSelectionOptions
  ): Promise<RoomSelectionResponse | null>
}

// ==================== Casino Adapter Port ====================

/**
 * Casino Adapter Port - handles real-time game data from casino WebSocket
 * Implemented by: EvolutionAdapter
 */
export interface ICasinoAdapter {
  readonly name: string
  readonly type: 'evolution' | 'pragmatic' | 'other'
  connect(config: CasinoConfig): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  supportsRealBetting?: boolean
  placeBet?(roomId: string, betType: string, amount: number): Promise<void>
  parseMessage(raw: string): ParsedMessage | null

  // Room data access
  getRoom(roomId: string): Room | null
  getRooms(): Map<string, Room>

  // Event subscriptions
  onRoomUpdate(callback: (rooms: Room[]) => void): UnsubscribeFn
  onGameResult(callback: (event: GameResultEvent) => void): UnsubscribeFn
  onBettingPhase(callback: (event: BettingPhaseEvent) => void): UnsubscribeFn
  onHistoryUpdate(callback: (roomId: string, history: RoadResult[]) => void): UnsubscribeFn
  onShoeChange?(callback: (roomId: string, roomName: string) => void): UnsubscribeFn
  onBalanceUpdate?(callback: (balance: number) => void): UnsubscribeFn

  // Lifecycle management
  /** 완전한 리소스 해제 (콜백 배열 포함) - 앱 종료/재초기화 시 호출 */
  dispose?(): void
  /** 오래된 캐시 데이터 정리 */
  cleanupStaleCache?(maxAgeMs?: number): void
}

export interface CasinoConfig {
  wsUrl?: string
  cookies?: string
  authToken?: string
  siteUrl?: string
}

export interface ParsedMessage {
  type: string
  roomId?: string
  data: unknown
}

// ==================== Local Storage Port ====================

/**
 * Local Storage Port - handles persistent local storage
 * Implemented by: LocalStorageAdapter
 *
 * Clean Architecture: This abstracts browser localStorage access
 * so domain/application layers don't depend on browser APIs
 */
export interface ILocalStoragePort {
  get<T>(key: string): T | null
  set<T>(key: string, value: T): void
  remove(key: string): void
  has(key: string): boolean
  isAvailable(): boolean
}

// Storage key constants for type safety
export const StorageKeys = {
  EVO_CASINO_URL: 'evoCasinoUrl',
  EVO_MULTI_SOCKET_CONFIG: 'evoMultiSocketConfig',
  CUSTOM_PATTERNS: 'bcr_custom_patterns',
  LOGIN_DATA: 'bcr_login',
} as const

export type StorageKey = typeof StorageKeys[keyof typeof StorageKeys]
