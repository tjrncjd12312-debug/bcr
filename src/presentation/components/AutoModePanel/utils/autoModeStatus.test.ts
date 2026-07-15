import { beforeEach, describe, expect, it } from 'vitest'
import type { AutoModeSettings, RoomBettingState } from '../../../../application/services/AutoModeService'
import CustomStrategyService from '../../../../application/services/CustomStrategyService'
import CustomStrategyRuntime from '../../../../application/services/customstrategy/CustomStrategyRuntime'
import type { Room } from '../../../../domain/entities'
import {
  getFilterShortLabel,
  getRoomProgressionDisplay,
  getRoomStatusChip,
  isTieFilterLabel,
} from './autoModeStatus'

function settings(): AutoModeSettings {
  return {
    enabled: true,
    isVirtualMode: true,
    autoBetting: true,
    baseBetAmount: 10_000,
    maxMartin: 5,
    betStrategy: 'martingale',
    customBetAmounts: [],
    roomConfigs: [],
    patternConfigs: [],
  } as unknown as AutoModeSettings
}

function structuredState(): RoomBettingState {
  return {
    roomId: 'room-1',
    roomName: '테스트 방',
    martinLevel: 4,
    waitingForResult: false,
    lastBetAmount: 10_000,
    customStrategyId: 'no-streak-15-two-hit',
    customStrategyStage: 2,
    customStrategyAttempt: 1,
    customStrategyStatus: 'ready',
  } as unknown as RoomBettingState
}

describe('autoModeStatus — structured strategy display', () => {
  beforeEach(() => {
    CustomStrategyService.resetToDefault()
    CustomStrategyRuntime.resetAll()
  })

  it('uses the structured stage amount instead of stacking the global martingale level', () => {
    const display = getRoomProgressionDisplay(settings(), structuredState())

    expect(display).toMatchObject({
      kind: 'structured',
      strategyLabel: '15회 무3연속 · 2연승',
      stepLabel: '2단계 1차',
      compactStepLabel: 'S2-1',
      amount: 20_000,
      stage: 2,
      maxStage: 3,
    })
  })

  it('shows structured observation and execution states without calling them martingale', () => {
    expect(getRoomStatusChip(structuredState(), settings(), true, true).text)
      .toBe('조건전략 2단계 1차 · 배팅준비')

    const observing = { ...structuredState(), customStrategyStatus: 'observing' as const }
    expect(getRoomStatusChip(observing, settings(), true, true).text).toBe('진입 조건 관찰')
  })

  it('resolves strategy filter labels and Korean tie labels consistently', () => {
    expect(getFilterShortLabel(['strategy:no-streak-15-two-hit'])).toBe('15회 무3연속 · 2연승')
    expect(isTieFilterLabel('타이 0/2 (1~60판)')).toBe(true)
    expect(isTieFilterLabel('Tie 0/2')).toBe(true)
  })

  it('keeps showing the in-flight snapshot amount after the saved strategy is edited', () => {
    const chronological = 'PPBBPPBBPPBBPPB'.split('')
    const room = {
      id: 'room-1',
      name: '테스트 방',
      koreanName: '테스트 방',
      history: chronological.map(winner => ({ winner })).reverse(),
    } as unknown as Room
    CustomStrategyRuntime.prepareDecision('strategy:no-streak-15-two-hit', room)

    const saved = CustomStrategyService.getById('no-streak-15-two-hit')!
    CustomStrategyService.update(saved.id, {
      progression: {
        ...saved.progression,
        stages: saved.progression.stages.map((stage, index) => (
          index === 1 ? { ...stage, amounts: [99_000, 99_000] } : stage
        )),
      },
    })

    expect(getRoomProgressionDisplay(settings(), structuredState()).amount).toBe(20_000)
  })
})
