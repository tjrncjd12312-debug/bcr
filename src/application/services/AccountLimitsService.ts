// AccountLimitsService - 관리자가 계정별로 지정한 상한값 보관소 (로그인/세션 검증에서 주입)
// Presentation-friendly application service (no React dependency)
//
// ⚠️ 이 상한은 클라이언트 UX 가드이며 보안 경계가 아니다.
//    서버가 배팅을 중계하지 않으므로(앱이 카지노에 직접 배팅) 앱 조작으로 우회 가능하다.
//    "사용자가 실수로/모르고 과하게 벌리는 것"을 막는 용도로만 쓴다.
//
// ⚠️ localStorage 영속화를 일부러 넣지 않았다. 계정별 서버 값이라 저장해두면
//    다른 계정으로 로그인했을 때 남의 상한이 그대로 살아난다(오염). 메모리에만 둔다.

/** 계정별 상한 스냅샷 */
export interface AccountLimits {
  /**
   * 동시배팅 최대 개수.
   * - null  = 서버 상한 미주입(테스트/오프라인/구서버) → clamp는 no-op(기존 동작 100% 유지)
   * - 0     = 무제한(관리자가 제한 풀기)
   * - 1~50  = 사용자는 1~N만 선택 가능
   */
  maxConcurrentBets: number | null
}

/** 서버/DB CHECK/관리페이지 input max와 동일한 최대치 */
const MAX_CONCURRENT_BETS_CAP = 50

const DEFAULTS: AccountLimits = {
  maxConcurrentBets: null,
}

class AccountLimitsServiceImpl {
  private values: AccountLimits = { ...DEFAULTS }
  private listeners: Array<(v: AccountLimits) => void> = []

  /** 숫자가 아니면 null(미주입), 숫자면 정수화 후 0~50 클램프 */
  private coerce(v: unknown): number | null {
    const n = typeof v === 'number' ? v : Number(v)
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null
    return Math.min(MAX_CONCURRENT_BETS_CAP, Math.max(0, Math.trunc(n)))
  }

  get(): AccountLimits {
    return { ...this.values }
  }

  getMaxConcurrentBets(): number | null {
    return this.values.maxConcurrentBets
  }

  set(partial: Partial<AccountLimits>): void {
    const next: AccountLimits = {
      maxConcurrentBets: partial.maxConcurrentBets !== undefined
        ? this.coerce(partial.maxConcurrentBets)
        : this.values.maxConcurrentBets,
    }
    // 실제로 바뀔 때만 emit (10초 세션 검증이 같은 값을 계속 밀어넣는다)
    if (next.maxConcurrentBets === this.values.maxConcurrentBets) return
    this.values = next
    this.emit()
  }

  /** 로그아웃/세션 만료 시 호출 — 다음 계정에 이전 계정 상한이 새지 않게 */
  reset(): void {
    this.set({ maxConcurrentBets: DEFAULTS.maxConcurrentBets })
  }

  /**
   * 공용 clamp — UI(설정 다이얼로그)와 서비스(AutoModeService)가 같은 규칙을 쓰도록 여기 한 곳에만 둔다.
   * - 미주입(null)·무제한(0) → 기존 동작 그대로(음수만 0으로)
   * - 상한 계정(1~50) → 0(무제한)은 cap으로 정규화, 나머지는 1~cap으로 조인다
   */
  clampConcurrentBets(n: number): number {
    const cap = this.values.maxConcurrentBets
    // ⚠️ 문자열 숫자("20" 등 손상된/구버전 localStorage 값)를 먼저 살린다. Number.isFinite("20")은
    //    false라 그냥 0으로 떨어뜨리면 0=무제한이 되어 "더 많이 배팅하는" 위험한 쪽으로 실패한다.
    const raw = typeof n === 'number' ? n : Number(n)
    const v = Number.isFinite(raw) ? Math.trunc(raw) : 0
    if (cap === null || cap === 0) return Math.max(0, v)
    return v <= 0 ? cap : Math.min(Math.max(1, v), cap)
  }

  onChange(cb: (v: AccountLimits) => void): () => void {
    this.listeners.push(cb)
    return () => { this.listeners = this.listeners.filter(l => l !== cb) }
  }

  private emit(): void {
    const snap = this.get()
    // 리스너 하나가 던져도 나머지가 호출되게(그리고 호출자에게 전파되지 않게) — CallbackManager와 같은 규칙.
    // set()은 로그인 성공 경로 한복판에서 불리므로, 여기서 예외가 새면 로그인이 통째로 실패한다.
    this.listeners.forEach(l => {
      try { l(snap) } catch (e) { console.error('[AccountLimits] listener error:', e) }
    })
  }
}

const AccountLimitsService = new AccountLimitsServiceImpl()
export default AccountLimitsService
export { AccountLimitsService }
