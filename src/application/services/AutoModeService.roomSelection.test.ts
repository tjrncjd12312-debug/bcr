// AutoModeService.isRoomEnabled — 사용자 방 선택 우선 회귀 가드.
//
// 증상 3 수정: 추천필터(activeBettingRoomIds)에 뜬 방이라도 사용자가 방을 선택(roomConfigs)했다면
// 그 선택 밖의 방엔 배팅하지 않는다. 이전엔 추천필터가 방 선택 체크를 우회(return true)해 사용자가
// 고르지 않은 방에도 배팅됐다(= "방 선택 무시"). 마틴 진행 중인 방은 선택/필터와 무관하게 계속 간다.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { BettingPhaseEvent, GameResultEvent, Room, RoomBetConfig } from '../../domain/entities'
import type { ICasinoAdapter, IMultiRoomPredictionPort } from '../../domain/interfaces'
import { container } from '../di/Container'
import AutoModeService from './AutoModeService'
import { VirtualBettingService } from './VirtualBettingService'
import { PatternBettingService } from './PatternBettingService'

class MockCasinoAdapter implements ICasinoAdapter {
  readonly name = 'Mock'
  readonly type = 'evolution' as const
  private rooms: Map<string, Room> = new Map()

  async connect(_config: any): Promise<void> {}
  async disconnect(): Promise<void> { this.rooms.clear() }
  isConnected(): boolean { return true }
  parseMessage(_raw: string): any { return null }
  getRoom(roomId: string): Room | null { return this.rooms.get(roomId) || null }
  getRooms(): Map<string, Room> { return this.rooms }
  setRoom(room: Room): void { this.rooms.set(room.id, room) }
  onRoomUpdate(): () => void { return () => {} }
  onHistoryUpdate(): () => void { return () => {} }
  onGameResult(_cb: (e: GameResultEvent) => void): () => void { return () => {} }
  onBettingPhase(_cb: (e: BettingPhaseEvent) => void): () => void { return () => {} }
}

const flush = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const FILTER_TRANSITION_WAIT_MS = 220

// roomConfigs 항목 (enabled=true, 휴식 무제한)
const cfg = (roomId: string): RoomBetConfig => ({ roomId, enabled: true, maxConsecutiveLosses: 0 })

describe('AutoModeService.isRoomEnabled — 사용자 방 선택 우선', () => {
  beforeEach(() => {
    localStorage.clear()
    container.clear()

    const predictionPort: IMultiRoomPredictionPort = {
      requestPredictionForRoom: vi.fn(async () => null),
      requestBestRoomSelection: vi.fn(async () => null),
    }
    container.register('casinoAdapter', new MockCasinoAdapter() as unknown as ICasinoAdapter)
    container.register('multiRoomPredictionPort', predictionPort)

    VirtualBettingService.disable()
    VirtualBettingService.reset()
    PatternBettingService.dispose()

    AutoModeService.dispose()
    AutoModeService.initialize()
    // 싱글턴 settings 누수 방지: 매 테스트 clean baseline(선택 없음)으로 초기화.
    AutoModeService.updateSettings({ roomConfigs: [] })
  })

  afterEach(() => {
    AutoModeService.stop()
    AutoModeService.dispose()
    VirtualBettingService.disable()
    PatternBettingService.dispose()
  })

  it('선택한 방 밖의 추천필터 방은 배팅하지 않는다', async () => {
    // 사용자 선택 = {A, B}, 추천필터(실시간 매칭) = {B, C}
    AutoModeService.updateSettings({ roomConfigs: [cfg('A'), cfg('B')] })
    AutoModeService.setActiveBettingRooms(['B', 'C'], 'all')
    await flush(FILTER_TRANSITION_WAIT_MS) // 필터 전환 락 해제 대기

    expect(AutoModeService.isRoomEnabled('B')).toBe(true)   // 선택O + 추천O
    expect(AutoModeService.isRoomEnabled('C')).toBe(false)  // 선택X + 추천O  → 이전 버그에선 true
    expect(AutoModeService.isRoomEnabled('A')).toBe(false)  // 선택O 이지만 추천(매칭) X
  })

  it('방 선택이 없으면 추천필터가 그대로 동작한다 (회귀 가드)', async () => {
    AutoModeService.setActiveBettingRooms(['B', 'C'], 'all')
    await flush(FILTER_TRANSITION_WAIT_MS)

    expect(AutoModeService.isRoomEnabled('B')).toBe(true)
    expect(AutoModeService.isRoomEnabled('C')).toBe(true)
    expect(AutoModeService.isRoomEnabled('Z')).toBe(false) // 추천에 없는 방
  })
})
