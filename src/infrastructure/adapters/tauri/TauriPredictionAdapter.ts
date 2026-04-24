// TauriPredictionAdapter - 예측 및 V2 API 관리
// Clean Architecture: Infrastructure Layer
// 단일 책임: 예측 요청, 결과 보고, 게임 데이터 관리

import { invoke } from '@tauri-apps/api/core'
import type {
  Winner,
  Prediction,
  PredictionResult,
  Room,
  RoadResult,
  RoomSelectionOptions,
  RoomSelectionResult,
  RoomSelectionResponse,
  V2PredictionResponse,
  V2ResultComparison,
  V2RoomGameData,
} from '../../../domain/entities'
import type { UserBalanceTracking } from '../../../domain/interfaces'
import { toWinnerArray, toTauriWinner, toPrediction, type TauriPredictionResult } from '../../../domain/utils/converters'
import { SessionService } from '../../../application/services/SessionService'

// ==================== Interface ====================

/**
 * 🆕 v3.7.0: 사용자 추적 옵션
 * Domain 레이어의 UserBalanceTracking을 확장하여 추가 필드 포함
 */
export interface UserTrackingOptions extends UserBalanceTracking {
  userId?: string
  username?: string
  sessionId?: string
  betAmount?: number
  clientType?: 'desktop' | 'android' | 'ios' | 'web'
}

export interface IPredictionAdapter {
  // 기본 예측
  requestPredictionWithHistory(
    roomId: string,
    roomName: string,
    history: Winner[],
    remainingSeconds: number,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean,
    userTracking?: UserTrackingOptions
  ): Promise<Prediction | null>

  requestPredictionForRoom(
    roomId: string,
    history: Winner[] | RoadResult[],
    roomName?: string,
    remainingSeconds?: number,
    betType?: string,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean,
    userTracking?: UserTrackingOptions
  ): Promise<Prediction | null>

  requestBestRoomSelection(
    rooms: Room[],
    options?: RoomSelectionOptions
  ): Promise<RoomSelectionResponse | null>

  // V2 API
  requestPredictionV2(roomId: string, betType?: string): Promise<V2PredictionResponse | null>
  reportResultV2(roomId: string, actualResult: Winner): Promise<V2ResultComparison>
  notifyShoeChangeV2(roomId: string, roomName: string): Promise<boolean>
  processEvolutionMessage(messageType: string, tableId: string, data: Record<string, unknown>): Promise<string | null>
  getRoomGameData(roomId: string): Promise<V2RoomGameData | null>
  getTrackedRooms(): Promise<string[]>

  // 방 조회
  getAllRooms(): Promise<Room[]>
  getRankedRooms(): Promise<Room[]>
}

// ==================== Types ====================

interface TauriRoom {
  id: string
  name: string
  history: string[]
  game_count: number
  phase: string
}

interface TauriRoomSelectionResult {
  roomId: string
  roomName: string
  prediction?: string | null
  confidence?: number
  isSkip?: boolean
  skipReason?: string | null
  score?: number
}

interface TauriRoomSelectionResponse {
  bestRoomId?: string | null
  bestRoomName?: string | null
  results?: TauriRoomSelectionResult[]
  evaluated?: number
  skipped?: number
  responseTimeMs?: number
  reason?: string | null
}

// ==================== Pending Request Management ====================

interface PendingPrediction {
  promise: Promise<Prediction | null>
  timestamp: number
}

const pendingPredictions: Map<string, PendingPrediction> = new Map()
const PENDING_TTL_MS = 15000

// Cleanup stale pending predictions
setInterval(() => {
  const now = Date.now()
  for (const [key, pending] of pendingPredictions.entries()) {
    if (now - pending.timestamp > PENDING_TTL_MS) {
      console.log(`[TauriPredictionAdapter] Cleaning up stale pending: ${key}`)
      pendingPredictions.delete(key)
    }
  }
}, 5000)

// ==================== Helper Functions ====================

function toPredictionWithRoomId(result: TauriPredictionResult, roomId: string): Prediction {
  const prediction = toPrediction(result)
  prediction.roomId = roomId
  return prediction
}

function convertTauriRoom(r: TauriRoom): Room {
  return {
    id: r.id,
    name: r.name,
    koreanName: r.name,
    history: r.history.map((h) => ({
      winner: (h === 'Banker' ? 'B' : h === 'Player' ? 'P' : 'T') as Winner,
      isPlayerPair: false,
      isBankerPair: false,
    })),
    gameCount: r.game_count,
  }
}

