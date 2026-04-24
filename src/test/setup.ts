// Vitest setup file
import '@testing-library/jest-dom'
import { vi, beforeEach } from 'vitest'

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
