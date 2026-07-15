import type { RoadResult, Winner } from '../entities'

export const CUSTOM_STRATEGY_SCHEMA_VERSION = 1 as const

export type CustomStrategyFilterType = `strategy:${string}`
export type StrategyConditionLogic = 'all' | 'any'
export type StrategyTiePolicy = 'ignore_keep_streak' | 'break_streak'

export interface MaxStreakCondition {
  id: string
  type: 'max_streak'
  targets: Array<'P' | 'B' | 'T'>
  max: number
  tiePolicy: StrategyTiePolicy
}

export interface ResultCountCondition {
  id: string
  type: 'result_count'
  target: 'P' | 'B' | 'T'
  min: number
  max: number
}

export interface SequenceCondition {
  id: string
  type: 'sequence'
  sequence: Winner[]
  occurrence: 'present' | 'absent'
}

export type CustomEntryCondition = MaxStreakCondition | ResultCountCondition | SequenceCondition

export interface CustomStrategyStage {
  id: string
  amounts: number[]
}

export interface CustomStrategyDefinitionV1 {
  schemaVersion: typeof CUSTOM_STRATEGY_SCHEMA_VERSION
  id: string
  name: string
  description?: string
  enabled: boolean
  entryFilter: {
    fromHand: number
    toHand: number
    requireFullWindow: boolean
    logic: StrategyConditionLogic
    conditions: CustomEntryCondition[]
  }
  trigger: {
    type: 'next_non_tie' | 'player_only' | 'banker_only'
    direction: 'follow' | 'opposite' | 'fixed_player' | 'fixed_banker' | 'fixed_tie'
    startBet: 'next_round'
  }
  progression: {
    requiredConsecutiveWins: number
    stages: CustomStrategyStage[]
    onLoss: 'next_stage'
    onPush: 'retry_same'
    onRejected: 'retry_same'
    onLastStageLoss: 'stop_until_shoe' | 'repeat_last'
  }
  onClear: 'stop_until_shoe' | 'rearm'
  createdAt: number
  updatedAt: number
}

export interface StrategyValidationResult {
  valid: boolean
  errors: string[]
}

export interface EntryFilterEvaluation {
  complete: boolean
  matched: boolean
  conditionResults: boolean[]
  reason: string
}

