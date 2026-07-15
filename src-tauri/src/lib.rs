//! BCR Predictor Desktop Application
//!
//! Tauri + Rust desktop app for baccarat prediction
//! Architecture: Clean Architecture with Domain, Data, Application, Presentation layers
//!
//! Features:
//! - Single room prediction mode (semi-automatic)
//! - Multi room prediction mode (all 33 rooms)
//! - Evolution Gaming Multiwidget WebSocket integration
//! - Local statistics storage

pub mod application;
pub mod data;
pub mod domain;
pub mod evolution;
pub mod pragmatic;
pub mod presentation;
pub mod security;

use evolution::commands::{
    // Multi-table single-socket (multiwidget) - 프론트엔드에서 실제 사용
    connect_evolution_multi_socket,
    disconnect_evolution_multi_socket,
    get_evolution_multi_status,
    resubscribe_evolution_table,
    send_evolution_multi_message,
    // NOTE: Unified socket commands removed - not used by frontend
    // See evolution/unified_client.rs if needed later
};
use pragmatic::commands::{
    connect_pragmatic, connect_pragmatic_room, connect_pragmatic_table, disconnect_all_pragmatic,
    disconnect_pragmatic, disconnect_pragmatic_room, place_pragmatic_bet, send_pragmatic_message,
    set_pragmatic_user_id,
};
use pragmatic::manager::{PragmaticConnectionManager, PragmaticManagerState};
use presentation::{
    commands::{
        // Session monitoring commands (duplicate login detection)
        check_session_validity,
        cleanup_on_exit,
        click_evolution_launch,
        // Connection mode commands (actual WS handled by evolution/multi_client)
        click_pragmatic_room_in_lobby,
        connect_evolution_manual,
        connect_multiwidget_manual,
        detach_embedded_chrome,
        disable_multi_room_mode,
        disable_multi_room_prediction,
        disconnect_multiwidget,
        download_client_update,
        embed_chrome_window,
        enable_multi_room_mode,
        enable_multi_room_prediction,
        exit_app,
        fe_diag,
        force_quit_app,
        get_all_predictions,
        // Room commands
        get_all_rooms,
        get_client_version,
        get_connection_status,
        get_current_user,
        get_evolution_base_url,
        get_multi_room_status,
        // Multiwidget auto-connection commands (CDP auto-connect)
        get_multiwidget_status,
        get_predictable_rooms,
        get_ranked_rooms,
        get_remaining_seconds,
        get_room_detail,
        get_room_game_data,
        get_top_predictions,
        get_tracked_rooms,
        is_logged_in,
        is_session_expired,
        kill_chrome,
        // Auth commands
        login,
        logout,
        manual_token_validation,
        navigate_chrome,
        navigate_pragmatic_room,
        navigate_to_evolution_lobby,
        navigate_to_room_with_ws_block,
        notify_shoe_change_v2,
        open_in_chrome,
        open_in_chrome_normal,
        open_new_tab_cdp,
        park_browser_lobby,
        process_evolution_message,
        refresh_lobby_page,
        refresh_pragmatic_lobby_rooms_from_dom,
        report_result_v2,
        request_all_predictions,
        request_best_room_selection,
        // V2 API commands (Enhanced prediction with Evolution data)
        request_prediction_v2,
        request_prediction_with_history,
        resize_embedded_chrome,
        restart_cdp_monitoring,
        restore_session,
        rotate_evolution_session,
        send_multiwidget_message,
        // CDP (Chrome DevTools Protocol) commands for auto WebSocket capture
        start_cdp_monitoring,
        start_session_monitoring,
        stop_cdp_monitoring,
        stop_session_monitoring,
        subscribe_to_room,
        unsubscribe_from_room,
        // Session management commands
        validate_session,
        MultiRoomPredictionState,
        SessionMonitorState,
    },
    state::AppState,
};
use std::sync::Arc;
use tokio::sync::Mutex;

