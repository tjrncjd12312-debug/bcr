import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MoveOnTieListener } from '../MoveOnTieListener'
import { FreshShoeTieMartingalePreset } from '../FreshShoeTieMartingalePreset'
import { BettingDecisionService } from '../../automode/BettingDecisionService'
import { MartingaleManager } from '../../automode/MartingaleManager'
import { DEFAULT_SETTINGS, createRoomContext } from '../../automode/types'
import type { Prediction } from '../../../../domain/entities'

function makeAdapter() {
  const result: any[] = []
  const shoe: any[] = []
  return {
    onGameResult(cb: any) { result.push(cb); return () => {} },
    onShoeChange(cb: any) { shoe.push(cb); return () => {} },
    emitResult(e: any) { result.forEach(cb => cb(e)) },
    emitShoeChange(roomId: string) { shoe.forEach(cb => cb(roomId, `room-${roomId}`)) },
  }
}

function makeFilter() {
  const active = new Set<string>()
  return {
    toggleFilter(t: string) { active.has(t) ? active.delete(t) : active.add(t) },
    getActiveFilters() { return Array.from(active) },
  }
}

function makeStorage() {
  let v: string | null = null
  return { get: () => v, set: (s: string) => { v = s }, remove: () => { v = null } }
}

function pred(p: 'B' | 'P' | 'T' | null): Prediction {
  return { roomId: 'r1', prediction: p, confidence: 0.9, isSkip: false, timestamp: Date.now() } as Prediction
}

describe('Fresh-Shoe Tie Martingale — Auto mode end-to-end', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let filter: ReturnType<typeof makeFilter>
  let listener: MoveOnTieListener
  let martin: MartingaleManager
  let svc: BettingDecisionService
  let preset: FreshShoeTieMartingalePreset
  let autoSettings: any
  let semiAutoSettings: any

  beforeEach(() => {
    adapter = makeAdapter()
    filter = makeFilter()
    autoSettings = { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false, maxMartin: 3 }
    semiAutoSettings = { ...DEFAULT_SETTINGS, autoBetting: true, isVirtualMode: false }
    martin = new MartingaleManager(3)
    listener = new MoveOnTieListener({
      casinoAdapter: adapter as any,
      getCurrentFocusedRoomId: () => null,
      onMartinReset: (id) => martin.resetLevel(id),
    })
    svc = new BettingDecisionService(martin, {})
    preset = new FreshShoeTieMartingalePreset({
      filterService: filter as any,
      settingsBridge: {
        auto: { get: () => autoSettings, update: (p) => Object.assign(autoSettings, p) },
        semiauto: { get: () => semiAutoSettings, update: (p) => Object.assign(semiAutoSettings, p) },
      },
      listener: listener as any,
      casinoAdapter: adapter as any,
      storage: makeStorage(),
      semiAutoTriggerHandler: vi.fn().mockResolvedValue(undefined),
      onMartinReset: (id) => martin.resetLevel(id),
    })
    svc.setStoppedRoomsChecker((id) => preset.isRoomStopped(id))
    svc.setOnMartinCap((id) => listener.signalMartinCap(id))
  })

  it('forces Tie bet when preset is enabled', () => {
    preset.enable('auto')
    const d = svc.shouldBet('r1', pred('B'), autoSettings, createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
    expect(d.betType).toBe('Tie')
  })

  it('stops betting in room after a Tie result, resumes after shoe change', () => {
    preset.enable('auto')

    const ctx = createRoomContext('r1', 'Room')
    const d1 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d1.shouldBet).toBe(true)
    listener.notePendingBet('r1', { roundId: 'rd-1', betType: 'Tie' })

    adapter.emitResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })

    const d2 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d2.shouldBet).toBe(false)
    expect(d2.skipReason).toBe('Fresh-shoe 종료')

    adapter.emitShoeChange('r1')
    const d3 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d3.shouldBet).toBe(true)
  })

  it('stops betting after martin cap, resumes after shoe change', () => {
    preset.enable('auto')
    const ctx = createRoomContext('r1', 'Room')
    ctx.martingale.level = 3

    const d1 = svc.shouldBet('r1', pred('B'), autoSettings, ctx)
    expect(d1.shouldBet).toBe(false)
    expect(d1.skipReason).toMatch(/최대 마틴/)

    const ctx2 = createRoomContext('r1', 'Room')
    ctx2.martingale.level = 0
    const d2 = svc.shouldBet('r1', pred('B'), autoSettings, ctx2)
    expect(d2.shouldBet).toBe(false)
    expect(d2.skipReason).toBe('Fresh-shoe 종료')

    adapter.emitShoeChange('r1')
    const d3 = svc.shouldBet('r1', pred('B'), autoSettings, ctx2)
    expect(d3.shouldBet).toBe(true)
  })

  it('disable restores full prior behavior', () => {
    const beforeFilters = filter.getActiveFilters().slice()
    const beforeForceDir = autoSettings.forceBetDirection
    preset.enable('auto')
    preset.disable('auto')
    expect(filter.getActiveFilters()).toEqual(beforeFilters)
    expect(autoSettings.forceBetDirection).toBe(beforeForceDir)
    const d = svc.shouldBet('r1', pred('B'), autoSettings, createRoomContext('r1', 'Room'))
    expect(d.shouldBet).toBe(true)
    expect(d.betType).toBe('Banker')
  })
})
