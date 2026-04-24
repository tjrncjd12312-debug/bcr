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
