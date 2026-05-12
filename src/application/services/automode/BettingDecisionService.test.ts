import { describe, it, expect, beforeEach, vi } from 'vitest'
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

describe('BettingDecisionService gates', () => {
  it('emits martin_cap callback when level reaches maxMartin', () => {
    const martin = new MartingaleManager(5)
    const onMartinCap = vi.fn()
    const svc = new BettingDecisionService(martin, new RestPeriodManager(), { onMartinCap })
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 5
    const d = svc.shouldBet('r1', prediction('B'), settings({ maxMartin: 5 }), ctx)
    expect(d.shouldBet).toBe(false)
    expect(onMartinCap).toHaveBeenCalledWith('r1')
  })

  it('does NOT emit martin_cap callback when level is below cap', () => {
    const onMartinCap = vi.fn()
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager(), { onMartinCap })
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 3
    svc.shouldBet('r1', prediction('B'), settings({ maxMartin: 5 }), ctx)
    expect(onMartinCap).not.toHaveBeenCalled()
  })

  it('blocks bet when stoppedRoomsChecker returns true', () => {
    const stoppedRoomsChecker = vi.fn((roomId: string) => roomId === 'r-stopped')
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager(), { stoppedRoomsChecker })
    const d = svc.shouldBet('r-stopped', prediction('B'), settings(), createRoomContext('r-stopped', 'Room'))
    expect(d.shouldBet).toBe(false)
    expect(d.skipReason).toBe('Fresh-shoe 종료')
  })

  it('allows bet when stoppedRoomsChecker returns false', () => {
    const stoppedRoomsChecker = vi.fn(() => false)
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager(), { stoppedRoomsChecker })
    const d = svc.shouldBet('r1', prediction('B'), settings(), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
  })

  it('does not require gates option (backwards compatible)', () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const d = svc.shouldBet('r1', prediction('B'), settings(), createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
  })

  it('setStoppedRoomsChecker and setOnMartinCap allow post-construction wiring', () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const checker = vi.fn((roomId: string) => roomId === 'r-stopped')
    const onCap = vi.fn()
    svc.setStoppedRoomsChecker(checker)
    svc.setOnMartinCap(onCap)

    expect(svc.shouldBet('r-stopped', prediction('B'), settings(), createRoomContext('r-stopped', 'Room')).shouldBet).toBe(false)

    const ctx = createRoomContext('r-capped', 'Room')
    ctx.martingale.level = 5
    svc.shouldBet('r-capped', prediction('B'), settings({ maxMartin: 5 }), ctx)
    expect(onCap).toHaveBeenCalledWith('r-capped')
  })
})
