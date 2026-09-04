import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { BettingPhaseEvent, GameResultEvent, RoadResult, Room } from '../../domain/entities'
import type { ICasinoAdapter } from '../../domain/interfaces'
import { container } from '../di/Container'
import { ManualBetService } from './ManualBetService'
import { VirtualBettingService } from './VirtualBettingService'

class MockAdapter implements ICasinoAdapter {
  readonly name = 'Mock'
  readonly type = 'evolution' as const
  private rooms = new Map<string, Room>()
  private results: Array<(e: GameResultEvent) => void> = []
  private phases: Array<(e: BettingPhaseEvent) => void> = []
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected() { return true }
  parseMessage() { return null }
  getRoom(id: string) { return this.rooms.get(id) || null }
  getRooms() { return this.rooms }
  onRoomUpdate() { return () => {} }
  onGameResult(cb: (e: GameResultEvent) => void) { this.results.push(cb); return () => {} }
  onBettingPhase(cb: (e: BettingPhaseEvent) => void) { this.phases.push(cb); return () => {} }
  onHistoryUpdate() { return () => {} }
  setRoom(room: Room) { this.rooms.set(room.id, room) }
  emitResult(e: GameResultEvent) { this.results.forEach(cb => cb(e)) }
  emitPhase(e: BettingPhaseEvent) { this.phases.forEach(cb => cb(e)) }
}

function hist(winners: Array<'B' | 'P' | 'T'>): RoadResult[] {
  return winners.map(winner => ({ winner, isPlayerPair: false, isBankerPair: false }))
}

function openRoom(id = 'r1', msLeft = 8000): Room {
  return { id, name: id, koreanName: id, history: hist(['B', 'P', 'B']), gameCount: 3, phase: 'betting', bettingDeadlineAt: Date.now() + msLeft }
}

describe('ManualBetService (virtual)', () => {
  let adapter: MockAdapter
  const INITIAL = 1_000_000

  beforeEach(() => {
    container.clear()
    adapter = new MockAdapter()
    container.register('casinoAdapter', adapter as unknown as ICasinoAdapter)
    VirtualBettingService.updateSettings({ initialBalance: INITIAL })
    ManualBetService.dispose()
    ManualBetService.initialize()
    ManualBetService.setVirtualMode(true)
    ManualBetService.setChip(10_000)
    ManualBetService.setFollowMartin(false)
    ManualBetService.enable()
    ManualBetService.resetStats()
  })

  afterEach(() => {
    ManualBetService.dispose()
    vi.useRealTimers()
  })

  it('stacks chips on one side, deducts the virtual balance, and undoes the last chip', async () => {
    const room = openRoom()
    adapter.setRoom(room)
    expect((await ManualBetService.addChip(room, 'B')).ok).toBe(true)
    expect((await ManualBetService.addChip(room, 'B', 5_000)).ok).toBe(true)
    let s = ManualBetService.getState()
    expect(s.bets.get('r1')).toMatchObject({ side: 'B', chips: [10_000, 5_000], total: 15_000 })
    expect(s.virtualBalance).toBe(INITIAL - 15_000)
    expect(s.pendingAmount).toBe(15_000)

    expect((await ManualBetService.undoChip(room)).ok).toBe(true)
    s = ManualBetService.getState()
    expect(s.bets.get('r1')?.total).toBe(10_000)
    expect(s.virtualBalance).toBe(INITIAL - 10_000)

    expect((await ManualBetService.clearRoom(room)).ok).toBe(true)
    s = ManualBetService.getState()
    expect(s.bets.has('r1')).toBe(false)
    expect(s.virtualBalance).toBe(INITIAL)
  })

  it('refuses a second side in the same room and refuses when the window is closed', async () => {
    const room = openRoom()
    adapter.setRoom(room)
    await ManualBetService.addChip(room, 'P')
    const other = await ManualBetService.addChip(room, 'B')
    expect(other.ok).toBe(false)
    expect(other.error).toContain('플레이어')

    const closed: Room = { ...openRoom('r2'), phase: 'dealing' }
    adapter.setRoom(closed)
    expect((await ManualBetService.addChip(closed, 'B')).ok).toBe(false)
    const late: Room = openRoom('r3', 500)
    adapter.setRoom(late)
    expect((await ManualBetService.addChip(late, 'B')).ok).toBe(false)
  })

  it('settles win, loss and tie with the shared payout policy', async () => {
    const r1 = openRoom('r1'); const r2 = openRoom('r2'); const r3 = openRoom('r3')
    adapter.setRoom(r1); adapter.setRoom(r2); adapter.setRoom(r3)
    await ManualBetService.addChip(r1, 'B', 10_000) // 뱅커 승 → +9,500
    await ManualBetService.addChip(r2, 'P', 10_000) // 뱅커 승 → −10,000
    await ManualBetService.addChip(r3, 'P', 10_000) // 타이 → 환불

    adapter.emitResult({ roomId: 'r1', winner: 'B' })
    adapter.emitResult({ roomId: 'r2', winner: 'B' })
    adapter.emitResult({ roomId: 'r3', winner: 'T' })

    const s = ManualBetService.getState()
    expect(s.bets.size).toBe(0)
    expect(s.stats).toMatchObject({ wins: 1, losses: 1, ties: 1, betCount: 3, totalBet: 30_000, profit: -500 })
    expect(s.virtualBalance).toBe(INITIAL - 500)
    expect(s.logs.filter(l => l.kind === 'win' || l.kind === 'loss' || l.kind === 'tie')).toHaveLength(3)
  })

  it('settles from history when the result event was missed and the next window opens', async () => {
    const room = openRoom('r1')
    adapter.setRoom(room)
    await ManualBetService.addChip(room, 'P', 10_000)
    adapter.setRoom({ ...room, history: hist(['P', ...room.history.map(h => h.winner)]) })
    adapter.emitPhase({ roomId: 'r1', remainingSeconds: 12, phase: 'start' })
    const s = ManualBetService.getState()
    expect(s.bets.size).toBe(0)
    expect(s.stats.wins).toBe(1)
    expect(s.stats.profit).toBe(10_000)
  })

  it('voids a virtual bet that never gets a result and refunds it', async () => {
    ManualBetService.disable()
    vi.useFakeTimers() // enable()이 만드는 sweep 타이머가 가짜 시계를 타야 한다
    ManualBetService.enable()
    const room = openRoom('r1')
    adapter.setRoom(room)
    await ManualBetService.addChip(room, 'B', 10_000)
    expect(ManualBetService.getState().virtualBalance).toBe(INITIAL - 10_000)
    vi.advanceTimersByTime(130_000)
    const s = ManualBetService.getState()
    expect(s.bets.size).toBe(0)
    expect(s.virtualBalance).toBe(INITIAL)
    expect(s.logs[s.logs.length - 1]?.kind).toBe('void')
  })
})

