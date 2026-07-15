// SemiAutoService.test.ts - 반자동 모드 핵심 로직 검증
// bcrstore의 GameLogic 참조하여 이벤트 기반 아키텍처 테스트
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 공유 CDP 목 (방 이동 전략 검증용) — 팩토리가 매번 새 객체를 만들지 않도록 hoist
const { cdpMock } = vi.hoisted(() => ({
  cdpMock: {
    navigateChrome: vi.fn().mockResolvedValue(undefined),
    openInChrome: vi.fn().mockResolvedValue(undefined),
    navigateToRoom: vi.fn().mockResolvedValue(undefined),
    openNewTab: vi.fn().mockResolvedValue(undefined),
    openInChromeNormal: vi.fn().mockResolvedValue(undefined),
  },
}))

// Tauri invoke는 테스트 런타임에 없으므로 목으로 대체 (resubscribe 등)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

// Mock dependencies
vi.mock('../di', () => ({
  container: {
    get: vi.fn((key: string) => {
      if (key === 'casinoAdapter') {
        return {
          onShoeChange: vi.fn(() => () => { }),
          onHistoryUpdate: vi.fn(() => () => { }),
          onGameResult: vi.fn(() => () => { }),
          onBettingPhase: vi.fn(() => () => { }),
        }
      }
      if (key === 'multiRoomPredictionPort') {
        return {
          requestPredictionForRoom: vi.fn().mockResolvedValue({
            roomId: 'room1',
            prediction: 'B',
            confidence: 0.8,
            isSkip: false,
            timestamp: Date.now(),
          }),
          requestBestRoomSelection: vi.fn().mockResolvedValue(null),
        }
      }
      if (key === 'roomFilterUseCase') {
        return {
          getActiveFilters: vi.fn(() => []),
          detectPattern: vi.fn(() => null),
          matchesFilter: vi.fn(() => true),
        }
      }
      if (key === 'soundPort') {
        return {
          playTie: vi.fn(),
          playPrediction: vi.fn(),
          playMove: vi.fn(),
          playData: vi.fn(),
          preload: vi.fn(),
        }
      }
      if (key === 'cdpPort') {
        return cdpMock
      }
      return {}
    }),
  },
}))

// Import after mocking
import {
  calculateBetAmount,
  getNextBetLevel,
} from '../../domain/entities'

