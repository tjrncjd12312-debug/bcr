// PatternPredictionService - 패턴 기반 예측 로직
// Clean Architecture: Application Layer
// 단일 책임: 패턴 매칭 및 예측 생성 (AI 요청 포함)

import type {
  Room,
  Prediction,
  RoomFilterType,
  PatternBetDirection,
  PatternBetConfig,
  Winner,
} from '../../../domain/entities'
import type { IMultiRoomPredictionPort } from '../../../domain/interfaces'
import { CustomPatternService } from '../CustomPatternService'
import { PatternBettingService } from '../PatternBettingService'
import { RoomFilterService } from '../RoomFilterService'

// ==================== Types ====================

export interface PatternMatch {
  patternType: RoomFilterType
  betDirection: PatternBetDirection
  patternName: string
}

export interface PatternPredictionConfig {
  maxMartin: number
  betStrategy: string
  minConfidence?: number
  realBalance?: number | null // 🆕 v3.7.0: 실제 사용자 잔액
}

// ==================== Interface ====================

export interface IPatternPredictionService {
  /**
   * 패턴 기반으로 예측 생성
   * @param room 방 정보
   * @param remainingSeconds 남은 배팅 시간
   * @param currentFilter 현재 선택된 패턴 필터
   * @param config 예측 설정 (realBalance 포함)
   * @returns 예측 결과 또는 null
   */
  getPatternBasedPrediction(
    room: Room,
    remainingSeconds: number,
    currentFilter: RoomFilterType | string,
    config: PatternPredictionConfig
  ): Promise<Prediction | null>

  /**
   * 현재 필터에 매칭되는 패턴 찾기
   * @param room 방 정보
   * @param currentFilter 현재 선택된 패턴 필터
   * @returns 매칭된 패턴 또는 null
   */
  findMatchedPattern(
    room: Room,
    currentFilter: RoomFilterType | string
  ): PatternMatch | null
}

// ==================== Pattern Name Mapping ====================

const PATTERN_NAMES: Record<string, string> = {
  alternating: '퐁당',
  long_streak: '장줄',
  short_streak: '단줄',
  banker_dominant: 'B우세',
  player_dominant: 'P우세',
  after_tie: '타이후',
  winning_streak: '연승',
  losing_streak: '연패',
}

// ==================== Implementation ====================

export class PatternPredictionService implements IPatternPredictionService {
  private predictionPort: IMultiRoomPredictionPort

  constructor(predictionPort: IMultiRoomPredictionPort) {
    this.predictionPort = predictionPort
  }

  // ==================== Main Prediction Logic ====================

  async getPatternBasedPrediction(
    room: Room,
    remainingSeconds: number,
    currentFilter: RoomFilterType | string,
    config: PatternPredictionConfig
  ): Promise<Prediction | null> {
    const history = room.history
    if (history.length < 3) return null

    // 현재 방에 매칭되는 패턴 찾기
    const matchedPattern = this.findMatchedPattern(room, currentFilter)

    if (!matchedPattern) {
      // 패턴 매칭 안 됨 - 배팅 안 함
      console.log(`[PatternPrediction] ${room.koreanName} - 매칭되는 패턴 없음, 배팅 스킵`)
      return this.createSkipPrediction(room.id, '매칭되는 패턴 없음')
    }

    const { betDirection, patternName } = matchedPattern

    // betDirection에 따른 처리
    if (betDirection === 'skip') {
      console.log(`[PatternPrediction] ${room.koreanName} - ${patternName} 패턴, betDirection=skip으로 배팅 안 함`)
      return this.createSkipPrediction(room.id, `${patternName} → 스킵`)
    }

    if (betDirection === 'B' || betDirection === 'P' || betDirection === 'T') {
      // 사용자가 명시적으로 설정한 배팅 방향 (고정)
      console.log(`[PatternPrediction] ${room.koreanName} - ${patternName} 패턴, betDirection=${betDirection} (사용자 설정)`)
      return {
        roomId: room.id,
        prediction: betDirection,
        confidence: 80,
        reasoning: `${patternName} → ${betDirection}`,
        isSkip: false,
        timestamp: Date.now(),
      }
    }

    // betDirection === 'ai' - AI 서버 예측 요청
    return this.requestAiPrediction(room, remainingSeconds, patternName, config)
  }

