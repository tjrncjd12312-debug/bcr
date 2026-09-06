import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionLogService, { describeDisconnectReason } from './ConnectionLogService'

describe('ConnectionLogService', () => {
  beforeEach(() => ConnectionLogService.reset())

  it('delivers entries to subscribers and replays the buffer to late subscribers', () => {
    const early = vi.fn()
    ConnectionLogService.subscribe(early)
    ConnectionLogService.log('warn', '끊김')
    expect(early).toHaveBeenCalledTimes(1)
    expect(early.mock.calls[0][0]).toMatchObject({ level: 'warn', message: '끊김' })

    const late = vi.fn()
    ConnectionLogService.subscribe(late, { replay: true })
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0][0].message).toBe('끊김')
  })

  it('describes kickout reasons in Korean while keeping the raw reason', () => {
    expect(describeDisconnectReason('kickout:inactivity')).toContain('비활성')
    expect(describeDisconnectReason('kickout:inactivity')).toContain('inactivity')
    expect(describeDisconnectReason('kickout:connectionAlreadyExists')).toContain('다른 접속')
    expect(describeDisconnectReason('receive_timeout:bridge_no_frames_120s')).toContain('수신')
    expect(describeDisconnectReason('network_error:reset')).toContain('네트워크')
    expect(describeDisconnectReason('')).toContain('사유 없음')
  })
})