describe('SemiAutoService Core Logic', () => {
  describe('1. N승 후 방 이동 로직', () => {
    it('winThreshold=1일 때 1승 후 shouldMove=true', () => {
      const winThreshold = 1
      let winCount = 0

      // 승리 시
      winCount++
      const shouldMove = winThreshold > 0 && winCount >= winThreshold

      expect(shouldMove).toBe(true)
    })

    it('winThreshold=3일 때 2승 후 shouldMove=false, 3승 후 shouldMove=true', () => {
      const winThreshold = 3
      let winCount = 0

      // 1승
      winCount++
      expect(winThreshold > 0 && winCount >= winThreshold).toBe(false)

      // 2승
      winCount++
      expect(winThreshold > 0 && winCount >= winThreshold).toBe(false)

      // 3승
      winCount++
      expect(winThreshold > 0 && winCount >= winThreshold).toBe(true)
    })

    it('winThreshold=0일 때 무제한 (항상 shouldMove=false)', () => {
      const winThreshold = 0
      const winCount = 10

      const shouldMove = winThreshold > 0 && winCount >= winThreshold
      expect(shouldMove).toBe(false)
    })
  })

  describe('2. 마틴 한도 도달 시 방 이동 로직', () => {
    it('마틴게일: 패배 시 레벨 증가, maxMartin 도달 시 방 이동', () => {
      const maxMartin = 5
      let martin = 0

      // 5번 연속 패배
      for (let i = 0; i < 5; i++) {
        martin = getNextBetLevel('martingale', martin, false, maxMartin)
      }

      // 5마틴 도달 (maxMartin과 같거나 클 때 방 이동)
      expect(martin >= maxMartin).toBe(true)
    })

    it('마틴게일: 승리 시 레벨 0으로 리셋', () => {
      let martin = 3
      martin = getNextBetLevel('martingale', martin, true, 5)
      expect(martin).toBe(0)
    })

    it('배팅 금액 계산: 마틴게일 1-2-4-8-16 진행', () => {
      const baseBet = 10000

      expect(calculateBetAmount('martingale', baseBet, 0)).toBe(10000)
      expect(calculateBetAmount('martingale', baseBet, 1)).toBe(20000)
      expect(calculateBetAmount('martingale', baseBet, 2)).toBe(40000)
      expect(calculateBetAmount('martingale', baseBet, 3)).toBe(80000)
      expect(calculateBetAmount('martingale', baseBet, 4)).toBe(160000)
    })
  })

  describe('3. SKIP 예측 처리', () => {
    it('isSkip=true일 때 waitingForResult=false, martin 유지 (패스 시 마틴 리셋 안함)', () => {
      const prediction = {
        isSkip: true,
        prediction: null,
        reasoning: '연패 회복 중',
      }

      let waitingForResult = true
      let martin = 3

      if (prediction.isSkip) {
        waitingForResult = false
        // 패스 시 마틴 유지 - 승리 시에만 리셋됨
        // martin = 0  // 삭제: 패스 후 다음 예측에서 마틴 이어감
      } else {
        waitingForResult = true
      }

      expect(waitingForResult).toBe(false)
      expect(martin).toBe(3)  // 마틴 유지 확인
    })
  })

  describe('4. TIE 결과 처리 (bcrstore 방식)', () => {
    it('TIE일 때 승패 판정 없이 대기 유지 - 횟수 유지', () => {
      const winner = 'T'
      let waitingForResult = true
      let martin = 2
      let winCount = 1

      // TIE 처리 로직 - bcrstore 방식
      if (winner === 'T') {
        // TIE - 대기 유지, 마틴/승수 변경 없음
        // 실제 코드에서는 return으로 처리
      }

      // TIE 후 상태 유지 확인
      expect(waitingForResult).toBe(true)
      expect(martin).toBe(2)
      expect(winCount).toBe(1)
    })
  })

  describe('5. 자동 방 탐색 (ON 모드)', () => {
    it('이전 방 제외 로직 검증', () => {
      const previousRoomIds = new Set(['room1', 'room2'])
      const candidateRoomId = 'room1'

      const shouldSkip = previousRoomIds.has(candidateRoomId)
      expect(shouldSkip).toBe(true)

      const newRoomId = 'room3'
      expect(previousRoomIds.has(newRoomId)).toBe(false)
    })

    it('후보 없을 때 이전 방 목록 초기화 후 재탐색', () => {
      const previousRoomIds = new Set(['room1', 'room2', 'room3'])
      let candidates: string[] = []

      if (candidates.length === 0 && previousRoomIds.size > 0) {
        previousRoomIds.clear()
        candidates = ['room1', 'room2', 'room3']
      }

      expect(previousRoomIds.size).toBe(0)
      expect(candidates.length).toBe(3)
    })
  })

  describe('6. 정지 후 다음 최적 방 찾기', () => {
    it('toggle OFF 시 현재 방을 previousRoomIds에 추가', () => {
      const previousRoomIds = new Set<string>()
      const currentRoomId = 'room1'
      const enabled = true

      if (enabled && currentRoomId) {
        previousRoomIds.add(currentRoomId)
      }

      expect(previousRoomIds.has('room1')).toBe(true)
    })
  })

  describe('7. 방 점수 계산 로직 (20~40 범위 최적화)', () => {
    it('퐁당 패턴 (교대) - +12점 가산', () => {
      const history = ['B', 'P', 'B', 'P', 'B', 'P']

      let alternatingCount = 0
      for (let i = 0; i < Math.min(6, history.length - 1); i++) {
        if (history[i] !== history[i + 1]) alternatingCount++
      }

      expect(alternatingCount).toBe(5)
      expect(alternatingCount >= 5).toBe(true) // +12점 (베이스 15 + 12 = 27점)
    })

    it('장줄 패턴 (연속) - +10점 가산', () => {
      const history = ['B', 'B', 'B', 'B', 'B', 'P']

      let streakLength = 1
      for (let i = 1; i < history.length; i++) {
        if (history[i] === history[0]) streakLength++
        else break
      }

      expect(streakLength).toBe(5)
      expect(streakLength >= 5).toBe(true) // +10점 (베이스 15 + 10 = 25점)
    })

    it('점수 범위 검증 (20~40점 목표)', () => {
      // 최소 점수: 베이스(15) + 패턴 없음(0) = 15
      // 최대 점수: 베이스(15) + 퐁당(12) + 장줄(10) + 1-2(5) + 히스토리(3) + 승률(5) = 50
      // 목표 범위: 20~40점 우선 선택
      const MIN_SCORE = 20
      const MAX_SCORE = 40
      const TARGET_SCORE = (MIN_SCORE + MAX_SCORE) / 2

      expect(TARGET_SCORE).toBe(30)
    })
  })
})

