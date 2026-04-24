// TauriWindowAdapter - Window management adapter implementation
// Implements IWindowPort interface (Single Responsibility)
// Cross-platform compatible (macOS/Windows)

import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, LogicalPosition } from '@tauri-apps/api/dpi'
import type { IWindowPort } from '../../../domain/interfaces'

// Predefined window sizes (logical pixels - cross-platform compatible)
export const WINDOW_SIZES = {
  SEMI_AUTO: { width: 438, height: 665 },  // 반자동
  NORMAL: { width: 1400, height: 800 },    // 로비: 전체 화면
  FOCUSED: { width: 820, height: 860 },    // 포커싱: 방 입장 시 (Windows 안정감 기준)
} as const

class TauriWindowAdapterImpl implements IWindowPort {
  // 이전 윈도우 크기 저장 (복원용 - 현재 미사용, 향후 확장 가능)
  private previousSize: { width: number; height: number } | null = null

  async setSize(width: number, height: number): Promise<void> {
    const window = getCurrentWindow()
    await window.setSize(new LogicalSize(width, height))
  }

  async center(): Promise<void> {
    const window = getCurrentWindow()
    await window.center()
  }

  async getSize(): Promise<{ width: number; height: number }> {
    const window = getCurrentWindow()
    const size = await window.innerSize()
    return { width: size.width, height: size.height }
  }

  async getPosition(): Promise<{ x: number; y: number }> {
    const window = getCurrentWindow()
    const pos = await window.outerPosition()
    return { x: pos.x, y: pos.y }
  }

  async setPosition(x: number, y: number): Promise<void> {
    const window = getCurrentWindow()
    await window.setPosition(new LogicalPosition(x, y))
  }

  // 세미오토 모드: 컴팩트 UI 크기
  async setSemiAutoMode(): Promise<void> {
    try {
      console.log('[TauriWindowAdapter] Setting semi-auto mode...')
      
      // 현재 크기 저장 (향후 복원 가능)
      this.previousSize = await this.getSize()

      await this.setSize(WINDOW_SIZES.SEMI_AUTO.width, WINDOW_SIZES.SEMI_AUTO.height)

      console.log('[TauriWindowAdapter] Window resized to semi-auto mode:', WINDOW_SIZES.SEMI_AUTO)
    } catch (error) {
      console.error('[TauriWindowAdapter] Failed to set semi-auto mode:', error)
    }
  }

  // 일반 모드: 무조건 전체 화면(NORMAL) 크기로 복원 + 중앙 배치
  async setNormalMode(): Promise<void> {
    try {
      console.log('[TauriWindowAdapter] Restoring to normal mode (full screen)...')

      await this.setSize(WINDOW_SIZES.NORMAL.width, WINDOW_SIZES.NORMAL.height)
      await this.center()

      // 저장된 크기 초기화
      this.previousSize = null

      console.log('[TauriWindowAdapter] Window restored to normal mode:', WINDOW_SIZES.NORMAL)
    } catch (error) {
      console.error('[TauriWindowAdapter] Failed to set normal mode:', error)
    }
  }

  // 포커싱 모드: 컴팩트 크기 (단일 방 집중)
  async setFocusedMode(): Promise<void> {
    try {
      console.log('[TauriWindowAdapter] Setting focused mode...')
      
      // 현재 크기 저장 (향후 복원 가능)
      if (!this.previousSize) {
        this.previousSize = await this.getSize()
      }

      await this.setSize(WINDOW_SIZES.FOCUSED.width, WINDOW_SIZES.FOCUSED.height)

      console.log('[TauriWindowAdapter] Window resized to focused mode:', WINDOW_SIZES.FOCUSED)
    } catch (error) {
      console.error('[TauriWindowAdapter] Failed to set focused mode:', error)
    }
  }
}

export const TauriWindowAdapter = new TauriWindowAdapterImpl()
export default TauriWindowAdapter
