// AccountLimitsService — 계정별 상한(관리자 지정) 보관소 단위 테스트.
//
// 이 서비스는 "관리자가 어드민 페이지에서 계정마다 건 동시배팅 최대 개수"를 로그인/세션 검증에서
// 받아 메모리에 들고 있다가, UI(설정 다이얼로그)와 AutoModeService가 같은 규칙으로 값을 조이도록
// clampConcurrentBets 한 곳만 공유하게 하는 것이 목적이다.
//
// ⚠️ 이 상한은 클라이언트 UX 가드이며 보안 경계가 아니다(서버가 배팅을 중계하지 않는다).
//    테스트도 "실수 방지가 제대로 동작하는가"만 본다.
//
// 가장 중요한 계약은 마지막 케이스 묶음이다 — cap이 null(미주입)이면 clamp는 no-op이고,
// 따라서 상한 기능이 붙기 전 동작이 100% 그대로 살아 있어야 한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountLimitsService, { AccountLimitsService as namedService } from './AccountLimitsService'

describe('AccountLimitsService', () => {
  // 싱글턴이라 케이스끼리 값이 새면 안 된다 — 앞뒤로 모두 초기화한다.
  beforeEach(() => {
    AccountLimitsService.reset()
  })

  afterEach(() => {
    AccountLimitsService.reset()
  })

  it('default / named export가 같은 싱글턴이다', () => {
    expect(namedService).toBe(AccountLimitsService)
  })

  describe('get / set / getMaxConcurrentBets / reset', () => {
    it('초기값은 null(서버 상한 미주입)이다', () => {
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()
      expect(AccountLimitsService.get()).toEqual({ maxConcurrentBets: null })
    })

    it('set한 값을 get / getMaxConcurrentBets로 다시 읽는다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(10)
      expect(AccountLimitsService.get()).toEqual({ maxConcurrentBets: 10 })
    })

    it('get()은 스냅샷(복사본)이라 반환값을 고쳐도 내부 값이 안 바뀐다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 7 })
      const snap = AccountLimitsService.get()
      snap.maxConcurrentBets = 99
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(7)
    })

    it('set({})처럼 키가 없으면 기존 값을 유지한다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 4 })
      AccountLimitsService.set({})
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(4)
    })

    it('reset()은 null(미주입)로 되돌린다 — 로그아웃 후 다음 계정에 안 새게', () => {
      AccountLimitsService.set({ maxConcurrentBets: 3 })
      AccountLimitsService.reset()
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()
    })
  })

  describe('값 정규화(coerce)', () => {
    it('0~50 밖의 값은 0~50으로 조인다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 60 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(50)

      AccountLimitsService.set({ maxConcurrentBets: 999 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(50)

      AccountLimitsService.set({ maxConcurrentBets: -5 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(0)
    })

    it('경계값 0과 50은 그대로 통과한다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 0 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(0)

      AccountLimitsService.set({ maxConcurrentBets: 50 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(50)
    })

    it('소수는 정수화한다(내림이 아니라 절삭)', () => {
      AccountLimitsService.set({ maxConcurrentBets: 3.7 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(3)

      AccountLimitsService.set({ maxConcurrentBets: 9.99 })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(9)
    })

    it('숫자가 아닌 값 / null은 null(미주입)로 떨어진다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AccountLimitsService.set({ maxConcurrentBets: null })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()

      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AccountLimitsService.set({ maxConcurrentBets: 'abc' as unknown as number })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()

      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AccountLimitsService.set({ maxConcurrentBets: NaN })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()

      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AccountLimitsService.set({ maxConcurrentBets: '' as unknown as number })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()

      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AccountLimitsService.set({ maxConcurrentBets: Infinity })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBeNull()
    })

    it('숫자 문자열은 서버가 문자열로 내려줘도 살린다', () => {
      AccountLimitsService.set({ maxConcurrentBets: '12' as unknown as number })
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(12)
    })
  })

  describe('onChange', () => {
    it('값이 바뀌면 스냅샷과 함께 호출된다', () => {
      const cb = vi.fn()
      const unsub = AccountLimitsService.onChange(cb)

      AccountLimitsService.set({ maxConcurrentBets: 8 })

      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith({ maxConcurrentBets: 8 })
      unsub()
    })

    it('반환된 해제 함수를 부르면 더 이상 안 불린다', () => {
      const cb = vi.fn()
      const unsub = AccountLimitsService.onChange(cb)

      AccountLimitsService.set({ maxConcurrentBets: 8 })
      expect(cb).toHaveBeenCalledTimes(1)

      unsub()
      AccountLimitsService.set({ maxConcurrentBets: 2 })
      expect(cb).toHaveBeenCalledTimes(1)
      // 구독만 끊겼을 뿐 값 자체는 정상 반영된다
      expect(AccountLimitsService.getMaxConcurrentBets()).toBe(2)
    })

    it('한 구독만 해제해도 나머지 구독은 계속 살아 있다', () => {
      const a = vi.fn()
      const b = vi.fn()
      const unsubA = AccountLimitsService.onChange(a)
      const unsubB = AccountLimitsService.onChange(b)

      unsubA()
      AccountLimitsService.set({ maxConcurrentBets: 5 })

      expect(a).not.toHaveBeenCalled()
      expect(b).toHaveBeenCalledTimes(1)
      unsubB()
    })

    it('값이 안 바뀌면 emit하지 않는다 — 10초 세션 검증이 같은 값을 계속 밀어넣는다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })
      const cb = vi.fn()
      const unsub = AccountLimitsService.onChange(cb)

      AccountLimitsService.set({ maxConcurrentBets: 10 })
      AccountLimitsService.set({ maxConcurrentBets: 10 })
      // coerce 결과가 같으면(10.4 → 10) 역시 조용해야 한다
      AccountLimitsService.set({ maxConcurrentBets: 10.4 })
      // 키가 없는 set도 마찬가지
      AccountLimitsService.set({})

      expect(cb).not.toHaveBeenCalled()

      AccountLimitsService.set({ maxConcurrentBets: 9 })
      expect(cb).toHaveBeenCalledTimes(1)
      unsub()
    })

    it('이미 null이면 reset()도 emit하지 않는다', () => {
      const cb = vi.fn()
      const unsub = AccountLimitsService.onChange(cb)

      AccountLimitsService.reset()
      expect(cb).not.toHaveBeenCalled()
      unsub()
    })
  })

  describe('clampConcurrentBets — cap = null (서버 상한 미주입)', () => {
    // ★ 이 묶음이 "기존 동작 100% 유지"의 증거다. 상한이 없으면 clamp는 사실상 no-op이라
    //    상한 기능이 붙기 전 코드(Math.max(0, n))와 결과가 같아야 한다.
    it('0은 0(무제한) 그대로다', () => {
      expect(AccountLimitsService.clampConcurrentBets(0)).toBe(0)
    })

    it('20은 20 그대로다 — 아무것도 조이지 않는다', () => {
      expect(AccountLimitsService.clampConcurrentBets(20)).toBe(20)
    })

    it('50을 넘는 값도 그대로 둔다(상한이 없으니 조일 근거가 없다)', () => {
      expect(AccountLimitsService.clampConcurrentBets(999)).toBe(999)
    })

    it('음수만 0으로 올린다 — 기존 Math.max(0, n)과 동일', () => {
      expect(AccountLimitsService.clampConcurrentBets(-3)).toBe(0)
    })

    it('소수는 절삭한다', () => {
      expect(AccountLimitsService.clampConcurrentBets(6.9)).toBe(6)
    })

    it('NaN은 0(무제한)으로 본다', () => {
      expect(AccountLimitsService.clampConcurrentBets(NaN)).toBe(0)
    })
  })

  describe('clampConcurrentBets — cap = 0 (관리자가 제한 풀기 = 무제한)', () => {
    beforeEach(() => {
      AccountLimitsService.set({ maxConcurrentBets: 0 })
    })

    it('0은 0 그대로다', () => {
      expect(AccountLimitsService.clampConcurrentBets(0)).toBe(0)
    })

    it('20은 20 그대로다', () => {
      expect(AccountLimitsService.clampConcurrentBets(20)).toBe(20)
    })

    it('음수만 0으로 올린다 — cap=null과 완전히 같은 동작', () => {
      expect(AccountLimitsService.clampConcurrentBets(-3)).toBe(0)
    })
  })

  describe('clampConcurrentBets — cap = 10 (1~50 상한 계정)', () => {
    beforeEach(() => {
      AccountLimitsService.set({ maxConcurrentBets: 10 })
    })

    it('상한을 넘으면 상한으로 조인다 (20 → 10)', () => {
      expect(AccountLimitsService.clampConcurrentBets(20)).toBe(10)
    })

    it('0(무제한)은 상한으로 정규화한다 (0 → 10)', () => {
      expect(AccountLimitsService.clampConcurrentBets(0)).toBe(10)
    })

    it('상한 이내 값은 그대로 둔다 (5 → 5)', () => {
      expect(AccountLimitsService.clampConcurrentBets(5)).toBe(5)
    })

    it('음수도 무제한 취급이라 상한으로 정규화한다 (-3 → 10)', () => {
      expect(AccountLimitsService.clampConcurrentBets(-3)).toBe(10)
    })

    it('최소값 1은 그대로 둔다 (1 → 1)', () => {
      expect(AccountLimitsService.clampConcurrentBets(1)).toBe(1)
    })

    it('상한 그 자체도 그대로 둔다 (10 → 10)', () => {
      expect(AccountLimitsService.clampConcurrentBets(10)).toBe(10)
    })

    it('소수는 절삭 후 조인다 (10.9 → 10, 0.5 → 10)', () => {
      expect(AccountLimitsService.clampConcurrentBets(10.9)).toBe(10)
      expect(AccountLimitsService.clampConcurrentBets(0.5)).toBe(10)
    })
  })

  describe('clampConcurrentBets — cap = 1 (가장 빡빡한 상한)', () => {
    it('무엇을 넣어도 1이 된다', () => {
      AccountLimitsService.set({ maxConcurrentBets: 1 })
      expect(AccountLimitsService.clampConcurrentBets(0)).toBe(1)
      expect(AccountLimitsService.clampConcurrentBets(1)).toBe(1)
      expect(AccountLimitsService.clampConcurrentBets(50)).toBe(1)
      expect(AccountLimitsService.clampConcurrentBets(-9)).toBe(1)
    })
  })

  it('reset() 후에는 clamp가 다시 no-op이 된다 — 로그아웃 뒤 상한이 안 남는다', () => {
    AccountLimitsService.set({ maxConcurrentBets: 3 })
    expect(AccountLimitsService.clampConcurrentBets(20)).toBe(3)

    AccountLimitsService.reset()
    expect(AccountLimitsService.clampConcurrentBets(20)).toBe(20)
  })
})