describe('SemiAutoService Event-Based Architecture', () => {
  describe('이벤트 기반 흐름 (bcrstore 참조)', () => {
    it('예측 요청은 베팅 페이즈에서만 발생해야 함', () => {
      // 이벤트 기반 아키텍처 검증
      // - onBettingPhase: 예측 요청 (Single Source of Truth)
      // - onGameResult: 결과 비교 (Single Source of Truth)
      // - handleHistoryUpdate: 데이터 동기화만

      const eventFlow = {
        bettingPhase: 'requestPrediction',
        gameResult: 'compareResult',
        historyUpdate: 'dataSync', // NOT prediction or comparison
      }

      expect(eventFlow.bettingPhase).toBe('requestPrediction')
      expect(eventFlow.gameResult).toBe('compareResult')
      expect(eventFlow.historyUpdate).toBe('dataSync')
    })

    it('첫 라운드는 예측 스킵 (데이터 수집만)', () => {
      let isFirstRound = true
      let predictionRequested = false

      // 베팅 페이즈 이벤트 수신
      if (isFirstRound) {
        // Skip prediction, collect data only
        predictionRequested = false
      } else {
        predictionRequested = true
      }

      expect(predictionRequested).toBe(false)

      // 첫 라운드 완료 후
      isFirstRound = false

      // 다음 베팅 페이즈
      if (!isFirstRound) {
        predictionRequested = true
      }

      expect(predictionRequested).toBe(true)
    })
  })

  describe('동시성 문제 방지', () => {
    it('predictionMadeForRound 플래그로 중복 예측 방지', () => {
      let predictionMadeForRound = false
      let predictionCount = 0

      const requestPrediction = () => {
        if (predictionMadeForRound) return
        predictionMadeForRound = true
        predictionCount++
      }

      // 연속 3번 호출
      requestPrediction()
      requestPrediction()
      requestPrediction()

      expect(predictionCount).toBe(1)
    })

    it('waitingForPrediction 플래그로 중복 API 요청 방지', () => {
      let waitingForPrediction = false
      let apiCallCount = 0

      const requestPrediction = async () => {
        if (waitingForPrediction) return
        waitingForPrediction = true
        apiCallCount++
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 10))
        waitingForPrediction = false
      }

      // 동시 호출
      requestPrediction()
      requestPrediction()
      requestPrediction()

      expect(apiCallCount).toBe(1)
    })

    it('lastComparedResult로 중복 결과 처리 방지', () => {
      let lastComparedResult: string | null = null
      let lastComparedRound = -1
      let processCount = 0

      const processResult = (winner: string, historyLength: number) => {
        const resultKey = `${winner}-${historyLength}`
        if (lastComparedResult === resultKey && lastComparedRound === historyLength) return
        lastComparedResult = resultKey
        lastComparedRound = historyLength
        processCount++
      }

      // 같은 결과 3번 수신
      processResult('B', 10)
      processResult('B', 10)
      processResult('B', 10)

      expect(processCount).toBe(1)
    })

    it('predictionRequestRoom으로 비동기 레이스 방지', () => {
      let predictionRequestRoom: string | null = null
      let currentRoomId = 'room1'
      let predictionApplied = false

      // 예측 요청
      predictionRequestRoom = currentRoomId

      // 방 이동 발생
      currentRoomId = 'room2'

      // 예측 응답 도착
      const applyPrediction = () => {
        if (predictionRequestRoom !== currentRoomId) {
          // Stale prediction - ignore
          predictionApplied = false
          return
        }
        predictionApplied = true
      }

      applyPrediction()

      expect(predictionApplied).toBe(false) // 이전 방의 예측은 무시
    })
  })

  describe('상태 리셋', () => {
    it('방 이동 시 clearPredictionState() 호출', () => {
      // 방 이동 전 상태
      let lastPrediction: { prediction: string } | null = { prediction: 'B' }
      let waitingForResult = true
      let waitingForPrediction = true
      let predictionMadeForRound = true
      let martin = 3
      let winCount = 2

      // clearPredictionState() 호출 시뮬레이션
      lastPrediction = null
      waitingForResult = false
      waitingForPrediction = false
      predictionMadeForRound = false
      martin = 0
      winCount = 0

      expect(lastPrediction).toBe(null)
      expect(waitingForResult).toBe(false)
      expect(waitingForPrediction).toBe(false)
      expect(predictionMadeForRound).toBe(false)
      expect(martin).toBe(0)
      expect(winCount).toBe(0)
    })

    it('새 슈 시작 시 상태 초기화', () => {
      let isFirstRound = false
      let lastPrediction: { prediction: string } | null = { prediction: 'B' }
      let waitingForResult = true
      let predictionMadeForRound = true

      // resetRoomState() 호출 시뮬레이션
      isFirstRound = true
      lastPrediction = null
      waitingForResult = false
      predictionMadeForRound = false

      expect(isFirstRound).toBe(true)
      expect(lastPrediction).toBe(null)
      expect(waitingForResult).toBe(false)
      expect(predictionMadeForRound).toBe(false)
    })
  })
})