// ==================== Implementation ====================

class TauriPredictionAdapterImpl implements IPredictionAdapter {
  // ==================== 기본 예측 ====================

  async requestPredictionWithHistory(
    roomId: string,
    roomName: string,
    history: Winner[],
    remainingSeconds: number,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean,
    userTracking?: UserTrackingOptions
  ): Promise<Prediction | null> {
    const result = await invoke<TauriPredictionResult | null>('request_prediction_with_history', {
      roomId,
      roomName,
      history: history.map(toTauriWinner),
      remainingSeconds,
      betType: null,
      martinLevel: martinLevel ?? null,
      minConfidence: minConfidence ?? null,
      autoMode: autoMode ?? null,
      // 🆕 v3.7.0: 사용자 추적
      userId: userTracking?.userId ?? null,
      username: userTracking?.username ?? null,
      sessionId: userTracking?.sessionId ?? null,
      currentBalance: userTracking?.currentBalance ?? null,
      betAmount: userTracking?.betAmount ?? null,
      clientType: userTracking?.clientType ?? 'desktop',
    })
    return result ? toPredictionWithRoomId(result, roomId) : null
  }

  async requestPredictionForRoom(
    roomId: string,
    history: Winner[] | RoadResult[],
    roomName?: string,
    remainingSeconds?: number,
    betType?: string,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean,
    userTracking?: UserTrackingOptions
  ): Promise<Prediction | null> {
    const displayName = roomName || roomId
    const timer = remainingSeconds ?? 15
    console.log(`[TauriPredictionAdapter] requestPredictionForRoom: ${displayName}, history=${history?.length || 0}`)

    const winners = toWinnerArray(history)

    if (winners.length < 5) {
      console.log(`[TauriPredictionAdapter] Skipping - history insufficient (${winners.length}/5)`)
      return null
    }

    // Deduplication
    const pendingKey = `${roomId}:${winners.length}`
    const pending = pendingPredictions.get(pendingKey)
    if (pending) {
      console.log(`[TauriPredictionAdapter] Waiting for pending: ${pendingKey}`)
      return pending.promise
    }

    const requestPromise = this._doInvokePrediction(
      roomId,
      winners,
      displayName,
      timer,
      betType,
      martinLevel,
      minConfidence,
      autoMode,
      userTracking
    )
    pendingPredictions.set(pendingKey, {
      promise: requestPromise,
      timestamp: Date.now(),
    })

    try {
      return await requestPromise
    } finally {
      pendingPredictions.delete(pendingKey)
    }
  }

  async requestBestRoomSelection(
    rooms: Room[],
    options?: RoomSelectionOptions
  ): Promise<RoomSelectionResponse | null> {
    if (!rooms || rooms.length === 0) return null

    const candidates = rooms.map((room) => {
      const winners = toWinnerArray(room.history)
      return {
        roomId: room.id,
        roomName: room.koreanName || room.name,
        history: winners.map(toTauriWinner),
      }
    }).filter(c => c.history.length > 0)

    if (candidates.length === 0) return null

    const result = await invoke<TauriRoomSelectionResponse>('request_best_room_selection', {
      candidates,
      betType: options?.betType ?? null,
      martinLevel: options?.martinLevel ?? null,
      minConfidence: options?.minConfidence ?? null,
      maxResults: options?.maxResults ?? null,
      includeSkipped: options?.includeSkipped ?? null,
    })

    if (!result) return null

    const mappedResults = (result.results ?? []).map((r): RoomSelectionResult => {
      let prediction: PredictionResult = null
      if (r.prediction) {
        const normalized = r.prediction.toLowerCase()
        if (normalized === 'banker') prediction = 'B'
        else if (normalized === 'player') prediction = 'P'
        else if (normalized === 'tie') prediction = 'T'
      }
      const isSkip = r.isSkip ?? prediction === null
      return {
        roomId: r.roomId || '',
        roomName: r.roomName || r.roomId || '',
        prediction,
        confidence: r.confidence ?? 0,
        isSkip,
        skipReason: r.skipReason ?? undefined,
        score: r.score ?? 0,
      }
    })

    return {
      bestRoomId: result.bestRoomId ?? undefined,
      bestRoomName: result.bestRoomName ?? undefined,
      results: mappedResults,
      evaluated: result.evaluated ?? mappedResults.length,
      skipped: result.skipped ?? mappedResults.filter(r => r.isSkip).length,
      responseTimeMs: result.responseTimeMs ?? undefined,
      reason: result.reason ?? undefined,
    }
  }

