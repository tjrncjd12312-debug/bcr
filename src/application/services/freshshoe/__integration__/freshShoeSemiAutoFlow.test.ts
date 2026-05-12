import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MoveOnTieListener } from '../MoveOnTieListener'
import { FreshShoeTieMartingalePreset } from '../FreshShoeTieMartingalePreset'

function makeAdapter() {
  const result: any[] = []
  const shoe: any[] = []
  return {
    onGameResult(cb: any) { result.push(cb); return () => {} },
    onShoeChange(cb: any) { shoe.push(cb); return () => {} },
    emitResult(e: any) { result.forEach(cb => cb(e)) },
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

describe('Fresh-Shoe Tie Martingale — Semi-Auto end-to-end', () => {
  let adapter: ReturnType<typeof makeAdapter>
  let filter: ReturnType<typeof makeFilter>
  let semiAutoTriggerHandler: ReturnType<typeof vi.fn>
  let focusedRoomId: string | null
  let listener: MoveOnTieListener
  let preset: FreshShoeTieMartingalePreset

  beforeEach(() => {
    adapter = makeAdapter()
    filter = makeFilter()
    focusedRoomId = 'r-focus'
    semiAutoTriggerHandler = vi.fn().mockResolvedValue(undefined)
    listener = new MoveOnTieListener({
      casinoAdapter: adapter as any,
      getCurrentFocusedRoomId: () => focusedRoomId,
      onMartinReset: vi.fn(),
    })
    preset = new FreshShoeTieMartingalePreset({
      filterService: filter as any,
      settingsBridge: {
        auto: { get: () => ({ forceBetDirection: 'auto' }), update: vi.fn() },
        semiauto: { get: () => ({ forceBetDirection: 'auto' }), update: vi.fn() },
      },
      listener: listener as any,
      casinoAdapter: adapter as any,
      storage: makeStorage(),
      semiAutoTriggerHandler,
      onMartinReset: vi.fn(),
    })
  })

  it("invokes semiAutoTriggerHandler when focused room sees Tie result", () => {
    preset.enable('semiauto')
    adapter.emitResult({ roomId: 'r-focus', winner: 'T', roundId: 'rd-1' })
    expect(semiAutoTriggerHandler).toHaveBeenCalledWith('r-focus', 'organic_tie')
  })

  it("does NOT invoke handler for non-focused rooms", () => {
    preset.enable('semiauto')
    adapter.emitResult({ roomId: 'r-other', winner: 'T', roundId: 'rd-1' })
    expect(semiAutoTriggerHandler).not.toHaveBeenCalled()
  })

  it("does NOT mark STOPPED in semiauto mode (navigation handler is responsible)", () => {
    preset.enable('semiauto')
    adapter.emitResult({ roomId: 'r-focus', winner: 'T', roundId: 'rd-1' })
    expect(preset.isRoomStopped('r-focus')).toBe(false)
  })

  it("disable removes the listener subscription cleanly", () => {
    preset.enable('semiauto')
    preset.disable('semiauto')
    adapter.emitResult({ roomId: 'r-focus', winner: 'T', roundId: 'rd-1' })
    expect(semiAutoTriggerHandler).not.toHaveBeenCalled()
  })
})
