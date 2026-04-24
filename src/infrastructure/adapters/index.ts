// Legacy adapter (for backward compatibility during migration)
export { TauriAdapter } from './TauriAdapter'
export { EvolutionAdapter } from './EvolutionAdapter'
export { PragmaticAdapter } from './PragmaticAdapter'

// Clean Architecture - ISP compliant adapters
export {
  TauriAuthAdapter,
  TauriCdpAdapter,
  TauriWindowAdapter,
  WINDOW_SIZES,
} from './tauri'

// Storage adapter
export { LocalStorageAdapter } from './LocalStorageAdapter'