  async _doInvokePrediction(
    roomId: string,
    history: Winner[],
    roomName: string,
    remainingSeconds: number,
    betType?: string,
    martinLevel?: number,
    minConfidence?: number,
    autoMode?: boolean,
    userTracking?: UserTrackingOptions
  ): Promise<Prediction | null> {
    try {
      const historyStrings = history.map(toTauriWinner)

      const result = await invoke<TauriPredictionResult | null>('request_prediction_with_history', {
        roomId,
        roomName,
        history: historyStrings,
        remainingSeconds,
        betType: betType || null,
        martinLevel: martinLevel ?? null,
        minConfidence: minConfidence ?? null,
        autoMode: autoMode ?? null,
        // 🆕 v3.7.0: 사용자 추적
        userId: userTracking?.userId ?? null,
        username: userTracking?.username ?? null,
        sessionId: userTracking?.sessionId ?? null,
        currentBalance: userTracking?.currentBalance ?? null,
        betAmount: userTracking?.betAmount ?? null,
        clientType: userTracking?.clientType ?? 'desktop',
      })

      if (!result) return null

      return toPredictionWithRoomId(result, roomId)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('token-expired')) {
        console.error('[TauriPredictionAdapter] Token expired - forcing app exit')
        // 인증 실패 시 세션 강제 만료 → App.tsx의 onExpired 콜백에서 앱 종료 처리
        SessionService.forceExpire('token_revoked')
        throw new Error('token-expired')
      }
      console.error(`[TauriPredictionAdapter] Prediction failed: ${errorMsg}`)
      throw new Error('prediction-failed')
    }
  }

  // ==================== V2 API ====================

  async requestPredictionV2(roomId: string, betType?: string): Promise<V2PredictionResponse | null> {
    try {
      const result = await invoke<V2PredictionResponse | null>('request_prediction_v2', {
        roomId,
        betType: betType || null,
      })
      if (result) {
        console.log(`[TauriPredictionAdapter] V2 prediction: ${result.prediction || 'SKIP'}`)
      }
      return result
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('token-expired')) {
        console.error('[TauriPredictionAdapter] V2 Token expired - forcing app exit')
        SessionService.forceExpire('token_revoked')
        throw new Error('token-expired')
      }
      console.error('[TauriPredictionAdapter] V2 prediction failed:', error)
      throw error
    }
  }

  async reportResultV2(roomId: string, actualResult: Winner): Promise<V2ResultComparison> {
    const resultStr = actualResult === 'B' ? 'Banker' : actualResult === 'P' ? 'Player' : 'Tie'
    return invoke<V2ResultComparison>('report_result_v2', { roomId, actualResult: resultStr })
  }

  async notifyShoeChangeV2(roomId: string, roomName: string): Promise<boolean> {
    return invoke<boolean>('notify_shoe_change_v2', { roomId, roomName })
  }

  async processEvolutionMessage(
    messageType: string,
    tableId: string,
    data: Record<string, unknown>
  ): Promise<string | null> {
    return invoke<string | null>('process_evolution_message', { messageType, tableId, data })
  }

  async getRoomGameData(roomId: string): Promise<V2RoomGameData | null> {
    try {
      return await invoke<V2RoomGameData>('get_room_game_data', { roomId })
    } catch {
      return null
    }
  }

  async getTrackedRooms(): Promise<string[]> {
    return invoke<string[]>('get_tracked_rooms')
  }

  // ==================== 방 조회 ====================

  async getAllRooms(): Promise<Room[]> {
    const rooms = await invoke<TauriRoom[]>('get_all_rooms')
    return rooms.map(convertTauriRoom)
  }

  async getRankedRooms(): Promise<Room[]> {
    const rooms = await invoke<TauriRoom[]>('get_ranked_rooms')
    return rooms.map(convertTauriRoom)
  }
}

// ==================== Singleton Export ====================

export const TauriPredictionAdapter = new TauriPredictionAdapterImpl()
export default TauriPredictionAdapter
