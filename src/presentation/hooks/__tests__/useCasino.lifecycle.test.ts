// F2 lifecycle characterization tests for useCasino.
//
// These tests pin the post-F2 invariant: every Tauri `listen()` registration
// is tracked in a synchronous ref and every corresponding `unlisten` is
// invoked exactly once on unmount, even if the underlying listen() promise
// has not yet resolved.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted; use vi.hoisted to make listenMock available
// to the factory.
const { invokeMock, listenMock, showWarningMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (..._args: unknown[]) => undefined),
  listenMock: vi.fn(),
  showWarningMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

// Minimal DI / Error contexts so the hook renders without the full provider stack.
vi.mock('../../context', () => {
  const baseRoom = new Map()
  const fakeAdapter = {
    name: 'evolution',
    type: 'evolution' as const,
    supportsRealBetting: false,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => false),
    placeBet: undefined,
    parseMessage: vi.fn(() => null),
    getRoom: vi.fn(() => null),
    getRooms: vi.fn(() => baseRoom),
    onRoomUpdate: vi.fn(() => () => {}),
    onGameResult: vi.fn(() => () => {}),
    onBettingPhase: vi.fn(() => () => {}),
    onHistoryUpdate: vi.fn(() => () => {}),
    onShoeChange: vi.fn(() => () => {}),
    onBalanceUpdate: vi.fn(() => () => {}),
  }
  return {
    useService: () => fakeAdapter,
    useError: () => ({
      errors: [],
      addError: vi.fn(),
      clearError: vi.fn(),
      clearAllErrors: vi.fn(),
      toasts: [],
      showToast: vi.fn(),
      hideToast: vi.fn(),
      showError: vi.fn(),
      showWarning: showWarningMock,
      showInfo: vi.fn(),
      showSuccess: vi.fn(),
      showDanger: vi.fn(),
    }),
  }
})

// eslint-disable-next-line import/first
import {
  classifyEvolutionDisconnect,
  createSessionRotationScheduler,
  useCasino,
} from '../useCasino'
// eslint-disable-next-line import/first
import { AutoBettingService } from '../../../application/services/AutoBettingService'

type Unlisten = () => void
type Deferred = { promise: Promise<Unlisten>; resolve: (u: Unlisten) => void }

function deferred(): Deferred {
  let resolve!: (u: Unlisten) => void
  const promise = new Promise<Unlisten>((r) => { resolve = r })
  return { promise, resolve }
}

function installImmediateListenMock() {
  // Each call returns a unique unlisten spy and resolves immediately.
  const unlistens: Array<ReturnType<typeof vi.fn>> = []
  listenMock.mockImplementation(async () => {
    const unlisten = vi.fn()
    unlistens.push(unlisten)
    return unlisten
  })
  return unlistens
}

