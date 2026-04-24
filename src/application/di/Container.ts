// Dependency Injection Container
// Manages service instances and their dependencies
// Follows Dependency Inversion Principle (DIP)

import type {
  IAuthPort,
  ICdpPort,
  IWindowPort,
  IVirtualBettingUseCase,
  IRoomFilterUseCase,
  ICasinoAdapter,
  ISoundPort,
  IMultiRoomPredictionPort,
  ILocalStoragePort,
} from '../../domain/interfaces'

// Service registry types
export interface ServiceRegistry {
  // Infrastructure Ports (Adapters)
  authPort: IAuthPort
  cdpPort: ICdpPort
  windowPort: IWindowPort
  casinoAdapter: ICasinoAdapter
  pragmaticAdapter: ICasinoAdapter
  soundPort: ISoundPort
  multiRoomPredictionPort: IMultiRoomPredictionPort
  localStoragePort: ILocalStoragePort

  // Application Use Cases
  virtualBettingUseCase: IVirtualBettingUseCase
  roomFilterUseCase: IRoomFilterUseCase
}

export type ServiceKey = keyof ServiceRegistry

// Container implementation
class DIContainer {
  private services: Map<ServiceKey, unknown> = new Map()
  private factories: Map<ServiceKey, () => unknown> = new Map()

  /**
   * Register a service instance
   */
  register<K extends ServiceKey>(key: K, instance: ServiceRegistry[K]): void {
    this.services.set(key, instance)
  }

  /**
   * Register a factory function for lazy instantiation
   */
  registerFactory<K extends ServiceKey>(key: K, factory: () => ServiceRegistry[K]): void {
    this.factories.set(key, factory)
  }

  /**
   * Get a service instance
   */
  get<K extends ServiceKey>(key: K): ServiceRegistry[K] {
    // Check if already instantiated
    let service = this.services.get(key)
    if (service) {
      return service as ServiceRegistry[K]
    }

    // Try factory
    const factory = this.factories.get(key)
    if (factory) {
      service = factory()
      this.services.set(key, service) // Cache the instance
      return service as ServiceRegistry[K]
    }

    throw new Error(`Service not registered: ${key}`)
  }

  /**
   * Check if a service is registered
   */
  has(key: ServiceKey): boolean {
    return this.services.has(key) || this.factories.has(key)
  }

  /**
   * Clear all registered services (useful for testing)
   */
  clear(): void {
    this.services.clear()
    this.factories.clear()
  }

  /**
   * Replace a service (useful for testing with mocks)
   */
  replace<K extends ServiceKey>(key: K, instance: ServiceRegistry[K]): void {
    this.services.set(key, instance)
  }
}

// Global container instance
export const container = new DIContainer()

// Export for module augmentation
export { DIContainer }
