//! Authentication Commands
//!
//! Tauri commands for user authentication
//! Includes session management for 정액 시간 (subscription time) and duplicate login detection

use crate::data::datasources::PredictionApi;
use crate::domain::entities::SessionStatus;
use crate::presentation::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::info;

/// Login request from frontend
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    pub site_url: String,
}

/// Login response to frontend
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub success: bool,
    pub message: String,
    pub user: Option<UserInfo>,
    /// 정액 시간 (초) - Session duration from server
    pub remaining_seconds: Option<i64>,
    /// 공지사항 정보
    pub notice: Option<NoticeData>,
}

/// Notice data for frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeData {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub reg_date: Option<String>,
}

/// User info for frontend
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: String,
    pub username: String,
    pub token: String, // ✅ Added: auth token for API requests
    pub site_url: String,
    pub total_predictions: u32,
    pub correct_predictions: u32,
    pub win_rate: f64,
}

/// Login command
#[tauri::command]
pub async fn login(
    request: LoginRequest,
    state: State<'_, AppState>,
) -> Result<LoginResult, String> {
    info!(
        "📲 Login request for user: {} (target site: {})",
        request.username, request.site_url
    );

    // Login always uses bcra.store (same as Android)
    // The user's siteUrl is stored for WebView navigation after login

    let response = state
        .user_authentication
        .login(&request.username, &request.password)
        .await;

    match response {
        Ok(login_response) => {
            if login_response.success {
                // ✅ Security: 사용 시간 만료 체크 (remaining_seconds가 0 이하면 로그인 거부)
                let remaining = login_response.remaining_seconds.unwrap_or(0);
                if remaining <= 0 {
                    info!(
                        "❌ Login rejected: 사용 시간 만료 (remaining_seconds: {})",
                        remaining
                    );
                    return Ok(LoginResult {
                        success: false,
                        message: "사용 시간이 만료되었습니다. 관리자에게 문의하세요.".to_string(),
                        user: None,
                        remaining_seconds: Some(0),
                        notice: None,
                    });
                }

                // Set auth token for API calls
                if let Some(ref user) = login_response.user {
                    state.set_auth_token(&user.auth_token).await;
                    // Store site URL
                    state.set_site_url(&request.site_url).await;
                }
            }

            Ok(LoginResult {
                success: login_response.success,
                message: login_response.message,
                remaining_seconds: login_response.remaining_seconds,
                user: login_response.user.map(|u| UserInfo {
                    id: u.id,
                    username: u.username,
                    token: u.auth_token.clone(), // ✅ Include token for API requests
                    site_url: request.site_url.clone(),
                    total_predictions: u.stats.total_predictions,
                    correct_predictions: u.stats.correct_predictions,
                    win_rate: if u.stats.total_predictions > 0 {
                        u.stats.correct_predictions as f64 / u.stats.total_predictions as f64
                    } else {
                        0.0
                    },
                }),
                notice: login_response.notice.map(|n| NoticeData {
                    id: n.id,
                    title: n.title,
                    content: n.content,
                    reg_date: n.reg_date,
                }),
            })
        }
        Err(e) => Ok(LoginResult {
            success: false,
            message: e,
            user: None,
            remaining_seconds: None,
            notice: None,
        }),
    }
}

/// Logout command
#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    info!("📲 Logout request");
    state.user_authentication.logout().await
}

/// Restore session command
#[tauri::command]
pub async fn restore_session(state: State<'_, AppState>) -> Result<Option<UserInfo>, String> {
    info!("📲 Restore session request");

    let user = state.user_authentication.restore_session().await?;
    let site_url = state.get_site_url().await;

    if let Some(ref u) = user {
        state.set_auth_token(&u.auth_token).await;
    }

    Ok(user.map(|u| UserInfo {
        id: u.id,
        username: u.username,
        token: u.auth_token.clone(), // ✅ Include token for API requests
        site_url: site_url.unwrap_or_default(),
        total_predictions: u.stats.total_predictions,
        correct_predictions: u.stats.correct_predictions,
        win_rate: if u.stats.total_predictions > 0 {
            u.stats.correct_predictions as f64 / u.stats.total_predictions as f64
        } else {
            0.0
        },
    }))
}

/// Check if logged in
#[tauri::command]
pub fn is_logged_in(state: State<'_, AppState>) -> bool {
    state.user_authentication.is_logged_in()
}

/// Get current user
#[tauri::command]
pub async fn get_current_user(state: State<'_, AppState>) -> Result<Option<UserInfo>, String> {
    let site_url = state.get_site_url().await;

    Ok(state
        .user_authentication
        .get_current_user()
        .map(|u| UserInfo {
            id: u.id,
            username: u.username,
            token: u.auth_token.clone(), // ✅ Include token for API requests
            site_url: site_url.unwrap_or_default(),
            total_predictions: u.stats.total_predictions,
            correct_predictions: u.stats.correct_predictions,
            win_rate: if u.stats.total_predictions > 0 {
                u.stats.correct_predictions as f64 / u.stats.total_predictions as f64
            } else {
                0.0
            },
        }))
}

// ==================== Session Management Commands ====================

/// Validate current session (called periodically from frontend)
/// Checks token validity and detects duplicate login
#[tauri::command]
pub async fn validate_session(state: State<'_, AppState>) -> Result<SessionStatus, String> {
    info!("📲 Validate session request");
    state.user_authentication.validate_session().await
}

/// Get remaining session time in seconds
#[tauri::command]
pub fn get_remaining_seconds(state: State<'_, AppState>) -> Option<i64> {
    state.user_authentication.get_remaining_seconds()
}

/// Check if session is expired
#[tauri::command]
pub fn is_session_expired(state: State<'_, AppState>) -> bool {
    state.user_authentication.is_session_expired()
}

/// Exit the application (called when session expires)
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    info!("📲 Exit app request - session expired or forced logout");
    // 🔒 중복 로그인/만료로 종료할 때 앱이 띄운 크롬(카지노 세션)과 절전 억제도 함께 정리한다 —
    //   run()이 돌아오지 않을 수 있어 lib.rs의 사후 정리에 기대지 않는다.
    super::webview_commands::cleanup_on_exit();
    app.exit(0);
}

/// Get client version
#[tauri::command]
pub fn get_client_version() -> String {
    PredictionApi::CLIENT_VERSION.to_string()
}
