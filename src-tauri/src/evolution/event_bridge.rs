//! Tauri Event Bridge
//!
//! 도메인 이벤트를 Tauri 프론트엔드 이벤트로 변환하는 브릿지.
//! Presentation Layer에 위치하며, 네트워크 계층과 UI 계층을 분리합니다.

use super::events::{DisconnectReason, EvolutionEvent, EventReceiver};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{debug, error, info, warn};

/// Tauri 이벤트 이름 상수
pub mod event_names {
    pub const CONNECTED: &str = "evolution_multi_connected";
    pub const DISCONNECTED: &str = "evolution_multi_disconnected";
    pub const ERROR: &str = "evolution_multi_error";
    pub const ROOMS_READY: &str = "evolution_multi_rooms_ready";
    pub const EVENT: &str = "evolution_multi_event";
    pub const RAW: &str = "evolution_multi_raw";
    pub const RECONNECT_ATTEMPT: &str = "evolution_multi_reconnect_attempt";
}

/// Tauri 이벤트 브릿지
///
/// 도메인 이벤트를 수신하여 Tauri 프론트엔드 이벤트로 변환합니다.
pub struct TauriEventBridge {
    app_handle: AppHandle,
}

impl TauriEventBridge {
    /// 새 브릿지 생성
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }

    /// 이벤트 브릿지 실행 (백그라운드 태스크)
    ///
    /// 이벤트 채널에서 도메인 이벤트를 수신하고 Tauri 이벤트로 변환합니다.
    pub async fn run(self, mut event_rx: EventReceiver) {
        info!("[EventBridge] Starting event bridge...");

        while let Some(event) = event_rx.recv().await {
            self.handle_event(event);
        }

        info!("[EventBridge] Event bridge stopped");
    }

    /// 단일 이벤트 처리
    fn handle_event(&self, event: EvolutionEvent) {
        match event {
            EvolutionEvent::Connected { url, is_multiwidget } => {
                self.emit_connected(&url, is_multiwidget);
            }
            EvolutionEvent::Disconnected { url, reason } => {
                self.emit_disconnected(&url, reason);
            }
            EvolutionEvent::Error {
                url,
                error,
                error_detail,
            } => {
                self.emit_error(&url, &error, error_detail.as_deref());
            }
            EvolutionEvent::TablesAvailable { tables } => {
                debug!(
                    "[EventBridge] Tables available: {} tables",
                    tables.len()
                );
                // 테이블 목록은 RoomsReady에서 처리
            }
            EvolutionEvent::RoomsReady {
                room_count,
                total_available,
            } => {
                self.emit_rooms_ready(room_count, total_available);
            }
            EvolutionEvent::GameResult { table_id, data } => {
                self.emit_table_event(Some(table_id), "game.result", data);
            }
            EvolutionEvent::GameState { table_id, data } => {
                self.emit_table_event(Some(table_id), "game.state", data);
            }
            EvolutionEvent::Kickout { reason } => {
                warn!("[EventBridge] Kickout: {}", reason);
                self.emit_disconnected("", DisconnectReason::Kickout(reason));
            }
            EvolutionEvent::TableEvent {
                table_id,
                event_type,
                data,
            } => {
                self.emit_table_event(table_id, &event_type, data);
            }
            EvolutionEvent::ReconnectAttempt {
                attempt,
                max_attempts,
                delay_ms,
                reason,
            } => {
                self.emit_reconnect_attempt(attempt, max_attempts, delay_ms, &reason);
            }
            EvolutionEvent::RawMessage {
                event_type,
                payload,
            } => {
                self.emit_raw(&event_type, payload);
            }
        }
    }

    /// 연결 성공 이벤트 방출
    fn emit_connected(&self, url: &str, is_multiwidget: bool) {
        info!("[EventBridge] Emitting connected event...");

        let payload = serde_json::json!({
            "url": url,
            "status": "connected",
            "isMultiwidget": is_multiwidget
        });

        if let Err(e) = self.emit_to_main_window(event_names::CONNECTED, payload) {
            error!("[EventBridge] Failed to emit connected: {}", e);
        }
    }

    /// 연결 해제 이벤트 방출
    fn emit_disconnected(&self, url: &str, reason: DisconnectReason) {
        info!("[EventBridge] Emitting disconnected event: {:?}", reason);

        let payload = serde_json::json!({
            "url": url,
            "reason": reason.as_str()
        });

        if let Err(e) = self.emit_to_main_window(event_names::DISCONNECTED, payload) {
            error!("[EventBridge] Failed to emit disconnected: {}", e);
        }
    }

    /// 에러 이벤트 방출
    fn emit_error(&self, url: &str, error: &str, error_detail: Option<&str>) {
        error!("[EventBridge] Emitting error event: {}", error);

        let mut payload = serde_json::json!({
            "url": url,
            "error": error
        });

        if let Some(detail) = error_detail {
            payload["errorDetail"] = serde_json::Value::String(detail.to_string());
        }

        if let Err(e) = self.emit_to_main_window(event_names::ERROR, payload) {
            error!("[EventBridge] Failed to emit error: {}", e);
        }
    }

    /// 룸 준비 완료 이벤트 방출
    fn emit_rooms_ready(&self, room_count: usize, total_available: usize) {
        info!(
            "[EventBridge] Emitting rooms_ready: {}/{}",
            room_count, total_available
        );

        let payload = serde_json::json!({
            "roomCount": room_count,
            "totalAvailable": total_available
        });

        if let Err(e) = self.emit_to_main_window(event_names::ROOMS_READY, payload) {
            error!("[EventBridge] Failed to emit rooms_ready: {}", e);
        }
    }

    /// 테이블 이벤트 방출
    fn emit_table_event(
        &self,
        table_id: Option<String>,
        event_type: &str,
        data: serde_json::Value,
    ) {
        let payload = serde_json::json!({
            "tableId": table_id,
            "eventType": event_type,
            "data": data
        });

        // evolution_multi_event로 방출
        if let Err(e) = self.emit_to_main_window(event_names::EVENT, payload) {
            debug!("[EventBridge] Failed to emit table event: {}", e);
        }
    }

    /// 재연결 시도 이벤트 방출
    fn emit_reconnect_attempt(&self, attempt: u32, max_attempts: u32, delay_ms: u64, reason: &str) {
        warn!(
            "[EventBridge] Reconnect attempt {}/{} in {}ms (reason: {})",
            attempt, max_attempts, delay_ms, reason
        );

        let payload = serde_json::json!({
            "attempt": attempt,
            "maxAttempts": max_attempts,
            "delayMs": delay_ms,
            "reason": reason
        });

        if let Err(e) = self.emit_to_main_window(event_names::RECONNECT_ATTEMPT, payload) {
            error!("[EventBridge] Failed to emit reconnect_attempt: {}", e);
        }
    }

    /// Raw 메시지 방출
    fn emit_raw(&self, event_type: &str, payload: serde_json::Value) {
        let raw_payload = serde_json::json!({
            "eventType": event_type,
            "payload": payload
        });

        if let Err(e) = self.emit_to_main_window(event_names::RAW, raw_payload) {
            debug!("[EventBridge] Failed to emit raw: {}", e);
        }
    }

    /// 메인 윈도우로 이벤트 방출
    fn emit_to_main_window(
        &self,
        event_name: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        // 먼저 main window로 시도
        if let Some(main_window) = self.app_handle.get_webview_window("main") {
            main_window
                .emit(event_name, payload)
                .map_err(|e| e.to_string())
        } else {
            // Fallback: app_handle으로 전역 방출
            warn!("[EventBridge] Main window not found, using global emit");
            self.app_handle
                .emit(event_name, payload)
                .map_err(|e| e.to_string())
        }
    }
}

/// 이벤트 브릿지를 백그라운드에서 실행
pub fn spawn_event_bridge(app_handle: AppHandle, event_rx: EventReceiver) {
    let bridge = TauriEventBridge::new(app_handle);
    tokio::spawn(async move {
        bridge.run(event_rx).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_names() {
        assert_eq!(event_names::CONNECTED, "evolution_multi_connected");
        assert_eq!(event_names::DISCONNECTED, "evolution_multi_disconnected");
        assert_eq!(event_names::ERROR, "evolution_multi_error");
        assert_eq!(event_names::ROOMS_READY, "evolution_multi_rooms_ready");
    }
}