export interface StrategyTriggerMatch {
  handNumber: number
  result: 'P' | 'B'
  direction: Winner
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function validateCustomStrategy(strategy: CustomStrategyDefinitionV1): StrategyValidationResult {
  const errors: string[] = []

  if (!strategy || strategy.schemaVersion !== CUSTOM_STRATEGY_SCHEMA_VERSION) {
    errors.push('지원하지 않는 전략 서식 버전입니다.')
    return { valid: false, errors }
  }
  if (!strategy.id?.trim()) errors.push('전략 ID가 없습니다.')
  if (!strategy.name?.trim()) errors.push('전략 이름을 입력하세요.')

  const { fromHand, toHand, conditions } = strategy.entryFilter
  if (!isPositiveInteger(fromHand)) errors.push('관찰 시작 회차는 1 이상 정수여야 합니다.')
  if (!isPositiveInteger(toHand)) errors.push('관찰 종료 회차는 1 이상 정수여야 합니다.')
  if (isPositiveInteger(fromHand) && isPositiveInteger(toHand) && fromHand > toHand) {
    errors.push('관찰 종료 회차는 시작 회차보다 빠를 수 없습니다.')
  }
  if (!Array.isArray(conditions) || conditions.length === 0) {
    errors.push('진입 조건을 한 개 이상 추가하세요.')
  } else {
    conditions.forEach((condition, index) => {
      const label = `조건 ${index + 1}`
      if (!condition.id?.trim()) errors.push(`${label}의 ID가 없습니다.`)
      if (condition.type === 'max_streak') {
        if (!Array.isArray(condition.targets) || condition.targets.length === 0) {
          errors.push(`${label}의 검사 대상을 선택하세요.`)
        }
        if (!isPositiveInteger(condition.max)) errors.push(`${label}의 최대 연속은 1 이상 정수여야 합니다.`)
      } else if (condition.type === 'result_count') {
        if (!isNonNegativeInteger(condition.min) || !isNonNegativeInteger(condition.max)) {
          errors.push(`${label}의 출현 횟수는 0 이상 정수여야 합니다.`)
        } else if (condition.min > condition.max) {
          errors.push(`${label}의 최대 출현 횟수는 최소보다 작을 수 없습니다.`)
        }
      } else if (condition.type === 'sequence') {
        if (!Array.isArray(condition.sequence) || condition.sequence.length === 0) {
          errors.push(`${label}의 B/P/T 패턴을 입력하세요.`)
        }
      } else {
        errors.push(`${label}의 형식이 올바르지 않습니다.`)
      }
    })
  }

  const wins = strategy.progression.requiredConsecutiveWins
  if (!isPositiveInteger(wins) || wins > 5) errors.push('목표 연속 적중은 1~5 사이 정수여야 합니다.')
  if (!Array.isArray(strategy.progression.stages) || strategy.progression.stages.length === 0) {
    errors.push('베팅 단계를 한 개 이상 추가하세요.')
  } else {
    strategy.progression.stages.forEach((stage, stageIndex) => {
      if (!stage.id?.trim()) errors.push(`${stageIndex + 1}단계의 ID가 없습니다.`)
      if (!Array.isArray(stage.amounts) || stage.amounts.length !== wins) {
        errors.push(`${stageIndex + 1}단계 금액은 목표 적중 횟수(${wins})와 같아야 합니다.`)
        return
      }
      stage.amounts.forEach((amount, attemptIndex) => {
        if (!isPositiveInteger(amount)) {
          errors.push(`${stageIndex + 1}단계 ${attemptIndex + 1}차 금액은 1 이상 정수여야 합니다.`)
        }
      })
    })
  }

  return { valid: errors.length === 0, errors }
}

export function toChronologicalWinners(history: Winner[] | RoadResult[]): Winner[] {
  if (history.length === 0) return []
  const winners = typeof history[0] === 'string'
    ? history as Winner[]
    : (history as RoadResult[]).map(result => result.winner)
  return [...winners].reverse()
}

function evaluateMaxStreak(window: Winner[], condition: MaxStreakCondition): boolean {
  const targets = new Set<Winner>(condition.targets)
  let currentResult: Winner | null = null
  let currentLength = 0
  let observedMax = 0

  for (const result of window) {
    if (result === 'T' && condition.tiePolicy === 'ignore_keep_streak' && !targets.has('T')) {
      continue
    }
    if (!targets.has(result)) {
      currentResult = null
      currentLength = 0
      continue
    }
    if (currentResult === result) {
      currentLength += 1
    } else {
      currentResult = result
      currentLength = 1
    }
    observedMax = Math.max(observedMax, currentLength)
  }

  return observedMax <= condition.max
}

function evaluateSequence(window: Winner[], condition: SequenceCondition): boolean {
  const sequence = condition.sequence
  let found = false
  for (let start = 0; start <= window.length - sequence.length; start++) {
    if (sequence.every((result, offset) => window[start + offset] === result)) {
      found = true
      break
    }
  }
  return condition.occurrence === 'present' ? found : !found
}

export function evaluateEntryFilter(
  history: Winner[] | RoadResult[],
  strategy: CustomStrategyDefinitionV1
): EntryFilterEvaluation {
  const chronological = toChronologicalWinners(history)
  const { fromHand, toHand, requireFullWindow, conditions, logic } = strategy.entryFilter
  const complete = chronological.length >= toHand

  if (requireFullWindow && !complete) {
    return {
      complete: false,
      matched: false,
      conditionResults: [],
      reason: `${toHand}회차 관찰 대기 (${chronological.length}/${toHand})`,
    }
  }

  const endExclusive = Math.min(toHand, chronological.length)
  const window = chronological.slice(Math.max(0, fromHand - 1), endExclusive)
  if (window.length === 0) {
    return { complete, matched: false, conditionResults: [], reason: '관찰 구간에 결과가 없습니다.' }
  }

  const conditionResults = conditions.map(condition => {
    if (condition.type === 'max_streak') return evaluateMaxStreak(window, condition)
    if (condition.type === 'result_count') {
      const count = window.filter(result => result === condition.target).length
      return count >= condition.min && count <= condition.max
    }
    return evaluateSequence(window, condition)
  })

  const matched = logic === 'all'
    ? conditionResults.every(Boolean)
    : conditionResults.some(Boolean)

  return {
    complete,
    matched,
    conditionResults,
    reason: matched ? '진입 조건 충족' : '진입 조건 불충족',
  }
}

export function resolveTriggerDirection(
  result: 'P' | 'B',
  direction: CustomStrategyDefinitionV1['trigger']['direction']
): Winner {
  if (direction === 'follow') return result
  if (direction === 'opposite') return result === 'P' ? 'B' : 'P'
  if (direction === 'fixed_player') return 'P'
  if (direction === 'fixed_banker') return 'B'
  return 'T'
}

export function findStrategyTrigger(
  chronological: Winner[],
  strategy: CustomStrategyDefinitionV1,
  afterHand: number
): StrategyTriggerMatch | null {
  for (let index = Math.max(strategy.entryFilter.toHand, afterHand); index < chronological.length; index++) {
    const result = chronological[index]
    const matches = strategy.trigger.type === 'next_non_tie'
      ? result === 'P' || result === 'B'
      : strategy.trigger.type === 'player_only'
        ? result === 'P'
        : result === 'B'
    if (!matches || (result !== 'P' && result !== 'B')) continue
    return {
      handNumber: index + 1,
      result,
      direction: resolveTriggerDirection(result, strategy.trigger.direction),
    }
  }
  return null
}

export function createDefaultCustomStrategy(now = Date.now()): CustomStrategyDefinitionV1 {
  return {
    schemaVersion: CUSTOM_STRATEGY_SCHEMA_VERSION,
    id: 'no-streak-15-two-hit',
    name: '15회 무3연속 · 2연승',
    description: '1~15회차에 P/B 3연속이 없으면 다음 P/B 방향으로 진입합니다.',
    enabled: true,
    entryFilter: {
      fromHand: 1,
      toHand: 15,
      requireFullWindow: true,
      logic: 'all',
      conditions: [{
        id: 'condition-max-streak',
        type: 'max_streak',
        targets: ['P', 'B'],
        max: 2,
        tiePolicy: 'ignore_keep_streak',
      }],
    },
    trigger: {
      type: 'next_non_tie',
      direction: 'follow',
      startBet: 'next_round',
    },
    progression: {
      requiredConsecutiveWins: 2,
      stages: [
        { id: 'stage-1', amounts: [10000, 10000] },
        { id: 'stage-2', amounts: [20000, 20000] },
        { id: 'stage-3', amounts: [40000, 40000] },
      ],
      onLoss: 'next_stage',
      onPush: 'retry_same',
      onRejected: 'retry_same',
      onLastStageLoss: 'stop_until_shoe',
    },
    onClear: 'stop_until_shoe',
    createdAt: now,
    updatedAt: now,
  }
}

export function describeCustomStrategy(strategy: CustomStrategyDefinitionV1): string {
  const { fromHand, toHand } = strategy.entryFilter
  const stageCount = strategy.progression.stages.length
  const wins = strategy.progression.requiredConsecutiveWins
  const trigger = strategy.trigger.direction === 'follow'
    ? '나온 방향 따라가기'
    : strategy.trigger.direction === 'opposite'
      ? '반대 방향'
      : strategy.trigger.direction === 'fixed_player'
        ? '플레이어 고정'
        : strategy.trigger.direction === 'fixed_banker'
          ? '뱅커 고정'
          : '타이 고정'
  return `${fromHand}~${toHand}회 관찰 · ${trigger} · ${wins}연속 적중 · ${stageCount}단계`
}
