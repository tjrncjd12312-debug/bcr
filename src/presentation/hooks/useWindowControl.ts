// useWindowControl Hook - Window management
// Clean Architecture: Presentation -> Application (via DI container)

import { useCallback } from 'react'
import { useService } from '../context'

export interface UseWindowControlResult {
  setSemiAutoMode: () => Promise<void>
  setNormalMode: () => Promise<void>
  setFocusedMode: () => Promise<void>
}

export function useWindowControl(): UseWindowControlResult {
  // Type is inferred from ServiceRegistry['windowPort'] -> IWindowPort
  const windowPort = useService('windowPort')

  const setSemiAutoMode = useCallback(async () => {
    try {
      await windowPort.setSemiAutoMode()
    } catch (error) {
      console.error('[useWindowControl] Failed to set semi-auto mode:', error)
    }
  }, [windowPort])

  const setNormalMode = useCallback(async () => {
    try {
      await windowPort.setNormalMode()
    } catch (error) {
      console.error('[useWindowControl] Failed to set normal mode:', error)
    }
  }, [windowPort])

  const setFocusedMode = useCallback(async () => {
    try {
      await windowPort.setFocusedMode()
    } catch (error) {
      console.error('[useWindowControl] Failed to set focused mode:', error)
    }
  }, [windowPort])

  return {
    setSemiAutoMode,
    setNormalMode,
    setFocusedMode,
  }
}

export default useWindowControl
