// Container Setup - Registers all services with the DI container
// This is the composition root where we wire up all dependencies

import { container } from './Container'

// Infrastructure Adapters
import {
  TauriAuthAdapter,
  TauriCdpAdapter,
  TauriWindowAdapter,
  EvolutionAdapter,
  PragmaticAdapter,
  TauriAdapter,
  LocalStorageAdapter,
} from '../../infrastructure/adapters'

// Infrastructure Utils
import { SoundManager } from '../../infrastructure/utils/SoundManager'

// Application Services
import { VirtualBettingService } from '../services/VirtualBettingService'
import { RoomFilterService } from '../services/RoomFilterService'
import { MultiRoomPredictionService } from '../services/MultiRoomPredictionService'
import { SemiAutoService } from '../services/SemiAutoService'
import { AutoModeService } from '../services/AutoModeService'
import { MoveOnTieListener, FreshShoeTieMartingalePreset } from '../services/freshshoe'
import type { FreshShoeTieMartingalePreset as FreshShoeTieMartingalePresetType } from '../services/freshshoe'

// Module-level singleton reference for the FreshShoeTieMartingalePreset
let freshShoePresetInstance: FreshShoeTieMartingalePresetType | null = null

/**
 * Returns the FreshShoeTieMartingalePreset singleton created during setupContainer().
 * Returns null if setupContainer() has not been called yet.
 */
export function getFreshShoePreset(): FreshShoeTieMartingalePresetType | null {
  return freshShoePresetInstance
}

/**
 * Initialize the DI container with all services
 * Call this once at application startup
 */
export function setupContainer(): void {
  // Register Infrastructure Ports (Adapters)
  container.register('authPort', TauriAuthAdapter)
  container.register('cdpPort', TauriCdpAdapter)
  container.register('windowPort', TauriWindowAdapter)
  container.register('casinoAdapter', EvolutionAdapter)
  container.register('pragmaticAdapter', PragmaticAdapter)
  container.register('soundPort', SoundManager)
  container.register('multiRoomPredictionPort', TauriAdapter)
  container.register('localStoragePort', LocalStorageAdapter)

  // Register Application Use Cases
  container.register('virtualBettingUseCase', VirtualBettingService)
  container.register('roomFilterUseCase', RoomFilterService)

  console.log('[DI] Container initialized with all services')

  // ==================== Fresh-Shoe Tie Martingale Preset ====================
  // Get the casino adapter (EvolutionAdapter) — already registered above
  const casinoAdapter = container.get('casinoAdapter')

  // Build MoveOnTieListener — uses Evolution game-result events
  const moveOnTieListener = new MoveOnTieListener({
    casinoAdapter: {
      onGameResult: (cb) => {
        // GameResultEvent shape: { roomId, winner, ... }; no roundId in the domain event,
        // so roundId is always undefined here — all Tie results classify as 'organic_tie'
        // until notePendingBet is wired to the actual bet-placement path.
        return casinoAdapter.onGameResult((event) => {
          cb({
            roomId: event.roomId,
            winner: event.winner as 'B' | 'P' | 'T',
            roundId: undefined,
          })
        })
      },
    },
    getCurrentFocusedRoomId: () => SemiAutoService.getCurrentRoomId(),
    onMartinReset: (_roomId: string) => {
      // Defensive martin reset is managed internally by AutoModeService via MartingaleManager.
      // The stoppedRoomsChecker gate blocks subsequent bets in the room, so no-op is correct here.
    },
  })

  // Wire setFreshShoeGates with lazy references BEFORE constructing the preset.
  // This eliminates the window where preset auto-restore fires before gates are set.
  // The lazy closure captures presetForGates which is assigned right after construction.
  let presetForGates: FreshShoeTieMartingalePresetType | null = null
  AutoModeService.setFreshShoeGates(
    (roomId) => presetForGates?.isRoomStopped(roomId) ?? false,
    (roomId) => moveOnTieListener.signalMartinCap(roomId),
  )

  // Build FreshShoeTieMartingalePreset
  freshShoePresetInstance = new FreshShoeTieMartingalePreset({
    filterService: RoomFilterService,
    settingsBridge: {
      auto: {
        // AutoModeSettings (public type) doesn't declare forceBetDirection, but the underlying
        // settings object (from automode/types.ts AutoModeSettings) does — cast to access it.
        get: () => ({ forceBetDirection: (AutoModeService.getSettings() as unknown as Record<string, unknown>)['forceBetDirection'] as 'auto' | 'tie_only' | undefined }),
        update: (patch) => AutoModeService.updateSettings(patch as Parameters<typeof AutoModeService.updateSettings>[0]),
      },
      semiauto: {
        // SemiAutoSettings does not include forceBetDirection; use no-op bridge.
        // TODO(freshshoe-forceBetDirection): expose forceBetDirection on SemiAutoSettings
        // and wire it through SemiAutoService.updateSettings when needed.
        get: () => ({ forceBetDirection: 'auto' as const }),
        update: (_patch) => { /* no-op — SemiAutoService has no forceBetDirection setting */ },
      },
    },
    listener: moveOnTieListener,
    casinoAdapter: {
      onShoeChange: (cb) => {
        // ICasinoAdapter.onShoeChange is optional; EvolutionAdapter implements it
        const unsub = casinoAdapter.onShoeChange?.(cb)
        return unsub ?? (() => { /* no-op if adapter doesn't support onShoeChange */ })
      },
    },
    storage: {
      get: () => (typeof window !== 'undefined' && window.localStorage) ? window.localStorage.getItem('bcr-freshshoe-preset') : null,
      set: (v) => { if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem('bcr-freshshoe-preset', v) },
      remove: () => { if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem('bcr-freshshoe-preset') },
    },
    semiAutoTriggerHandler: (roomId, reason) => SemiAutoService.handlePresetTrigger(roomId, reason),
    onMartinReset: (_roomId: string) => {
      // See MoveOnTieListener.onMartinReset above for rationale — no-op is intentional.
    },
  })
  // Assign lazy reference so the gates closure can resolve the preset
  presetForGates = freshShoePresetInstance

  // TODO(freshshoe-notePendingBet): when bet-placement events are exposed by AutoBettingService,
  // call moveOnTieListener.notePendingBet(roomId, { roundId, betType }) for accurate
  // tie_hit vs organic_tie classification. Until then both classify as organic_tie, which is
  // functionally equivalent for the downstream STOPPED/navigate logic.

  // Initialize services that need event subscriptions
  // This must be called after all services are registered
  MultiRoomPredictionService.initialize()
  SemiAutoService.initialize()
  AutoModeService.initialize()

  console.log('[DI] Services initialized with event subscriptions')
}

/**
 * Setup container for testing with mock services
 */
export function setupTestContainer(mocks: Partial<Record<string, unknown>>): void {
  container.clear()

  // Register mocks
  Object.entries(mocks).forEach(([key, mock]) => {
    container.register(key as never, mock as never)
  })

  console.log('[DI] Test container initialized with mocks')
}

export { container }
