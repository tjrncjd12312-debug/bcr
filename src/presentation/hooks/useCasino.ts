// useCasino Hook - Generalized hook for Casino WebSocket integration (Evolution & Pragmatic)
// Clean Architecture: Presentation -> Application (via DI container)

import { useState, useEffect, useCallback, useRef } from 'react'
import { listen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import type { Room, GameResultEvent, BettingPhaseEvent, AppMode, Winner, RoadResult } from '../../domain/entities'
import type { ICasinoAdapter } from '../../domain/interfaces'
import { wsToHttpBaseUrl } from '../../domain/utils/converters'
import { useService } from '../context'
import { useError } from '../context'
import { EvolutionAdapter } from '../../infrastructure/adapters/EvolutionAdapter'
import { AutoBettingService } from '../../application/services/AutoBettingService'
import MultiRoomPredictionService from '../../application/services/MultiRoomPredictionService'

// ==================== Pragmatic Types ====================
interface NormalizedPragmaticRoom {
  id: string
  name: string
  history: { winner: Winner; is_player_pair?: boolean; is_banker_pair?: boolean }[]
  status: string
}

interface NormalizedPragmaticGameResult {
  room_id: string
  winner: Winner
  player_score?: number | null
  banker_score?: number | null
  is_player_pair?: boolean
  is_banker_pair?: boolean
  table_name?: string | null
  table_type?: string | null
}

interface NormalizedPragmaticBettingPhase {
  room_id: string
  remaining_seconds: number
}

type PragmaticCasinoEvent =
  | { type: 'room_update'; data: NormalizedPragmaticRoom[] }
  | { type: 'game_result'; data: NormalizedPragmaticGameResult }
  | { type: 'betting_phase'; data: NormalizedPragmaticBettingPhase }
  | { type: 'balance_update'; data: { balance: number; currency: string } }

const PRAGMATIC_ROOM_PREFIX = 'pragmatic:'

/** Pragmatic tableId → 한국어 이름 캐시 (게임 결과 등에서 수집) */
const pragmaticTableNameCache = new Map<string, string>()

// 🧹 Lane F3 (perf-plan): bound pragmaticTableNameCache with a tiny LRU so it
// doesn't grow without limit as the user navigates casino lobbies. Map
// preserves insertion order, so we treat that as recency and re-insert on
// read/write.
const PRAGMATIC_TABLE_NAME_CACHE_CAP = 500
function cacheSet(id: string, name: string): void {
  if (
    pragmaticTableNameCache.size >= PRAGMATIC_TABLE_NAME_CACHE_CAP &&
    !pragmaticTableNameCache.has(id)
  ) {
    const firstKey = pragmaticTableNameCache.keys().next().value
    if (firstKey !== undefined) {
      pragmaticTableNameCache.delete(firstKey)
    }
  }
  pragmaticTableNameCache.delete(id) // re-insert for recency
  pragmaticTableNameCache.set(id, name)
}
function cacheGet(id: string): string | undefined {
  const v = pragmaticTableNameCache.get(id)
  if (v !== undefined) {
    pragmaticTableNameCache.delete(id)
    pragmaticTableNameCache.set(id, v)
  }
  return v
}

/** Winner 값 정규화 */
function normalizeWinner(value: string): Winner {
  const upper = (value || '').toUpperCase()
  if (upper.startsWith('B')) return 'B'
  if (upper.startsWith('P')) return 'P'
  if (upper.startsWith('T')) return 'T'
  return 'T'
}

export type ConnectionStatus = 'idle' | 'launching' | 'monitoring' | 'captured' | 'connected' | 'reconnecting' | 'error'
export type CasinoProvider = 'evolution' | 'pragmatic' | null

export type EvolutionDisconnectKind =
  | 'upgrade_forbidden'
  | 'session_expired'
  | 'intentional'
  | 'reconnect_exhausted'
  | 'network'

export function classifyEvolutionDisconnect(payload?: { reason?: string; type?: string }): EvolutionDisconnectKind {
  const reason = payload?.reason || ''
  const messageType = payload?.type || ''
  const combined = `${reason} ${messageType}`.toLowerCase()

  if (combined.includes('upgrade_forbidden_401') || combined.includes('upgrade_forbidden_403')) {
    return 'upgrade_forbidden'
  }
  if (combined.includes('user_requested')) {
    return 'intentional'
  }
  if (
    combined.includes('kickout') ||
    combined.includes('newconnection') ||
    combined.includes('connectionalreadyexists')
  ) {
    return 'session_expired'
  }
  if (combined.includes('max reconnect attempts')) {
    return 'reconnect_exhausted'
  }
  return 'network'
}

export interface SessionRotationScheduler {
  start: () => void
  stop: () => void
  isRunning: () => boolean
}

export function createSessionRotationScheduler(
  rotate: () => Promise<unknown>,
  options: {
    firstDelayMs?: number
    nextDelayMs?: number
    shouldDefer?: () => boolean
    deferDelayMs?: number
    onError?: (error: unknown) => void
  } = {},
): SessionRotationScheduler {
  const firstDelayMs = options.firstDelayMs ?? 300_000
  const nextDelayMs = options.nextDelayMs ?? 420_000
  const deferDelayMs = options.deferDelayMs ?? 12_000
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true
  let inFlight = false

  const schedule = (delayMs: number) => {
    if (stopped || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void run()
    }, delayMs)
  }

  const run = async () => {
    if (stopped || inFlight) return
    if (options.shouldDefer?.()) {
      schedule(deferDelayMs)
      return
    }
    inFlight = true
    try {
      await rotate()
    } catch (error) {
      options.onError?.(error)
    } finally {
      inFlight = false
      schedule(nextDelayMs)
    }
  }

  return {
    start: () => {
      if (!stopped) return
      stopped = false
      schedule(firstDelayMs)
    },
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
    isRunning: () => !stopped,
  }
}

interface MultiSocketConfig {
  wsUrl: string
  origin?: string
  cookie?: string
  userAgent?: string
  referer?: string
}