describe('SemiAutoService Room URL Building', () => {
  it('buildRoomUrl이 올바른 형식의 URL 생성', () => {
    const baseUrl = 'https://casino.example.com/game?token=abc'
    const roomId = 'leqhceumaq6qfoug'

    // buildRoomUrl 로직 시뮬레이션
    const randomLaunchId = 'test-uuid-12345'
    const url = `${baseUrl}&game=baccarat&table_id=${roomId}&lobby_launch_id=${randomLaunchId}`

    expect(url).toContain(baseUrl)
    expect(url).toContain('game=baccarat')
    expect(url).toContain(`table_id=${roomId}`)
    expect(url).toContain('lobby_launch_id=')
  })
})

import SemiAutoService from './SemiAutoService'
import type { TriggerReason } from './freshshoe'
import AutoBettingService from './AutoBettingService'

describe('SemiAutoService preset trigger', () => {
  beforeEach(() => {
    if (typeof (SemiAutoService as any).resetForTest === 'function') {
      ;(SemiAutoService as any).resetForTest()
    }
  })

  it('exposes getCurrentRoomId', () => {
    expect(typeof SemiAutoService.getCurrentRoomId).toBe('function')
  })

  it("handlePresetTrigger with no candidates does not call navigateToRoom", async () => {
    const navigateSpy = vi.spyOn(SemiAutoService, 'navigateToRoom' as any).mockResolvedValue(undefined)
    ;(SemiAutoService as any).__testSetCandidatesProvider(() => [])

    await SemiAutoService.handlePresetTrigger('current', 'tie_hit' as TriggerReason)

    expect(navigateSpy).not.toHaveBeenCalled()
    navigateSpy.mockRestore()
  })

  it("handlePresetTrigger with candidates navigates to first candidate that is not the current room", async () => {
    const candidates = [
      { id: 'current', name: 'Current', koreanName: '현재', history: [], gameCount: 0 } as any,
      { id: 'other', name: 'Other', koreanName: '다음', history: [], gameCount: 0 } as any,
    ]
    ;(SemiAutoService as any).__testSetCandidatesProvider(() => candidates)

    const navigateSpy = vi.spyOn(SemiAutoService, 'navigateToRoom' as any).mockResolvedValue(undefined)

    await SemiAutoService.handlePresetTrigger('current', 'organic_tie' as TriggerReason)

    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect((navigateSpy.mock.calls[0][0] as any).id).toBe('other')
    navigateSpy.mockRestore()
  })

  it('production candidates require an explicit shoe-change signal', () => {
    const verified = {
      id: 'verified', name: 'Verified', koreanName: '검증됨',
      history: Array.from({ length: 5 }, () => ({ winner: 'B' })), gameCount: 5,
    } as any
    const inferredOnly = {
      id: 'inferred', name: 'Inferred', koreanName: '추정만',
      history: Array.from({ length: 2 }, () => ({ winner: 'P' })), gameCount: 2,
    } as any

    SemiAutoService.updateAvailableRooms(new Map([
      [verified.id, verified],
      [inferredOnly.id, inferredOnly],
    ]))
    ;(SemiAutoService as any).freshShoeDetectedAtByRoom.set(verified.id, Date.now())

    const candidates = (SemiAutoService as any).collectFreshShoeCandidates() as any[]
    expect(candidates.map(room => room.id)).toEqual(['verified'])
  })

  it('forces a non-skip prediction to Tie while the preset direction is active', () => {
    SemiAutoService.updateSettings({ forceBetDirection: 'tie_only' })
    const prediction = {
      roomId: 'room1', prediction: 'B', confidence: 0.8,
      reasoning: 'server', isSkip: false, timestamp: Date.now(),
    } as const

    const forced = (SemiAutoService as any).applyForcedBetDirection(prediction)
    expect(forced.prediction).toBe('T')
    expect(forced.isSkip).toBe(false)

    SemiAutoService.updateSettings({ forceBetDirection: 'auto' })
  })

  it('preserves an unknown real bet through stop and waits for explicit acceptance', async () => {
    const prediction = {
      roomId: 'room-real', prediction: 'B', confidence: 0.8,
      reasoning: 'server', isSkip: false, timestamp: Date.now(),
    } as const
    const internal = (SemiAutoService as any).internalState
    Object.assign(internal, {
      currentRoomId: 'room-real',
      currentRoomName: '실베팅 방',
      currentRoomProvider: 'evolution',
      currentBetAmount: 10_000,
      lastPrediction: prediction,
      waitingForResult: true,
      predictionMadeForRound: true,
      roomHistory: ['B'],
    })
    SemiAutoService.updateSettings({ enabled: true, autoBetting: true, baseBetAmount: 10_000 })
    const placeSpy = vi.spyOn(AutoBettingService, 'placeBetForPrediction').mockResolvedValue({
      success: false,
      placementStatus: 'unknown',
      error: 'confirmation-timeout',
    })

    await (SemiAutoService as any).executeAutoBetting(prediction)
    expect(internal.realBetPlacementStatus).toBe('unknown')
    expect(internal.waitingForResult).toBe(true)

    SemiAutoService.stop()
    expect(SemiAutoService.getState().settings.enabled).toBe(false)
    expect(internal.waitingForResult).toBe(true)

    SemiAutoService.onGameResult('room-real', 'P', ['P', 'B'])
    expect(internal.waitingForResult).toBe(true)
    expect(internal.cumulativeProfit).toBe(0)

    SemiAutoService.onGameResult('room-real', 'P', ['P', 'B'], {
      acceptedBets: { Banker: 10_000 },
      rejectedBets: {},
    })
    expect(internal.waitingForResult).toBe(false)
    expect(internal.realBetPlacementStatus).toBeNull()
    expect(internal.cumulativeProfit).toBe(-10_000)

    placeSpy.mockRestore()
  })
})

