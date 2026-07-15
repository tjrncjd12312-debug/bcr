import type { Room, Winner } from '../../../domain/entities'
import {
  evaluateEntryFilter,
  findStrategyTrigger,
  toChronologicalWinners,
  type CustomStrategyDefinitionV1,
  type CustomStrategyFilterType,
} from '../../../domain/strategies/customStrategy'
import CustomStrategyService from '../CustomStrategyService'

export type CustomStrategySessionStatus =
  | 'observing'
  | 'blocked_until_shoe'
  | 'waiting_trigger'
  | 'ready'
  | 'pending'
  | 'cleared'
  | 'failed'

export interface CustomStrategySessionState {
  strategyId: string
  roomId: string
  roomName: string
  status: CustomStrategySessionStatus
  direction: Winner | null
  stageIndex: number
  attemptIndex: number
  observedHistoryLength: number
  triggerHandNumber?: number
  pendingDecisionId?: string
  pendingRoundKey?: string
  lastSettledRoundKey?: string
  requiresFreshBettingPhase?: boolean
  reason?: string
}

export interface CustomStrategyBetDecision {
  decisionId: string
  strategyId: string
  strategyName: string
  roomId: string
  direction: Winner
  amount: number
  stageIndex: number
  attemptIndex: number
  historyLength: number
}

export interface CustomStrategyTransition {
  handled: boolean
  status: CustomStrategySessionStatus
  stageIndex: number
  attemptIndex: number
  cleared: boolean
  failed: boolean
  duplicate: boolean
}

function cloneSession(session: CustomStrategySessionState): CustomStrategySessionState {
  return { ...session }
}

function cloneStrategy(strategy: CustomStrategyDefinitionV1): CustomStrategyDefinitionV1 {
  return JSON.parse(JSON.stringify(strategy)) as CustomStrategyDefinitionV1
}

class CustomStrategyRuntimeImpl {
  private sessions = new Map<string, CustomStrategySessionState>()
  private strategySnapshots = new Map<string, CustomStrategyDefinitionV1>()

  prepareDecision(filterType: string, room: Room, freshBettingPhase = true): CustomStrategyBetDecision | null {
    const continuing = Array.from(this.sessions.values()).find(session =>
      session.roomId === room.id && (session.status === 'ready' || session.status === 'pending')
    )
    const configuredStrategy = continuing
      ? CustomStrategyService.getById(continuing.strategyId)
      : CustomStrategyService.getByFilterType(filterType)
    const strategyId = continuing?.strategyId ?? configuredStrategy?.id
    if (!strategyId) return null

    const key = this.key(strategyId, room.id)
    let strategy = this.strategySnapshots.get(key)
    if (!strategy) {
      if (!configuredStrategy?.enabled) return null
      strategy = cloneStrategy(configuredStrategy)
      this.strategySnapshots.set(key, strategy)
    }
    const chronological = toChronologicalWinners(room.history)
    let session = continuing ?? this.sessions.get(key)

    if (!session) {
      if (chronological.length > strategy.entryFilter.toHand) {
        session = {
          strategyId: strategy.id,
          roomId: room.id,
          roomName: room.koreanName,
          status: 'blocked_until_shoe',
          direction: null,
          stageIndex: 0,
          attemptIndex: 0,
          observedHistoryLength: chronological.length,
          reason: '관찰 종료 이후 활성화되어 다음 슈까지 진입하지 않습니다.',
        }
        this.sessions.set(key, session)
        return null
      }
      session = {
        strategyId: strategy.id,
        roomId: room.id,
        roomName: room.koreanName,
        status: 'observing',
        direction: null,
        stageIndex: 0,
        attemptIndex: 0,
        observedHistoryLength: chronological.length,
      }
      this.sessions.set(key, session)
    }

    if (session.status === 'blocked_until_shoe' || session.status === 'pending' || session.status === 'failed' || session.status === 'cleared') {
      return null
    }

    if (session.status === 'observing') {
      const evaluation = evaluateEntryFilter(room.history, strategy)
      if (!evaluation.complete) {
        session.observedHistoryLength = chronological.length
        session.reason = evaluation.reason
        return null
      }
      if (!evaluation.matched) {
        session.status = 'blocked_until_shoe'
        session.observedHistoryLength = chronological.length
        session.reason = evaluation.reason
        return null
      }

      const trigger = findStrategyTrigger(chronological, strategy, strategy.entryFilter.toHand)
      if (trigger) {
        session.status = 'ready'
        session.direction = trigger.direction
        session.triggerHandNumber = trigger.handNumber
        session.observedHistoryLength = chronological.length
        session.reason = `${trigger.handNumber}회차 ${trigger.result} 트리거`
      } else {
        session.status = 'waiting_trigger'
        session.observedHistoryLength = chronological.length
        session.reason = '진입 조건 통과 · 다음 트리거 대기'
        return null
      }
    } else if (session.status === 'waiting_trigger') {
      const trigger = findStrategyTrigger(chronological, strategy, session.observedHistoryLength)
      session.observedHistoryLength = chronological.length
      if (!trigger) return null
      session.status = 'ready'
      session.direction = trigger.direction
      session.triggerHandNumber = trigger.handNumber
      session.reason = `${trigger.handNumber}회차 ${trigger.result} 트리거`
    }

    if (session.status !== 'ready' || !session.direction) return null
    if (session.requiresFreshBettingPhase) {
      if (!freshBettingPhase) return null
      session.requiresFreshBettingPhase = false
    }
    const stage = strategy.progression.stages[session.stageIndex]
    const amount = stage?.amounts[session.attemptIndex]
    if (!stage || !Number.isInteger(amount) || amount <= 0) {
      session.status = 'blocked_until_shoe'
      session.reason = '현재 단계의 베팅 금액이 올바르지 않습니다.'
      return null
    }

    return {
      decisionId: this.decisionId(session, chronological.length),
      strategyId: strategy.id,
      strategyName: strategy.name,
      roomId: room.id,
      direction: session.direction,
      amount,
      stageIndex: session.stageIndex,
      attemptIndex: session.attemptIndex,
      historyLength: chronological.length,
    }
  }

