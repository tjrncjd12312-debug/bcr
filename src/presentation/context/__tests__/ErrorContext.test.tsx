// Lane F3 (perf-plan): verify the toast queue is bounded and the evicted
// toast's auto-hide timer is cleared to avoid timer leaks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ErrorProvider, useError } from '../ErrorContext'

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <ErrorProvider>{children}</ErrorProvider>
}

describe('ErrorContext toast queue cap (Lane F3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('caps the toast queue at 20 and evicts the oldest when overflowed', () => {
    const { result } = renderHook(() => useError(), { wrapper })

    act(() => {
      for (let i = 0; i < 25; i++) {
        result.current.showToast(`toast-${i}`, 'info', 10_000)
      }
    })

    expect(result.current.toasts).toHaveLength(20)
    // The five oldest (toast-0..toast-4) should have been evicted.
    const messages = result.current.toasts.map((t) => t.message)
    expect(messages).not.toContain('toast-0')
    expect(messages).not.toContain('toast-4')
    expect(messages).toContain('toast-5')
    expect(messages).toContain('toast-24')
  })

  it('clears timers of evicted toasts so they do not fire later', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { result } = renderHook(() => useError(), { wrapper })

    act(() => {
      for (let i = 0; i < 25; i++) {
        result.current.showToast(`toast-${i}`, 'info', 10_000)
      }
    })

    // 5 toasts were evicted; each should have had its timer cleared.
    expect(clearSpy).toHaveBeenCalled()
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(5)

    // Advancing time past the duration should not push the queue past the cap.
    act(() => {
      vi.advanceTimersByTime(10_100)
    })
    expect(result.current.toasts).toHaveLength(0)

    clearSpy.mockRestore()
  })
})
