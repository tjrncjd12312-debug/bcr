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

export type ConnectionStatus = 'idle' | 'launching' | 'monitoring' | 'captured' | 'connected' | 'error'
export type CasinoProvider = 'evolution' | 'pragmatic' | null

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

    pendingRoomUpdatesRef.current.clear()

    // 완전히 새로운 Map 생성 (모든 방을 새 객체로)
    const updatedRooms = new Map<string, Room>()
    roomsRef.current.forEach((room, id) => {
      // 모든 방을 새 객체 + 새 history 배열로 복사
      updatedRooms.set(id, {
        ...room,
        history: [...room.history]
      })
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
      // 🎯 로비소켓: 첫 방 데이터 수신 시 roomsReady = true
      // (멀티소켓은 evolution_multi_rooms_ready 이벤트로 별도 처리)
      if (updatedRooms.length > 0 && appModeRef.current === 'predict') {
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

          // 🔥 로비 소켓은 무시 - 멀티소켓만 사용
          if (wsUrl.includes('/public/lobby/socket')) {
            console.log('[useCasino] ⏭️ Skipping lobby socket - using multi-socket only')
            return
          }

          // 🎰 멀티위젯 소켓은 Rust CDP에서 자동 연결하므로 여기서는 건너뜀
          // Rust가 브라우저 WS를 먼저 닫고 연결해야 중복 접속 오류가 발생하지 않음
          const isMultiwidget = event.payload.isMultiwidget || wsUrl.includes('/multiwidget/') || wsUrl.includes('/multiplay/')
          if (isMultiwidget) {
            console.log('[useCasino] 🎰 Multiwidget detected - letting Rust CDP handle auto-connection')
            // 🔒 잠금되지 않은 경우에만 baseUrl 설정 (중계사이트 URL 우선)
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
      setRoomsReady(false)  // 연결 시 roomsReady 초기화 (구독 완료 대기)
      // Keep CDP running so real multiwidget socket can still be captured later
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
        setStatus('idle')
        setProvider(null)
        setEvolutionBaseUrl(null)
        evolutionBaseUrlRef.current = null
        evolutionBaseUrlLockedRef.current = false // 🔓 잠금 해제 - 다음 연결시 새 URL 캡처 가능
        setRoomsReady(false)  // 연결 종료 시 roomsReady 초기화

        const reason = event.payload?.reason || ''
        const msgType = event.payload?.type || ''

        // Check if this is a kickout due to session conflict
        const isKickout = reason.includes('kickout') ||
          reason.includes('newConnection') ||
          reason.includes('connectionAlreadyExists') ||
          msgType.includes('kickout') ||
          msgType.includes('connectionAlreadyExists')

        if (isKickout) {
          // Session conflict - do NOT auto-reconnect
          console.warn('[useCasino] ⚠️ Disconnected due to session conflict:', reason)
          showWarning('세션 충돌로 연결이 종료되었습니다. 브라우저를 새로고침 후 다시 시도하세요.')
          return
        }

        // predict 모드(멀티룸 로비)에서만 자동 재연결, auto 모드에서는 세션 충돌 방지를 위해 재연결 안함
        if (appModeRef.current === 'predict') {
          console.log('[useCasino] 🔄 Multiwidget disconnected in predict mode, restarting CDP monitoring in 3s...')
          setTimeout(() => {
            invoke('restart_cdp_monitoring').catch((e) => {
              console.warn('[useCasino] Failed to restart CDP monitoring:', e)
            })
          }, 3000)
        } else {
          // Auto 모드 - 자동 재연결하지 않음 (세션 충돌 방지)
          console.log('[useCasino] 📊 Multiwidget disconnected in auto mode:', reason)
          showWarning('멀티소켓 연결이 끊어졌습니다.')
        }
      },
      'evolution')

    trackedListen('evolution_multi_error', (event) => {
      setStatus('error')
      showError('CONNECTION_FAILED', 'Evolution 소켓 오류', (event as any)?.payload?.error || '연결 오류')
    }, 'evolution')

    // CDP에서 테이블 설정 캡처 (CLIENT_UNAVAILABLE_CHIPS_HIDDEN, CLIENT_BET_CHIP)
    trackedListen<Record<string, unknown>>('evolution-table-config', (event) => {
      EvolutionAdapter.updateTableConfigFromCDP(event.payload)
    }, 'evolution')

    // 🔥 멀티소켓: 모든 게임 데이터의 단일 소스
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
              // Pragmatic 룸을 rooms Map에 병합 (prefix로 구분)
              const normalizedRooms = pragmaticEvent.data
              normalizedRooms.forEach((nr) => {
                const roomId = `${PRAGMATIC_ROOM_PREFIX}${nr.id}`
                const roadHistory: RoadResult[] = nr.history.map((h) => ({
                  winner: normalizeWinner(h.winner),
                  isPlayerPair: Boolean(h.is_player_pair),
                  isBankerPair: Boolean(h.is_banker_pair),
                }))

                // 이름 우선순위: 캐시 → nr.name (단, "Baccarat XXX" 패턴은 fallback으로 간주)
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

              // 🎲 Pragmatic: gameResult 콜백 호출 (예측 결과 처리용)
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

              // 🎲 Pragmatic: 결과 후 베팅 페이즈 시작 (타이머 이벤트가 없으므로)
              // Pragmatic은 결과 수신 직후 다음 베팅 페이즈가 시작됨
              const PRAGMATIC_BETTING_SECONDS = 15
              const syntheticBettingEvent: BettingPhaseEvent = {
                roomId,
                remainingSeconds: PRAGMATIC_BETTING_SECONDS,
                phase: 'start',
              }

              // 등록된 모든 bettingPhase 콜백 호출 (예측 트리거)
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
              // Pragmatic 잔액은 별도 관리 (필요시)
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
      // Pragmatic만 끊어져도 Evolution이 있으면 connected 유지
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
      showWarning('멀티테이블 WebSocket URL이 없습니다. 브라우저에서 캡처를 기다리세요.')
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
        showInfo('브라우저에서 WebSocket을 감지하면 자동으로 연결됩니다.')
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
  // 브라우저 새로고침 후 새 세션을 캡처하여 다시 연결
  const reconnectLobby = useCallback(async () => {
    console.log('[useCasino] 🔄 Reconnecting via page refresh...')
    setStatus('launching')
    showInfo('브라우저 새로고침 중... 새 세션을 캡처합니다.')

    // Reset connection state
    evolutionBaseUrlLockedRef.current = false
    evolutionBaseUrlRef.current = null
    setEvolutionBaseUrl(null)

    try {
      const refreshed = await invoke<boolean>('refresh_lobby_page')
      if (refreshed) {
        console.log('[useCasino] 🔄 Page refresh sent - waiting for new session capture')
        // CDP will capture new WebSocket and emit 'evolution-multiwidget-auto-connected'
      } else {
        throw new Error('로비 페이지를 찾을 수 없습니다')
      }
    } catch (error: any) {
      console.error('[useCasino] 🔄 Reconnect failed:', error)
      setStatus('idle')
      setProvider(null)
      showWarning(error?.message || '재연결 실패. 브라우저에서 수동으로 새로고침해주세요.')
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
        `${details} / CDP 브라우저 세션이 끊겼습니다. 카지노 창을 다시 열어 새 세션을 캡처하세요.`
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

    // Pragmatic 이벤트를 위해 ref에도 등록 (둘 다 동시에 동작)
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