  markPending(decision: CustomStrategyBetDecision, roundKey?: string): boolean {
    const session = this.sessions.get(this.key(decision.strategyId, decision.roomId))
    if (!session || session.status !== 'ready') return false
    if (this.decisionId(session, decision.historyLength) !== decision.decisionId) return false
    session.status = 'pending'
    session.pendingDecisionId = decision.decisionId
    session.pendingRoundKey = roundKey
    return true
  }

  releasePending(roomId: string, reason?: string): void {
    const session = this.findPendingByRoom(roomId)
    if (!session) return
    session.status = 'ready'
    session.pendingDecisionId = undefined
    session.pendingRoundKey = undefined
    session.reason = reason || '베팅 미체결 · 같은 차수 재시도'
    session.requiresFreshBettingPhase = true
  }

  settle(roomId: string, outcome: 'win' | 'loss' | 'push', resultKey: string): CustomStrategyTransition {
    const session = this.findPendingByRoom(roomId)
    if (!session) return this.emptyTransition()
    if (session.lastSettledRoundKey === resultKey) {
      return { ...this.toTransition(session), duplicate: true }
    }

    const strategy = this.strategySnapshots.get(this.key(session.strategyId, session.roomId))
    if (!strategy) {
      session.status = 'failed'
      session.reason = '실행 중인 전략 스냅샷을 찾을 수 없습니다.'
      return this.toTransition(session)
    }

    session.lastSettledRoundKey = resultKey
    session.pendingDecisionId = undefined
    session.pendingRoundKey = undefined

    if (outcome === 'push') {
      session.status = 'ready'
      session.reason = '타이/PUSH · 같은 차수 재시도'
      session.requiresFreshBettingPhase = true
      return this.toTransition(session)
    }

    if (outcome === 'win') {
      const nextAttempt = session.attemptIndex + 1
      if (nextAttempt >= strategy.progression.requiredConsecutiveWins) {
        if (strategy.onClear === 'rearm') {
          session.status = 'waiting_trigger'
          session.direction = null
          session.stageIndex = 0
          session.attemptIndex = 0
          session.reason = '클리어 · 다음 트리거 대기'
        } else {
          session.status = 'cleared'
          session.reason = '목표 연속 적중 클리어'
        }
      } else {
        session.attemptIndex = nextAttempt
        session.status = 'ready'
        session.requiresFreshBettingPhase = true
        session.reason = `${session.stageIndex + 1}단계 ${session.attemptIndex + 1}차 대기`
      }
      return this.toTransition(session)
    }

    const nextStage = session.stageIndex + 1
    session.attemptIndex = 0
    if (nextStage < strategy.progression.stages.length) {
      session.stageIndex = nextStage
      session.status = 'ready'
      session.requiresFreshBettingPhase = true
      session.reason = `${session.stageIndex + 1}단계 1차 대기`
    } else if (strategy.progression.onLastStageLoss === 'repeat_last') {
      session.stageIndex = Math.max(0, strategy.progression.stages.length - 1)
      session.status = 'ready'
      session.requiresFreshBettingPhase = true
      session.reason = `마지막 ${session.stageIndex + 1}단계 반복`
    } else {
      session.status = 'failed'
      session.reason = '마지막 단계 실패 · 이번 슈 종료'
    }
    return this.toTransition(session)
  }

