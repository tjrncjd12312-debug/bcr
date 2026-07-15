import { beforeEach, describe, expect, it } from 'vitest'
import type { RoadResult, Room, Winner } from '../entities'
import CustomStrategyService from '../../application/services/CustomStrategyService'
import CustomStrategyRuntime from '../../application/services/customstrategy/CustomStrategyRuntime'
import {
  createDefaultCustomStrategy,
  evaluateEntryFilter,
  validateCustomStrategy,
} from './customStrategy'

function newestFirst(chronological: Winner[]): RoadResult[] {
  return [...chronological].reverse().map(winner => ({ winner, isPlayerPair: false, isBankerPair: false }))
}

function room(chronological: Winner[]): Room {
  return {
    id: 'room-1',
    name: 'Room 1',
    koreanName: '테스트 방',
    history: newestFirst(chronological),
    gameCount: chronological.length,
  }
}

describe('custom strategy definition and entry evaluator', () => {
  it('accepts the shipped 15-hand/no-three-streak template', () => {
    expect(validateCustomStrategy(createDefaultCustomStrategy())).toEqual({ valid: true, errors: [] })
  })

  it('waits for the complete observation window', () => {
    const strategy = createDefaultCustomStrategy()
    const evaluation = evaluateEntryFilter(newestFirst('PBPBPBPBPBPBPB'.split('') as Winner[]), strategy)
    expect(evaluation.complete).toBe(false)
    expect(evaluation.matched).toBe(false)
  })

  it('matches when the first 15 hands never contain a P/B streak longer than two', () => {
    const strategy = createDefaultCustomStrategy()
    const history = 'PPBBPPBBPPBBPPB'.split('') as Winner[]
    expect(evaluateEntryFilter(newestFirst(history), strategy).matched).toBe(true)
  })

  it('rejects a three streak even when a Tie sits inside it and ties keep the streak', () => {
    const strategy = createDefaultCustomStrategy()
    const history = 'PTPPBBPBPBPBPBP'.split('') as Winner[]
    expect(evaluateEntryFilter(newestFirst(history), strategy).matched).toBe(false)
  })

  it('evaluates only the configured window and ignores a later streak', () => {
    const strategy = createDefaultCustomStrategy()
    const history = 'PPBBPPBBPPBBPPBPPP'.split('') as Winner[]
    expect(evaluateEntryFilter(newestFirst(history), strategy).matched).toBe(true)
  })

  it('supports count and sequence conditions in the same structured filter', () => {
    const strategy = createDefaultCustomStrategy()
    strategy.entryFilter.conditions = [
      { id: 'count-t', type: 'result_count', target: 'T', min: 1, max: 1 },
      { id: 'no-bbb', type: 'sequence', sequence: ['B', 'B', 'B'], occurrence: 'absent' },
    ]
    const history = 'PBPBTPBPBPBPBPB'.split('') as Winner[]
    expect(evaluateEntryFilter(newestFirst(history), strategy).matched).toBe(true)
  })
})

describe('custom strategy runtime', () => {
  beforeEach(() => {
    localStorage.clear()
    CustomStrategyService.resetToDefault()
    CustomStrategyRuntime.resetAll()
  })

  it('arms at hand 15, follows the next non-tie, and clears after two wins', () => {
    const first15 = 'PPBBPPBBPPBBPPB'.split('') as Winner[]
    expect(CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room(first15))).toBeNull()

    const first = CustomStrategyRuntime.prepareDecision(
      'strategy:no-streak-15-two-hit',
      room([...first15, 'P'])
    )
    expect(first).toMatchObject({ direction: 'P', amount: 10000, stageIndex: 0, attemptIndex: 0 })
    expect(CustomStrategyRuntime.markPending(first!)).toBe(true)
    expect(CustomStrategyRuntime.settle('room-1', 'win', 'round-17')).toMatchObject({
      handled: true,
      status: 'ready',
      stageIndex: 0,
      attemptIndex: 1,
    })

    const second = CustomStrategyRuntime.prepareDecision(
      'strategy:no-streak-15-two-hit',
      room([...first15, 'P', 'P'])
    )
    expect(second).toMatchObject({ direction: 'P', amount: 10000, stageIndex: 0, attemptIndex: 1 })
    expect(CustomStrategyRuntime.markPending(second!)).toBe(true)
    expect(CustomStrategyRuntime.settle('room-1', 'win', 'round-18')).toMatchObject({
      handled: true,
      status: 'cleared',
      cleared: true,
    })
    expect(CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room([...first15, 'P', 'P', 'P']))).toBeNull()
  })

  it('moves either first- or second-attempt losses to the next stage', () => {
    const first15 = 'PPBBPPBBPPBBPPB'.split('') as Winner[]
    CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room(first15))
    const first = CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room([...first15, 'B']))!
    CustomStrategyRuntime.markPending(first)
    const transition = CustomStrategyRuntime.settle('room-1', 'loss', 'loss-1')
    expect(transition).toMatchObject({ status: 'ready', stageIndex: 1, attemptIndex: 0 })
    const next = CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room([...first15, 'B', 'P']))
    expect(next).toMatchObject({ direction: 'B', amount: 20000, stageIndex: 1, attemptIndex: 0 })
  })

  it('keeps the same attempt on push or rejected placement', () => {
    const first15 = 'PPBBPPBBPPBBPPB'.split('') as Winner[]
    CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room(first15))
    const decision = CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room([...first15, 'P']))!
    CustomStrategyRuntime.markPending(decision)
    expect(CustomStrategyRuntime.settle('room-1', 'push', 'push-1')).toMatchObject({
      status: 'ready', stageIndex: 0, attemptIndex: 0,
    })
    const retry = CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room([...first15, 'P', 'T']))!
    CustomStrategyRuntime.markPending(retry)
    CustomStrategyRuntime.releasePending('room-1', 'rejected')
    expect(CustomStrategyRuntime.getSession('no-streak-15-two-hit', 'room-1')).toMatchObject({
      status: 'ready', stageIndex: 0, attemptIndex: 0,
    })
  })

  it('keeps an in-flight shoe on the strategy snapshot it started with', () => {
    const first15 = 'PPBBPPBBPPBBPPB'.split('') as Winner[]
    CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room(first15))
    const decision = CustomStrategyRuntime.prepareDecision(
      'strategy:no-streak-15-two-hit',
      room([...first15, 'P'])
    )!
    CustomStrategyRuntime.markPending(decision)

    const saved = CustomStrategyService.getById('no-streak-15-two-hit')!
    CustomStrategyService.update(saved.id, {
      progression: {
        ...saved.progression,
        stages: saved.progression.stages.map((stage, index) => (
          index === 1 ? { ...stage, amounts: [99000, 99000] } : stage
        )),
      },
    })

    CustomStrategyRuntime.settle('room-1', 'loss', 'snapshot-loss')
    const next = CustomStrategyRuntime.prepareDecision(
      'strategy:no-streak-15-two-hit',
      room([...first15, 'P', 'B'])
    )
    expect(next).toMatchObject({ amount: 20000, stageIndex: 1, attemptIndex: 0 })
  })

  it('fails closed when enabled after the observation window has already passed', () => {
    const history = 'PPBBPPBBPPBBPPBP'.split('') as Winner[]
    expect(CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room(history))).toBeNull()
    expect(CustomStrategyRuntime.getSession('no-streak-15-two-hit', 'room-1')).toMatchObject({
      status: 'blocked_until_shoe',
    })
  })
})
