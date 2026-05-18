// VirtualBettingService — initialBalance persistence tests.
//
// Regression: previously the user-configured virtual seed reverted to the
// 1,000,000 default on every reload because the service had no persistence
// layer. We now save initialBalance to localStorage on updateSettings and
// reload it on dispose/reinit + on next construction.

import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualBettingService } from './VirtualBettingService'

const KEY = 'bcr-virtual-betting-initial-balance'

describe('VirtualBettingService — initialBalance persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    VirtualBettingService.dispose() // re-seeds from (now-empty) storage → default
    VirtualBettingService.disable()
  })

  it('defaults to 1,000,000 when no persisted value exists', () => {
    expect(VirtualBettingService.getSettings().initialBalance).toBe(1_000_000)
  })

  it('writes the new balance to localStorage on updateSettings', () => {
    VirtualBettingService.updateSettings({ initialBalance: 5_000_000 })
    expect(localStorage.getItem(KEY)).toBe('5000000')
    expect(VirtualBettingService.getSettings().initialBalance).toBe(5_000_000)
  })

  it('restores the user-configured balance after dispose (simulates logout/relogin)', () => {
    VirtualBettingService.updateSettings({ initialBalance: 7_500_000 })
    expect(VirtualBettingService.getSettings().initialBalance).toBe(7_500_000)

    VirtualBettingService.dispose() // logout flow

    // After dispose, the in-memory state should reflect the persisted value,
    // not the hard-coded default.
    expect(VirtualBettingService.getSettings().initialBalance).toBe(7_500_000)
    expect(VirtualBettingService.getGlobalBalance()).toBe(7_500_000)
  })

  it('ignores non-positive or non-numeric stored values and falls back to default', () => {
    localStorage.setItem(KEY, '-1')
    VirtualBettingService.dispose() // forces re-load
    expect(VirtualBettingService.getSettings().initialBalance).toBe(1_000_000)

    localStorage.setItem(KEY, 'not-a-number')
    VirtualBettingService.dispose()
    expect(VirtualBettingService.getSettings().initialBalance).toBe(1_000_000)
  })

  it('updates globalBalance to match the new initialBalance (session reset)', () => {
    VirtualBettingService.updateSettings({ initialBalance: 3_000_000 })
    expect(VirtualBettingService.getGlobalBalance()).toBe(3_000_000)
  })
})
