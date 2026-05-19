import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GameResultEvent, RoadResult } from '../../domain/entities'
import { EvolutionAdapter } from './EvolutionAdapter'

const TABLE_ID = 'p63cmvmwagteemoy'

describe('EvolutionAdapter lobby history parsing', () => {
  beforeEach(() => {
    EvolutionAdapter.dispose?.()
  })

  afterEach(() => {
    EvolutionAdapter.dispose?.()
  })

  it('emits history updates for the first lobby.historyUpdated snapshot', () => {
    const historyUpdates: Array<{ roomId: string; history: RoadResult[] }> = []
    const gameResults: GameResultEvent[] = []

    EvolutionAdapter.onHistoryUpdate((roomId, history) => {
      historyUpdates.push({ roomId, history })
    })
    EvolutionAdapter.onGameResult((event) => {
      gameResults.push(event)
    })

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'widget.availableTables',
      args: {
        availableTables: [{
          tableId: TABLE_ID,
          tableName: 'Korean Speed Baccarat A',
          config: { gameType: 'baccarat' },
        }],
      },
    }))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'lobby.historyUpdated',
      args: {
        tableId: TABLE_ID,
        history: [
          { winner: 'Player', timestamp: 1, playerScore: 8, bankerScore: 4 },
        ],
      },
    }))

    expect(historyUpdates).toHaveLength(1)
    expect(historyUpdates[0].roomId).toBe(TABLE_ID)
    expect(historyUpdates[0].history).toEqual([
      expect.objectContaining({ winner: 'P', playerScore: 8, bankerScore: 4 }),
    ])
    expect(gameResults).toHaveLength(0)
  })

  it('emits a game result when lobby history grows after initialization', () => {
    const gameResults: GameResultEvent[] = []
    EvolutionAdapter.onGameResult((event) => {
      gameResults.push(event)
    })

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'widget.availableTables',
      args: {
        availableTables: [{
          tableId: TABLE_ID,
          tableName: 'Korean Speed Baccarat A',
          config: { gameType: 'baccarat' },
        }],
      },
    }))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'lobby.historyUpdated',
      args: {
        tableId: TABLE_ID,
        history: [
          { winner: 'Player', timestamp: 1 },
        ],
      },
    }))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'lobby.historyUpdated',
      args: {
        tableId: TABLE_ID,
        history: [
          { winner: 'Player', timestamp: 1 },
          { winner: 'Banker', timestamp: 2, playerScore: 2, bankerScore: 9 },
        ],
      },
    }))

    expect(gameResults).toHaveLength(1)
    expect(gameResults[0]).toEqual(expect.objectContaining({
      roomId: TABLE_ID,
      winner: 'B',
      playerScore: 2,
      bankerScore: 9,
    }))
  })
})
