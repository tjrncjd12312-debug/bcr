import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MoveOnTieListener, type TriggerReason } from './MoveOnTieListener'

function createFakeAdapter() {
  const resultCallbacks: Array<(e: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) => void> = []
  return {
    onGameResult(cb: (e: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) => void): () => void {
      resultCallbacks.push(cb)
      return () => {
        const i = resultCallbacks.indexOf(cb)
        if (i >= 0) resultCallbacks.splice(i, 1)
      }
    },
    fireResult(e: { roomId: string; winner: 'B' | 'P' | 'T'; roundId?: string }) {
      resultCallbacks.slice().forEach(cb => cb(e))
    },
  }
}

describe('MoveOnTieListener', () => {
  let adapter: ReturnType<typeof createFakeAdapter>
  let listener: MoveOnTieListener
  let emitted: Array<{ roomId: string; reason: TriggerReason }>

  beforeEach(() => {
    adapter = createFakeAdapter()
    listener = new MoveOnTieListener({
      casinoAdapter: adapter,
      getCurrentFocusedRoomId: () => null,
      onMartinReset: vi.fn(),
    })
    emitted = []
    listener.onTrigger((roomId, reason) => emitted.push({ roomId, reason }))
  })

  describe("scope === 'auto'", () => {
    it("emits 'organic_tie' when result is T and no pending bet existed for room", () => {
      const disable = listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(emitted).toEqual([{ roomId: 'r1', reason: 'organic_tie' }])
      disable()
    })

    it("emits 'tie_hit' when result is T and listener was told a Tie bet was placed for that round", () => {
      listener.enable('auto')
      listener.notePendingBet('r1', { roundId: '1', betType: 'Tie' })
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(emitted).toEqual([{ roomId: 'r1', reason: 'tie_hit' }])
    })

    it("does NOT emit for non-Tie results", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'B' })
      adapter.fireResult({ roomId: 'r1', winner: 'P' })
      expect(emitted).toEqual([])
    })

    it("dedupes duplicate game-result events by (roomId, roundId)", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })
      expect(emitted).toHaveLength(1)
    })

    it("emits separately for different rounds in same room", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-1' })
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: 'rd-2' })
      expect(emitted).toHaveLength(2)
    })

    it("does not emit after disable()", () => {
      const disable = listener.enable('auto')
      disable()
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(emitted).toEqual([])
    })

    it("emits 'martin_cap' via signalMartinCap", () => {
      listener.enable('auto')
      listener.signalMartinCap('r1')
      expect(emitted).toEqual([{ roomId: 'r1', reason: 'martin_cap' }])
    })

    it("calls onMartinReset on any T result (defensive level reset)", () => {
      const onMartinReset = vi.fn()
      const l = new MoveOnTieListener({ casinoAdapter: adapter, getCurrentFocusedRoomId: () => null, onMartinReset })
      l.onTrigger(() => {})
      l.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T', roundId: '1' })
      expect(onMartinReset).toHaveBeenCalledWith('r1')
    })

    it("forgetRoom clears dedup state so a later tie in the same room emits again", () => {
      listener.enable('auto')
      adapter.fireResult({ roomId: 'r1', winner: 'T' })
      expect(emitted).toHaveLength(1)

      // Without forgetRoom, a second Tie with no roundId would be deduped
      adapter.fireResult({ roomId: 'r1', winner: 'T' })
      expect(emitted).toHaveLength(1)

      // After forgetRoom, a new Tie should emit again
      listener.forgetRoom('r1')
      adapter.fireResult({ roomId: 'r1', winner: 'T' })
      expect(emitted).toHaveLength(2)
    })
  })

  describe("scope === 'semiauto'", () => {
    it("only processes events for the currently focused room", () => {
      let focusedRoomId: string | null = 'r-focus'
      const l = new MoveOnTieListener({
        casinoAdapter: adapter,
        getCurrentFocusedRoomId: () => focusedRoomId,
        onMartinReset: vi.fn(),
      })
      const got: Array<{ roomId: string; reason: TriggerReason }> = []
      l.onTrigger((roomId, reason) => got.push({ roomId, reason }))
      l.enable('semiauto')

      adapter.fireResult({ roomId: 'r-other', winner: 'T', roundId: 'a' })
      expect(got).toEqual([])

      adapter.fireResult({ roomId: 'r-focus', winner: 'T', roundId: 'b' })
      expect(got).toEqual([{ roomId: 'r-focus', reason: 'organic_tie' }])

      focusedRoomId = 'r-new-focus'
      adapter.fireResult({ roomId: 'r-focus', winner: 'T', roundId: 'c' })
      adapter.fireResult({ roomId: 'r-new-focus', winner: 'T', roundId: 'd' })
      expect(got).toEqual([
        { roomId: 'r-focus', reason: 'organic_tie' },
        { roomId: 'r-new-focus', reason: 'organic_tie' },
      ])
    })

    it("scope filter applies to signalMartinCap too", () => {
      let focusedRoomId: string | null = 'r1'
      const l = new MoveOnTieListener({
        casinoAdapter: adapter,
        getCurrentFocusedRoomId: () => focusedRoomId,
        onMartinReset: vi.fn(),
      })
      const got: Array<{ roomId: string; reason: TriggerReason }> = []
      l.onTrigger((roomId, reason) => got.push({ roomId, reason }))
      l.enable('semiauto')

      l.signalMartinCap('r-other')
      expect(got).toEqual([])

      l.signalMartinCap('r1')
      expect(got).toEqual([{ roomId: 'r1', reason: 'martin_cap' }])
    })
  })

  it('keeps auto and semiauto subscriptions isolated when both scopes are enabled', () => {
    let focusedRoomId: string | null = 'r-focus'
    const l = new MoveOnTieListener({
      casinoAdapter: adapter,
      getCurrentFocusedRoomId: () => focusedRoomId,
      onMartinReset: vi.fn(),
    })
    const autoEvents: string[] = []
    const semiAutoEvents: string[] = []
    l.onTrigger(roomId => autoEvents.push(roomId), 'auto')
    l.onTrigger(roomId => semiAutoEvents.push(roomId), 'semiauto')

    const disableAuto = l.enable('auto')
    l.enable('semiauto')
    adapter.fireResult({ roomId: 'r-other', winner: 'T', roundId: 'a' })
    adapter.fireResult({ roomId: 'r-focus', winner: 'T', roundId: 'b' })

    expect(autoEvents).toEqual(['r-other', 'r-focus'])
    expect(semiAutoEvents).toEqual(['r-focus'])

    disableAuto()
    focusedRoomId = 'r-next'
    adapter.fireResult({ roomId: 'r-next', winner: 'T', roundId: 'c' })
    expect(autoEvents).toEqual(['r-other', 'r-focus'])
    expect(semiAutoEvents).toEqual(['r-focus', 'r-next'])
  })
})
