// AutoModeService — 계정별 동시배팅 상한(관리자 지정) 반영 테스트.
//
// 묻는 것: "관리자가 어드민에서 이 계정 동시배팅을 N개로 묶으면, 앱 설정이 실제로 N 이하로 조여지는가?"
//
// 검증 경로 2개
//   1) updateSettings(...) — 사용자가 설정창에서 고른 값은 그 자리에서 상한으로 조여 저장된다
//   2) getEffectiveMaxConcurrentBets() — 상한은 "로그인 후에" 도착한다. 이미 저장돼 있던 값(예: 20)은
//      원본 그대로 두고 실제 적용값만 조인다. 저장을 덮어쓰지 않으므로, 관리자가 상한을 풀면
//      원래 값이 즉시 되살아나고 같은 PC의 다른 계정으로도 앞 계정 상한이 새지 않는다.
//
// ⚠️ 이 상한은 클라이언트 UX 가드이며 보안 경계가 아니다(서버가 배팅을 중계하지 않는다).
//    "사용자가 모르고 과하게 벌리는 것"을 막는 용도.
//
// ★ cap = null(미주입)일 때 기존 동작이 100% 그대로인지도 여기서 못박는다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { container } from '../di/Container'
import AutoModeService from './AutoModeService'
import AccountLimitsService from './AccountLimitsService'
import { VirtualBettingService } from './VirtualBettingService'

/** 사용자가 고른 원본 설정값 (저장되는 값) */
const concurrent = () => AutoModeService.getState().settings.maxConcurrentBets
/** 실제로 배팅 게이트에 적용되는 값 (원본을 계정 상한으로 조인 결과) */
const effective = () => AutoModeService.getEffectiveMaxConcurrentBets()