  getSession(strategyId: string, roomId: string): CustomStrategySessionState | null {
    const session = this.sessions.get(this.key(strategyId, roomId))
    return session ? cloneSession(session) : null
  }

  getSessionForRoom(roomId: string): CustomStrategySessionState | null {
    for (const session of this.sessions.values()) {
      if (session.roomId === roomId && session.status !== 'blocked_until_shoe') return cloneSession(session)
    }
    return null
  }

  getStrategySnapshot(strategyId: string, roomId: string): CustomStrategyDefinitionV1 | null {
    const strategy = this.strategySnapshots.get(this.key(strategyId, roomId))
    return strategy ? cloneStrategy(strategy) : null
  }

  isProgressionActive(roomId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.roomId === roomId && (session.status === 'ready' || session.status === 'pending')) return true
    }
    return false
  }

  getActiveRoomIds(): string[] {
    const ids = new Set<string>()
    this.sessions.forEach(session => {
      if (session.status === 'ready' || session.status === 'pending') ids.add(session.roomId)
    })
    return Array.from(ids)
  }

  resetRoom(roomId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.roomId === roomId) {
        this.sessions.delete(key)
        this.strategySnapshots.delete(key)
      }
    }
  }

  stopNonPendingSessions(): void {
    this.sessions.forEach(session => {
      if (session.status === 'pending') return
      if (session.status === 'ready' || session.status === 'waiting_trigger' || session.status === 'observing') {
        session.status = 'blocked_until_shoe'
        session.reason = '사용자 정지 · 다음 슈까지 대기'
      }
    })
  }

  resetAll(): void {
    this.sessions.clear()
    this.strategySnapshots.clear()
  }

  private findPendingByRoom(roomId: string): CustomStrategySessionState | null {
    for (const session of this.sessions.values()) {
      if (session.roomId === roomId && session.status === 'pending') return session
    }
    return null
  }

  private key(strategyId: string, roomId: string): string {
    return `${strategyId}::${roomId}`
  }

  private decisionId(session: CustomStrategySessionState, historyLength: number): string {
    return `${session.strategyId}:${session.roomId}:${session.stageIndex}:${session.attemptIndex}:${historyLength}`
  }

  private toTransition(session: CustomStrategySessionState): CustomStrategyTransition {
    return {
      handled: true,
      status: session.status,
      stageIndex: session.stageIndex,
      attemptIndex: session.attemptIndex,
      cleared: session.status === 'cleared',
      failed: session.status === 'failed',
      duplicate: false,
    }
  }

  private emptyTransition(): CustomStrategyTransition {
    return {
      handled: false,
      status: 'failed',
      stageIndex: 0,
      attemptIndex: 0,
      cleared: false,
      failed: false,
      duplicate: false,
    }
  }
}

export const CustomStrategyRuntime = new CustomStrategyRuntimeImpl()
export default CustomStrategyRuntime

export function strategyFilterType(strategy: CustomStrategyDefinitionV1): CustomStrategyFilterType {
  return `strategy:${strategy.id}`
}