  // ==================== Pattern Matching ====================

  findMatchedPattern(
    room: Room,
    currentFilter: RoomFilterType | string
  ): PatternMatch | null {
    const winners: Winner[] = room.history.map((r) => r.winner)

    // 필터가 'all'이 아니면, 해당 필터 패턴과 실제로 매칭되는지 확인
    if (currentFilter !== 'all') {
      // 커스텀 패턴 체크
      if (typeof currentFilter === 'string' && currentFilter.startsWith('custom:')) {
        return this.matchCustomPattern(winners, currentFilter)
      }

      // 기본 패턴 설정 가져오기 + 실시간 패턴 매칭 체크
      return this.matchBuiltInPattern(room, currentFilter as RoomFilterType)
    }

    // 필터가 'all'이면 AI 자동 배팅
    return {
      patternType: 'all' as RoomFilterType,
      betDirection: 'ai',
      patternName: 'AI 자동',
    }
  }

  // ==================== Private Methods ====================

  private matchCustomPattern(
    winners: Winner[],
    filter: string
  ): PatternMatch | null {
    const patternId = filter.replace('custom:', '')
    const pattern = CustomPatternService.getPatterns().find((p) => p.id === patternId)

    if (!pattern) {
      console.warn(`[PatternPrediction] 커스텀 패턴 ID "${patternId}" 찾을 수 없음`)
      return null
    }

    // 실제로 방의 히스토리가 패턴과 매칭되는지 확인
    const isMatched = this.matchesCustomSequence(winners, pattern.sequence)
    if (!isMatched) {
      return null
    }

    return {
      patternType: filter as RoomFilterType,
      betDirection: pattern.betDirection || 'ai',
      patternName: `[커스텀] ${pattern.name}`,
    }
  }

  private matchBuiltInPattern(
    room: Room,
    filter: RoomFilterType
  ): PatternMatch | null {
    const config = this.getPatternConfig(filter)

    // RoomFilterService를 사용해서 실시간으로 패턴 매칭 체크
    const isMatched = RoomFilterService.matchesFilter(room, null, filter)
    if (!isMatched) {
      return null
    }

    return {
      patternType: filter,
      betDirection: config.betDirection,
      patternName: PATTERN_NAMES[filter] || filter,
    }
  }

  /**
   * 커스텀 시퀀스 매칭 (마지막 결과 기준)
   *
   * 사용자 입력 패턴: "PPBB" = 오래된→최신 순서 (시간순)
   * history[0] = 최신 결과 (newest-first)
   * 패턴을 reverse하여 비교
   */
  private matchesCustomSequence(history: Winner[], sequence: Winner[]): boolean {
    if (!sequence || sequence.length === 0) return false
    if (history.length < sequence.length) return false

    // 패턴을 reverse하여 비교 (사용자 입력은 시간순, history는 최신이 앞)
    const reversedSeq = [...sequence].reverse()

    for (let i = 0; i < reversedSeq.length; i++) {
      if (history[i] !== reversedSeq[i]) {
        return false
      }
    }
    return true
  }

  private getPatternConfig(patternType: RoomFilterType): PatternBetConfig {
    const betDirection = PatternBettingService.getBetDirection(patternType)
    const enabled = PatternBettingService.isPatternEnabled(patternType)

    return {
      patternType,
      betDirection,
      enabled,
      includeTie: false,
    }
  }

  // ==================== AI Prediction ====================

