// DI Context - React Context for Dependency Injection
// Provides services to React components

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { container, type ServiceRegistry, type ServiceKey } from '../../application/di'

// Context type
interface DIContextValue {
  getService: <K extends ServiceKey>(key: K) => ServiceRegistry[K]
}

// Create context
const DIContext = createContext<DIContextValue | null>(null)

// Provider component
interface DIProviderProps {
  children: ReactNode
}

export function DIProvider({ children }: DIProviderProps): JSX.Element {
  const value = useMemo<DIContextValue>(
    () => ({
      getService: <K extends ServiceKey>(key: K) => container.get(key),
    }),
    []
  )

  return <DIContext.Provider value={value}>{children}</DIContext.Provider>
}

// Hook to get a service
export function useService<K extends ServiceKey>(key: K): ServiceRegistry[K] {
  const context = useContext(DIContext)

  if (!context) {
    // Fallback to direct container access if outside provider
    // This maintains backward compatibility during migration
    return container.get(key)
  }

  return context.getService(key)
}

// Hook to get multiple services
export function useServices<K extends ServiceKey>(keys: K[]): Pick<ServiceRegistry, K> {
  const context = useContext(DIContext)

  return useMemo(() => {
    const services = {} as Pick<ServiceRegistry, K>
    keys.forEach((key) => {
      services[key] = context ? context.getService(key) : container.get(key)
    })
    return services
  }, [context, keys])
}

export { DIContext }
