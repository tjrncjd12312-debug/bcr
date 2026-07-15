import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BET_CODES, type BetType, type GameResultEvent, type RoadResult } from '../../domain/entities'
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

  it('expands Big-Road ties (results.ties) into separate T entries to match the live shoe', () => {
    // 로비 v2 빅로드 형식: 셀 = 승자(c) + 그 직후 타이 횟수(ties).
    // c='B'=Player(파랑), c='R'=Banker(빨강). ties는 별도 'T' 판으로 펼쳐져야
    // 타이 필터/통계/빅로드가 입장 후 라이브 화면과 일치한다.
    const historyUpdates: Array<{ roomId: string; history: RoadResult[] }> = []
    EvolutionAdapter.onHistoryUpdate((roomId, history) => {
      historyUpdates.push({ roomId, history })
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

    // 시간순(오래된→최신): P, (B + 타이2회), P  =>  P, B, T, T, P
    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'lobby.historyUpdated',
      args: {
        tableId: TABLE_ID,
        results: [
          { c: 'B', ties: 0 },
          { c: 'R', ties: 2 },
          { c: 'B', ties: 0 },
        ],
      },
    }))

    expect(historyUpdates.length).toBeGreaterThan(0)
    const latest = historyUpdates[historyUpdates.length - 1].history
    // newest-first: [P, T, T, B, P]
    expect(latest.map(h => h.winner)).toEqual(['P', 'T', 'T', 'B', 'P'])
    expect(latest.filter(h => h.winner === 'T')).toHaveLength(2)
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

describe('EvolutionAdapter player bet request building', () => {
  beforeEach(() => {
    EvolutionAdapter.dispose?.()
  })

  afterEach(() => {
    EvolutionAdapter.dispose?.()
  })

  it.each([
    ['Player', BET_CODES.Player],
    ['Banker', BET_CODES.Banker],
    ['Tie', BET_CODES.Tie],
  ] as Array<[BetType, string]>)('uses the plain Evolution bet spot (%s) as the chips key', (betType, betCode) => {
    // ★2026-06-23 라이브 캡처 확정: action.chips 키는 평문 'Banker'/'Player'/'Tie' (BAC_ 접두사 아님).
    expect(betCode).toBe(betType)
    expect(betCode.startsWith('BAC_')).toBe(false)

    // 실배팅 메시지는 synthetic gameId를 거부하므로 실시간 gameId를 먼저 주입한다.
    const REAL_GAME_ID = 'real-game-abc123'
    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.gameState',
      args: { tableId: TABLE_ID, gameId: REAL_GAME_ID },
    }))

    const raw = EvolutionAdapter.buildPlayerBetRequest({
      tableId: TABLE_ID,
      betType,
      amount: 10000,
    })

    expect(raw).not.toBeNull()
    const message = JSON.parse(raw!)

    expect(message.type).toBe('baccarat.playerBetRequest')
    expect(message.args.tableId).toBe(TABLE_ID)
    expect(message.args.gameId).toBe(REAL_GAME_ID)
    expect(message.args.action).toMatchObject({
      name: 'Chips',
      chips: { [betCode]: 10000 },
    })
    // 평문 베팅명 그대로가 chips 키 (예: { Banker: 10000 })
    expect(message.args.action.chips).toHaveProperty(betType)
  })

  it('실배팅 안전장치 #1: synthetic/미수신 gameId로는 실배팅 메시지를 만들지 않는다', () => {
    // 실시간 gameId 미수신 상태 → ensureGameId가 synthetic 생성. 실배팅 메시지는 null이어야 한다.
    const synthetic = EvolutionAdapter.ensureGameId(TABLE_ID)
    expect(synthetic.startsWith('synthetic-')).toBe(true)

    const raw = EvolutionAdapter.buildPlayerBetRequest({
      tableId: TABLE_ID,
      betType: 'Banker',
      amount: 10000,
    })
    expect(raw).toBeNull()
  })
})

describe('EvolutionAdapter baccarat.resolved bet outcome', () => {
  beforeEach(() => { EvolutionAdapter.dispose?.() })
  afterEach(() => { EvolutionAdapter.dispose?.() })

  it('threads acceptedBets/rejectedBets/winningSpots from baccarat.resolved into the GameResult event', () => {
    // ★2026-06-23: 정산을 히스토리 추론이 아니라 Evolution 실제 체결결과로 하기 위해 betOutcome을 실어보낸다.
    const events: GameResultEvent[] = []
    EvolutionAdapter.onGameResult((e) => events.push(e))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'widget.availableTables',
      args: { availableTables: [{ tableId: TABLE_ID, tableName: 'Korean Speed Baccarat A', config: { gameType: 'baccarat' } }] },
    }))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.resolved',
      args: {
        tableId: TABLE_ID,
        gameId: 'g-reject-1',
        result: { winner: 'Banker', playerScore: 3, bankerScore: 7 },
        winningSpots: ['Banker', 'Big'],
        bets: { acceptedBets: {}, rejectedBets: { Banker: { amount: 2000, error: '1013' } } },
      },
    }))

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last.winner).toBe('B')
    expect(last.betOutcome).toBeDefined()
    expect(last.betOutcome?.rejectedBets?.Banker?.error).toBe('1013')
    expect(last.betOutcome?.winningSpots).toEqual(['Banker', 'Big'])
  })

  it('leaves betOutcome undefined for plain gameState (no bets field) → settlement falls back', () => {
    const events: GameResultEvent[] = []
    EvolutionAdapter.onGameResult((e) => events.push(e))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'widget.availableTables',
      args: { availableTables: [{ tableId: TABLE_ID, tableName: 'Korean Speed Baccarat A', config: { gameType: 'baccarat' } }] },
    }))

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.gameState',
      args: { tableId: TABLE_ID, gameId: 'g-plain-1', gameData: { result: { winner: 'Player', playerScore: 8, bankerScore: 2 } } },
    }))

    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1].betOutcome).toBeUndefined()
  })
})

