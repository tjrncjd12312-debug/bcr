// Toast Component - Displays notification toasts
import { useError, type Toast as ToastType } from '../../context/ErrorContext'
import './Toast.css'

interface ToastItemProps {
  toast: ToastType
  onClose: () => void
}

function ToastItem({ toast, onClose }: ToastItemProps) {
  const getIcon = () => {
    switch (toast.severity) {
      case 'error':
        return '✕'
      case 'warning':
        return '⚠'
      case 'success':
        return '✓'
      case 'danger':
        return '!'
      case 'info':
      default:
        return 'ℹ'
    }
  }

  return (
    <div className={`toast toast--${toast.severity}`}>
      <span className="toast__icon">{getIcon()}</span>
      <span className="toast__message">{toast.message}</span>
      <button className="toast__close" onClick={onClose}>
        ×
      </button>
    </div>
  )
}

export function ToastContainer() {
  const { toasts, hideToast } = useError()

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onClose={() => hideToast(toast.id)}
        />
      ))}
    </div>
  )
}

export default ToastContainer