use std::path::PathBuf;
use tauri::Manager;
use tracing::info;

/// Initialize and run the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing. File output is opt-in because runtime logs can
    // contain operational details even after individual call sites redact
    // credentials.
    let env_filter = tracing_subscriber::EnvFilter::from_default_env()
        .add_directive("bcr_predictor=debug".parse().unwrap())
        .add_directive("tauri=info".parse().unwrap())
        // 🔇 예측/결과보고 로그는 방마다·라운드마다 도배돼 연결 진단 로그를 묻어버린다. warn으로 낮춤.
        // (되돌리려면 이 세 줄 삭제. WARN/ERROR는 여전히 보임 — 예: Prediction WRONG)
        .add_directive(
            "bcr_predictor_lib::presentation::commands::prediction_commands=warn"
                .parse()
                .unwrap(),
        )
        .add_directive(
            "bcr_predictor_lib::data::repositories::prediction_repository_impl=warn"
                .parse()
                .unwrap(),
        )
        .add_directive(
            "bcr_predictor_lib::data::datasources::prediction_api=warn"
                .parse()
                .unwrap(),
        )
        // 🆕 진단 핵심 모듈은 INFO 보장(RUST_LOG 미설정 환경에서도 [PARK]/[Evolution-Multi]/[BET-FIX] 캡처).
        .add_directive("bcr_predictor_lib::evolution=info".parse().unwrap())
        .add_directive(
            "bcr_predictor_lib::presentation::commands::webview_commands=info"
                .parse()
                .unwrap(),
        );

    let diagnostics_enabled = std::env::var("BCR_DIAGNOSTICS")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if diagnostics_enabled {
        let log_dir = std::env::var_os("BCR_DIAGNOSTICS_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("newbcr-diagnostics"));
        let log_path = log_dir.join("bcr-runtime.log");
        let file = std::fs::create_dir_all(&log_dir).and_then(|_| std::fs::File::create(&log_path));

        match file {
            Ok(file) => {
                use tracing_subscriber::fmt::writer::MakeWriterExt;
                tracing_subscriber::fmt()
                    .with_env_filter(env_filter)
                    .with_ansi(false)
                    .with_writer(
                        std::io::stdout
                            .and(move || file.try_clone().expect("clone diagnostics log file")),
                    )
                    .init();
                info!("📝 Diagnostics log enabled: {}", log_path.display());
            }
            Err(error) => {
                tracing_subscriber::fmt().with_env_filter(env_filter).init();
                info!(
                    "⚠️ Diagnostics log unavailable ({}); stdout only: {}",
                    log_path.display(),
                    error
                );
            }
        }
    } else {
        tracing_subscriber::fmt().with_env_filter(env_filter).init();
    }

    info!("🚀 Starting BCR Predictor Desktop Application");

    // 🧪 베팅 포맷 캡처 모드 안내(env BCR_BET_CAPTURE=1). 켜지면 Rust는 멀티위젯에 연결 안 함 →
    //    브라우저가 유일 세션이 되어 Evolution 베팅 UI가 작동. Chrome devtools에서 플래그 켜고 베팅하면
    //    그 메시지를 [BCR_BET_CAPTURED]로 캡처(서버 전송 차단 = 돈 안 빠짐).
    if std::env::var("BCR_BET_CAPTURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        info!("🧪🧪🧪 BET-CAPTURE 모드 ON — Rust 멀티위젯 연결 안 함. Chrome(Evolution) devtools 콘솔에서");
        info!("🧪 → sessionStorage.setItem('__BCR_BET_CAPTURE__','1'); location.reload();  실행 후 테이블 입장→베팅 클릭");
        info!("🧪 → 그러면 [BCR_BET_CAPTURED]로 베팅 메시지가 로그에 잡힘(전송 차단=실제 돈 안 빠짐).");
    }

    // Security checks (release mode only)
    #[cfg(not(debug_assertions))]
    {
        if !security::anti_debug::run_security_checks() {
            tracing::error!("E01");
            std::process::exit(1);
        }

        if !security::integrity::verify_integrity() {
            tracing::error!("E02");
            std::process::exit(1);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            info!("📦 Setting up application...");

            // Get app data directory
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            // Initialize app state
            let runtime = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
            let app_state = runtime
                .block_on(AppState::new(data_dir))
                .expect("Failed to initialize app state");

            // Manage state
            app.manage(app_state);
            app.manage(MultiRoomPredictionState::default());
            app.manage(SessionMonitorState::default());
            app.manage(PragmaticManagerState {
                manager: Arc::new(Mutex::new(PragmaticConnectionManager::new())),
            });

            info!("✅ Application setup complete");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Auth commands
            login,
            logout,
            restore_session,
            is_logged_in,
            get_current_user,
            get_client_version,
            download_client_update,
            // Session management commands
            validate_session,
            get_remaining_seconds,
            is_session_expired,
            exit_app,
            // Session monitoring commands (duplicate login detection & force quit)
            check_session_validity,
            start_session_monitoring,
            stop_session_monitoring,
            force_quit_app,
            manual_token_validation,
            // Connection mode commands (actual WS via evolution/multi_client)
            get_connection_status,
            enable_multi_room_mode,
            disable_multi_room_mode,
            // Evolution multi-table single socket (multiwidget)
            connect_evolution_multi_socket,
            disconnect_evolution_multi_socket,
            get_evolution_multi_status,
            send_evolution_multi_message,
            resubscribe_evolution_table,
            // Room commands
            get_all_rooms,
            get_room_detail,
            subscribe_to_room,
            unsubscribe_from_room,
            get_ranked_rooms,
            get_predictable_rooms,
            // Prediction commands
            enable_multi_room_prediction,
            disable_multi_room_prediction,
            request_all_predictions,
            get_multi_room_status,
            get_all_predictions,
            get_top_predictions,
            request_best_room_selection,
            request_prediction_with_history,
            // CDP (Chrome DevTools Protocol) commands
            click_pragmatic_room_in_lobby,
            refresh_pragmatic_lobby_rooms_from_dom,
            start_cdp_monitoring,
            stop_cdp_monitoring,
            restart_cdp_monitoring,
            rotate_evolution_session,
            open_in_chrome,
            open_in_chrome_normal,
            navigate_chrome,
            navigate_pragmatic_room,
            navigate_to_room_with_ws_block,
            park_browser_lobby,
            fe_diag,
            open_new_tab_cdp,
            kill_chrome,
            refresh_lobby_page,
            click_evolution_launch,
            navigate_to_evolution_lobby,
            connect_evolution_manual,
            embed_chrome_window,
            resize_embedded_chrome,
            detach_embedded_chrome,
            // Pragmatic commands
            connect_pragmatic,
            disconnect_pragmatic,
            connect_pragmatic_room,
            disconnect_pragmatic_room,
            disconnect_all_pragmatic,
            connect_pragmatic_table,
            send_pragmatic_message,
            set_pragmatic_user_id,
            place_pragmatic_bet,
            // Multiwidget auto-connection commands (CDP auto-connect)
            get_multiwidget_status,
            get_evolution_base_url,
            disconnect_multiwidget,
            send_multiwidget_message,
            connect_multiwidget_manual,
            // V2 API commands (Enhanced prediction with Evolution data)
            request_prediction_v2,
            report_result_v2,
            notify_shoe_change_v2,
            process_evolution_message,
            get_room_game_data,
            get_tracked_rooms,
        ])
        .on_window_event(|window, event| {
            // Cleanup Chrome when main window is closed
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    info!("🚪 Main window closing, cleaning up Chrome...");
                    cleanup_on_exit();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    // Final cleanup (in case app exits without window close event)
    cleanup_on_exit();
}
