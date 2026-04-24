// TauriCdpAdapter - Chrome DevTools Protocol adapter implementation
// Implements ICdpPort interface (Single Responsibility)

import { invoke } from '@tauri-apps/api/core'
import type { ICdpPort } from '../../../domain/interfaces'

class TauriCdpAdapterImpl implements ICdpPort {
  async openInChrome(url: string): Promise<void> {
    await invoke('open_in_chrome', { url })
  }

  async navigateChrome(url: string): Promise<void> {
    await invoke('navigate_chrome', { url })
  }

  async startMonitoring(): Promise<void> {
    await invoke('start_cdp_monitoring')
  }

  async stopMonitoring(): Promise<void> {
    await invoke('stop_cdp_monitoring')
  }

  async killChrome(): Promise<void> {
    await invoke('kill_chrome')
  }

  async openNewTab(url: string): Promise<void> {
    await invoke('open_new_tab_cdp', { url })
  }

  // Additional helper for normal Chrome opening (non-CDP)
  async openInChromeNormal(url: string): Promise<void> {
    await invoke('open_in_chrome_normal', { url })
  }

  // Refresh lobby page to keep connection alive
  async refreshLobbyPage(): Promise<boolean> {
    return await invoke('refresh_lobby_page')
  }

  // Navigate to room with WebSocket blocking (reuses existing tab)
  async navigateToRoom(url: string): Promise<void> {
    await invoke('navigate_to_room_with_ws_block', { url })
  }
}

export const TauriCdpAdapter = new TauriCdpAdapterImpl()
export default TauriCdpAdapter