describe('AutoModeService — 계정 동시배팅 상한', () => {
  beforeEach(() => {
    localStorage.clear()
    container.clear()

    // 싱글턴 누수 차단 — 상한은 계정별 값이라 케이스 사이에 절대 남으면 안 된다.
    AccountLimitsService.reset()

    VirtualBettingService.disable()
    VirtualBettingService.reset()
    AutoModeService.dispose()
  })

  afterEach(() => {
    AutoModeService.stop()
    AutoModeService.dispose()
    AccountLimitsService.reset()
    VirtualBettingService.disable()
  })

  describe('updateSettings 클램프', () => {
    it('상한 10인 계정에서 20을 넣으면 10으로 조여진다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })

      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      expect(concurrent()).toBe(10)
    })

    it('상한 10인 계정에서 0(무제한)은 10으로 정규화된다 — 상한 계정은 무제한을 못 고른다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })

      AutoModeService.updateSettings({ maxConcurrentBets: 0 })

      expect(concurrent()).toBe(10)
    })

    it('상한 10인 계정에서 상한 이내 값은 그대로 저장된다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })

      AutoModeService.updateSettings({ maxConcurrentBets: 5 })

      expect(concurrent()).toBe(5)
    })

    it('상한 0(관리자가 제한 풀기)이면 20은 20 그대로다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 0 })

      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      expect(concurrent()).toBe(20)
    })

    it('상한 미주입(null)이면 0은 0 그대로다 — 기존 무제한 동작 보호', () => {
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()

      AutoModeService.updateSettings({ maxConcurrentBets: 0 })

      expect(concurrent()).toBe(0)
    })

    it('상한 미주입(null)이면 20도 20 그대로다 — clamp가 no-op', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      expect(concurrent()).toBe(20)
    })

    it('maxConcurrentBets를 안 보낸 updateSettings는 이 값을 건드리지 않는다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AutoModeService.updateSettings({ maxConcurrentBets: 4 })

      AutoModeService.updateSettings({ baseBetAmount: 20_000 })

      expect(concurrent()).toBe(4)
      expect(AutoModeService.getState().settings.baseBetAmount).toBe(20_000)
    })
  })

  describe('상한이 나중에 도착할 때(로그인/세션 검증 주입)', () => {
    it('이미 20으로 저장돼 있어도 상한 5가 들어오면 실제 적용은 5다 — 저장값 원본은 20 그대로', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })
      expect(concurrent()).toBe(20)

      let stateChanges = 0
      const unsub = AutoModeService.onStateChange(() => { stateChanges += 1 })

      AccountLimitsService.set({ maxConcurrentBets: 5 })

      expect(effective()).toBe(5)
      // ★ 원본을 덮어쓰지 않는다 — 덮어쓰면 상한을 풀어도 5에 갇히고, 같은 PC의 다른 계정까지 오염된다
      expect(concurrent()).toBe(20)
      // 설정창의 max·프리셋이 달라지므로 UI 갱신용 상태변경은 나가야 한다
      expect(stateChanges).toBeGreaterThan(0)
      unsub()
    })

    it('상한이 사용자 설정을 조이면 사용자에게 보이는 안내가 남는다', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      AccountLimitsService.set({ maxConcurrentBets: 5 })

      expect(AutoModeService.getState().statusMessage).toContain('관리자 설정')
      expect(AutoModeService.getState().statusMessage).toContain('5')
    })

    it('저장값이 이미 상한 이내면 실제 적용도 그대로다', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 3 })

      AccountLimitsService.set({ maxConcurrentBets: 10 })

      expect(effective()).toBe(3)
      expect(concurrent()).toBe(3)
      // 조인 게 없으니 안내도 띄우지 않는다
      expect(AutoModeService.getState().statusMessage).not.toContain('관리자 설정')
    })

    it('저장값이 0(무제한)인데 상한 6이 들어오면 실제 적용은 6이다', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 0 })

      AccountLimitsService.set({ maxConcurrentBets: 6 })

      expect(effective()).toBe(6)
    })

    it('★ 관리자가 상한을 풀면(0) 사용자가 원래 쓰던 값이 되살아난다', () => {
      // 상한 없을 때 20으로 쓰던 사용자
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      // 관리자가 4로 묶는다 → 실제 적용만 4
      AccountLimitsService.set({ maxConcurrentBets: 4 })
      expect(effective()).toBe(4)
      expect(concurrent()).toBe(20)

      // 관리자가 "제한 풀기"(0) → 저장된 20이 그대로 되살아난다 (사용자가 다시 입력할 필요 없음)
      AccountLimitsService.set({ maxConcurrentBets: 0 })
      expect(effective()).toBe(20)
      expect(concurrent()).toBe(20)
    })

    it('★ 계정 전환: 상한 3 계정을 쓰고 나가도 무제한 계정의 설정이 조여진 채로 남지 않는다', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      // 상한 3 계정 로그인 → 사용 → 로그아웃(reset)
      AccountLimitsService.set({ maxConcurrentBets: 3 })
      expect(effective()).toBe(3)
      AccountLimitsService.reset()

      // 무제한 계정 로그인
      AccountLimitsService.set({ maxConcurrentBets: 0 })
      expect(effective()).toBe(20)
    })

    it('dispose() 후에도 상한 구독이 살아 있다 — 로그아웃→재로그인에서 상한이 다시 먹혀야 한다', () => {
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      // App.tsx 로그아웃 경로가 실제로 dispose()를 부른다
      AutoModeService.dispose()

      AccountLimitsService.set({ maxConcurrentBets: 2 })

      expect(effective()).toBe(2)
    })

    it('구독은 언제나 1개다 — dispose를 여러 번 불러도 중복 발화하지 않는다', () => {
      AutoModeService.dispose()
      AutoModeService.dispose()
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })

      let emits = 0
      const unsub = AutoModeService.onStateChange(() => { emits += 1 })

      AccountLimitsService.set({ maxConcurrentBets: 7 })

      expect(effective()).toBe(7)
      // 리스너가 중복 등록됐다면 한 번의 상한 변경에 두 번 이상 발화한다
      expect(emits).toBe(1)
      unsub()
    })
  })

  describe('localStorage에 남아 있던 값(계정 무관 단일 키)', () => {
    it('상한 계정으로 로그인하면 로드된 저장값이 상한으로 조여 적용된다(저장은 그대로)', () => {
      // 예전 계정에서 20으로 저장해둔 상태
      AutoModeService.updateSettings({ maxConcurrentBets: 20 })
      expect(concurrent()).toBe(20)

      // 상한 8짜리 계정으로 로그인 → 주입
      AccountLimitsService.set({ maxConcurrentBets: 8 })

      expect(effective()).toBe(8)
      expect(concurrent()).toBe(20)
    })

    it('손상된 저장값(문자열)이 무제한으로 뒤집히지 않는다 — 위험한 쪽으로 실패하지 않기', () => {
      // 구버전/수동 편집으로 숫자가 아닌 값이 들어간 경우
      AutoModeService.updateSettings({ maxConcurrentBets: '12' as unknown as number })

      expect(effective()).toBe(12)

      AccountLimitsService.set({ maxConcurrentBets: 5 })
      expect(effective()).toBe(5)
    })
  })
})
