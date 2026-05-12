import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FreshShoeTieMartingalePreset } from './FreshShoeTieMartingalePreset'

function createFakeRoomFilterService() {
  const active = new Set<string>()
  return {
    toggleFilter: vi.fn((t: string) => { active.has(t) ? active.delete(t) : active.add(t) }),
    getActiveFilters: () => Array.from(active),
    has(t: string) { return active.has(t) },
  }
}

function createFakeSettings() {
  const settings: any = { forceBetDirection: 'auto' }
  return {
    get: () => ({ ...settings }),
    update: (patch: any) => { Object.assign(settings, patch) },
  }
}

function createFakeListener() {
  let scope: 'auto' | 'semiauto' | null = null
  const triggerCallbacks: any[] = []
  return {
    enable: vi.fn((s: 'auto' | 'semiauto') => {
      scope = s
      return () => { scope = null }
    }),
    disable: vi.fn(() => { scope = null }),
    onTrigger: vi.fn((cb: any) => { triggerCallbacks.push(cb); return () => {} }),
    getScope: () => scope,
    fireTrigger: (roomId: string, reason: string) => triggerCallbacks.forEach(cb => cb(roomId, reason)),
    notePendingBet: vi.fn(),
    signalMartinCap: vi.fn(),
  }
}

function createFakeAdapter() {
  const shoeChangeCbs: any[] = []
  return {
    onShoeChange(cb: any) { shoeChangeCbs.push(cb); return () => {} },
    fireShoeChange(roomId: string) { shoeChangeCbs.forEach(cb => cb(roomId, `room-${roomId}`)) },
  }
}

function createFakeStorage() {
  let data: string | null = null
  return {
    get: () => data,
    set: (v: string) => { data = v },
    remove: () => { data = null },
  }
}

function createPreset(overrides: any = {}) {
  return new FreshShoeTieMartingalePreset({
    filterService: overrides.filterService ?? createFakeRoomFilterService(),
    settingsBridge: overrides.settingsBridge ?? { auto: createFakeSettings(), semiauto: createFakeSettings() },
    listener: overrides.listener ?? createFakeListener(),
    casinoAdapter: overrides.casinoAdapter ?? createFakeAdapter(),
    storage: overrides.storage ?? createFakeStorage(),
    semiAutoTriggerHandler: overrides.semiAutoTriggerHandler ?? vi.fn().mockResolvedValue(undefined),
    onMartinReset: overrides.onMartinReset ?? vi.fn(),
  })
}

describe('FreshShoeTieMartingalePreset', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('enable("auto") activates fresh_shoe filter, sets forceBetDirection, enables listener', () => {
    const filterService = createFakeRoomFilterService()
    const settingsBridge = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener = createFakeListener()
    const p = createPreset({ filterService, settingsBridge, listener })

    p.enable('auto')

    expect(filterService.has('fresh_shoe')).toBe(true)
    expect(settingsBridge.auto.get().forceBetDirection).toBe('tie_only')
    expect(listener.enable).toHaveBeenCalledWith('auto')
    expect(p.isEnabled('auto')).toBe(true)
    expect(p.isEnabled('semiauto')).toBe(false)
  })

  it('disable("auto") restores filter / setting / listener state', () => {
    const filterService = createFakeRoomFilterService()
    const settingsBridge = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener = createFakeListener()
    const p = createPreset({ filterService, settingsBridge, listener })

    p.enable('auto')
    p.disable('auto')

    expect(filterService.has('fresh_shoe')).toBe(false)
    expect(settingsBridge.auto.get().forceBetDirection).toBe('auto')
    expect(listener.getScope()).toBeNull()
    expect(p.isEnabled('auto')).toBe(false)
  })

  it('persists enabled state to storage and auto-restores on construction', () => {
    const storage = createFakeStorage()
    const p1 = createPreset({ storage })
    p1.enable('auto')
    p1.enable('semiauto')

    const filterService2 = createFakeRoomFilterService()
    const settingsBridge2 = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener2 = createFakeListener()
    const p2 = createPreset({ storage, filterService: filterService2, settingsBridge: settingsBridge2, listener: listener2 })

    expect(p2.isEnabled('auto')).toBe(true)
    expect(p2.isEnabled('semiauto')).toBe(true)
    expect(filterService2.has('fresh_shoe')).toBe(true)
  })

  it('isRoomStopped is false initially even with preset enabled', () => {
    const p = createPreset()
    p.enable('auto')
    expect(p.isRoomStopped('r1')).toBe(false)
  })

  it('listener trigger in auto mode marks room as stopped', () => {
    const listener = createFakeListener()
    const p = createPreset({ listener })
    p.enable('auto')
    listener.fireTrigger('r1', 'tie_hit')
    expect(p.isRoomStopped('r1')).toBe(true)
  })

  it('clears STOPPED set on onShoeChange', () => {
    const adapter = createFakeAdapter()
    const listener = createFakeListener()
    const p = createPreset({ casinoAdapter: adapter, listener })
    p.enable('auto')
    listener.fireTrigger('r1', 'tie_hit')
    expect(p.isRoomStopped('r1')).toBe(true)
    adapter.fireShoeChange('r1')
    expect(p.isRoomStopped('r1')).toBe(false)
  })

  it('listener trigger in semiauto mode invokes semiAutoTriggerHandler', () => {
    const listener = createFakeListener()
    const semiAutoTriggerHandler = vi.fn().mockResolvedValue(undefined)
    const p = createPreset({ listener, semiAutoTriggerHandler })
    p.enable('semiauto')
    listener.fireTrigger('r1', 'organic_tie')
    expect(semiAutoTriggerHandler).toHaveBeenCalledWith('r1', 'organic_tie')
    expect(p.isRoomStopped('r1')).toBe(false)
  })

  it('disable rolls back even if listener.enable throws after filter is set', () => {
    const filterService = createFakeRoomFilterService()
    const settingsBridge = { auto: createFakeSettings(), semiauto: createFakeSettings() }
    const listener = {
      ...createFakeListener(),
      enable: vi.fn(() => { throw new Error('listener boom') }),
    } as any
    const p = createPreset({ filterService, settingsBridge, listener })

    expect(() => p.enable('auto')).toThrow('listener boom')
    expect(filterService.has('fresh_shoe')).toBe(false)
    expect(settingsBridge.auto.get().forceBetDirection).toBe('auto')
    expect(p.isEnabled('auto')).toBe(false)
  })

  it("getDescription returns a non-empty Korean help string", () => {
    const p = createPreset()
    const s = p.getDescription()
    expect(s.length).toBeGreaterThan(20)
    expect(s).toMatch(/fresh|슈|Tie|마틴/i)
  })
})