beforeEach(() => {
  invokeMock.mockClear()
  listenMock.mockReset()
  showWarningMock.mockClear()
  // Ensure localStorage is a working object (some vitest/jsdom combos leave
  // it as undefined after test globals reset). Provide a simple in-memory
  // polyfill if the environment lacks it.
  const anyGlobal = globalThis as unknown as {
    localStorage?: Storage
  }
  if (!anyGlobal.localStorage || typeof anyGlobal.localStorage.getItem !== 'function') {
    const store = new Map<string, string>()
    const ls: Storage = {
      get length() { return store.size },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => { store.delete(k) },
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
    }
    anyGlobal.localStorage = ls
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  listenMock.mockReset()
})

describe('Evolution session lifecycle helpers', () => {
  it('classifies kickout, intentional handover, and upgrade rejection separately', () => {
    expect(classifyEvolutionDisconnect({ reason: 'kickout:inactivity' })).toBe('session_expired')
    expect(classifyEvolutionDisconnect({ type: 'connectionAlreadyExists' })).toBe('session_expired')
    expect(classifyEvolutionDisconnect({ reason: 'user_requested' })).toBe('intentional')
    expect(classifyEvolutionDisconnect({ reason: 'upgrade_forbidden_403' })).toBe('upgrade_forbidden')
    expect(classifyEvolutionDisconnect({ reason: 'Max reconnect attempts exceeded' })).toBe('reconnect_exhausted')
  })

  it('runs one rotation at a time, reschedules after completion, and stops cleanly', async () => {
    vi.useFakeTimers()
    const rotate = vi.fn(async () => undefined)
    const scheduler = createSessionRotationScheduler(rotate, {
      firstDelayMs: 10,
      nextDelayMs: 20,
    })

    scheduler.start()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(rotate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(20)
    expect(rotate).toHaveBeenCalledTimes(2)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(100)
    expect(rotate).toHaveBeenCalledTimes(2)
    expect(scheduler.isRunning()).toBe(false)
  })

  it('classifies crypto mismatch separately so rotation is not attempted', () => {
    // 암복호 키 불일치는 로테이션(=런치)으로 못 고친다 — network 로 뭉뚱그리면
    // 반응형 로테이션이 걸려 런치만 쌓이고 403 [G.8] 을 앞당긴다.
    expect(
      classifyEvolutionDisconnect({ reason: 'crypto_mismatch:frame decrypt failed' }),
    ).toBe('crypto_mismatch')
  })

  it('rotateNow enforces a minimum interval so reactive rotation cannot storm launches', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const rotate = vi.fn(async () => undefined)
    const scheduler = createSessionRotationScheduler(rotate, {
      firstDelayMs: 10,
      nextDelayMs: 10_000,
      minIntervalMs: 1_000,
      now: () => clock,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(rotate).toHaveBeenCalledTimes(1)

    // 방금 로테이션했는데 곧바로 끊긴 경우: 즉시 재런치하면 안 되고 최소 간격을 채워야 한다.
    clock += 100
    scheduler.rotateNow()
    expect(rotate).toHaveBeenCalledTimes(1)

    clock += 900
    await vi.advanceTimersByTimeAsync(900)
    expect(rotate).toHaveBeenCalledTimes(2)
  })

  it('gives up rotating when the session keeps dying inside the minimum interval', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const rotate = vi.fn(async () => undefined)
    const onGaveUp = vi.fn()
    const scheduler = createSessionRotationScheduler(rotate, {
      firstDelayMs: 10,
      nextDelayMs: 10_000,
      minIntervalMs: 1_000,
      maxRapidRotations: 2,
      onGaveUp,
      now: () => clock,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(rotate).toHaveBeenCalledTimes(1)

    // 최소 간격 안에서 계속 끊기면 런치를 더 해봐야 밴만 앞당긴다 → 포기해야 한다.
    scheduler.rotateNow()
    scheduler.rotateNow()
    scheduler.rotateNow()
    expect(onGaveUp).toHaveBeenCalledTimes(1)
    expect(scheduler.isRunning()).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(rotate).toHaveBeenCalledTimes(1)
  })

  it('defers rotation while a real bet is pending and retries on the short interval', async () => {
    vi.useFakeTimers()
    let hasPendingBet = true
    const rotate = vi.fn(async () => undefined)
    const scheduler = createSessionRotationScheduler(rotate, {
      firstDelayMs: 10,
      nextDelayMs: 20,
      shouldDefer: () => hasPendingBet,
      deferDelayMs: 5,
    })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(rotate).not.toHaveBeenCalled()

    hasPendingBet = false
    await vi.advanceTimersByTimeAsync(5)
    expect(rotate).toHaveBeenCalledTimes(1)

    scheduler.stop()
  })

  it('does not manually rotate while a real bet is pending', async () => {
    installImmediateListenMock()
    vi.spyOn(AutoBettingService, 'getPendingBetCount').mockReturnValue(1)
    const { result, unmount } = renderHook(() => useCasino('https://example.com'))

    await act(async () => {
      await result.current.reconnectLobby()
    })

    expect(invokeMock).not.toHaveBeenCalledWith(
      'rotate_evolution_session',
      expect.anything(),
    )
    expect(showWarningMock).toHaveBeenCalledWith(
      '진행 중인 베팅이 있어 세션 갱신을 잠시 미룹니다.',
    )
    unmount()
  })
})

describe('useCasino — F2 listener lifecycle', () => {
  it('mounts and registers at least one Tauri listen() subscription', async () => {
    installImmediateListenMock()
    const { unmount } = renderHook(() => useCasino('https://example.com'))

    // Allow microtasks so the synchronous listen() calls resolve and push
    // their unlisten functions into listenersRef.
    await act(async () => {
      await Promise.resolve()
    })

    expect(listenMock).toHaveBeenCalled()
    expect(listenMock.mock.calls.length).toBeGreaterThanOrEqual(1)

    unmount()
  })

  it('unmount invokes every resolved unlisten exactly once', async () => {
    const unlistens = installImmediateListenMock()
    const { unmount } = renderHook(() => useCasino('https://example.com'))

    // Flush microtasks so every listen() promise resolves and each unlisten
    // is tracked in listenersRef before we unmount.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(unlistens.length).toBeGreaterThan(0)
    const registeredCount = unlistens.length

    unmount()

    // Every tracked unlisten should have been called exactly once by the
    // synchronous cleanup (no .then() chain means no race).
    for (const u of unlistens) {
      expect(u).toHaveBeenCalledTimes(1)
    }
    // Sanity: no new unlistens should have appeared post-unmount.
    expect(unlistens.length).toBe(registeredCount)
  })

  it('unmount does not throw when listen() promises have not yet resolved', async () => {
    // Defer every listen() call so their unlisten fns are NOT yet tracked in
    // listenersRef at the moment of unmount. The F2 contract: unmount must
    // still be safe (no throw), and when the deferred promise later resolves,
    // the listener must self-unlisten because the effect is already gone.
    const pending: Deferred[] = []
    listenMock.mockImplementation(async () => {
      const d = deferred()
      pending.push(d)
      return d.promise
    })

    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown) => { unhandled.push(err) }
    const proc = (globalThis as unknown as { process?: { on?: Function; off?: Function } }).process
    if (proc && typeof proc.on === 'function') {
      proc.on('unhandledRejection', onUnhandled)
    }

    const { unmount } = renderHook(() => useCasino('https://example.com'))

    // Do NOT flush microtasks — unmount while listeners are still pending.
    expect(() => unmount()).not.toThrow()

    // Now resolve each deferred registration with a spy unlisten. The hook
    // should detect it was unmounted and unlisten immediately without
    // throwing.
    const lateUnlistens = pending.map(() => vi.fn())
    await act(async () => {
      pending.forEach((d, i) => d.resolve(lateUnlistens[i]))
      // Flush microtasks so the .then() handlers inside the hook run.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Each late-resolved listener should have been unlistened exactly once
    // via the race-resilience path (pending listen resolved post-unmount).
    for (const u of lateUnlistens) {
      expect(u).toHaveBeenCalledTimes(1)
    }

    expect(unhandled).toHaveLength(0)

    if (proc && typeof proc.off === 'function') {
      proc.off('unhandledRejection', onUnhandled)
    }
  })
})
