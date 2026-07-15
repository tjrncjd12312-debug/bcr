// TauriConnectionAdapter - Evolution/Pragmatic 연결 관리
// Clean Architecture: Infrastructure Layer
// 단일 책임: 카지노 WebSocket 연결 관리
// Note: 실제 WS 연결은 evolution/multi_client.rs에서 처리

import { invoke } from '@tauri-apps/api/core'

// ==================== Interface ====================

export interface IConnectionAdapter {
  // Evolution Multi-Socket (주 연결 방식)
  connectEvolutionMultiSocket(params: MultiSocketParams): Promise<void>
  disconnectEvolutionMultiSocket(): Promise<void>
  sendEvolutionMultiMessage(message: string): Promise<void>
  resubscribeEvolutionTable(tableId: string): Promise<void>
  getEvolutionMultiStatus(): Promise<boolean>

  // Manual 연결
  connectEvolutionManual(wsUrl: string, cookies?: string): Promise<void>

  // 브라우저 로비 페이지 새로고침 (CDP 사용)
  refreshLobbyPage(): Promise<boolean>

  // Connection status (legacy - uses multi_client events)
  getConnectionStatus(): Promise<{ connected: boolean; roomCount: number; predictableRooms: number }>
}

// ==================== Types ====================

export interface MultiSocketParams {
  wsUrl: string
  origin?: string
  cookie?: string
  userAgent?: string
}

interface MultiSocketStatus {
  is_connected?: boolean
  isConnected?: boolean
  state?: string
}

// ==================== Implementation ====================

class TauriConnectionAdapterImpl implements IConnectionAdapter {
  // ==================== Evolution Multi-Socket ====================

  async connectEvolutionMultiSocket(params: MultiSocketParams): Promise<void> {
    await invoke('connect_evolution_multi_socket', {
      wsUrl: params.wsUrl,
      origin: params.origin,
      cookie: params.cookie,
      userAgent: params.userAgent,
    })
  }

  async disconnectEvolutionMultiSocket(): Promise<void> {
    await invoke('disconnect_evolution_multi_socket')
  }

  async sendEvolutionMultiMessage(message: string): Promise<void> {
    await invoke('send_evolution_multi_message', { message })
  }

  async resubscribeEvolutionTable(tableId: string): Promise<void> {
    await invoke('resubscribe_evolution_table', { tableId })
  }

  async getEvolutionMultiStatus(): Promise<boolean> {
    const status = await invoke<boolean | MultiSocketStatus>('get_evolution_multi_status')
    if (typeof status === 'boolean') return status
    return status.is_connected === true || status.isConnected === true
  }

  // ==================== Manual 연결 ====================

  async connectEvolutionManual(wsUrl: string, cookies?: string): Promise<void> {
    await invoke('connect_evolution_manual', { wsUrl, cookies })
  }

  // ==================== Lobby Page Management ====================

  async refreshLobbyPage(): Promise<boolean> {
    return invoke<boolean>('refresh_lobby_page')
  }

  // ==================== Connection Status ====================

  async getConnectionStatus(): Promise<{ connected: boolean; roomCount: number; predictableRooms: number }> {
    return invoke('get_connection_status')
  }
}

// ==================== Singleton Export ====================

export const TauriConnectionAdapter = new TauriConnectionAdapterImpl()
export default TauriConnectionAdapter
