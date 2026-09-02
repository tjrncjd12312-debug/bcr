// AutoModeStatus utilities — Mosaic/Grid/List 세 뷰가 공유하는 상태 칩/필터 라벨/다음 배팅금액 계산
// Clean Architecture: Presentation Layer Utility (no React 의존성, pure functions)

import type { AutoModeSettings, RoomBettingState } from '../../../../application/services/AutoModeService'
import type { RoomFilterType } from '../../../../domain/entities'
import FilterThresholdsService from '../../../../application/services/FilterThresholdsService'
import CustomStrategyService from '../../../../application/services/CustomStrategyService'
import CustomStrategyRuntime from '../../../../application/services/customstrategy/CustomStrategyRuntime'

export type ChipTone = 'idle' | 'observing' | 'betting' | 'pending' | 'martin' | 'disabled'

export interface RoomStatusChip {
  text: string
  tone: ChipTone
}

export interface RoomStatusChipOptions {
  /** 모자이크처럼 좁은 칸은 brief=true로 짧게 표시 (예: 마틴 3단계 → M3) */
  brief?: boolean
}

/**
 * 방의 현재 상태를 한 줄 칩으로 요약.
 */
export function getRoomStatusChip(
  autoState: RoomBettingState | null,
  _settings: AutoModeSettings,
  isEnabled: boolean,
  isAutoEnabled: boolean,
  options?: RoomStatusChipOptions,
): RoomStatusChip {
  const brief = options?.brief === true

  if (!isEnabled) return { text: '정지', tone: 'disabled' }
  if (!isAutoEnabled) return { text: '대기', tone: 'idle' }

  const martinLevel = autoState?.martinLevel ?? 0
  const waitingForResult = autoState?.waitingForResult ?? false

  if (autoState?.customStrategyId && autoState.customStrategyStatus) {
    const stage = autoState.customStrategyStage ?? 1
    const attempt = autoState.customStrategyAttempt ?? 1
    const step = `${stage}-${attempt}`

    switch (autoState.customStrategyStatus) {
      case 'pending':
        // brief(모자이크)도 한글로 — 'S2-1*' 같은 약어는 읽을 수 없다
        return brief
          ? { text: `${step} 결과 대기`, tone: 'pending' }
          : { text: `조건전략 ${stage}단계 ${attempt}차 · 결과대기`, tone: 'pending' }
      case 'ready':
        return brief
          ? { text: `${step} 배팅 준비`, tone: 'betting' }
          : { text: `조건전략 ${stage}단계 ${attempt}차 · 배팅준비`, tone: 'betting' }
      case 'waiting_trigger':
        return { text: brief ? '트리거' : '진입 트리거 대기', tone: 'observing' }
      case 'observing':
        return { text: brief ? '관찰' : '진입 조건 관찰', tone: 'observing' }
      case 'cleared':
        return { text: '클리어', tone: 'observing' }
      case 'failed':
        return { text: brief ? '종료' : '전략 단계 종료', tone: 'disabled' }
      case 'blocked_until_shoe':
        return { text: brief ? '슈 대기' : '다음 슈까지 정지', tone: 'disabled' }
    }
  }

  if (waitingForResult) {
    if (martinLevel > 0) {
      return brief
        ? { text: `마틴 ${martinLevel + 1} 대기`, tone: 'martin' }
        : { text: `마틴 ${martinLevel + 1}단계 대기`, tone: 'martin' }
    }
    return brief
      ? { text: '결과 대기', tone: 'pending' }
      : { text: '결과 대기', tone: 'pending' }
  }

  if (martinLevel > 0) {
    return brief
      ? { text: `마틴 ${martinLevel + 1}단계`, tone: 'martin' }
      : { text: `마틴 ${martinLevel + 1}단계`, tone: 'martin' }
  }

  // 사용자 요구: 필터에 걸린 방이면 배팅이 진행되어야 한다. lastPrediction이 있더라도
  // 별도의 "관망" 상태는 표시하지 않고 그냥 대기로 통일한다(혼동 방지).
  return { text: '대기', tone: 'idle' }
}

/**
 * 현재 활성 필터를 짧은 라벨로 변환. 여러 필터일 경우 첫 번째만 라벨링.
 * 예: tie_frequent + 임계값 (start=1, window=60, min=0, max=0) → "Tie 0/0 (1~60판)"
 */
