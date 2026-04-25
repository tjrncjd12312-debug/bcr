// ErrorContext - Global error handling and toast notifications
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import type { AppError, AppErrorCode, ErrorSeverity } from '../../domain/entities'
import { createAppError } from '../../domain/entities'

// Toast message type
export interface Toast {
  id: number
  message: string
  severity: ErrorSeverity
  duration?: number
}

// Context type
interface ErrorContextValue {
  // Errors
  errors: AppError[]
  addError: (error: AppError) => void
  clearError: (code: string) => void
  clearAllErrors: () => void

  // Toasts
  toasts: Toast[]
  showToast: (message: string, severity?: ErrorSeverity, duration?: number) => void
  hideToast: (id: number) => void

  // Convenience methods
  showError: (code: AppErrorCode, message: string, details?: string) => void
  showWarning: (message: string) => void
  showInfo: (message: string) => void
  showSuccess: (message: string) => void
  showDanger: (message: string) => void
}

const ErrorContext = createContext<ErrorContextValue | null>(null)

// Toast ID counter
let toastIdCounter = 0

// 🧹 Lane F3 (perf-plan): cap toast queue to avoid unbounded growth under
// bursty error scenarios. When the queue is full the oldest toast is evicted
// and any associated auto-hide timer is cleared.
const MAX_TOAST_QUEUE = 20

// Provider component
interface ErrorProviderProps {
  children: ReactNode
}

export function ErrorProvider({ children }: ErrorProviderProps): JSX.Element {
  const [errors, setErrors] = useState<AppError[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach(timer => clearTimeout(timer))
      toastTimersRef.current.clear()
    }
  }, [])

  // Error management
  const addError = useCallback((error: AppError) => {
    setErrors((prev) => {
      // Prevent duplicate errors
      if (prev.some((e) => e.code === error.code)) {
        return prev
      }
      return [...prev, error]
    })
  }, [])

  const clearError = useCallback((code: string) => {
    setErrors((prev) => prev.filter((e) => e.code !== code))
  }, [])

  const clearAllErrors = useCallback(() => {
    setErrors([])
  }, [])

  // Toast management
  const showToast = useCallback(
    (message: string, severity: ErrorSeverity = 'info', duration = 3000) => {
      const id = ++toastIdCounter
      const toast: Toast = { id, message, severity, duration }

      setToasts((prev) => {
        if (prev.length < MAX_TOAST_QUEUE) {
          return [...prev, toast]
        }
        // Evict oldest toast (FIFO) and clear its timer if any. Lane F3.
        const oldest = prev[0]
        if (oldest) {
          const oldTimer = toastTimersRef.current.get(oldest.id)
          if (oldTimer) {
            clearTimeout(oldTimer)
            toastTimersRef.current.delete(oldest.id)
          }
        }
        return [...prev.slice(1), toast]
      })

      // Auto-hide toast with cleanup tracking
      if (duration > 0) {
        const timer = setTimeout(() => {
          toastTimersRef.current.delete(id)
          setToasts((prev) => prev.filter((t) => t.id !== id))
        }, duration)
        toastTimersRef.current.set(id, timer)
      }
    },
    []
  )

  const hideToast = useCallback((id: number) => {
    // Clear the auto-hide timer if manually hidden
    const timer = toastTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      toastTimersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // Convenience methods
  const showError = useCallback(
    (code: AppErrorCode, message: string, details?: string) => {
      const error = createAppError(code, message, { details, severity: 'error' })
      addError(error)
      showToast(message, 'error', 5000)
    },
    [addError, showToast]
  )

  const showWarning = useCallback(
    (message: string) => {
      showToast(message, 'warning', 4000)
    },
    [showToast]
  )

  const showInfo = useCallback(
    (message: string) => {
      showToast(message, 'info', 3000)
    },
    [showToast]
  )

  const showSuccess = useCallback(
    (message: string) => {
      showToast(message, 'success', 3000)
    },
    [showToast]
  )

  const showDanger = useCallback(
    (message: string) => {
      // High-alert with shake animation, longer duration
      showToast(message, 'danger', 5000)
    },
    [showToast]
  )

  const value = useMemo<ErrorContextValue>(
    () => ({
      errors,
      addError,
      clearError,
      clearAllErrors,
      toasts,
      showToast,
      hideToast,
      showError,
      showWarning,
      showInfo,
      showSuccess,
      showDanger,
    }),
    [
      errors,
      addError,
      clearError,
      clearAllErrors,
      toasts,
      showToast,
      hideToast,
      showError,
      showWarning,
      showInfo,
      showSuccess,
      showDanger,
    ]
  )

  return <ErrorContext.Provider value={value}>{children}</ErrorContext.Provider>
}

// Hook to use error context
export function useError(): ErrorContextValue {
  const context = useContext(ErrorContext)
  if (!context) {
    throw new Error('useError must be used within an ErrorProvider')
  }
  return context
}

// Export context for testing
export { ErrorContext }
