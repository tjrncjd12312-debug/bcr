// VirtualBettingService Unit Tests
import { describe, it, expect, beforeEach } from 'vitest'
import { VirtualBettingService } from './VirtualBettingService'

describe('VirtualBettingService', () => {
  beforeEach(() => {
    // Reset to initial state before each test
    // First reset settings to default
    VirtualBettingService.updateSettings({
      initialBalance: 1000000,
      martingale: {
        enabled: true,
        baseAmount: 10000,
        maxLevel: 5,
        resetOnWin: true,
      },
    })
    VirtualBettingService.disable()
    VirtualBettingService.reset()
  })

  describe('enable/disable', () => {
    it('should start disabled', () => {
      expect(VirtualBettingService.isEnabled()).toBe(false)
    })

    it('should enable betting', () => {
      VirtualBettingService.enable()
      expect(VirtualBettingService.isEnabled()).toBe(true)
    })

    it('should disable betting', () => {
      VirtualBettingService.enable()
      VirtualBettingService.disable()
      expect(VirtualBettingService.isEnabled()).toBe(false)
    })

    it('should toggle betting', () => {
      expect(VirtualBettingService.isEnabled()).toBe(false)
      VirtualBettingService.toggle()
      expect(VirtualBettingService.isEnabled()).toBe(true)
      VirtualBettingService.toggle()
      expect(VirtualBettingService.isEnabled()).toBe(false)
    })
  })

  describe('initial state', () => {
    it('should have default initial balance', () => {
      expect(VirtualBettingService.getGlobalBalance()).toBe(1000000)
    })

    it('should have default settings', () => {
      const settings = VirtualBettingService.getSettings()
      expect(settings.initialBalance).toBe(1000000)
      expect(settings.martingale.enabled).toBe(true)
      expect(settings.martingale.baseAmount).toBe(10000)
      expect(settings.martingale.maxLevel).toBe(5)
    })

    it('should have no room states initially', () => {
      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState).toBeNull()
    })

    it('should have no bet history initially', () => {
      const logs = VirtualBettingService.getRecentLogs()
      expect(logs).toHaveLength(0)
    })
  })

  describe('settings', () => {
    it('should update settings', () => {
      VirtualBettingService.updateSettings({
        initialBalance: 500000,
      })

      const settings = VirtualBettingService.getSettings()
      expect(settings.initialBalance).toBe(500000)
    })

    it('should update martingale settings', () => {
      VirtualBettingService.updateSettings({
        martingale: {
          enabled: true,
          baseAmount: 5000,
          maxLevel: 3,
          resetOnWin: false,
        },
      })

      const settings = VirtualBettingService.getSettings()
      expect(settings.martingale.baseAmount).toBe(5000)
      expect(settings.martingale.maxLevel).toBe(3)
      expect(settings.martingale.resetOnWin).toBe(false)
    })
  })

  describe('placeBet', () => {
    it('should not place bet when disabled', () => {
      const initialBalance = VirtualBettingService.getGlobalBalance()
      VirtualBettingService.placeBet('room1', '방 1', 'B')

      expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance)
    })

    it('should deduct bet amount from balance when enabled', () => {
      VirtualBettingService.enable()
      const initialBalance = VirtualBettingService.getGlobalBalance()
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      VirtualBettingService.placeBet('room1', '방 1', 'B')

      expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance - baseAmount)
    })

    it('should create room state on first bet', () => {
      VirtualBettingService.enable()
      VirtualBettingService.placeBet('room1', '방 1', 'B')

      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState).not.toBeNull()
      expect(roomState?.lastBetResult).toBe('pending')
    })

    it('should not place bet with null prediction', () => {
      VirtualBettingService.enable()
      const initialBalance = VirtualBettingService.getGlobalBalance()

      VirtualBettingService.placeBet('room1', '방 1', null)

      expect(VirtualBettingService.getGlobalBalance()).toBe(initialBalance)
    })
  })

  describe('resolveBet', () => {
    beforeEach(() => {
      VirtualBettingService.enable()
    })

    it('should handle winning bet correctly', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      const balanceAfterBet = VirtualBettingService.getGlobalBalance()

      const log = VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      expect(log).not.toBeNull()
      expect(log?.won).toBe(true)
      // Balance should increase by betAmount (win pays 2x, net gain is betAmount)
      expect(VirtualBettingService.getGlobalBalance()).toBeGreaterThan(balanceAfterBet)
    })

    it('should handle losing bet correctly', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      const balanceAfterBet = VirtualBettingService.getGlobalBalance()

      const log = VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P')

      expect(log).not.toBeNull()
      expect(log?.won).toBe(false)
      // Balance should stay the same (already deducted on placeBet)
      expect(VirtualBettingService.getGlobalBalance()).toBe(balanceAfterBet)
    })

    it('should skip tie results', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'B')

      const log = VirtualBettingService.resolveBet('room1', '방 1', 'B', 'T')

      expect(log).toBeNull()
    })

    it('should add bet to history', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      const logs = VirtualBettingService.getRecentLogs()
      // Now we have 2 logs: 1 for placeBet (type: 'placed'), 1 for resolveBet (type: 'resolved')
      expect(logs).toHaveLength(2)
      expect(logs[0].roomId).toBe('room1')
      expect(logs[0].type).toBe('placed')
      expect(logs[1].roomId).toBe('room1')
      expect(logs[1].type).toBe('resolved')
    })
  })

  describe('banker commission (5%)', () => {
    beforeEach(() => {
      VirtualBettingService.enable()
    })

    it('should apply 5% commission on banker win', () => {
      const initialBalance = VirtualBettingService.getGlobalBalance()
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      // Bet on Banker
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      const balanceAfterBet = VirtualBettingService.getGlobalBalance()
      expect(balanceAfterBet).toBe(initialBalance - baseAmount)

      // Banker wins
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      // Payout: baseAmount * 2 - (baseAmount * 0.05) = baseAmount * 1.95
      // Net profit: baseAmount * 0.95
      const expectedBalance = balanceAfterBet + baseAmount * 2 - baseAmount * 0.05
      expect(VirtualBettingService.getGlobalBalance()).toBe(expectedBalance)

      // Room profit should be baseAmount * 0.95
      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.profitLoss).toBe(baseAmount * 0.95)
    })

    it('should not apply commission on player win', () => {
      const initialBalance = VirtualBettingService.getGlobalBalance()
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      // Bet on Player
      VirtualBettingService.placeBet('room1', '방 1', 'P')
      const balanceAfterBet = VirtualBettingService.getGlobalBalance()
      expect(balanceAfterBet).toBe(initialBalance - baseAmount)

      // Player wins
      VirtualBettingService.resolveBet('room1', '방 1', 'P', 'P')

      // Payout: baseAmount * 2 (no commission)
      // Net profit: baseAmount
      const expectedBalance = balanceAfterBet + baseAmount * 2
      expect(VirtualBettingService.getGlobalBalance()).toBe(expectedBalance)

      // Room profit should be baseAmount (full)
      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.profitLoss).toBe(baseAmount)
    })

    it('should correctly calculate cumulative profit with mixed bets', () => {
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      // Win on Banker (profit: 9500)
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      // Win on Player (profit: 10000)
      VirtualBettingService.placeBet('room1', '방 1', 'P')
      VirtualBettingService.resolveBet('room1', '방 1', 'P', 'P')

      // Room profit should be 9500 + 10000 = 19500
      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.profitLoss).toBe(baseAmount * 0.95 + baseAmount)
    })
  })

  describe('martingale system', () => {
    beforeEach(() => {
      VirtualBettingService.enable()
    })

    it('should double bet after loss', () => {
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss

      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.martingaleLevel).toBe(1)
      expect(roomState?.currentBetAmount).toBe(baseAmount * 2)
    })

    it('should reset martingale level after win', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss

      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B') // Win

      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.martingaleLevel).toBe(0)
    })

    it('should reset to level 0 when exceeding max level', () => {
      const maxLevel = VirtualBettingService.getSettings().martingale.maxLevel

      // Lose until max level
      for (let i = 0; i < maxLevel; i++) {
        VirtualBettingService.placeBet('room1', '방 1', 'B')
        VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss
      }

      // At max level now
      let roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.martingaleLevel).toBe(maxLevel)

      // One more loss should reset to 0
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss

      roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.martingaleLevel).toBe(0)
    })
  })

  describe('reset', () => {
    it('should reset global balance to initial', () => {
      VirtualBettingService.enable()
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P')

      VirtualBettingService.reset()

      expect(VirtualBettingService.getGlobalBalance()).toBe(1000000)
    })

    it('should clear all room states', () => {
      VirtualBettingService.enable()
      VirtualBettingService.placeBet('room1', '방 1', 'B')

      VirtualBettingService.reset()

      expect(VirtualBettingService.getRoomState('room1')).toBeNull()
    })

    it('should clear bet history', () => {
      VirtualBettingService.enable()
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      VirtualBettingService.reset()

      expect(VirtualBettingService.getRecentLogs()).toHaveLength(0)
    })
  })

  describe('resetRoom', () => {
    it('should reset specific room state', () => {
      VirtualBettingService.enable()
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss to increase martingale

      VirtualBettingService.resetRoom('room1')

      const roomState = VirtualBettingService.getRoomState('room1')
      expect(roomState?.martingaleLevel).toBe(0)
      expect(roomState?.lastBetResult).toBeUndefined()
    })
  })

  describe('state change callbacks', () => {
    it('should emit state change on enable', () => {
      let emittedState: { enabled?: boolean } = {}
      const unsubscribe = VirtualBettingService.onStateChange((state) => {
        emittedState = state
      })

      VirtualBettingService.enable()

      expect(emittedState.enabled).toBe(true)

      unsubscribe()
    })

    it('should unsubscribe correctly', () => {
      let callCount = 0
      const unsubscribe = VirtualBettingService.onStateChange(() => {
        callCount++
      })

      VirtualBettingService.enable()
      expect(callCount).toBe(1)

      unsubscribe()

      VirtualBettingService.disable()
      expect(callCount).toBe(1) // Should not increase
    })
  })

  describe('insufficient balance - auto disable', () => {
    it('should auto-disable when balance is insufficient for bet', () => {
      // Set low initial balance
      VirtualBettingService.updateSettings({ initialBalance: 5000 })
      VirtualBettingService.reset()
      VirtualBettingService.enable()

      // Try to place bet (10000원) with only 5000원 balance
      const result = VirtualBettingService.placeBet('room1', '방 1', 'B')

      expect(result).toBe(false)
      expect(VirtualBettingService.isEnabled()).toBe(false) // Auto disabled
    })

    it('should return true when balance is sufficient', () => {
      VirtualBettingService.enable()

      const result = VirtualBettingService.placeBet('room1', '방 1', 'B')

      expect(result).toBe(true)
      expect(VirtualBettingService.isEnabled()).toBe(true)
    })

    it('should auto-disable during martingale progression when balance runs out', () => {
      // Set balance that can only handle a few martingale levels
      VirtualBettingService.updateSettings({ initialBalance: 50000 })
      VirtualBettingService.reset()
      VirtualBettingService.enable()

      // Place and lose bets until balance runs out
      // Level 0: 10000, Level 1: 20000, Level 2: 40000 = 70000 needed
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss, balance: 40000

      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss, balance: 20000

      // Next bet would be 40000, but balance is only 20000
      const result = VirtualBettingService.placeBet('room1', '방 1', 'B')

      expect(result).toBe(false)
      expect(VirtualBettingService.isEnabled()).toBe(false)
    })
  })

  describe('extended statistics', () => {
    beforeEach(() => {
      VirtualBettingService.enable()
    })

    it('should track total bet amount', () => {
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      const state = VirtualBettingService.getState()
      expect(state.totalBetAmount).toBe(baseAmount)
      expect(state.totalBetCount).toBe(1)
    })

    it('should track total winnings on player win', () => {
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      VirtualBettingService.placeBet('room1', '방 1', 'P')
      VirtualBettingService.resolveBet('room1', '방 1', 'P', 'P')

      const state = VirtualBettingService.getState()
      // Player win: profit = baseAmount (not payout)
      expect(state.totalWinnings).toBe(baseAmount)
    })

    it('should track total winnings on banker win (with 5% commission)', () => {
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      const state = VirtualBettingService.getState()
      // Banker win: profit = baseAmount * 0.95 (not payout)
      expect(state.totalWinnings).toBe(baseAmount * 0.95)
    })

    it('should not track winnings on loss', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'P') // Loss

      const state = VirtualBettingService.getState()
      expect(state.totalWinnings).toBe(0)
    })

    it('should accumulate statistics across multiple bets', () => {
      const baseAmount = VirtualBettingService.getSettings().martingale.baseAmount

      // Win on Player (bet: 10000, profit: 10000)
      VirtualBettingService.placeBet('room1', '방 1', 'P')
      VirtualBettingService.resolveBet('room1', '방 1', 'P', 'P')

      // Win on Banker (bet: 10000, profit: 9500 due to 5% commission)
      VirtualBettingService.placeBet('room1', '방 1', 'B')
      VirtualBettingService.resolveBet('room1', '방 1', 'B', 'B')

      const state = VirtualBettingService.getState()
      expect(state.totalBetAmount).toBe(baseAmount * 2)
      expect(state.totalBetCount).toBe(2)
      // totalWinnings now tracks net profit only (not payout)
      // Player win: profit = baseAmount = 10000
      // Banker win: profit = baseAmount * 0.95 = 9500
      expect(state.totalWinnings).toBe(baseAmount + baseAmount * 0.95)
    })

    it('should reset statistics on reset()', () => {
      VirtualBettingService.placeBet('room1', '방 1', 'P')
      VirtualBettingService.resolveBet('room1', '방 1', 'P', 'P')

      VirtualBettingService.reset()

      const state = VirtualBettingService.getState()
      expect(state.totalBetAmount).toBe(0)
      expect(state.totalWinnings).toBe(0)
      expect(state.totalBetCount).toBe(0)
    })
  })
})