describe('EvolutionAdapter real bet placement confirmations', () => {
  beforeEach(() => { EvolutionAdapter.dispose?.() })
  afterEach(() => { EvolutionAdapter.dispose?.() })

  it('confirms a real bet from the live playerBettingState state shape', async () => {
    const confirmation = EvolutionAdapter.waitForBetConfirmation({
      tableId: TABLE_ID,
      gameId: 'g-confirm-1',
      betType: 'Tie',
      amount: 1000,
    }, 1000)

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.playerBettingState',
      args: {
        tableId: TABLE_ID,
        gameId: 'g-confirm-1',
        state: {
          acceptedBets: {},
          currentChips: { Tie: { amount: 1000 } },
          rejectedBets: {},
          totalAmount: 1000,
          HasBet: true,
        },
      },
    }))

    await expect(confirmation).resolves.toMatchObject({
      tableId: TABLE_ID,
      gameId: 'g-confirm-1',
      betType: 'Tie',
      amount: 1000,
      status: 'accepted',
      accepted: true,
      rejected: false,
      source: 'playerBettingState',
    })
  })

  it('reports a rejected real bet from playerBettingState rejectedBets', async () => {
    const confirmation = EvolutionAdapter.waitForBetConfirmation({
      tableId: TABLE_ID,
      gameId: 'g-rejected-1',
      betType: 'Tie',
      amount: 1000,
    }, 1000)

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.playerBettingState',
      args: {
        tableId: TABLE_ID,
        gameId: 'g-rejected-1',
        state: {
          acceptedBets: {},
          currentChips: {},
          rejectedBets: { Tie: { amount: 1000, error: '1013' } },
          totalAmount: 0,
          HasBet: false,
        },
      },
    }))

    await expect(confirmation).resolves.toMatchObject({
      tableId: TABLE_ID,
      gameId: 'g-rejected-1',
      betType: 'Tie',
      amount: 1000,
      status: 'rejected',
      accepted: false,
      rejected: true,
      error: '1013',
      source: 'playerBettingState',
    })
  })

  it('requires exact gameId and amount before resolving a confirmation waiter', async () => {
    let settled = false
    const confirmation = EvolutionAdapter.waitForBetConfirmation({
      tableId: TABLE_ID,
      gameId: 'g-exact-1',
      betType: 'Tie',
      amount: 1000,
    }, 1000)
    void confirmation.then(() => { settled = true })

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.playerBettingState',
      args: {
        tableId: TABLE_ID,
        state: { currentChips: { Tie: 1000 }, totalAmount: 1000, HasBet: true },
      },
    }))
    await Promise.resolve()
    expect(settled).toBe(false)

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.playerBettingState',
      args: {
        tableId: TABLE_ID,
        gameId: 'g-exact-1',
        state: { currentChips: { Tie: 2000 }, totalAmount: 2000, HasBet: true },
      },
    }))
    await Promise.resolve()
    expect(settled).toBe(false)

    EvolutionAdapter.processMessage(JSON.stringify({
      type: 'baccarat.playerBettingState',
      args: {
        tableId: TABLE_ID,
        gameId: 'g-exact-1',
        state: { currentChips: { Tie: 1000 }, totalAmount: 1000, HasBet: true },
      },
    }))

    await expect(confirmation).resolves.toMatchObject({
      gameId: 'g-exact-1',
      amount: 1000,
      status: 'accepted',
    })
  })

  it('resolves pending confirmations as unknown when disconnected', async () => {
    const confirmation = EvolutionAdapter.waitForBetConfirmation({
      tableId: TABLE_ID,
      gameId: 'g-disconnect-1',
      betType: 'Tie',
      amount: 1000,
    }, 60_000)

    await EvolutionAdapter.disconnect()

    await expect(confirmation).resolves.toMatchObject({
      status: 'unknown',
      accepted: false,
      rejected: false,
      source: 'disconnect',
    })
  })

  it('preserves timeout as an unknown placement outcome', async () => {
    const confirmation = EvolutionAdapter.waitForBetConfirmation({
      tableId: TABLE_ID,
      gameId: 'g-timeout-1',
      betType: 'Tie',
      amount: 1000,
    }, 10)

    await expect(confirmation).resolves.toMatchObject({
      status: 'unknown',
      accepted: false,
      rejected: false,
      source: 'timeout',
    })
  })
})