describe('ManualBetService (martin + per-mode stats)', () => {
  let adapter: MockAdapter
  beforeEach(() => {
    container.clear()
    adapter = new MockAdapter()
    container.register('casinoAdapter', adapter as unknown as ICasinoAdapter)
    VirtualBettingService.updateSettings({ initialBalance: 1_000_000 })
    ManualBetService.dispose()
    ManualBetService.initialize()
    ManualBetService.setVirtualMode(true)
    ManualBetService.setChip(1_000)
    ManualBetService.setFollowMartin(false)
    ManualBetService.setProgression({ baseAmount: 5_000, strategy: 'martingale', maxMartin: 3 })
    ManualBetService.enable()
    ManualBetService.resetStats()
  })
  afterEach(() => ManualBetService.dispose())

  it('follows the martin stage amount for the first chip and steps the level on losses', async () => {
    ManualBetService.setFollowMartin(true)
    const r = openRoom('r1')
    adapter.setRoom(r)
    await ManualBetService.addChip(r, 'P')
    expect(ManualBetService.getBet('r1')?.total).toBe(5_000) // 1단계
    adapter.emitResult({ roomId: 'r1', winner: 'B' })       // 패 → 2단계
    expect(ManualBetService.getMartinLevel('r1')).toBe(1)
    expect(ManualBetService.suggestedAmount('r1')).toBe(10_000)
    await ManualBetService.addChip(r, 'P')
    expect(ManualBetService.getBet('r1')?.total).toBe(10_000)
    adapter.emitResult({ roomId: 'r1', winner: 'B' })       // 패 → 3단계
    expect(ManualBetService.suggestedAmount('r1')).toBe(20_000)
    await ManualBetService.addChip(r, 'P')
    adapter.emitResult({ roomId: 'r1', winner: 'B' })       // 3단계 소진 → 0으로 재시작
    expect(ManualBetService.getMartinLevel('r1')).toBe(0)
    await ManualBetService.addChip(r, 'P')
    adapter.emitResult({ roomId: 'r1', winner: 'P' })       // 승 → 0
    expect(ManualBetService.getMartinLevel('r1')).toBe(0)
    expect(ManualBetService.getState().stats).toMatchObject({ wins: 1, losses: 3 })
  })

  it('keeps virtual and real stats separate across mode switches', async () => {
    const r = openRoom('r1')
    adapter.setRoom(r)
    await ManualBetService.addChip(r, 'P', 10_000)
    adapter.emitResult({ roomId: 'r1', winner: 'P' })
    expect(ManualBetService.getState().stats.profit).toBe(10_000)
    ManualBetService.setVirtualMode(false)
    expect(ManualBetService.getState().stats).toMatchObject({ wins: 0, losses: 0, profit: 0 })
    ManualBetService.setVirtualMode(true)
    expect(ManualBetService.getState().stats.profit).toBe(10_000)
  })
})