export function getFilterShortLabel(
  activeFilters: RoomFilterType[] | undefined,
): string | null {
  if (!activeFilters || activeFilters.length === 0) return null
  const filter = activeFilters[0]

  if (typeof filter === 'string' && filter.startsWith('custom:')) {
    return '커스텀 패턴'
  }

  if (typeof filter === 'string' && filter.startsWith('strategy:')) {
    return CustomStrategyService.getByFilterType(filter)?.name ?? '조건·단계 전략'
  }

  const thresholds = FilterThresholdsService.get()

  switch (filter) {
    case 'tie_frequent': {
      const { tieFrequentStart, tieFrequentWindow, tieFrequentMinCount, tieFrequentMaxCount } = thresholds
      const end = tieFrequentStart + tieFrequentWindow - 1
      return `타이 ${tieFrequentMinCount}/${tieFrequentMaxCount} (${tieFrequentStart}~${end}판)`
    }
    case 'tie_drought':
      return `타이 없음 ≥${thresholds.tieDroughtThreshold}판`
    case 'no_tie_room':
      return '타이 0건'
    case 'fresh_room':
      return `신규 ≤${thresholds.freshRoomGames}판`
    case 'fresh_shoe':
      return `새 슈 ≤${thresholds.freshShoeMaxGameNumber}판`
    case 'banker_dominant':
      return 'B 우세'
    case 'player_dominant':
      return 'P 우세'
    case 'alternating':
      return '퐁당 (4+)'
    case 'long_streak':
      return '장줄 (4+)'
    case 'short_streak':
      return '단줄 (2~3)'
    case 'after_tie':
      return '타이 직후'
    case 'winning_streak':
      return '연승'
    case 'losing_streak':
      return '연패'
    default:
      return null
  }
}

// 100단까지 안전하게 커버하는 피보나치 배열 (MartingaleManager와 동일 길이/값)
const FIBONACCI_MULTIPLIERS: readonly number[] = (() => {
  const arr: number[] = [1, 1]
  for (let i = 2; i < 100; i++) arr.push(arr[i - 1] + arr[i - 2])
  return arr
})()

export interface NextBetAmountOptions {
  /** 추가 캡 (예: 테이블 최대 한도). 0 또는 미지정이면 캡 미적용. */
  cap?: number
  /** Tie 베팅이면 settings.tieMaxBetLimit를 추가로 캡으로 적용 */
  isTieBet?: boolean
}

/**
 * 현재 마틴 레벨 기준 다음 배팅 금액 계산. MartingaleManager.calculateBetAmount와 동일한 식.
 * 실제 배팅 금액과 UI 표시가 어긋나지 않도록 한 곳에서만 식을 유지한다.
 *
 * 캡 우선순위: options.cap 와 settings.tieMaxBetLimit(Tie인 경우) 중 더 작은 값을 적용.
 * 실제 배팅 경로에서는 AutoModeService가 마지막에 한 번 더 강제한다.
 */
export function getNextBetAmount(
  settings: AutoModeSettings,
  martinLevel: number,
  options?: NextBetAmountOptions,
): number {
  const effectiveLevel = Math.min(martinLevel, Math.max(0, (settings.maxMartin || 1) - 1))
  const base = settings.baseBetAmount || 0
  let raw: number
  switch (settings.betStrategy) {
    case 'flat':
      raw = base
      break
    case 'fibonacci': {
      const idx = Math.min(effectiveLevel, FIBONACCI_MULTIPLIERS.length - 1)
      raw = base * FIBONACCI_MULTIPLIERS[idx]
      break
    }
    case 'paroli':
      // MartingaleManager와 동일: 최대 2레벨까지만 배수 적용 (1, 2, 4)
      raw = base * Math.pow(2, Math.min(effectiveLevel, 2))
      break
    case 'custom': {
      const arr = settings.customBetAmounts
      if (arr && arr.length > effectiveLevel) {
        const v = arr[effectiveLevel]
        if (typeof v === 'number' && v > 0) {
          raw = v
          break
        }
      }
      raw = base
      break
    }
    case 'martingale':
    default:
      raw = base * Math.pow(2, effectiveLevel)
      break
  }
  // 캡 적용: options.cap 와 Tie 한도(Tie 베팅인 경우) 중 더 작은 값을 사용
  let effectiveCap = 0
  if (options?.cap && options.cap > 0) effectiveCap = options.cap
  if (options?.isTieBet && settings.tieMaxBetLimit && settings.tieMaxBetLimit > 0) {
    effectiveCap = effectiveCap > 0
      ? Math.min(effectiveCap, settings.tieMaxBetLimit)
      : settings.tieMaxBetLimit
  }
  if (effectiveCap > 0 && raw > effectiveCap) return effectiveCap
  return raw
}