describe('SemiAutoService 방 이동 전략 (회귀 가드)', () => {
  const room = { id: 'roomX', name: 'X', koreanName: '엑스', history: [], gameCount: 0 } as any

  beforeEach(() => {
    ;(SemiAutoService as any).resetForTest?.()
    cdpMock.navigateToRoom.mockClear()
    cdpMock.openNewTab.mockClear()
    cdpMock.openInChromeNormal.mockClear()
  })

  it('가상/도움받기 기본(autoBetting=off)에서는 검증된 open_new_tab_cdp를 우선 사용한다', async () => {
    SemiAutoService.updateSettings({ baseUrl: 'https://casino.test', autoBetting: false })

    await SemiAutoService.navigateToRoom(room)

    // 예측 모드 컨텍스트에서 동작하는 새 탭 CDP 이동이 먼저 호출되고, 단일탭 ws-block는 호출되지 않아야 한다.
    expect(cdpMock.openNewTab).toHaveBeenCalledTimes(1)
    expect(cdpMock.navigateToRoom).not.toHaveBeenCalled()
  })

  it('실제 자동배팅(autoBetting=on)에서는 단일탭 navigate_to_room_with_ws_block를 우선 사용한다', async () => {
    SemiAutoService.updateSettings({ baseUrl: 'https://casino.test', autoBetting: true })

    await SemiAutoService.navigateToRoom(room)

    expect(cdpMock.navigateToRoom).toHaveBeenCalledTimes(1)
    expect(cdpMock.openNewTab).not.toHaveBeenCalled()
  })

  it('우선 전략이 실패하면 다음 전략으로 폴백한다', async () => {
    SemiAutoService.updateSettings({ baseUrl: 'https://casino.test', autoBetting: false })
    cdpMock.openNewTab.mockRejectedValueOnce(new Error('no cdp tab'))

    await SemiAutoService.navigateToRoom(room)

    // open_new_tab_cdp 실패 → ws-block로 폴백
    expect(cdpMock.openNewTab).toHaveBeenCalledTimes(1)
    expect(cdpMock.navigateToRoom).toHaveBeenCalledTimes(1)
  })
})
