// Vitest setup file
import '@testing-library/jest-dom'
import { vi, beforeEach } from 'vitest'

// Node 25 ships its own Web Storage `localStorage` global, and without
// `--localstorage-file` it is an inert object whose methods are undefined. It
// shadows jsdom's implementation on both `globalThis` and `window`, so every
// `localStorage.getItem`/`setItem` in the app throws "is not a function".
// Install a working in-memory Storage before any test module loads — services
// (AutoModeService, RoomFilterService, ...) read localStorage at import time.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    getItem: (key: string) => {
      const value = store.get(String(key))
      return value === undefined ? null : value
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value))
    },
    removeItem: (key: string) => {
      store.delete(String(key))
    },
    clear: () => {
      store.clear()
    },
  } as unknown as Storage
}

const memoryStorage = createMemoryStorage()
for (const target of [globalThis, (globalThis as { window?: object }).window]) {
  if (!target) continue
  Object.defineProperty(target, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  })
}

// Mock Tauri API for tests
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    setSize: vi.fn(),
    center: vi.fn(),
    innerSize: vi.fn(() => ({ width: 1400, height: 800 })),
    innerPosition: vi.fn(() => ({ x: 0, y: 0 })),
    setPosition: vi.fn(),
  })),
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalSize: vi.fn((width: number, height: number) => ({ width, height })),
  PhysicalPosition: vi.fn((x: number, y: number) => ({ x, y })),
}))

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks()
})