export interface UseCasinoResult {
  status: ConnectionStatus
  messageCount: number
  provider: CasinoProvider
  rooms: Map<string, Room>
  roomDataVersion: number  // 방 데이터 업데이트 시마다 증가 (실시간 패턴 업데이트 트리거용)
  roomsReady: boolean  // 멀티소켓 방 구독 완료 여부 (AutoMode에서 사용)
  selectedRoom: Room | null
  shoeChanges: Map<string, number>
  evolutionBaseUrl: string | null
  supportsRealBetting: boolean
  realBalance: number | null
  openCasino: (url: string) => Promise<void>
  reconnectLobby: () => Promise<void>
  casinoUrl: string
  selectRoom: (roomId: string) => void
  disconnect: () => Promise<void>
  enterRoom: (roomId: string) => Promise<void>
  placeBet: (roomId: string, betType: string, amount: number) => Promise<void>
  sendEvolutionMessage: (payload: string) => Promise<void>
  onGameResult: (callback: (event: GameResultEvent) => void) => () => void
  onBettingPhase: (callback: (event: BettingPhaseEvent) => void) => () => void
}

export function useCasino(initialCasinoUrl?: string, appMode: AppMode = 'auto'): UseCasinoResult {
  const evolutionAdapter = useService('casinoAdapter') as ICasinoAdapter

  const [activeAdapter, setActiveAdapter] = useState<ICasinoAdapter>(evolutionAdapter)
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const messageCountRef = useRef(0)
  const [messageCount, setMessageCount] = useState(0)
  const lastMessageCountUpdateRef = useRef(0)
  const MESSAGE_COUNT_UPDATE_INTERVAL = 200

  const [provider, setProvider] = useState<CasinoProvider>(null)
  const [rooms, setRooms] = useState<Map<string, Room>>(new Map())
  const [roomDataVersion, setRoomDataVersion] = useState(0)  // 방 데이터 업데이트 시마다 증가
  const [roomsReady, setRoomsReady] = useState(false)  // 멀티소켓 방 구독 완료 여부
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null)
  const [shoeChanges, setShoeChanges] = useState<Map<string, number>>(new Map())
  const [evolutionBaseUrl, setEvolutionBaseUrl] = useState<string | null>(null)
  const [realBalance, setRealBalance] = useState<number | null>(null)
  const [casinoUrl, setCasinoUrl] = useState<string>(() => {
    if (initialCasinoUrl && initialCasinoUrl.trim().length > 0) {
      return initialCasinoUrl.trim()
    }
    return localStorage.getItem('evoCasinoUrl') || ''
  })
  const [multiConfig, setMultiConfig] = useState<MultiSocketConfig>(() => {
    const stored = localStorage.getItem('evoMultiSocketConfig')
    if (stored) {
      try {
        return JSON.parse(stored)
      } catch {
        return { wsUrl: '' }
      }
    }
    return { wsUrl: '' }
  })
  const { showError, showWarning, showInfo } = useError()

  const roomsRef = useRef<Map<string, Room>>(new Map())
  const evolutionBaseUrlRef = useRef<string | null>(null)
  // 🔒 중계사이트 URL이 캡처되면 잠금 - 이후 덮어쓰기 방지
  const evolutionBaseUrlLockedRef = useRef<boolean>(false)
  const sessionRotationSchedulerRef = useRef<SessionRotationScheduler | null>(null)

  const pendingRoomUpdatesRef = useRef<Set<string>>(new Set())
  const roomUpdateRafIdRef = useRef<number | null>(null)
  const roomUpdateTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedRoomHistoryLengthRef = useRef<number>(0)
  const selectedRoomLastResultTimeRef = useRef<number>(0)
  const selectedRoomIdRef = useRef<string | null>(null)
  const cdpStoppedRef = useRef(false)
  const appModeRef = useRef<AppMode>(appMode)

  // Pragmatic 이벤트를 위한 콜백 저장소 (Evolution과 동시에 동작)
  const bettingPhaseCallbacksRef = useRef<Set<(event: BettingPhaseEvent) => void>>(new Set())
  const gameResultCallbacksRef = useRef<Set<(event: GameResultEvent) => void>>(new Set())

  // F2: Synchronous listener tracking with group tagging.
  // Replaces the legacy `listeners: Promise<UnlistenFn>[]` cleanup pattern that
  // race-leaked unlisten fns when the effect unmounted before the listen()
  // promise resolved, and kept adapter-specific listeners alive during swaps.
  type ListenerGroup = 'global' | 'evolution' | 'pragmatic'
  const listenersRef = useRef<Array<{ group: ListenerGroup; unlisten: UnlistenFn }>>([])
  // Track pending listen() promises so unmount can wait/cancel before they resolve.
  const pendingListenRegistrationsRef = useRef<Set<Promise<void>>>(new Set())
  const listenersMountedRef = useRef<boolean>(true)

  useEffect(() => {
    appModeRef.current = appMode
  }, [appMode])

  useEffect(() => {
    selectedRoomIdRef.current = selectedRoom?.id || null
  }, [selectedRoom?.id])

  // Auto-select first room with history when none selected
  useEffect(() => {
    if (!selectedRoom && rooms.size > 0) {
      const firstWithHistory =
        Array.from(rooms.values()).find(r => r.history.length > 0) || Array.from(rooms.values())[0]
      if (firstWithHistory) {
        setSelectedRoom(firstWithHistory)
      }
    }
  }, [rooms, selectedRoom])

  // If rooms arrive while status is not connected, flip to connected
  useEffect(() => {
    if (rooms.size > 0 && status !== 'connected') {
      setStatus('connected')
    }
  }, [rooms, status])

  const persistMultiConfig = useCallback((config: MultiSocketConfig) => {
    setMultiConfig(config)
    try {
      localStorage.setItem('evoMultiSocketConfig', JSON.stringify(config))
    } catch {
      // ignore storage errors
    }
  }, [])

  const persistCasinoUrl = useCallback((url: string) => {
    setCasinoUrl(url)
    try {
      localStorage.setItem('evoCasinoUrl', url)
    } catch {
      // ignore storage errors
    }
  }, [])

  // Initialize casinoUrl from initialCasinoUrl if provided later
  useEffect(() => {
    if (initialCasinoUrl && initialCasinoUrl.trim().length > 0 && casinoUrl !== initialCasinoUrl) {
      persistCasinoUrl(initialCasinoUrl.trim())
    }
  }, [initialCasinoUrl, casinoUrl, persistCasinoUrl])

  // 배칭 제거 - 즉시 업데이트로 실시간 반영 보장
  const flushRoomUpdates = useCallback(() => {
    if (pendingRoomUpdatesRef.current.size === 0) return

    // 이번 배치에서 실제로 변경된 방만 복제하고 나머지는 기존 참조를 유지한다.
    // 매 이벤트마다 최대 60개 방 전체 + history 배열을 통째로 복제하던 비용을 변경된 방으로
    // 변경 범위를 제한해 실시간성은 유지하면서 불필요한 재조정을 줄인다.
    // 소비자가 추후 추가되면 변경 없는 방의 재조정을 건너뛸 수 있다.
    const changedIds = pendingRoomUpdatesRef.current
    pendingRoomUpdatesRef.current = new Set<string>()

    const updatedRooms = new Map<string, Room>()
    roomsRef.current.forEach((room, id) => {
      if (changedIds.has(id)) {
        updatedRooms.set(id, { ...room, history: [...room.history] })
      } else {
        updatedRooms.set(id, room) // 변경 없는 방은 기존 참조 유지
      }
    })

    setRooms(updatedRooms)
    setRoomDataVersion(v => v + 1)

    // 🧹 Lane F3 (perf-plan): prune MultiRoomPredictionService entries for
    // rooms that are no longer active so its internal Maps don't grow
    // unbounded across reconnects/navigation.
    const activeIds = new Set<string>()
    updatedRooms.forEach((_, id) => activeIds.add(id))
    MultiRoomPredictionService.syncActiveRooms(activeIds)
  }, [])

  useEffect(() => {
    const adapter = activeAdapter

    const unsubRoomUpdate = adapter.onRoomUpdate((updatedRooms) => {
      updatedRooms.forEach((room) => {
        roomsRef.current.set(room.id, room)
        pendingRoomUpdatesRef.current.add(room.id)
      })
      flushRoomUpdates()
      setProvider((prev) => prev || 'evolution')
      if (status !== 'connected') {
        setStatus('connected')
        messageCountRef.current = 0
        setMessageCount(0)
      }
      // 첫 방 데이터 수신 시 roomsReady = true.
      // 구버전 multiwidget은 rooms-ready 이벤트를 보내지만 lobby v2는 그렇지 않을 수 있다.
      // widget.availableTables 파싱이 없어 그 이벤트가 안 뜬다 → 실제 방 데이터 도착으로 판정해
      // auto/predict 모두에서 대기화면이 풀리도록 한다.
      if (updatedRooms.length > 0) {
        setRoomsReady(true)
      }
    })

    const unsubGameResult = adapter.onGameResult((event) => {
      const room = roomsRef.current.get(event.roomId)
      if (room && selectedRoomIdRef.current === event.roomId) {
        const newHistoryLength = room.history.length
        const newLastResultTime = room.lastResultTime || 0
        const shouldUpdate =
          newHistoryLength !== selectedRoomHistoryLengthRef.current ||
          newLastResultTime !== selectedRoomLastResultTimeRef.current

        if (shouldUpdate) {
          selectedRoomHistoryLengthRef.current = newHistoryLength
          selectedRoomLastResultTimeRef.current = newLastResultTime
          setSelectedRoom({ ...room })
        }
      }
    })

    const unsubBettingPhase = adapter.onBettingPhase(() => { })

    // Shoe change 이벤트 구독 → UI 배지 표시용
    const unsubShoeChange = adapter.onShoeChange?.((roomId) => {
      setShoeChanges((prev) => {
        const next = new Map(prev)
        next.set(roomId, Date.now())
        return next
      })
    })

    let unsubBalance: (() => void) | undefined
    if (adapter.onBalanceUpdate) {
      unsubBalance = adapter.onBalanceUpdate((balance) => {
        setRealBalance(balance)
      })
    }

    return () => {
      unsubRoomUpdate()
      unsubGameResult()
      unsubBettingPhase()
      if (unsubShoeChange) unsubShoeChange()
      if (unsubBalance) unsubBalance()
      if (roomUpdateRafIdRef.current) {
        cancelAnimationFrame(roomUpdateRafIdRef.current)
        roomUpdateRafIdRef.current = null
      }
      if (roomUpdateTimeoutIdRef.current) {
        clearTimeout(roomUpdateTimeoutIdRef.current)
        roomUpdateTimeoutIdRef.current = null
      }
    }
  }, [activeAdapter, flushRoomUpdates])

  // Shoe change 배지 자동 만료 (10초 표시)
  useEffect(() => {
    const interval = setInterval(() => {
      setShoeChanges((prev) => {
        const now = Date.now()
        let changed = false
        const next = new Map<string, number>()
        prev.forEach((ts, roomId) => {
          if (now - ts < 10000) {
            next.set(roomId, ts)
          } else {
            changed = true
          }
        })
        return changed ? next : prev
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  // Multi-socket Evolution events (no CDP)
  useEffect(() => {
    listenersMountedRef.current = true

    // F2: Synchronous tracked listen. Pushes the unlisten fn into listenersRef
    // as soon as listen() resolves. If the effect already tore down before the
    // promise resolves, immediately invoke the unlisten so no listener leaks.
    const trackedListen = <T,>(
      event: string,
      handler: EventCallback<T>,
      group: ListenerGroup = 'global'
    ): Promise<void> => {
      const registration = listen<T>(event, handler).then(
        (unlisten) => {
          if (!listenersMountedRef.current) {
            // Effect already cleaned up before this listener registered — unlisten immediately.
            try { unlisten() } catch { /* ignore */ }
            return
          }
          listenersRef.current.push({ group, unlisten })
        },
        () => { /* ignore registration errors; no listener registered */ }
      )
      pendingListenRegistrationsRef.current.add(registration)
      registration.finally(() => {
        pendingListenRegistrationsRef.current.delete(registration)
      })
      return registration
    }

    // CDP 연결 실패 시 다시 재연결 가능하도록 idle 전환
    trackedListen<{ error: string }>('cdp-connection-failed', (event) => {
      setStatus('idle')
      messageCountRef.current = 0
      setMessageCount(0)
      showWarning('브라우저 감시에 실패했습니다: ' + (event.payload?.error || '알 수 없는 오류'))
    }, 'global')

    // Browser captures Evolution WebSocket URL -> auto-connect multi-socket
    trackedListen<{ wsUrl: string; isEvolution: boolean; isPragmatic?: boolean; cookies?: string; isLobby?: boolean; isMultiwidget?: boolean }>(
      'evolution-websocket-captured',
      async (event) => {
          if (!event.payload.isEvolution) return
          const wsUrl = event.payload.wsUrl
          if (!wsUrl) return

          // lobby v2는 multiwidget이 통합된 멀티테이블 피드다.
          // 일반 로비 소켓처럼 무시하면 안 되고 아래 multiwidget 경로로 처리한다(v2-1).
          const isLobbyV2 = wsUrl.includes('/lobby/socket/v2') || wsUrl.includes('/lobby/socket/V2')

          // 일반 로비 소켓은 무시하되 lobby v2는 예외로 처리한다.
          if (!isLobbyV2 && wsUrl.includes('/public/lobby/socket')) {
            console.log('[useCasino] ⏭️ Skipping lobby socket - using multi-socket only')
            return
          }

          // 🎰 멀티위젯 소켓은 Rust CDP에서 자동 연결하므로 여기서는 건너뜀
          // Rust가 브라우저 WS를 먼저 닫고 연결해야 중복 접속 오류가 발생하지 않음
          const isMultiwidget = event.payload.isMultiwidget || isLobbyV2 || wsUrl.includes('/multiwidget/') || wsUrl.includes('/multiplay/')
          if (isMultiwidget) {
            console.log('[useCasino] 🎰 Multiwidget detected - letting Rust CDP handle auto-connection')
            // 아직 잠기지 않은 경우에만 캡처한 base URL을 사용한다.
            if (!evolutionBaseUrlLockedRef.current) {
              const baseUrl = wsToHttpBaseUrl(wsUrl)
              if (baseUrl) {
                setEvolutionBaseUrl(baseUrl)
                evolutionBaseUrlRef.current = baseUrl
              }
            }
            setProvider('evolution')
            setActiveAdapter(evolutionAdapter)
            setStatus('monitoring') // Indicate waiting for Rust connection
            return
          }

          // Non-multiwidget Evolution socket - skip
        },
      'evolution')

    // Rust CDP detected multiwidget and is auto-connecting
    trackedListen<{ wsUrl: string; autoConnecting: boolean }>(
      'evolution-multiwidget-detected',
      (event) => {
        // 🔒 처음 연결시에만 URL 설정, 이후 덮어쓰기 방지
        if (!evolutionBaseUrlLockedRef.current) {
          const baseUrl = wsToHttpBaseUrl(event.payload.wsUrl)
          if (baseUrl) {
            setEvolutionBaseUrl(baseUrl)
            evolutionBaseUrlRef.current = baseUrl
            evolutionBaseUrlLockedRef.current = true // 🔒 잠금
          }
        }
        setProvider('evolution')
        setActiveAdapter(evolutionAdapter)
        setStatus('launching') // Rust is connecting
      },
      'evolution')

    trackedListen('evolution_multi_connected', () => {
      setStatus('connected')
      messageCountRef.current = 0
      setMessageCount(0)
      setProvider('evolution')
      // Keep the last room snapshot visible while a replacement session is captured.
      if (!sessionRotationSchedulerRef.current) {
        sessionRotationSchedulerRef.current = createSessionRotationScheduler(
          async () => {
            console.log('[useCasino] Starting atomic Evolution session rotation')
            await invoke<boolean>('rotate_evolution_session', { appMode: appModeRef.current })
          },
          {
            shouldDefer: () => AutoBettingService.getPendingBetCount() > 0,
            deferDelayMs: 12_000,
            onError: (error) => console.warn('[useCasino] Session rotation failed:', error),
          },
        )
      }
      sessionRotationSchedulerRef.current.start()
    }, 'evolution')

    // 🔒 중계사이트 base URL 캡처 이벤트 - 이 URL은 덮어쓰지 않음
    trackedListen<{ baseUrl: string; pageUrl?: string }>('evolution-base-url-captured', (event) => {
      const { baseUrl } = event.payload
      if (baseUrl) {
        setEvolutionBaseUrl(baseUrl)
        evolutionBaseUrlRef.current = baseUrl
        evolutionBaseUrlLockedRef.current = true // 🔒 잠금 - 이후 덮어쓰기 방지
      }
    }, 'evolution')

    // 🎯 멀티소켓 방 구독 완료 이벤트 - AutoMode에서 이 신호를 받아야 방 렌더링
    trackedListen<{ roomCount: number; totalAvailable: number }>('evolution_multi_rooms_ready', (event) => {
      setRoomsReady(true)
      showInfo(`${event.payload.roomCount}개 방 구독 완료`)
    }, 'evolution')

    trackedListen<{ reason?: string; type?: string }>('evolution_multi_disconnected', (event) => {
        const reason = event.payload?.reason || ''
        const disconnectKind = classifyEvolutionDisconnect(event.payload)

        if (disconnectKind === 'upgrade_forbidden') {
          console.warn('[useCasino] Rust direct socket was rejected because the browser owns the Evolution session. Keeping browser/CDP feed active.', reason)
          setProvider('evolution')
          setActiveAdapter(evolutionAdapter)
          setStatus((prev) => (prev === 'connected' ? prev : 'monitoring'))
          return
        }

        // An intentional disconnect is part of the atomic rotation handover.
        // The same command has already restarted CDP to capture the new session.
        if (disconnectKind === 'intentional') {
          console.log('[useCasino] Ignoring intentional Evolution disconnect during handover')
          return
        }

        // Only mark the UI disconnected for real disconnects. Upgrade-forbidden is expected under the one-session policy while the browser lobby remains active.
        setStatus('idle')
        setProvider(null)
        setEvolutionBaseUrl(null)
        evolutionBaseUrlRef.current = null
        evolutionBaseUrlLockedRef.current = false
        setRoomsReady(false)

        if (disconnectKind === 'session_expired') {
          sessionRotationSchedulerRef.current?.stop()
          console.warn('[useCasino] Session expired. A fresh login or lobby launch is required.', reason)
          showWarning('카지노 세션이 만료되었습니다. 다시 로그인하거나 로비를 새로 열어주세요.')
          return
        }

        if (disconnectKind === 'reconnect_exhausted') {
          sessionRotationSchedulerRef.current?.stop()
          console.error('[useCasino] ❌ All reconnect attempts exhausted:', reason)
          showWarning('재연결에 실패했습니다. 다시 로그인한 뒤 연결을 시도해주세요.')
          return
        }

        // predict 모드에서만 CDP 재시작 (Rust 자동 재연결이 실패한 후의 폴백)
        if (appModeRef.current === 'predict') {
          console.log('[useCasino] 🔄 Rust reconnect exhausted, falling back to CDP restart...')
          setTimeout(() => {
            // 새 CDP 모니터를 시작해 다음 로비 소켓을 다시 캡처한다.
            invoke('start_cdp_monitoring', { appMode: appModeRef.current })
              .catch((e) => {
                console.warn('[useCasino] Failed to (re)start CDP monitoring:', e)
            })
          }, 3000)
        } else {
          console.log('[useCasino] 📊 Multiwidget disconnected in auto mode:', reason)
          showWarning('멀티테이블 연결이 끊어졌습니다.')
        }
      },
      'evolution')

    trackedListen('evolution_multi_error', (event) => {
      const payload = (event as any)?.payload || {}
      const message = `${payload.error || ''} ${payload.errorDetail || ''}`
      if (message.includes('upgrade rejected') || message.includes('fresh EVOSESSIONID')) {
        console.log('[useCasino] Suppressing expected upgrade-forbidden error toast:', payload)
        return
      }
      setStatus('error')
      showError('CONNECTION_FAILED', 'Evolution 소켓 오류', (event as any)?.payload?.error || '연결 오류')
    }, 'evolution')

    trackedListen<{ attempt: number; maxAttempts: number; delayMs: number; reason: string }>(
      'evolution_multi_reconnect_attempt',
      (event) => {
        const { attempt, maxAttempts, delayMs } = event.payload
        setStatus('reconnecting')
        showWarning(`재연결 시도 중 (${attempt}/${maxAttempts})... ${Math.round(delayMs / 1000)}초 후 다시 시도합니다.`)
        console.log('[useCasino] 🔄 Auto-reconnect attempt:', event.payload)
      },
      'evolution'
    )

    // CDP에서 테이블 설정 캡처 (CLIENT_UNAVAILABLE_CHIPS_HIDDEN, CLIENT_BET_CHIP)
    trackedListen<Record<string, unknown>>('evolution-table-config', (event) => {
      EvolutionAdapter.updateTableConfigFromCDP(event.payload)
    }, 'evolution')

    // 멀티소켓을 모든 Evolution 게임 데이터의 단일 소스로 사용한다.
    trackedListen<{ tableId?: string; eventType: string; data: any }>('evolution_multi_event', (event) => {
      const now = Date.now()
      messageCountRef.current += 1
      if (now - lastMessageCountUpdateRef.current > MESSAGE_COUNT_UPDATE_INTERVAL) {
        lastMessageCountUpdateRef.current = now
        setMessageCount(messageCountRef.current)
      }

      if ('processMessage' in activeAdapter) {
        try {
          const raw = JSON.stringify(event.payload.data)
            ; (activeAdapter as { processMessage: (raw: string, tableId?: string) => void })
              .processMessage(raw, event.payload.tableId || undefined)
        } catch (e) {
          console.warn('[useCasino] Failed to process multi event', e)
        }
      }

      // Ensure provider/status reflect incoming data
      setProvider((prev) => prev || 'evolution')
      setStatus((prev) => (prev === 'connected' ? prev : 'connected'))
    }, 'evolution')

    // ==================== 🎲 PRAGMATIC PLAY Events ====================
    // Pragmatic raw 메시지 로깅 (디버깅용)
    trackedListen<{ pageId?: string; roomId?: string; url?: string; message: string }>('pragmatic_raw_message', (event) => {
        const payload = event.payload
        try {
          const parsed = JSON.parse(payload.message)
          // tableName이 있는 메시지에서 캐시 업데이트
          if (parsed.tableId && parsed.tableName) {
            const trimmedName = parsed.tableName?.trim()
            if (trimmedName && trimmedName !== '-' && trimmedName.toUpperCase() !== 'N/A') {
              cacheSet(parsed.tableId, trimmedName)

              // 이미 방이 존재하면 이름 업데이트
              const roomId = `${PRAGMATIC_ROOM_PREFIX}${parsed.tableId}`
              const existing = roomsRef.current.get(roomId)
              if (existing && existing.name !== trimmedName) {
                const updated = { ...existing, name: trimmedName, koreanName: trimmedName }
                roomsRef.current.set(roomId, updated)
                pendingRoomUpdatesRef.current.add(roomId)
                flushRoomUpdates()
              }
            }
          }
        } catch {
          // JSON 파싱 실패 무시
        }
      }, 'pragmatic')

    // Pragmatic 이벤트를 Evolution과 동시에 수신하여 rooms Map에 병합
    trackedListen<PragmaticCasinoEvent>('pragmatic_event', (event) => {
        const pragmaticEvent = event.payload

        try {
          switch (pragmaticEvent.type) {
            case 'room_update': {
              // Pragmatic 방을 prefix로 구분해 rooms Map에 병합한다.
              const normalizedRooms = pragmaticEvent.data
              normalizedRooms.forEach((nr) => {
                const roomId = `${PRAGMATIC_ROOM_PREFIX}${nr.id}`
                const roadHistory: RoadResult[] = nr.history.map((h) => ({
                  winner: normalizeWinner(h.winner),
                  isPlayerPair: Boolean(h.is_player_pair),
                  isBankerPair: Boolean(h.is_banker_pair),
                }))

                // 이름 우선순위: 캐시 -> nr.name. 기본 Baccarat 이름은 fallback으로 본다.
                const rawName = nr.name?.trim()
                const isFallbackName = !rawName || rawName === '-' || rawName.toUpperCase() === 'N/A' || /^Baccarat\s+\d+$/i.test(rawName)

                let displayName: string
                if (isFallbackName) {
                  // Fallback 이름이면 캐시 우선 사용
                  displayName = cacheGet(nr.id) || rawName || `Baccarat ${nr.id}`
                } else {
                  // 유효한 이름이면 캐시에 저장하고 사용
                  cacheSet(nr.id, rawName)
                  displayName = rawName
                }

                const room: Room = {
                  id: roomId,
                  name: displayName,
                  koreanName: displayName,
                  history: roadHistory,
                  gameCount: roadHistory.length,
                  lastResultTime: Date.now(),
                  provider: 'pragmatic',
                }

                roomsRef.current.set(roomId, room)
                pendingRoomUpdatesRef.current.add(roomId)
              })

              if (normalizedRooms.length > 0) {
                flushRoomUpdates()
                setStatus((prev) => (prev === 'connected' ? prev : 'connected'))
              }
              break
            }

            case 'game_result': {
              const data = pragmaticEvent.data
              const roomId = `${PRAGMATIC_ROOM_PREFIX}${data.room_id}`
              const winner = normalizeWinner(data.winner)
              const isPlayerPair = Boolean(data.is_player_pair)
              const isBankerPair = Boolean(data.is_banker_pair)

              // tableName이 있으면 캐시에 저장
              const tableName = data.table_name?.trim()
              if (tableName && tableName !== '-' && tableName.toUpperCase() !== 'N/A') {
                cacheSet(data.room_id, tableName)
              }

              // Update room history
              const existing = roomsRef.current.get(roomId)
              const history = existing?.history ?? []
              const updatedHistory: RoadResult[] = [{
                winner,
                isPlayerPair,
                isBankerPair,
              }, ...history]

              // 이름 우선순위: data.table_name → 캐시 → 기존 → 기본값
              const displayName = tableName || cacheGet(data.room_id) || existing?.name || `Baccarat ${data.room_id}`

              const room: Room = existing ? {
                ...existing,
                name: displayName,
                koreanName: displayName,
                history: updatedHistory,
                gameCount: updatedHistory.length,
                lastResultTime: Date.now(),
              } : {
                id: roomId,
                name: displayName,
                koreanName: displayName,
                history: updatedHistory,
                gameCount: updatedHistory.length,
                lastResultTime: Date.now(),
                provider: 'pragmatic',
              }

              roomsRef.current.set(roomId, room)
              pendingRoomUpdatesRef.current.add(roomId)
              flushRoomUpdates()

              // Update selected room if it's this one
              if (selectedRoomIdRef.current === roomId) {
                setSelectedRoom({ ...room })
              }

              // Pragmatic 결과를 등록된 gameResult 콜백에 전달한다.
              const gameResultEvent: GameResultEvent = {
                roomId,
                winner,
                isPlayerPair,
                isBankerPair,
                playerScore: data.player_score ?? undefined,
                bankerScore: data.banker_score ?? undefined,
              }
              // 등록된 모든 gameResult 콜백 호출
              gameResultCallbacksRef.current.forEach((callback) => {
                try {
                  callback(gameResultEvent)
                } catch (e) {
                  console.error('[useCasino] Error in Pragmatic gameResult callback:', e)
                }
              })

              // Pragmatic은 별도 타이머 이벤트가 없어 결과 직후 베팅 페이즈를 합성한다.
              // Pragmatic은 결과 수신 직후 다음 베팅 페이즈가 시작됨
              const PRAGMATIC_BETTING_SECONDS = 15
              const syntheticBettingEvent: BettingPhaseEvent = {
                roomId,
                remainingSeconds: PRAGMATIC_BETTING_SECONDS,
                phase: 'start',
              }

              // 등록된 bettingPhase 콜백을 호출해 예측을 트리거한다.
              bettingPhaseCallbacksRef.current.forEach((callback) => {
                try {
                  callback(syntheticBettingEvent)
                } catch (e) {
                  console.error('[useCasino] Error in synthetic betting phase callback:', e)
                }
              })
              break
            }

            case 'betting_phase': {
              // 베팅 페이즈 이벤트를 등록된 콜백들에 전달
              const pragmaticRoomId = `${PRAGMATIC_ROOM_PREFIX}${pragmaticEvent.data.room_id}`
              const bettingEvent: BettingPhaseEvent = {
                roomId: pragmaticRoomId,
                remainingSeconds: pragmaticEvent.data.remaining_seconds,
                phase: pragmaticEvent.data.remaining_seconds > 0 ? 'start' : 'end',
              }

              // 등록된 모든 콜백 호출
              bettingPhaseCallbacksRef.current.forEach((callback) => {
                try {
                  callback(bettingEvent)
                } catch (e) {
                  console.error('[useCasino] Error in betting phase callback:', e)
                }
              })
              break
            }

            case 'balance_update': {
              // Pragmatic 잔액은 별도 경로에서 관리한다.
              break
            }
          }
        } catch (error) {
          console.error('[useCasino] Error handling Pragmatic event:', error)
        }
      }, 'pragmatic')

    // Pragmatic 연결 상태 이벤트
    trackedListen('pragmatic_connected', () => {
      if (status !== 'connected') {
        setStatus('connected')
        messageCountRef.current = 0
        setMessageCount(0)
      }
    }, 'pragmatic')

    trackedListen('pragmatic_disconnected', () => {
      // Pragmatic만 끊겨도 Evolution 연결이 있으면 상태를 유지한다.
    }, 'pragmatic')

    return () => {
      // F2: Synchronous cleanup — no `.then()` chain, no race.
      // Mark unmounted first so any still-pending listen() registration that
      // resolves after this tick will unlisten itself immediately.
      listenersMountedRef.current = false
      const snapshot = listenersRef.current
      listenersRef.current = []
      snapshot.forEach(({ unlisten }) => {
        try { unlisten() } catch { /* ignore */ }
      })
      sessionRotationSchedulerRef.current?.stop()
      sessionRotationSchedulerRef.current = null
    }
  }, [showError])

  // F2: Adapter-swap teardown.
  // When the active adapter changes (Evolution ↔ Pragmatic), tear down any
  // listeners tagged with the *abandoned* adapter's group plus any stale
  // consumer callbacks that were registered against it. The consumer
  // `onGameResult` / `onBettingPhase` closures are memoised on `activeAdapter`,
  // so downstream effects re-subscribe automatically after the swap — clearing
  // the callback refs here prevents double-dispatch via leftover closures.
  const previousAdapterTypeRef = useRef<ICasinoAdapter['type'] | null>(null)
  useEffect(() => {
    const prevType = previousAdapterTypeRef.current
    const nextType = activeAdapter.type
    if (prevType !== null && prevType !== nextType) {
      // Adapter actually swapped — scope listener teardown to the abandoned group.
      const abandonedGroup: ListenerGroup | null =
        prevType === 'evolution' ? 'evolution'
        : prevType === 'pragmatic' ? 'pragmatic'
        : null
      if (abandonedGroup) {
        const kept: typeof listenersRef.current = []
        listenersRef.current.forEach((entry) => {
          if (entry.group === abandonedGroup) {
            try { entry.unlisten() } catch { /* ignore */ }
          } else {
            kept.push(entry)
          }
        })
        listenersRef.current = kept
      }
      // Clear consumer callback refs so stale closures from the previous adapter
      // don't double-fire. Consumers with `onGameResult` / `onBettingPhase` in
      // their effect deps will re-register because those refs are memoised on
      // `activeAdapter`.
      gameResultCallbacksRef.current.clear()
      bettingPhaseCallbacksRef.current.clear()
    }
    previousAdapterTypeRef.current = nextType
  }, [activeAdapter])

  const connectMultiSocket = useCallback(async (override?: Partial<MultiSocketConfig>) => {
    const next = { ...multiConfig, ...(override || {}) }
    const wsUrl = (next.wsUrl || '').trim()
    const origin = (next.origin || '').trim()
    const cookie = (next.cookie || '').trim()
    const userAgent = (next.userAgent || '').trim()

    if (!wsUrl) {
      showWarning('멀티테이블 WebSocket URL이 없습니다. 브라우저 캡처를 기다려주세요.')
      return
    }

    const merged: MultiSocketConfig = { ...next, wsUrl, origin, cookie, userAgent }
    if (!merged.referer && merged.origin) {
      merged.referer = `${merged.origin}/frontend/evo/r2/`
    }
    persistMultiConfig(merged)

    try {
      setStatus('launching')
      await invoke('connect_evolution_multi_socket', {
        wsUrl: merged.wsUrl,
        origin: merged.origin,
        cookie: merged.cookie,
        userAgent: merged.userAgent,
        referer: merged.referer,
      })
      setStatus('connected')
      setProvider('evolution')
      if (!cdpStoppedRef.current) {
        cdpStoppedRef.current = true
        invoke('stop_cdp_monitoring').catch(() => { })
      }
      // 🔒 처음 연결시에만 URL 설정, 이후 덮어쓰기 방지
      if (!evolutionBaseUrlLockedRef.current) {
        const baseUrl = wsToHttpBaseUrl(merged.wsUrl)
        if (baseUrl) {
          setEvolutionBaseUrl(baseUrl)
          evolutionBaseUrlRef.current = baseUrl
          evolutionBaseUrlLockedRef.current = true
        }
      }
      setActiveAdapter(evolutionAdapter)
    } catch (error) {
      setStatus('error')
      showError('CONNECTION_FAILED', 'Evolution 연결 실패', error instanceof Error ? error.message : String(error))
    }
  }, [multiConfig, persistMultiConfig, showWarning, showError, evolutionAdapter])

  const openCasino = useCallback(async (_url: string) => {
    const url = (_url || '').trim()

    // ws:// 또는 wss:// 로 시작하면 멀티테이블 소켓 연결
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      await connectMultiSocket({ wsUrl: url })
      return
    }

    // 일반 URL이면 Chrome(CDP)으로 열고 WS 캡처를 기다림
    const targetUrl = url || casinoUrl
    if (targetUrl) {
      try {
        persistCasinoUrl(targetUrl)
        setStatus('launching')
        await invoke('open_in_chrome', { url: targetUrl })
        await invoke('start_cdp_monitoring', { appMode: appModeRef.current })
        setStatus('monitoring')
        // ❌ 여기서는 잠그지 않음! 이건 중계사이트 URL
        // 실제 멀티소켓 연결 URL이 캡처될 때 잠금
        showInfo('브라우저에서 WebSocket이 감지되면 자동으로 연결됩니다.')
      } catch (error) {
        setStatus('error')
        showError('CONNECTION_FAILED', '브라우저 실행 실패', error instanceof Error ? error.message : String(error))
      }
      return
    }

    // URL이 전혀 없으면 저장된 멀티소켓 정보로 바로 연결 시도
    await connectMultiSocket()
  }, [connectMultiSocket, showError, showInfo, casinoUrl, persistCasinoUrl])

  // 로비 재연결 (세션 만료 시 사용)
  // Rust 멀티클라이언트를 먼저 해제한 뒤 새 세션을 캡처한다.
  const reconnectLobby = useCallback(async () => {
    if (AutoBettingService.getPendingBetCount() > 0) {
      showWarning('진행 중인 베팅이 있어 세션 갱신을 잠시 미룹니다.')
      return
    }

    console.log('[useCasino] 🔄 Reconnecting with an atomic session handover...')
    setStatus('launching')
    showInfo('카지노 세션을 안전하게 갱신하는 중입니다.')

    // Reset connection state
    evolutionBaseUrlLockedRef.current = false
    evolutionBaseUrlRef.current = null
    setEvolutionBaseUrl(null)

    try {
      await invoke<boolean>('rotate_evolution_session', { appMode: appModeRef.current })
      setStatus('monitoring')
    } catch (error: any) {
      console.error('[useCasino] 🔄 Reconnect failed:', error)
      setStatus('idle')
      setProvider(null)
      showWarning(error?.message || '재연결에 실패했습니다. 다시 로그인한 뒤 시도해주세요.')
    }
  }, [showInfo, showWarning])

  const selectRoom = useCallback((roomId: string) => {
    const room = roomsRef.current.get(roomId)
    if (room) {
      setSelectedRoom(room)
    }
  }, [])

  const disconnect = useCallback(async () => {
    try {
      sessionRotationSchedulerRef.current?.stop()
      await invoke('disconnect_evolution_multi_socket')
      setStatus('idle')
      messageCountRef.current = 0
      setMessageCount(0)
      setProvider(null)
      setEvolutionBaseUrl(null)
      evolutionBaseUrlRef.current = null
      evolutionBaseUrlLockedRef.current = false // 🔓 잠금 해제
      showInfo('연결이 종료되었습니다')
    } catch (error) {
      showWarning('연결 종료 중 오류가 발생했습니다')
    }
  }, [showInfo, showWarning])

  const enterRoom = useCallback(async (roomId: string) => {
    // Pragmatic 방은 별도 명령 사용 (캡처된 로비 URL 기반)
    const room = rooms.get(roomId)
    if (room?.provider === 'pragmatic') {
      try {
        await invoke('navigate_pragmatic_room', { roomId })
        showInfo('프라그마틱 방으로 이동합니다')
      } catch (error) {
        console.error('[useCasino] 🎲 Pragmatic room navigation failed:', error)
        showError('CONNECTION_FAILED', '프라그마틱 방 입장 실패', error instanceof Error ? error.message : String(error))
      }
      return
    }

    const baseUrl = evolutionBaseUrlRef.current
    if (!baseUrl) {
      showWarning('먼저 멀티테이블 소켓에 연결하세요')
      return
    }

    const launchId =
      (typeof crypto !== 'undefined' && (crypto as any).randomUUID?.()) ||
      Math.random().toString(36).slice(2).padEnd(32, '0')
    const roomUrl = `${baseUrl}/frontend/evo/r2/#category=baccarat&game=baccarat&table_id=${roomId}&lobby_launch_id=${launchId}`

    try {
      let baseHost = 'invalid'
      try {
        baseHost = new URL(baseUrl).host
      } catch {
        // Keep diagnostics safe even if a caller provided a partial URL.
      }
      console.info('[useCasino] CDP room navigation only', { roomId, baseHost })

      // CDP로 기존 탭에서 네비게이션 + 게임 WebSocket 차단
      // Rust 멀티소켓과 충돌 방지
      await invoke('navigate_to_room_with_ws_block', { url: roomUrl })
      const room = roomsRef.current.get(roomId)
      if (room) {
        setSelectedRoom(room)
      }

      // 방 입장 후 해당 테이블 재구독 요청 (서버가 구독 해제했을 수 있음)
      try {
        await invoke('resubscribe_evolution_table', { tableId: roomId })
      } catch {
        // 재구독 실패 무시 - 기존 구독이 유효할 수 있음
      }

      showInfo('브라우저에서 방으로 이동합니다')
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      console.error('[useCasino] CDP room navigation failed:', error)
      setStatus('error')
      showError(
        'CONNECTION_FAILED',
        '방 이동에 실패했습니다',
        `${details} / CDP 브라우저 세션이 끊겼습니다. 카지노 창을 다시 열어 새 세션을 캡처해주세요.`
      )
    }
  }, [rooms, provider, showWarning, showInfo, showError])

  const sendEvolutionMessage = useCallback(async (payload: string) => {
    if (!payload || !payload.trim()) {
      showWarning('전송할 메시지를 입력하세요')
      return
    }
    try {
      await invoke('send_evolution_multi_message', { message: payload })
    } catch (error) {
      showError('CONNECTION_FAILED', '메시지 전송 실패', error instanceof Error ? error.message : String(error))
    }
  }, [showWarning, showError])

  const onGameResult = useCallback((callback: (event: GameResultEvent) => void) => {
    // Evolution adapter 콜백 등록
    const unsubAdapter = activeAdapter.onGameResult(callback)

    // Pragmatic 이벤트에도 같은 콜백을 등록해 두 공급자를 함께 처리한다.
    gameResultCallbacksRef.current.add(callback)

    // 정리 함수: 둘 다 해제
    return () => {
      unsubAdapter()
      gameResultCallbacksRef.current.delete(callback)
    }
  }, [activeAdapter])

  const onBettingPhase = useCallback((callback: (event: BettingPhaseEvent) => void) => {
    // Evolution adapter 콜백 등록
    const unsubAdapter = activeAdapter.onBettingPhase(callback)

    // Pragmatic 이벤트를 위해 ref에도 등록
    bettingPhaseCallbacksRef.current.add(callback)

    // 정리 함수: 둘 다 해제
    return () => {
      unsubAdapter()
      bettingPhaseCallbacksRef.current.delete(callback)
    }
  }, [activeAdapter])

  const placeBet = useCallback(async (roomId: string, betType: string, amount: number) => {
    if (activeAdapter.placeBet) {
      await activeAdapter.placeBet(roomId, betType, amount)
    } else {
      console.warn('[useCasino] Real betting not supported by current adapter')
    }
  }, [activeAdapter])

  return {
    status,
    messageCount,
    provider,
    rooms,
    roomDataVersion,
    roomsReady,
    selectedRoom,
    shoeChanges,
    evolutionBaseUrl,
    casinoUrl,
    supportsRealBetting: activeAdapter.supportsRealBetting || false,
    realBalance,
    openCasino,
    reconnectLobby,
    selectRoom,
    disconnect,
    enterRoom,
    placeBet,
    sendEvolutionMessage,
    onGameResult,
    onBettingPhase,
  }
}

export default useCasino
