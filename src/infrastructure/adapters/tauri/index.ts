// Tauri Adapters - Infrastructure implementations
// Each adapter implements a single interface (ISP)
// Clean Architecture: Infrastructure Layer

// Auth & Session
export { TauriAuthAdapter } from './TauriAuthAdapter'
export {
  TauriSessionMonitorAdapter,
  type SessionValidEvent,
  type SessionWarningEvent,
  type SessionExpiredEvent,
  type SessionErrorEvent,
  type ForceQuitEvent,
  type SessionValidationResult,
  type StartMonitoringResult,
  type SessionEvent,
} from './TauriSessionMonitorAdapter'

// Connection
export {
  TauriConnectionAdapter,
  type MultiSocketParams,
} from './TauriConnectionAdapter'

// Prediction
export { TauriPredictionAdapter } from './TauriPredictionAdapter'

// Chrome/CDP
export { TauriCdpAdapter } from './TauriCdpAdapter'

// Window
export { TauriWindowAdapter, WINDOW_SIZES } from './TauriWindowAdapter'