  private async requestAiPrediction(
    room: Room,
    remainingSeconds: number,
    patternName: string,
    config: PatternPredictionConfig
  ): Promise<Prediction | null> {
    console.log(
      `[PatternPrediction] ${room.koreanName} - ${patternName} 패턴, betDirection=ai, AI 예측 요청 (maxMartin=${config.maxMartin}, minConf=auto)`
    )

    try {
      // 🆕 v3.7.0: 실제 잔액 추적 - config에서 realBalance 추출
      const userTracking = config.realBalance != null
        ? { currentBalance: config.realBalance }
        : undefined

      const aiPrediction = await this.predictionPort.requestPredictionForRoom(
        room.id,
        room.history,
        room.koreanName,
        remainingSeconds,
        config.betStrategy,
        config.maxMartin,
        config.minConfidence,
        true,
        userTracking // 🆕 v3.7.0: 사용자 잔액 추적
      )

      // DEBUG: AI 서버 응답 상세 로깅
      console.log(`[PatternPrediction] 🔍 ${room.koreanName} - AI 서버 응답:`, {
        prediction: aiPrediction?.prediction,
        confidence: aiPrediction?.confidence,
        reasoning: aiPrediction?.reasoning,
        isSkip: aiPrediction?.isSkip,
      })

      if (aiPrediction && aiPrediction.prediction) {
        return {
          ...aiPrediction,
          reasoning: `${patternName} → AI: ${aiPrediction.prediction}`,
        }
      }

      // AI 예측 실패/SKIP 시 패스
      const skipReason = this.sanitizeSkipReason(aiPrediction)
      console.log(
        `[PatternPrediction] ⚠️ ${room.koreanName} - AI SKIP (reason: ${skipReason})`
      )

      return this.createSkipPrediction(room.id, `${patternName} → ${skipReason}`)
    } catch (error) {
      console.error(`[PatternPrediction] ❌ ${room.koreanName} - AI 예측 오류:`, error)
      return this.createSkipPrediction(room.id, `${patternName} → AI 패스`)
    }
  }

  /**
   * AI 스킵 사유를 사용자 친화적으로 정제
   */
  private sanitizeSkipReason(aiPrediction: Prediction | null): string {
    let skipReason =
      (aiPrediction as any)?.skipReason || aiPrediction?.reasoning || 'AI 예측 실패'

    // 이모지/SKIP 접두사 제거
    skipReason = skipReason.replace(/⏸️|SKIP:|SKIP/g, '').trim()

    // 1. 전략 필터 메시지 단순화
    if (skipReason.includes('전략 필터')) {
      if (skipReason.includes('markov_chain')) return '승률 저조 (변곡점)'
      if (skipReason.includes('streak_following')) return '승률 저조 (줄타기)'
      if (skipReason.includes('streak_reversal')) return '승률 저조 (꺾기)'
      return '승률 저조 구간'
    }

    // 2. 연패 회복 메시지 단순화
    if (skipReason.includes('연패 회복 중')) {
      const match = skipReason.match(/(\d+연패)/)
      const losses = match ? match[1] : '연패'
      return `리스크 관리 (${losses} 중)`
    }

    // 3. 데드존/저신뢰도 메시지 단순화
    if (skipReason.includes('Dead Zone') || skipReason.includes('데드존')) {
      return '더 확실한 기회 대기'
    }
    if (skipReason.includes('Low confidence') || skipReason.includes('저신뢰도')) {
      return '신뢰도 낮음'
    }

    // 4. 클라이언트 설정 미달
    if (
      skipReason.includes('클라이언트 설정 미달') ||
      skipReason.includes('client') ||
      skipReason.includes('Client')
    ) {
      return '신뢰도 부족'
    }

    // 5. 기타는 그대로 유지
    return skipReason
  }

  private createSkipPrediction(roomId: string, reasoning: string): Prediction {
    return {
      roomId,
      prediction: null,
      confidence: 0,
      reasoning,
      isSkip: true,
      timestamp: Date.now(),
    }
  }
}

// ==================== Factory ====================

export function createPatternPredictionService(
  predictionPort: IMultiRoomPredictionPort
): PatternPredictionService {
  return new PatternPredictionService(predictionPort)
}

export default PatternPredictionService
