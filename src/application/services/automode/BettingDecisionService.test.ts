import { describe, it, expect, beforeEach } from 'vitest'
import { BettingDecisionService } from './BettingDecisionService'
import { MartingaleManager } from './MartingaleManager'
import { RestPeriodManager } from './RestPeriodManager'
import { DEFAULT_SETTINGS, createRoomContext, type AutoModeSettings } from './types'
import type { Prediction } from '../../../domain/entities'

function settings(override: Partial<AutoModeSettings> = {}): AutoModeSettings {
  return { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false, ...override }
}

function prediction(p: 'B' | 'P' | 'T' | null, isSkip = false): Prediction {
  return {
    roomId: 'r1',
    prediction: p,
    confidence: 0.9,
    isSkip,
    timestamp: Date.now(),
  } as Prediction
}

describe('BettingDecisionService.forceBetDirection', () => {
  let svc: BettingDecisionService

  beforeEach(() => {
    svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
  })

  it("returns betType='Tie' when forceBetDirection='tie_only' and prediction is 'B'", () => {
    const d = svc.shouldBet('r1', prediction('B'), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
    expect(d.betType).toBe('Tie')
  })

  it("returns betType='Tie' when forceBetDirection='tie_only' and prediction is 'P'", () => {
    const d = svc.shouldBet('r1', prediction('P'), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.betType).toBe('Tie')
  })

  it("returns betType='Tie' when forceBetDirection='tie_only' and prediction is 'T'", () => {
    const d = svc.shouldBet('r1', prediction('T'), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.betType).toBe('Tie')
  })

  it("uses prediction-derived betType when forceBetDirection='auto' (default)", () => {
    const d = svc.shouldBet('r1', prediction('B'), settings({ forceBetDirection: 'auto' }), createRoomContext('r1', 'Room'))
    expect(d.betType).toBe('Banker')
  })

  it("does not bet when prediction.isSkip is true even with forceBetDirection='tie_only'", () => {
    const d = svc.shouldBet('r1', prediction('B', true), settings({ forceBetDirection: 'tie_only' }), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(false)
    expect(d.skipReason).toBe('패스 예측')
  })

  it("respects max martin gate with forceBetDirection='tie_only'", () => {
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 5
    const d = svc.shouldBet('r1', prediction('B'), settings({ forceBetDirection: 'tie_only', maxMartin: 5 }), ctx)
    expect(d.shouldBet).toBe(false)
  })
})
