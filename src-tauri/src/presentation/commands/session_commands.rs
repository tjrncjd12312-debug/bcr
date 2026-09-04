//! Session Management Commands
//!
//! Tauri commands for session monitoring, validation, and force quit
//! Handles duplicate login detection and session expiry
//!
//! Clean Architecture: Presentation Layer

use crate::domain::services::{SessionEvent, SessionValidationResult};
use crate::presentation::state::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{error, info, warn};

/// 세션 모니터링 상태
pub struct SessionMonitorState {
    /// 모니터링 활성화 여부
    pub is_monitoring: AtomicBool,
    /// 강제 종료 예약 여부
    pub force_quit_scheduled: AtomicBool,
}

impl Default for SessionMonitorState {
    fn default() -> Self {
        Self {
            is_monitoring: AtomicBool::new(false),
            force_quit_scheduled: AtomicBool::new(false),
        }
    }
}

/// 세션 모니터링 시작 응답
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMonitoringResult {
    pub success: bool,
    pub message: String,
    pub interval_seconds: u64,
}

/// 세션 검증 요청 (프론트엔드에서 주기적으로 호출)
///
/// Returns: SessionValidationResult with event info
#[tauri::command]
pub async fn check_session_validity(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<SessionValidationResult, String> {
    info!("📲 Check session validity request");

    let result = state.session_monitor.validate_session().await;

    // 이벤트가 있으면 프론트엔드로 emit
    if let Some(ref event) = result.event {
        emit_session_event(&app, event);
    }

    // 강제 종료 필요 시 처리
    if result.requires_force_quit {
        handle_force_quit(&app, &result).await;
    }

    Ok(result)
}

/// 세션 모니터링 시작 (로그인 성공 후 호출)
#[tauri::command]
pub async fn start_session_monitoring(
    state: State<'_, AppState>,
    monitor_state: State<'_, SessionMonitorState>,
    app: AppHandle,
) -> Result<StartMonitoringResult, String> {
    info!("📲 Start session monitoring request");

    // 이미 모니터링 중이면 스킵
    if monitor_state.is_monitoring.load(Ordering::SeqCst) {
        return Ok(StartMonitoringResult {
            success: true,
            message: "Session monitoring already active".to_string(),
            interval_seconds: state.session_monitor.validation_interval_secs(),
        });
    }

    // 세션 초기화
    state.session_monitor.initialize_session();

    // 모니터링 플래그 설정
    monitor_state.is_monitoring.store(true, Ordering::SeqCst);

    let interval = state.session_monitor.validation_interval_secs();

    info!("✅ Session monitoring started (interval: {}s)", interval);

    // 백그라운드 모니터링 태스크 시작
    start_background_monitoring(app.clone(), interval);

    Ok(StartMonitoringResult {
        success: true,
        message: "Session monitoring started".to_string(),
        interval_seconds: interval,
    })
}

/// 세션 모니터링 중지 (로그아웃 시 호출)
#[tauri::command]
pub async fn stop_session_monitoring(
    state: State<'_, AppState>,
    monitor_state: State<'_, SessionMonitorState>,
) -> Result<(), String> {
    info!("📲 Stop session monitoring request");

    // 모니터링 플래그 해제
    monitor_state.is_monitoring.store(false, Ordering::SeqCst);

    // 세션 상태 초기화
    state.session_monitor.clear_session();

    info!("✅ Session monitoring stopped");

    Ok(())
}

/// 강제 종료 실행 (세션 만료 또는 중복 로그인)
#[tauri::command]
pub async fn force_quit_app(app: AppHandle, reason: String) -> Result<(), String> {
    warn!("🚨 Force quit requested: {}", reason);

    // 프론트엔드에 종료 알림
    let _ = app.emit(
        "session:force_quit",
        serde_json::json!({
            "reason": reason,
            "timestamp": chrono::Utc::now().timestamp()
        }),
    );

    // 잠시 대기 후 종료 (UI가 메시지를 표시할 시간)
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // 크롬·절전 억제 정리 후 앱 종료
    super::webview_commands::cleanup_on_exit();
    app.exit(0);

    Ok(())
}

/// 수동 토큰 검증 (디버깅용)
#[tauri::command]
pub async fn manual_token_validation(
    state: State<'_, AppState>,
) -> Result<SessionValidationResult, String> {
    info!("📲 Manual token validation request");
    Ok(state.session_monitor.validate_session().await)
}

// ==================== Internal Functions ====================

/// 백그라운드 모니터링 태스크 시작
fn start_background_monitoring(app: AppHandle, interval_secs: u64) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(interval_secs));

        loop {
            interval.tick().await;

            // 앱 상태 가져오기
            let state = match app.try_state::<AppState>() {
                Some(s) => s,
                None => {
                    error!("❌ Failed to get app state in background task");
                    break;
                }
            };

            let monitor_state = match app.try_state::<SessionMonitorState>() {
                Some(s) => s,
                None => {
                    error!("❌ Failed to get monitor state in background task");
                    break;
                }
            };

            // 모니터링 비활성화 시 중지
            if !monitor_state.is_monitoring.load(Ordering::SeqCst) {
                info!("ℹ️ Background monitoring stopped (flag cleared)");
                break;
            }

            // 세션 검증 수행
            let result = state.session_monitor.validate_session().await;

            // 이벤트 emit
            if let Some(ref event) = result.event {
                emit_session_event(&app, event);
            }

            // 강제 종료 필요 시
            if result.requires_force_quit {
                handle_force_quit(&app, &result).await;
                break;
            }
        }
    });
}

/// 세션 이벤트를 프론트엔드로 emit
fn emit_session_event(app: &AppHandle, event: &SessionEvent) {
    let event_name = match event {
        SessionEvent::SessionValid { .. } => "session:valid",
        SessionEvent::SessionExpiryWarning { .. } => "session:expiry_warning",
        SessionEvent::SessionExpirySoon { .. } => "session:expiry_soon",
        SessionEvent::SessionExpired { .. } => "session:expired",
        SessionEvent::DuplicateLogin { .. } => "session:duplicate_login",
        SessionEvent::TokenRevoked { .. } => "session:token_revoked",
        SessionEvent::NetworkError { .. } => "session:network_error",
        SessionEvent::ServerError { .. } => "session:server_error",
    };

    if let Err(e) = app.emit(event_name, event) {
        error!("Failed to emit session event: {}", e);
    }

    // 모든 세션 이벤트를 통합 채널로도 emit
    if let Err(e) = app.emit("session:event", event) {
        error!("Failed to emit unified session event: {}", e);
    }
}

/// 강제 종료 처리
async fn handle_force_quit(app: &AppHandle, result: &SessionValidationResult) {
    let reason = match &result.event {
        Some(SessionEvent::SessionExpired { reason }) => reason.clone(),
        Some(SessionEvent::DuplicateLogin { reason }) => reason.clone(),
        Some(SessionEvent::TokenRevoked { reason }) => reason.clone(),
        _ => "세션이 종료되었습니다.".to_string(),
    };

    warn!("🚨 Force quit triggered: {}", reason);

    // 강제 종료 이벤트 emit
    let _ = app.emit(
        "session:force_quit",
        serde_json::json!({
            "reason": reason,
            "timestamp": chrono::Utc::now().timestamp(),
            "event": result.event
        }),
    );

    // UI가 메시지를 표시할 시간 대기 (3초)
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    // 앱 종료
    info!("👋 Exiting application due to session invalidation");
    app.exit(0);
}
