// TauriAdapter - Facade Pattern
// Clean Architecture: Infrastructure Layer
// 역할: 분리된 어댑터들을 통합하여 기존 API 호환성 유지
// 새 코드에서는 직접 TauriConnectionAdapter, TauriPredictionAdapter 등 사용 권장

import { TauriWindowAdapter } from './tauri/TauriWindowAdapter'
import { TauriConnectionAdapter } from './tauri/TauriConnectionAdapter'
import { TauriPredictionAdapter } from './tauri/TauriPredictionAdapter'
import { TauriCdpAdapter } from './tauri/TauriCdpAdapter'
import {
  TauriSessionMonitorAdapter,
  type SessionValidEvent,
  type SessionWarningEvent,
  type SessionExpiredEvent,
  type SessionErrorEvent,
  type ForceQuitEvent,
  type SessionValidationResult,
  type StartMonitoringResult,
} from './tauri/TauriSessionMonitorAdapter'

import { invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type {
  Winner,
  Prediction,
  Room,
  RoadResult,
  RoomSelectionOptions,
  RoomSelectionResponse,
  V2PredictionResponse,
  V2ResultComparison,
  V2RoomGameData,
} from '../../domain/entities'

// ==================== Re-export Types for Backward Compatibility ====================

export type {
  SessionValidEvent,
  SessionWarningEvent,
  SessionExpiredEvent,
  SessionErrorEvent,
  ForceQuitEvent,
  SessionValidationResult,
  StartMonitoringResult,
}

export type SessionEventType =
  | 'session:valid'
  | 'session:expiry_warning'
  | 'session:expiry_soon'
  | 'session:expired'
  | 'session:duplicate_login'
  | 'session:token_revoked'
  | 'session:network_error'
  | 'session:server_error'
  | 'session:force_quit'
  | 'session:event'

// User info type from Tauri backend
interface TauriUserInfo {
  username: string
  token: string
  siteUrl?: string
}

// ==================== TauriAdapter Facade ====================

export const TauriAdapter = {
  // ================== Prediction Commands ==================
  // Delegates to TauriPredictionAdapter

  async requestPredictionWithHistory(
    roomId: string,
    roomName: string,
    history: Winner[],
    remainingSeconds: number,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean
  ): Promise<Prediction | null> {
    return TauriPredictionAdapter.requestPredictionWithHistory(
      roomId, roomName, history, remainingSeconds, martinLevel, minConfidence, autoMode
    )
  },

  async requestPredictionForRoom(
    roomId: string,
    history: Winner[] | RoadResult[],
    roomName?: string,
    remainingSeconds?: number,
    betType?: string,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean
  ): Promise<Prediction | null> {
    return TauriPredictionAdapter.requestPredictionForRoom(
      roomId, history, roomName, remainingSeconds, betType, martinLevel, minConfidence, autoMode
    )
  },

  async requestBestRoomSelection(
    rooms: Room[],
    options?: RoomSelectionOptions
  ): Promise<RoomSelectionResponse | null> {
    return TauriPredictionAdapter.requestBestRoomSelection(rooms, options)
  },

  async _doInvokePrediction(
    roomId: string,
    history: Winner[],
    roomName: string,
    remainingSeconds: number,
    betType?: string,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean
  ): Promise<Prediction | null> {
    return TauriPredictionAdapter._doInvokePrediction(
      roomId, history, roomName, remainingSeconds, betType, martinLevel, minConfidence, autoMode
    )
  },

  // ================== Room Commands ==================
  // Delegates to TauriPredictionAdapter

  async getAllRooms(): Promise<Room[]> {
    return TauriPredictionAdapter.getAllRooms()
  },

  async getRankedRooms(): Promise<Room[]> {
    return TauriPredictionAdapter.getRankedRooms()
  },

  // ================== Connection Commands ==================
  // Delegates to TauriConnectionAdapter
  // Note: 실제 WS 연결은 evolution/multi_client.rs에서 처리

  async connectEvolutionMultiSocket(params: {
    wsUrl: string
    origin?: string
    cookie?: string
    userAgent?: string
  }): Promise<void> {
    return TauriConnectionAdapter.connectEvolutionMultiSocket(params)
  },

  async disconnectEvolutionMultiSocket(): Promise<void> {
    return TauriConnectionAdapter.disconnectEvolutionMultiSocket()
  },

  async sendEvolutionMultiMessage(message: string): Promise<void> {
    return TauriConnectionAdapter.sendEvolutionMultiMessage(message)
  },

  async resubscribeEvolutionTable(tableId: string): Promise<void> {
    return TauriConnectionAdapter.resubscribeEvolutionTable(tableId)
  },

  async getEvolutionMultiStatus(): Promise<boolean> {
    return TauriConnectionAdapter.getEvolutionMultiStatus()
  },

  async connectEvolutionManual(wsUrl: string, cookies?: string): Promise<void> {
    return TauriConnectionAdapter.connectEvolutionManual(wsUrl, cookies)
  },

  async getConnectionStatus(): Promise<{ connected: boolean; roomCount: number; predictableRooms: number }> {
    return TauriConnectionAdapter.getConnectionStatus()
  },

  // ================== Chrome/CDP Commands ==================
  // Delegates to TauriCdpAdapter

  async openInChrome(url: string): Promise<void> {
    return TauriCdpAdapter.openInChrome(url)
  },

  async startCdpMonitoring(): Promise<void> {
    return TauriCdpAdapter.startMonitoring()
  },

  async stopCdpMonitoring(): Promise<void> {
    return TauriCdpAdapter.stopMonitoring()
  },

  async killChrome(): Promise<void> {
    return TauriCdpAdapter.killChrome()
  },

  async navigateChrome(url: string): Promise<void> {
    return TauriCdpAdapter.navigateChrome(url)
  },

  async openInChromeNormal(url: string): Promise<void> {
    return TauriCdpAdapter.openInChromeNormal(url)
  },

  async openNewTabCdp(url: string): Promise<void> {
    return TauriCdpAdapter.openNewTab(url)
  },

  async refreshLobbyPage(): Promise<boolean> {
    return TauriConnectionAdapter.refreshLobbyPage()
  },

  // ================== Auth Commands ==================
  // Direct invoke for backward compatibility
  // New code should use TauriAuthAdapter directly

  async login(username: string, password: string): Promise<TauriUserInfo | null> {
    try {
      return await invoke<TauriUserInfo>('login', { username, password })
    } catch {
      return null
    }
  },

  async logout(): Promise<void> {
    await invoke('logout')
  },

  async restoreSession(): Promise<TauriUserInfo | null> {
    try {
      return await invoke<TauriUserInfo | null>('restore_session')
    } catch {
      return null
    }
  },

  async isLoggedIn(): Promise<boolean> {
    return invoke<boolean>('is_logged_in')
  },

  async getCurrentUser(): Promise<TauriUserInfo | null> {
    try {
      return await invoke<TauriUserInfo | null>('get_current_user')
    } catch {
      return null
    }
  },

  // ================== Session Monitoring Commands ==================
  // Delegates to TauriSessionMonitorAdapter

  async startSessionMonitoring(): Promise<StartMonitoringResult> {
    return TauriSessionMonitorAdapter.startSessionMonitoring()
  },

  async stopSessionMonitoring(): Promise<void> {
    return TauriSessionMonitorAdapter.stopSessionMonitoring()
  },

  async checkSessionValidity(): Promise<SessionValidationResult> {
    return TauriSessionMonitorAdapter.checkSessionValidity()
  },

  async forceQuitApp(reason: string): Promise<void> {
    return TauriSessionMonitorAdapter.forceQuitApp(reason)
  },

  async onSessionEvent(
    callback: (event: SessionValidEvent | SessionWarningEvent | SessionExpiredEvent | SessionErrorEvent) => void
  ): Promise<UnlistenFn> {
    return TauriSessionMonitorAdapter.onSessionEvent(callback)
  },

  async onForceQuit(callback: (event: ForceQuitEvent) => void): Promise<UnlistenFn> {
    return TauriSessionMonitorAdapter.onForceQuit(callback)
  },

  async onDuplicateLogin(callback: (event: SessionExpiredEvent) => void): Promise<UnlistenFn> {
    return TauriSessionMonitorAdapter.onDuplicateLogin(callback)
  },

  async onSessionExpired(callback: (event: SessionExpiredEvent) => void): Promise<UnlistenFn> {
    return TauriSessionMonitorAdapter.onSessionExpired(callback)
  },

  async onSessionExpiryWarning(callback: (event: SessionWarningEvent) => void): Promise<UnlistenFn> {
    return TauriSessionMonitorAdapter.onSessionExpiryWarning(callback)
  },

  async onSessionExpirySoon(callback: (event: SessionWarningEvent) => void): Promise<UnlistenFn> {
    return TauriSessionMonitorAdapter.onSessionExpirySoon(callback)
  },

  // ================== Window Management Commands ==================
  // Delegates to TauriWindowAdapter

  /**
   * @deprecated Use TauriWindowAdapter.setSemiAutoMode() directly
   */
  async setWindowSemiAutoMode(): Promise<void> {
    return TauriWindowAdapter.setSemiAutoMode()
  },

  /**
   * @deprecated Use TauriWindowAdapter.setNormalMode() directly
   */
  async setWindowNormalMode(): Promise<void> {
    return TauriWindowAdapter.setNormalMode()
  },

  /**
   * @deprecated Use TauriWindowAdapter.getSize() directly
   */
  async getWindowSize(): Promise<{ width: number; height: number }> {
    return TauriWindowAdapter.getSize()
  },

  // ================== V2 API Commands ==================
  // Delegates to TauriPredictionAdapter

  async requestPredictionV2(roomId: string, betType?: string): Promise<V2PredictionResponse | null> {
    return TauriPredictionAdapter.requestPredictionV2(roomId, betType)
  },

  async reportResultV2(roomId: string, actualResult: Winner): Promise<V2ResultComparison> {
    return TauriPredictionAdapter.reportResultV2(roomId, actualResult)
  },

  async notifyShoeChangeV2(roomId: string, roomName: string): Promise<boolean> {
    return TauriPredictionAdapter.notifyShoeChangeV2(roomId, roomName)
  },

  async processEvolutionMessage(
    messageType: string,
    tableId: string,
    data: Record<string, unknown>
  ): Promise<string | null> {
    return TauriPredictionAdapter.processEvolutionMessage(messageType, tableId, data)
  },

  async getRoomGameData(roomId: string): Promise<V2RoomGameData | null> {
    return TauriPredictionAdapter.getRoomGameData(roomId)
  },

  async getTrackedRooms(): Promise<string[]> {
    return TauriPredictionAdapter.getTrackedRooms()
  },
}

export default TauriAdapter