export type ProgressionKind = 'structured' | 'global'

export interface RoomProgressionDisplay {
  kind: ProgressionKind
  strategyLabel: string
  stepLabel: string
  compactStepLabel: string
  amount: number
  stage: number
  attempt?: number
  maxStage: number
  progressPercent: number
}

/**
 * 세 화면에서 같은 기준으로 보여 줄 전략 진행 상태.
 * 조건·단계 전략이 실행 중이면 해당 전략의 단계/차수/금액이 전역 마틴 설정보다 우선한다.
 */
export function getRoomProgressionDisplay(
  settings: AutoModeSettings,
  autoState: RoomBettingState | null,
  options?: NextBetAmountOptions,
): RoomProgressionDisplay {
  const customStrategy = autoState?.customStrategyId
    ? CustomStrategyRuntime.getStrategySnapshot(autoState.customStrategyId, autoState.roomId)
      ?? CustomStrategyService.getById(autoState.customStrategyId)
    : null

  if (customStrategy) {
    const maxStage = Math.max(1, customStrategy.progression.stages.length)
    const stage = Math.min(Math.max(1, autoState?.customStrategyStage ?? 1), maxStage)
    const maxAttempt = Math.max(1, customStrategy.progression.requiredConsecutiveWins)
    const attempt = Math.min(Math.max(1, autoState?.customStrategyAttempt ?? 1), maxAttempt)
    const stageConfig = customStrategy.progression.stages[stage - 1]
    const configuredAmount = stageConfig?.amounts[attempt - 1]
    const amount = typeof configuredAmount === 'number' && configuredAmount > 0
      ? configuredAmount
      : autoState?.lastBetAmount ?? 0
    const completedUnits = (stage - 1) + (attempt / maxAttempt)

    return {
      kind: 'structured',
      strategyLabel: customStrategy.name,
      stepLabel: `${stage}단계 ${attempt}차`,
      compactStepLabel: `S${stage}-${attempt}`,
      amount,
      stage,
      attempt,
      maxStage,
      progressPercent: Math.min(100, Math.max(0, (completedUnits / maxStage) * 100)),
    }
  }

  const maxStage = Math.max(1, settings.maxMartin || 1)
  const stage = Math.min(Math.max(1, (autoState?.martinLevel ?? 0) + 1), maxStage)
  const strategyLabel = settings.betStrategy === 'martingale'
    ? '마틴게일'
    : settings.betStrategy === 'flat'
      ? '플랫'
      : settings.betStrategy === 'fibonacci'
        ? '피보나치'
        : settings.betStrategy === 'paroli'
          ? '파롤리'
          : '단계별 금액'

  return {
    kind: 'global',
    strategyLabel,
    stepLabel: settings.betStrategy === 'flat' ? '고정 금액' : `${stage}단계`,
    compactStepLabel: settings.betStrategy === 'flat' ? '고정' : `${stage}단`,
    amount: getNextBetAmount(settings, autoState?.martinLevel ?? 0, options),
    stage,
    maxStage,
    progressPercent: Math.min(100, Math.max(0, (stage / maxStage) * 100)),
  }
}

export function isTieFilterLabel(label: string | null | undefined): boolean {
  return Boolean(label && (label.startsWith('타이') || /^tie\b/i.test(label)))
}

/**
 * 큰 금액을 한국식 만/억 단위로 압축 (Mosaic처럼 좁은 공간용).
 * 한국 노인 사용자도 즉시 해독 가능한 표기를 위해 'K' 약어 대신 '만/억' 사용.
 * 예: 15000 → '1.5만', 1500000 → '150만', 100000000 → '1억'
 */
export function compactAmount(amount: number): string {
  if (amount === 0) return '0'
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  const formatUnit = (value: number, unit: string): string => {
    // 10 이상은 정수로(예: 15만), 10 미만은 소수 한 자리(예: 1.5만), 정수면 소수점 제거
    const rounded = value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '')
    return `${sign}${rounded}${unit}`
  }
  if (abs >= 100_000_000) return formatUnit(abs / 100_000_000, '억')
  if (abs >= 10_000) return formatUnit(abs / 10_000, '만')
  return amount.toLocaleString()
}
