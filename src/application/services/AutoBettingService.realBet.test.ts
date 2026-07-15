import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutoBettingService from './AutoBettingService'
import { TauriAdapter } from '../../infrastructure/adapters/TauriAdapter'
import { EvolutionAdapter, type BetPlacementConfirmation } from '../../infrastructure/adapters/EvolutionAdapter'

const TABLE_ID = 'p63cmvmwagteemoy'
const GAME_ID = 'real-game-confirm-1'

function seedRealGame(): void {
  EvolutionAdapter.processMessage(JSON.stringify({
    type: 'baccarat.gameState',
    args: { tableId: TABLE_ID, gameId: GAME_ID },
  }))
  EvolutionAdapter.setBalance(100000)
}

describe('AutoBettingService real bet confirmation', () => {
  beforeEach(() => {
    EvolutionAdapter.dispose?.()
    AutoBettingService.reset()
    AutoBettingService.setVirtualMode(false)
    seedRealGame()
    vi.spyOn(TauriAdapter, 'getEvolutionMultiStatus').mockResolvedValue(true)
    vi.spyOn(TauriAdapter, 'resubscribeEvolutionTable').mockResolvedValue()
    vi.spyOn(TauriAdapter, 'sendEvolutionMultiMessage').mockResolvedValue()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    AutoBettingService.dispose()
    EvolutionAdapter.dispose?.()
  })

  it('preserves timeout as unknown and blocks a second send for the same round', async () => {
    vi.spyOn(EvolutionAdapter, 'waitForBetConfirmation').mockResolvedValue({
      tableId: TABLE_ID,
      gameId: GAME_ID,
      betType: 'Tie',
      amount: 1000,
      status: 'unknown',
      accepted: false,
      rejected: false,
      error: 'confirmation-timeout',
      source: 'timeout',
    } satisfies BetPlacementConfirmation)

    const firstResult = await AutoBettingService.placeBet(TABLE_ID, 'Tie', 1000, undefined, true)
    const secondResult = await AutoBettingService.placeBet(TABLE_ID, 'Tie', 1000, undefined, true)

    expect(firstResult).toMatchObject({
      success: false,
      placementStatus: 'unknown',
      error: 'confirmation-timeout',
    })
    expect(secondResult).toMatchObject({ success: false, placementStatus: 'not_sent' })
    expect(TauriAdapter.sendEvolutionMultiMessage).toHaveBeenCalledTimes(1)
    expect(AutoBettingService.getPendingBet(TABLE_ID)).toMatchObject({
      tableId: TABLE_ID,
      gameId: GAME_ID,
      placementStatus: 'unknown',
      placementError: 'confirmation-timeout',
    })
    expect(EvolutionAdapter.hasAlreadyBetOnGame(TABLE_ID, GAME_ID)).toBe(true)
  })

  it('reports success only after a real accepted-bet confirmation', async () => {
    vi.spyOn(EvolutionAdapter, 'waitForBetConfirmation').mockResolvedValue({
      tableId: TABLE_ID,
      gameId: GAME_ID,
      betType: 'Tie',
      amount: 1000,
      status: 'accepted',
      accepted: true,
      rejected: false,
      source: 'playerBettingState',
    } satisfies BetPlacementConfirmation)
    vi.mocked(TauriAdapter.sendEvolutionMultiMessage).mockImplementation(async () => {
      expect(EvolutionAdapter.hasAlreadyBetOnGame(TABLE_ID, GAME_ID)).toBe(true)
      expect(AutoBettingService.getPendingBet(TABLE_ID)).toMatchObject({
        gameId: GAME_ID,
        placementStatus: 'attempted',
      })
    })

    const result = await AutoBettingService.placeBet(TABLE_ID, 'Tie', 1000, undefined, true)

    expect(result).toMatchObject({ success: true, placementStatus: 'confirmed' })
    expect(TauriAdapter.sendEvolutionMultiMessage).toHaveBeenCalledTimes(1)
    expect(AutoBettingService.getPendingBet(TABLE_ID)).toMatchObject({
      tableId: TABLE_ID,
      betType: 'Tie',
      amount: 1000,
      gameId: GAME_ID,
      placementStatus: 'accepted',
    })
    expect(EvolutionAdapter.hasAlreadyBetOnGame(TABLE_ID, GAME_ID)).toBe(true)
  })

  it('uses playerBetRequest for semi-auto prediction bets', async () => {
    vi.spyOn(EvolutionAdapter, 'waitForBetConfirmation').mockResolvedValue({
      tableId: TABLE_ID,
      gameId: GAME_ID,
      betType: 'Banker',
      amount: 1000,
      status: 'accepted',
      accepted: true,
      rejected: false,
      source: 'playerBettingState',
    } satisfies BetPlacementConfirmation)

    const result = await AutoBettingService.placeBetForPrediction({
      roomId: TABLE_ID,
      prediction: 'B',
      confidence: 0.8,
      reasoning: 'semi-auto',
      isSkip: false,
      timestamp: Date.now(),
    }, TABLE_ID, 1000)

    expect(result).toMatchObject({ success: true, placementStatus: 'confirmed' })
    const sent = JSON.parse(vi.mocked(TauriAdapter.sendEvolutionMultiMessage).mock.calls[0][0])
    expect(sent.type).toBe('baccarat.playerBetRequest')
    expect(sent.args.action.chips).toEqual({ Banker: 1000 })
  })
})
