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
    disconnect_pragmatic, disconnect_pragmatic_room, send_pragmatic_message,
};
use pragmatic::manager::{PragmaticConnectionManager, PragmaticManagerState};
use presentation::{
    commands::{
        // Session monitoring commands (duplicate login detection)
        check_session_validity,
        cleanup_on_exit,
        // Connection mode commands (actual WS handled by evolution/multi_client)
        connect_evolution_manual,
        connect_multiwidget_manual,
        disable_multi_room_mode,
        disable_multi_room_prediction,
        disconnect_multiwidget,
        enable_multi_room_mode,
        enable_multi_room_prediction,
        exit_app,
        force_quit_app,
        get_all_predictions,
        // Room commands
        get_all_rooms,
        get_connection_status,
        get_current_user,
        get_multi_room_status,
        // Multiwidget auto-connection commands (CDP auto-connect)
        get_multiwidget_status,
        get_evolution_base_url,
        get_predictable_rooms,
        get_ranked_rooms,
        get_remaining_seconds,
        get_client_version,
        download_client_update,
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
        navigate_to_room_with_ws_block,
        notify_shoe_change_v2,
        open_in_chrome,
        open_in_chrome_normal,
        open_new_tab_cdp,
        process_evolution_message,
        refresh_lobby_page,
        navigate_to_evolution_lobby,
        report_result_v2,
        request_all_predictions,
        request_best_room_selection,
        // V2 API commands (Enhanced prediction with Evolution data)
        request_prediction_v2,
        request_prediction_with_history,
        restart_cdp_monitoring,
        restore_session,
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
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("bcr_predictor=debug".parse().unwrap())
                .add_directive("tauri=info".parse().unwrap()),
        )
        .init();

    info!("🚀 Starting BCR Predictor Desktop Application");

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
            start_cdp_monitoring,
            stop_cdp_monitoring,
            restart_cdp_monitoring,
            open_in_chrome,
            open_in_chrome_normal,
            navigate_chrome,
            navigate_pragmatic_room,
            navigate_to_room_with_ws_block,
            open_new_tab_cdp,
            kill_chrome,
            refresh_lobby_page,
            navigate_to_evolution_lobby,
            connect_evolution_manual,
            // Pragmatic commands
            connect_pragmatic,
            disconnect_pragmatic,
            connect_pragmatic_room,
            disconnect_pragmatic_room,
            disconnect_all_pragmatic,
            connect_pragmatic_table,
            send_pragmatic_message,
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
