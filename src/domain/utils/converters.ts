// Domain Converters - Common type conversion utilities
import type { Winner, RoadResult, Prediction, BetTypeOptimizationV2 } from '../entities'

// Tauri types (matching Rust backend)
export interface TauriPredictionResult {
  room_id?: string  // Optional room_id from some commands
  prediction: string  // 'Banker' | 'Player' | 'Tie'
  confidence: number
  reasoning?: string
  is_skip: boolean
  /** 서버의 연패/연승 추적 정보 (서버와 클라이언트 동기화용) */
  streak_tracking?: {
    consecutive_losses: number
    consecutive_wins: number
    total_predictions: number
    total_wins: number
    win_rate: number
    in_skip_mode: boolean
    martin_level: number
    recommended_multiplier: number
  }
  /** 🆕 서버 동적 최적화 설정 */
  bet_type_optimization?: BetTypeOptimizationV2
}

// ==================== History Converters ====================

/**
 * Convert history array to Winner[] format
 * Handles both Winner[] and RoadResult[] input types
 */
export function toWinnerArray(history: Winner[] | RoadResult[]): Winner[] {
  if (history.length === 0) return []
  
  // Check if first element is a RoadResult (has 'winner' property)
  if (typeof history[0] === 'object' && 'winner' in history[0]) {
    return (history as RoadResult[]).map(r => r.winner)
  }
  
  return history as Winner[]
}

// ==================== Tauri Converters ====================

/**
 * Convert Winner to Tauri format
 */
export function toTauriWinner(winner: Winner): string {
  switch (winner) {
    case 'B':
      return 'Banker'
    case 'P':
      return 'Player'
    case 'T':
      return 'Tie'
    default:
      return 'Tie'
  }
}

/**
 * Convert Tauri prediction to domain Prediction
 */
export function toPrediction(result: TauriPredictionResult): Prediction {
  let prediction: 'B' | 'P' | null = null

  if (result.prediction === 'Banker') prediction = 'B'
  else if (result.prediction === 'Player') prediction = 'P'

  // 서버의 streak_tracking 정보를 변환
  const streakTracking = result.streak_tracking ? {
    consecutiveLosses: result.streak_tracking.consecutive_losses,
    consecutiveWins: result.streak_tracking.consecutive_wins,
    totalPredictions: result.streak_tracking.total_predictions,
    totalWins: result.streak_tracking.total_wins,
    winRate: result.streak_tracking.win_rate,
    inSkipMode: result.streak_tracking.in_skip_mode,
    martinLevel: result.streak_tracking.martin_level,
    recommendedMultiplier: result.streak_tracking.recommended_multiplier,
  } : undefined

  return {
    roomId: '', // Will be set by caller
    prediction,
    confidence: result.confidence,
    reasoning: result.reasoning,
    isSkip: result.is_skip,
    timestamp: Date.now(),
    streakTracking,
    betTypeOptimization: result.bet_type_optimization,
  }
}

// ==================== Session Converters ====================

/** Warning thresholds in seconds */
export const SESSION_WARNING_THRESHOLDS = {
  FIRST_WARNING: 1800,  // 30 minutes
  FINAL_WARNING: 600,   // 10 minutes
} as const

/**
 * Format seconds to human-readable time string
 * Pure domain function - no external dependencies
 */
export function formatSessionTime(seconds: number): string {
  if (seconds <= 0) return '0초'

  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60

  if (h > 0) {
    return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
  }
  if (m > 0) {
    return s > 0 && m < 10 ? `${m}분 ${s}초` : `${m}분`
  }
  return `${s}초`
}

/**
 * Check if session time is in warning zone
 * Pure domain function
 */
export function isSessionWarning(remainingSeconds: number): boolean {
  return remainingSeconds > 0 && remainingSeconds <= SESSION_WARNING_THRESHOLDS.FIRST_WARNING
}

/**
 * Get warning minutes if threshold crossed
 * Pure domain function
 */
export function getWarningMinutes(
  currentSeconds: number,
  previousSeconds: number
): number | null {
  // Check 30 minute threshold
  if (previousSeconds > SESSION_WARNING_THRESHOLDS.FIRST_WARNING && 
      currentSeconds <= SESSION_WARNING_THRESHOLDS.FIRST_WARNING) {
    return 30
  }
  // Check 10 minute threshold
  if (previousSeconds > SESSION_WARNING_THRESHOLDS.FINAL_WARNING && 
      currentSeconds <= SESSION_WARNING_THRESHOLDS.FINAL_WARNING) {
    return 10
  }
  return null
}

// ==================== URL Converters ====================

/**
 * Convert WebSocket URL to HTTP(S) base URL
 * wss:// -> https://, ws:// -> http://
 * Used for browser navigation (room change buttons)
 */
export function wsToHttpBaseUrl(wsUrl: string): string {
  if (!wsUrl) return ''
  try {
    const urlObj = new URL(wsUrl)
    const protocol = urlObj.protocol === 'wss:' ? 'https:'
      : urlObj.protocol === 'ws:' ? 'http:'
      : urlObj.protocol
    return `${protocol}//${urlObj.host}`
  } catch {
    return wsUrl
  }
}
