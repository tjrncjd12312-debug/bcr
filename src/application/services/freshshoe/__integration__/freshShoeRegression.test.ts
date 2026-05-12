import { describe, it, expect } from 'vitest'
import { BettingDecisionService } from '../../automode/BettingDecisionService'
import { MartingaleManager } from '../../automode/MartingaleManager'
import { RestPeriodManager } from '../../automode/RestPeriodManager'
import { DEFAULT_SETTINGS, createRoomContext, type AutoModeSettings } from '../../automode/types'
import type { Prediction } from '../../../../domain/entities'

function pred(p: 'B' | 'P' | 'T' | null): Prediction {
  return { roomId: 'r1', prediction: p, confidence: 0.9, isSkip: false, timestamp: Date.now() } as Prediction
}

function settings(o: Partial<AutoModeSettings> = {}): AutoModeSettings {
  return { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false, ...o }
}

describe('Preset OFF regression — BettingDecisionService unchanged', () => {
  it("defaults forceBetDirection to 'auto' and bets per prediction", () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const cases: Array<{ p: 'B' | 'P' | 'T'; expected: string }> = [
      { p: 'B', expected: 'Banker' },
      { p: 'P', expected: 'Player' },
      { p: 'T', expected: 'Tie' },
    ]
    for (const c of cases) {
      const d = svc.shouldBet('r1', pred(c.p), settings(), createRoomContext('r1', 'Room'))
      expect(d.betType).toBe(c.expected)
    }
  })

  it("BettingDecisionService without gates option preserves backward behavior", () => {
    const svc = new BettingDecisionService(new MartingaleManager(5), new RestPeriodManager())
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 5
    const d = svc.shouldBet('r1', pred('B'), settings({ maxMartin: 5 }), ctx)
    expect(d.shouldBet).toBe(false)
    expect(d.skipReason).toMatch(/최대 마틴/)
  })
})
