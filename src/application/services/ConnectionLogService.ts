// ConnectionLogService — 연결 끊김·재접속 같은 "왜 끊겼는지"를 화면 히스토리로 보내는 작은 게시판.
//   useCasino(연결 훅)가 쓰고 AutoModePanel(히스토리 사이드바)이 읽는다. 둘은 같은 트리에 있지만
//   훅 → 패널로 props를 타고 내려갈 길이 없어 싱글턴 pub/sub로 잇는다(2026-09-06, 사용자: "자동배팅 중에도 팅긴다").
//   늦게 구독해도 최근 항목을 다시 받도록 링 버퍼를 둔다.
export type ConnectionLogLevel = 'info' | 'warn' | 'error'

export interface ConnectionLogEntry {
  level: ConnectionLogLevel
  message: string
  timestamp: number
}

type Listener = (entry: ConnectionLogEntry) => void

const MAX_BUFFER = 50

class ConnectionLogServiceImpl {
  private listeners = new Set<Listener>()
  private buffer: ConnectionLogEntry[] = []

  log(level: ConnectionLogLevel, message: string): void {
    const entry: ConnectionLogEntry = { level, message, timestamp: Date.now() }
    this.buffer.push(entry)
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift()
    this.listeners.forEach((cb) => {
      try { cb(entry) } catch (e) { console.warn('[ConnectionLog] listener failed:', e) }
    })
  }

  /** 구독. `replay`면 버퍼에 남은 항목을 먼저 흘려준다(패널이 늦게 마운트돼도 끊김 사유가 보이게). */
  subscribe(cb: Listener, options?: { replay?: boolean }): () => void {
    this.listeners.add(cb)
    if (options?.replay) this.buffer.forEach((e) => cb(e))
    return () => { this.listeners.delete(cb) }
  }

  recent(): ConnectionLogEntry[] { return [...this.buffer] }

  /** 테스트용 */
  reset(): void { this.listeners.clear(); this.buffer = [] }
}

/** Rust `evolution_multi_disconnected`의 reason 문자열을 사람이 읽을 문장으로. 원문은 괄호에 남긴다. */
export function describeDisconnectReason(reason: string | undefined): string {
  const raw = (reason || '').trim()
  const lower = raw.toLowerCase()
  if (lower.startsWith('kickout:')) {
    const detail = raw.slice('kickout:'.length)
    const d = detail.toLowerCase()
    if (d.includes('inactivity')) return `에볼루션이 비활성(배팅 없음)으로 세션을 끊었습니다 (${detail})`
    if (d.includes('newconnection') || d.includes('connectionalreadyexists') || d.includes('logoutbyplayer')) {
      return `같은 계정의 다른 접속이 감지되어 끊겼습니다 (${detail})`
    }
    if (d.includes('notauthorised') || d.includes('notauthorized')) return `세션 인증이 만료되어 끊겼습니다 (${detail})`
    return `에볼루션 서버가 세션을 끊었습니다 (${detail})`
  }
  if (lower.includes('connectionalreadyexists') || lower.includes('newconnection')) {
    return `같은 계정의 다른 접속이 감지되어 끊겼습니다 (${raw})`
  }
  if (lower.startsWith('receive_timeout')) return `게임 데이터 수신이 멈춰 끊김으로 판단했습니다 (${raw})`
  if (lower.startsWith('network_error')) return `네트워크 오류로 끊겼습니다 (${raw})`
  if (lower.startsWith('crypto_mismatch')) return `암호화 방식이 바뀌어 연결할 수 없습니다 (${raw})`
  if (lower === 'server_closed') return '에볼루션 서버가 연결을 닫았습니다'
  if (!raw) return '연결이 끊겼습니다 (사유 없음)'
  return `연결이 끊겼습니다 (${raw})`
}

export const ConnectionLogService = new ConnectionLogServiceImpl()
export default ConnectionLogService
