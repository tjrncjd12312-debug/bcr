//! WebView Commands
//!
//! Tauri commands for webview window management
//! Includes dynamic WebSocket interception like Android
//! Note: Uses only multiwidget socket (lobby_client removed)

use crate::evolution::multi_client::{
    EvolutionMultiSocket, MultiSocketOptions, GLOBAL_MULTI_CLIENT,
};
use crate::pragmatic::manager::PragmaticManagerState;
use crate::pragmatic::{normalizer as pragmatic_normalizer, parser as pragmatic_parser};
use crate::presentation::task_registry::TaskRegistry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as TokioMutex;
use tracing::{debug, error, info, warn};

use once_cell::sync::Lazy;

/// Global multiwidget client for auto-connection from CDP (shared with frontend commands)
static MULTIWIDGET_CLIENT: Lazy<&TokioMutex<EvolutionMultiSocket>> =
    Lazy::new(|| &GLOBAL_MULTI_CLIENT);

/// Global Chrome process ID for cleanup on exit
static CHROME_PID: AtomicU32 = AtomicU32::new(0);

pub fn chrome_pid() -> u32 {
    CHROME_PID.load(Ordering::SeqCst)
}

/// Global room tab target ID for reuse
static ROOM_TAB_TARGET_ID: Mutex<Option<String>> = Mutex::new(None);

/// Global lobby page ID for tracking
static LOBBY_PAGE_ID: Mutex<Option<String>> = Mutex::new(None);

/// Flag to signal CDP monitoring should stop (set when Evolution session is captured)
static CDP_SHOULD_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Lane R2 (perf-plan): registry for the long-running CDP polling task. The
/// existing `CDP_SHOULD_STOP` atomic is the cooperative cancellation path; the
/// registry is the safety net so `stop_cdp_monitoring` and `restart_cdp_monitoring`
/// can hard-abort a stuck poller (e.g. blocked on an HTTP read) instead of
/// leaking the `JoinHandle`. Defense in depth, not a replacement.
static CDP_TASK_REGISTRY: Lazy<TaskRegistry> = Lazy::new(TaskRegistry::new);

/// Stable key under which the CDP polling task is registered.
const CDP_MONITOR_KEY: &str = "cdp:monitor";

/// Serializes proactive session rotations. A second request must not tear down
/// a connection while the first request is capturing its replacement.
static SESSION_ROTATION_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct AtomicFlagGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

fn try_acquire_atomic_flag(flag: &AtomicBool) -> Option<AtomicFlagGuard<'_>> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| AtomicFlagGuard { flag })
}

/// Multiwidget connection status - prevents duplicate connection attempts
static MULTIWIDGET_CONNECTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Browser cookies captured via Network.getAllCookies (includes _abck for Akamai)
static BROWSER_ALL_COOKIES: once_cell::sync::Lazy<std::sync::Mutex<Option<String>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

/// URL debouncing - track recently processed multiwidget URLs to prevent duplicate handling
static PROCESSED_MULTIWIDGET_URLS: Lazy<
    Mutex<std::collections::HashMap<String, std::time::Instant>>,
> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

/// App mode for CDP monitoring - "auto" or "predict"
/// 🔥 UNIFIED: All modes now use multiwidget socket for consistent subscription behavior
static CDP_APP_MODE: Mutex<String> = Mutex::new(String::new());

/// URL that must be opened only after the CDP WebSocket blocker is installed
/// with Page.addScriptToEvaluateOnNewDocument. Loading Evolution directly in
/// Chrome races the page's own WebSocket creation and loses the single session.
static PENDING_CHROME_URL: Mutex<Option<String>> = Mutex::new(None);

/// Evolution base URL - captured from multiwidget WebSocket URL
/// Format: wss://babylontggasia.evo-games.com/... -> https://babylontggasia.evo-games.com
/// This domain is used for room navigation
static EVOLUTION_BASE_URL: Mutex<Option<String>> = Mutex::new(None);

/// Pragmatic launcher URL - captured when user enters a table
/// Format: https://client.pragmaticplaylive.net/desktop/launcher/?JSESSIONID=...&operatorGameId=...
/// This URL contains all session info needed for room navigation
static PRAGMATIC_LAUNCHER_URL: Mutex<Option<String>> = Mutex::new(None);
static PRAGMATIC_LAST_WS_URL: Mutex<Option<String>> = Mutex::new(None);
static PRAGMATIC_WS_URL_BY_OPERATOR_GAME_ID: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PRAGMATIC_TABLE_ID_BY_OPERATOR_GAME_ID: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Build Pragmatic launcher URL from a Pragmatic WebSocket URL that contains session params.
/// This enables room navigation even before the user manually opens a table.
fn build_pragmatic_launcher_url_from_ws(ws_url: &str) -> Option<String> {
    let parsed_ws = url::Url::parse(ws_url).ok()?;

    let mut params: Vec<(String, String)> = Vec::new();
    for (k, v) in parsed_ws.query_pairs() {
        params.push((k.into_owned(), v.into_owned()));
    }

    let table_id = params
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("tableId"))
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| "lobby".to_string());

    let jsession_id = params
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("JSESSIONID"))
        .map(|(_, v)| v.clone())?;

    let mut launcher =
        url::Url::parse("https://client.pragmaticplaylive.net/desktop/launcher/").ok()?;

    let mut has_operator_game_id = false;
    let mut has_table_id = false;
    let mut has_jsession = false;

    {
        let mut query = launcher.query_pairs_mut();
        for (k, v) in &params {
            if k.eq_ignore_ascii_case("operatorGameId") {
                query.append_pair("operatorGameId", &table_id);
                has_operator_game_id = true;
                continue;
            }
            if k.eq_ignore_ascii_case("tableId") {
                query.append_pair("tableId", &table_id);
                has_table_id = true;
                continue;
            }
            if k.eq_ignore_ascii_case("JSESSIONID") {
                query.append_pair("JSESSIONID", &jsession_id);
                has_jsession = true;
                continue;
            }
            query.append_pair(k, v);
        }

        if !has_jsession {
            query.append_pair("JSESSIONID", &jsession_id);
        }
        if !has_operator_game_id {
            query.append_pair("operatorGameId", &table_id);
        }
        if !has_table_id {
            query.append_pair("tableId", &table_id);
        }
    }

    Some(launcher.to_string())
}

fn build_pragmatic_launcher_url_for_operator_game_id(
    ws_url: &str,
    operator_game_id: &str,
    table_id_override: Option<&str>,
) -> Option<String> {
    let parsed_ws = url::Url::parse(ws_url).ok()?;
    let pairs: HashMap<String, String> = parsed_ws.query_pairs().into_owned().collect();

    let jsession_id = pairs.get("JSESSIONID")?.to_string();
    let ws_table_id = pairs
        .get("tableId")
        .cloned()
        .unwrap_or_else(|| operator_game_id.to_string());
    let table_id = table_id_override.unwrap_or(&ws_table_id);

    let mut launcher =
        url::Url::parse("https://client.pragmaticplaylive.net/desktop/launcher/").ok()?;

    {
        let mut query = launcher.query_pairs_mut();
        for (k, v) in pairs.iter() {
            match k.as_str() {
                "operatorGameId" => query.append_pair("operatorGameId", operator_game_id),
                "tableId" => query.append_pair("tableId", table_id),
                "JSESSIONID" => query.append_pair("JSESSIONID", &jsession_id),
                _ => query.append_pair(k, v),
            };
        }

        if !pairs.contains_key("JSESSIONID") {
            query.append_pair("JSESSIONID", &jsession_id);
        }
        if !pairs.contains_key("operatorGameId") {
            query.append_pair("operatorGameId", operator_game_id);
        }
        if !pairs.contains_key("tableId") {
            query.append_pair("tableId", table_id);
        }
    }

    Some(launcher.to_string())
}

async fn try_capture_pragmatic_launcher_url_from_open_pages(
    operator_game_id: &str,
) -> Option<String> {
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio_tungstenite::connect_async;

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let response = reqwest::get(&cdp_url).await.ok()?;
    let pages: Vec<serde_json::Value> = response.json().await.ok()?;

    let wanted = serde_json::to_string(operator_game_id).ok()?;
    let expression = format!(
        r#"(function() {{
  const wanted = {wanted};
  const found = [];
  function add(u) {{
    if (!u || typeof u !== 'string') return;
    if (u.indexOf('pragmaticplaylive.net/desktop/launcher') === -1) return;
    found.push(u);
  }}
  try {{
    document.querySelectorAll('a[href]').forEach(a => add(a.href));
  }} catch (e) {{}}
  try {{
    document.querySelectorAll('iframe[src]').forEach(f => add(f.src));
  }} catch (e) {{}}
  try {{
    if (typeof performance !== 'undefined' && performance.getEntriesByType) {{
      performance.getEntriesByType('resource').forEach(e => add(e.name));
    }}
  }} catch (e) {{}}

  function matchOperator(u) {{
    try {{
      const parsed = new URL(u);
      return parsed.searchParams.get('operatorGameId') === wanted;
    }} catch (e) {{
      return false;
    }}
  }}

  return found.find(matchOperator) || found[0] || null;
}})()"#
    );

    for page in pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if page_type != "page" {
            continue;
        }

        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_debugger_url = match page.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
            Some(ws) => ws,
            None => continue,
        };

        // Skip internal pages quickly
        if page_url.starts_with("chrome://") || page_url.starts_with("devtools://") {
            continue;
        }

        let connect_res =
            tokio::time::timeout(Duration::from_secs(2), connect_async(ws_debugger_url)).await;
        let (ws_stream, _) = match connect_res {
            Ok(Ok(v)) => v,
            _ => continue,
        };

        let (mut write, mut read) = ws_stream.split();

        let _ = write
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::json!({
                    "id": 1,
                    "method": "Runtime.enable"
                })
                .to_string(),
            ))
            .await;

        let eval_cmd = serde_json::json!({
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true
            }
        });

        if write
            .send(tokio_tungstenite::tungstenite::Message::Text(
                eval_cmd.to_string(),
            ))
            .await
            .is_err()
        {
            continue;
        }

        let result = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(msg) = read.next().await {
                if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if json.get("id").and_then(|v| v.as_i64()) == Some(2) {
                            return json
                                .get("result")
                                .and_then(|v| v.get("result"))
                                .and_then(|v| v.get("value"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                        }
                    }
                }
            }
            None
        })
        .await
        .ok()
        .flatten();

        if let Some(url) = result {
            info!(
                "🎲 Captured Pragmatic launcher URL (page_url_len={}, launcher_url_len={}, has_jsession={})",
                page_url.len(),
                url.len(),
                url.to_ascii_lowercase().contains("jsessionid=")
            );
            return Some(url);
        }
    }

    None
}

/// Dynamically capture tableId-operatorGameId mappings from Pragmatic lobby DOM.
/// Parses elements with id="tableId-operatorGameId" format (e.g., "413-SpeedBacL1").
async fn capture_pragmatic_table_mappings_from_dom() -> Vec<(String, String)> {
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio_tungstenite::connect_async;

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let response = match reqwest::get(&cdp_url).await {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let pages: Vec<serde_json::Value> = match response.json().await {
        Ok(p) => p,
        Err(_) => return vec![],
    };

    // JavaScript to extract tableId-operatorGameId mappings AND session info from DOM
    let expression = r#"(function() {
  const result = {
    mappings: [],
    sessionInfo: {}
  };

  // 1. Extract tableId-operatorGameId mappings from DOM IDs
  // Pragmatic lobby often uses IDs like "101-baccarat1"
  document.querySelectorAll('[id]').forEach(el => {
    const id = el.id;
    const parts = id.split('-');
    if (parts.length === 2 && /^\d+$/.test(parts[0])) {
      result.mappings.push({ tableId: parts[0], operatorGameId: parts[1] });
    }
  });

  // 2. Extract session info (JSESSIONID) from sessionStorage or global vars
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && (key.includes('JSESSIONID') || key.includes('session') || key.includes('token'))) {
            result.sessionInfo[key] = sessionStorage.getItem(key);
        }
    }
  } catch(e) {}

  // 3. Fallback: try to find common session keys in window object
  const commonKeys = ['JSESSIONID', 'operatorToken', 'session_id'];
  commonKeys.forEach(k => {
    if (window[k]) result.sessionInfo[k] = window[k];
  });

  return JSON.stringify(result);
})()"#;

    let mut all_mappings: Vec<(String, String)> = vec![];

    for page in pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if page_type != "page" {
            continue;
        }

        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");

        // Only check Pragmatic lobby pages
        if !page_url.contains("pragmaticplaylive.net") {
            continue;
        }

        let ws_debugger_url = match page.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
            Some(ws) => ws,
            None => continue,
        };

        let connect_res =
            tokio::time::timeout(Duration::from_secs(2), connect_async(ws_debugger_url)).await;
        let (ws_stream, _) = match connect_res {
            Ok(Ok(v)) => v,
            _ => continue,
        };

        let (mut write, mut read) = ws_stream.split();

        let _ = write
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::json!({
                    "id": 1,
                    "method": "Runtime.enable"
                })
                .to_string(),
            ))
            .await;

        let eval_cmd = serde_json::json!({
            "id": 2,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true
            }
        });

        if write
            .send(tokio_tungstenite::tungstenite::Message::Text(
                eval_cmd.to_string(),
            ))
            .await
            .is_err()
        {
            continue;
        }

        let result_str = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(msg) = read.next().await {
                if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        if json.get("id").and_then(|v| v.as_i64()) == Some(2) {
                            return json
                                .get("result")
                                .and_then(|v| v.get("result"))
                                .and_then(|v| v.get("value"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                        }
                    }
                }
            }
            None
        })
        .await
        .ok()
        .flatten();

        if let Some(json_str) = result_str {
            if let Ok(res_obj) = serde_json::from_str::<serde_json::Value>(&json_str) {
                // 1. Process mappings
                if let Some(mappings) = res_obj.get("mappings").and_then(|v| v.as_array()) {
                    for m in mappings {
                        if let (Some(table_id), Some(op_id)) = (
                            m.get("tableId").and_then(|v| v.as_str()),
                            m.get("operatorGameId").and_then(|v| v.as_str()),
                        ) {
                            all_mappings.push((table_id.to_string(), op_id.to_string()));
                        }
                    }
                }

                // 2. Check for JSESSIONID and potentially update PRAGMATIC_LAUNCHER_URL
                // This is a bit advanced: if we found a JSESSIONID, we can store it or construct a base launcher URL
                if let Some(session_info) = res_obj.get("sessionInfo").and_then(|v| v.as_object()) {
                    let jsessionid = session_info
                        .get("JSESSIONID")
                        .and_then(|v| v.as_str())
                        .or_else(|| session_info.values().find_map(|v| v.as_str()));

                    if let Some(sid) = jsessionid {
                        info!("🎲 Found Pragmatic session key from DOM/storage: {}", sid);
                        // If we don't have a launcher URL yet, we could construct a basic one
                        if PRAGMATIC_LAUNCHER_URL.lock().unwrap().is_none() {
                            let basic_url = format!("https://client.pragmaticplaylive.net/desktop/launcher/?JSESSIONID={}", sid);
                            *PRAGMATIC_LAUNCHER_URL.lock().unwrap() = Some(basic_url);
                        }
                    }
                }
            }

            if !all_mappings.is_empty() {
                info!(
                    "🎲 Captured {} tableId-operatorGameId mappings from Pragmatic lobby DOM",
                    all_mappings.len()
                );
                break;
            }
        }
    }
    all_mappings
}

/// CDP (Chrome DevTools Protocol) port for debugging
const CDP_PORT: u16 = 9222;

/// Check if a Chrome instance with remote debugging is already listening AND has active pages
async fn is_cdp_alive() -> bool {
    // 1. Check version info (fastest)
    let version_url = format!("http://127.0.0.1:{}/json/version", CDP_PORT);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    if client.get(&version_url).send().await.is_err() {
        return false;
    }

    // 2. Check for at least one active "page" target
    // If Chrome is running but has no windows, /json will return an empty array or only background targets
    let json_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    if let Ok(resp) = client.get(&json_url).send().await {
        if let Ok(pages) = resp.json::<Vec<serde_json::Value>>().await {
            return pages
                .iter()
                .any(|p| p.get("type").and_then(|v| v.as_str()) == Some("page"));
        }
    }

    false
}

/// Open Chrome with debugging enabled and auto-capture WebSocket
#[tauri::command]
pub async fn open_in_chrome(app: AppHandle, url: String) -> Result<(), String> {
    info!(
        "🌐 Opening Chrome with CDP debugging (url_len={})",
        url.len()
    );

    if let Ok(mut pending_url) = PENDING_CHROME_URL.lock() {
        *pending_url = Some(url.clone());
    }

    // If Chrome with remote debugging is already running AND has pages, reuse it
    if is_cdp_alive().await {
        info!(
            "✅ Existing Chrome remote debugging detected on {} - reusing",
            CDP_PORT
        );
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.emit(
                "chrome-cdp-ready",
                serde_json::json!({
                    "port": CDP_PORT,
                    "url": url
                }),
            );
        }
        return Ok(());
    }

    // If we are here, either Chrome is not running or it's a zombie (no pages)
    // Try to kill it first to avoid "Address already in use" errors
    let _ = kill_chrome().await;
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    // Use a dedicated profile directory for CDP debugging
    // Chrome requires a non-default profile for remote debugging
    let user_data_dir = if let Ok(data_dir) = app.path().app_data_dir() {
        data_dir.join("chrome-cdp-profile")
    } else {
        std::path::PathBuf::from("/tmp/bcr-chrome-cdp")
    };

    // Create the directory if it doesn't exist
    let _ = std::fs::create_dir_all(&user_data_dir);
    let user_data_dir_str = user_data_dir.to_string_lossy().to_string();

    info!("📁 Chrome user data dir: {}", user_data_dir_str);

    #[cfg(target_os = "macos")]
    {
        // Launch Chrome with remote debugging enabled
        let child = std::process::Command::new(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        )
        .args([
            &format!("--remote-debugging-port={}", CDP_PORT),
            &format!("--user-data-dir={}", user_data_dir_str),
            "--no-first-run",
            "--no-default-browser-check",
            // Background throttling prevention
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "about:blank",
        ])
        .spawn()
        .map_err(|e| format!("Failed to open Chrome: {}. Is Chrome installed?", e))?;

        // Store PID for cleanup on exit
        CHROME_PID.store(child.id(), Ordering::SeqCst);
        info!("📌 Chrome PID stored: {}", child.id());
    }

    #[cfg(target_os = "windows")]
    {
        // Find Chrome executable path on Windows
        let chrome_paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            &format!(
                r"{}\Google\Chrome\Application\chrome.exe",
                std::env::var("LOCALAPPDATA").unwrap_or_default()
            ),
            &format!(
                r"{}\Google\Chrome\Application\chrome.exe",
                std::env::var("PROGRAMFILES").unwrap_or_default()
            ),
            &format!(
                r"{}\Google\Chrome\Application\chrome.exe",
                std::env::var("PROGRAMFILES(X86)").unwrap_or_default()
            ),
        ];

        let chrome_path = chrome_paths
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .map(|s| s.to_string())
            .ok_or_else(|| "Chrome not found. Please install Google Chrome.".to_string())?;

        info!("🌐 Found Chrome at: {}", chrome_path);

        // CRITICAL: Background throttling flags keep WebSocket active even when tab is not focused
        let child = std::process::Command::new(&chrome_path)
            .args([
                &format!("--remote-debugging-port={}", CDP_PORT),
                &format!("--user-data-dir={}", user_data_dir_str),
                "--no-first-run",
                "--no-default-browser-check",
                // Prevent ALL background throttling for lobby WebSocket monitoring
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=IntensiveWakeUpThrottling,OptOutOfBackForwardCache",
                "--disable-hang-monitor",
                "--disable-ipc-flooding-protection",
                "--disable-background-networking=false",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "about:blank",
            ])
            .spawn()
            .map_err(|e| format!("Failed to open Chrome: {}. Path: {}", e, chrome_path))?;

        // Store PID for cleanup on exit
        CHROME_PID.store(child.id(), Ordering::SeqCst);
        info!("📌 Chrome PID stored: {}", child.id());
    }

    #[cfg(target_os = "linux")]
    {
        // CRITICAL: Background throttling flags keep WebSocket active even when tab is not focused
        std::process::Command::new("google-chrome")
            .args([
                &format!("--remote-debugging-port={}", CDP_PORT),
                &format!("--user-data-dir={}", user_data_dir_str),
                "--no-first-run",
                "--no-default-browser-check",
                // Prevent ALL background throttling for lobby WebSocket monitoring
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=IntensiveWakeUpThrottling,OptOutOfBackForwardCache",
                "--disable-hang-monitor",
                "--disable-ipc-flooding-protection",
                "--disable-background-networking=false",
                "--enable-features=NetworkService,NetworkServiceInProcess",
                "about:blank",
            ])
            .spawn()
            .or_else(|_| {
                std::process::Command::new("chromium-browser")
                    .args([
                        &format!("--remote-debugging-port={}", CDP_PORT),
                        &format!("--user-data-dir={}", user_data_dir_str),
                        "--no-first-run",
                        "--no-default-browser-check",
                        "--disable-background-timer-throttling",
                        "--disable-backgrounding-occluded-windows",
                        "--disable-renderer-backgrounding",
                        "--disable-features=IntensiveWakeUpThrottling,OptOutOfBackForwardCache",
                        "--disable-hang-monitor",
                        "--disable-ipc-flooding-protection",
                        "about:blank",
                    ])
                    .spawn()
            })
            .map_err(|e| format!("Failed to open Chrome: {}", e))?;
    }

    // Wait for Chrome to start
    std::thread::sleep(std::time::Duration::from_secs(3));

    // Notify frontend that Chrome is ready for CDP monitoring
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.emit(
            "chrome-cdp-ready",
            serde_json::json!({
                "port": CDP_PORT,
                "url": url
            }),
        );
    }

    Ok(())
}

/// Open Chrome normally (without CDP)
#[tauri::command]
pub async fn open_in_chrome_normal(url: String) -> Result<(), String> {
    info!("🌐 Opening Chrome (normal mode, url_len={})", url.len());

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Google Chrome", &url])
            .spawn()
            .map_err(|e| format!("Failed to open Chrome: {}. Is Chrome installed?", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        // Find Chrome executable path on Windows
        let chrome_paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            &format!(
                r"{}\Google\Chrome\Application\chrome.exe",
                std::env::var("LOCALAPPDATA").unwrap_or_default()
            ),
            &format!(
                r"{}\Google\Chrome\Application\chrome.exe",
                std::env::var("PROGRAMFILES").unwrap_or_default()
            ),
            &format!(
                r"{}\Google\Chrome\Application\chrome.exe",
                std::env::var("PROGRAMFILES(X86)").unwrap_or_default()
            ),
        ];

        let chrome_path = chrome_paths
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .map(|s| s.to_string())
            .ok_or_else(|| "Chrome not found. Please install Google Chrome.".to_string())?;

        std::process::Command::new(&chrome_path)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open Chrome: {}. Path: {}", e, chrome_path))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("google-chrome")
            .arg(&url)
            .spawn()
            .or_else(|_| {
                std::process::Command::new("chromium-browser")
                    .arg(&url)
                    .spawn()
            })
            .map_err(|e| format!("Failed to open Chrome: {}", e))?;
    }

    Ok(())
}

/// Evolution Gaming WebSocket patterns for detection
const EVOLUTION_PATTERNS: &[&str] = &[
    "evo-games",
    "evolution",
    "pobf",
    "evo-ply",
    "evogames",
    "skylinextm",
    "evo-",
    "evolution-gaming",
    "evolutiongaming",
    "/dao/",
    "/evo/",
    "live-games",
    "livecasino",
    "lobby.websocket",
    "game.websocket",
    "ws.live",
    "baccarat",
    "blackjack",
    "roulette",
    "sicbo",
    "/frontend/",
    "/game-api/",
    "/socket.io",
    "xtm.evo",
    "cdn-evo",
    "static.evo",
];

const PRAGMATIC_PATTERNS: &[&str] = &[
    "pragmatic",
    "ppgames",
    "pragmaticplay",
    "gs2c",
    "prp.insvr", // Pragmatic specific
    "prelivegs", // Pragmatic live games
];

/// Check if URL is Evolution Gaming related
fn is_evolution_url(url: &str) -> bool {
    let lower_url = url.to_lowercase();

    // Check patterns
    for pattern in EVOLUTION_PATTERNS {
        if lower_url.contains(pattern) {
            return true;
        }
    }

    // Check WebSocket URLs with lobby/game keywords
    if (lower_url.starts_with("wss://") || lower_url.starts_with("ws://"))
        && (lower_url.contains("lobby") || lower_url.contains("game"))
    {
        return true;
    }

    false
}

/// Check if URL is Pragmatic Play related
fn is_pragmatic_url(url: &str) -> bool {
    let lower_url = url.to_lowercase();
    for pattern in PRAGMATIC_PATTERNS {
        if lower_url.contains(pattern) {
            return true;
        }
    }
    false
}

/// Check if JSON payload is a Pragmatic message by content structure
/// Pragmatic messages have: tableId + (tableType or statistics or gameResult or tableName)
/// Evolution messages have: type field starting with "lobby." or "game." and args field
fn is_pragmatic_message_content(json_msg: &serde_json::Value) -> bool {
    // Must have tableId (Pragmatic uses camelCase tableId)
    let has_table_id = json_msg.get("tableId").is_some();

    // If has Evolution-style type field (lobby.*, game.*), it's NOT Pragmatic
    if let Some(type_val) = json_msg.get("type").and_then(|v| v.as_str()) {
        if type_val.starts_with("lobby.") || type_val.starts_with("game.") {
            return false;
        }
    }

    // Pragmatic-specific fields: statistics, gameResult, tableType, tableName, totalSeatedPlayers
    let has_pragmatic_field = json_msg.get("statistics").is_some()
        || json_msg.get("gameResult").is_some()
        || json_msg.get("tableType").is_some()
        || json_msg.get("tableName").is_some()
        || json_msg.get("totalSeatedPlayers").is_some();

    has_table_id && has_pragmatic_field
}

/// Manual WebSocket connection request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualConnectRequest {
    pub ws_url: String,
    pub cookies: Option<String>,
}

/// Manually connect to Evolution WebSocket with provided credentials
#[tauri::command]
pub async fn connect_evolution_manual(
    app: AppHandle,
    request: ManualConnectRequest,
) -> Result<bool, String> {
    info!("🔌 Manual Evolution WebSocket connection requested");
    info!(
        "   WebSocket metadata: url_len={}, has_session_query={}, has_cookie={}",
        request.ws_url.len(),
        request
            .ws_url
            .to_ascii_lowercase()
            .contains("evosessionid="),
        request
            .cookies
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    );

    // Validate URL
    if !request.ws_url.starts_with("wss://") && !request.ws_url.starts_with("ws://") {
        return Err("Invalid WebSocket URL. Must start with wss:// or ws://".to_string());
    }

    // Emit connection request to frontend (which will coordinate with Rust backend)
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.emit("evolution-connect-request", &request);
    }

    Ok(true)
}

/// CDP WebSocket monitoring - polls for pages and monitors WebSocket traffic
/// Continuously monitors ALL pages for Evolution Gaming WebSocket messages
/// This allows monitoring both lobby and room tabs simultaneously
#[tauri::command]
pub async fn start_cdp_monitoring(
    app: AppHandle,
    app_mode: Option<String>,
) -> Result<bool, String> {
    let mode = app_mode.unwrap_or_else(|| "auto".to_string());
    info!(
        "🔍 Starting CDP WebSocket monitoring on port {} (mode: {})",
        CDP_PORT, mode
    );

    CDP_SHOULD_STOP.store(true, std::sync::atomic::Ordering::SeqCst);
    CDP_TASK_REGISTRY.abort(CDP_MONITOR_KEY);
    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

    // Store app mode for use in monitoring loop
    if let Ok(mut stored_mode) = CDP_APP_MODE.lock() {
        *stored_mode = mode.clone();
    }

    // Reset all flags when starting CDP monitoring
    CDP_SHOULD_STOP.store(false, std::sync::atomic::Ordering::SeqCst);
    MULTIWIDGET_CONNECTED.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut lobby_id) = LOBBY_PAGE_ID.lock() {
        *lobby_id = None;
    }
    info!("🔄 Reset connection flags: CDP_SHOULD_STOP=false, MULTIWIDGET_CONNECTED=false, LOBBY_PAGE_ID=None");

    let app_handle = app.clone();

    // Spawn async task to poll for pages and monitor them.
    // Lane R2: capture the JoinHandle and store it in CDP_TASK_REGISTRY so
    // stop/restart can hard-abort it as a safety net on top of CDP_SHOULD_STOP.
    let cdp_handle = tokio::spawn(async move {
        // Wait a bit for Chrome to fully initialize
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        // Track monitored page IDs (pages we've already started monitoring)
        let monitored_pages: std::sync::Arc<tokio::sync::Mutex<std::collections::HashSet<String>>> =
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new()));

        // Track count of Evolution pages found (for logging)
        let evolution_count: std::sync::Arc<std::sync::atomic::AtomicU32> =
            std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));

        // Notify frontend that CDP is monitoring
        if let Some(main_window) = app_handle.get_webview_window("main") {
            let _ = main_window.emit("cdp-monitoring-started", ());
        }

        // Continuously poll for new pages
        //
        // CRITICAL DESIGN DECISION (bcrstore 방식):
        // - 모든 페이지를 CDP 모니터링하되, 첫 번째로 Evolution WebSocket이 발견된 페이지만 실제로 메시지 캡처
        // - 방 페이지(table_id 포함)는 CDP 연결은 하지만 Network.enable을 하지 않음
        // - 로비 페이지만 Network.enable → WebSocket 메시지 캡처
        // - Evolution 서버는 방 페이지에서 Network.enable하면 로비 데이터 전송을 중단함
        //
        // 탐지 방식:
        // - table_id가 URL에 있으면 → 방 페이지 (CDP 모니터링 안 함)
        // - Evolution WebSocket이 감지되면 → 로비 페이지 (CDP 모니터링)
        loop {
            if CDP_SHOULD_STOP.load(std::sync::atomic::Ordering::SeqCst) {
                info!("🛑 CDP polling stopped (stop flag set)");
                break;
            }

            let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);

            match reqwest::get(&cdp_url).await {
                Ok(response) => {
                    if let Ok(pages) = response.json::<Vec<serde_json::Value>>().await {
                        for page in pages {
                            let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            let page_id = page.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            let ws_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());
                            let is_pragmatic_page = is_pragmatic_url(page_url);
                            let is_evo_page = is_evolution_url(page_url);

                            // 🎲 Pragmatic launcher URL 캡처 - 게임 테이블 입장 시 URL 저장
                            // launcher URL에는 JSESSIONID, casino_id 등 모든 세션 정보가 포함됨
                            if page_url.contains("pragmaticplaylive.net/desktop/launcher") {
                                info!(
                                    "🎲 Pragmatic launcher URL detected (url_len={}, has_jsession={})",
                                    page_url.len(),
                                    page_url.to_ascii_lowercase().contains("jsessionid=")
                                );
                                if let Ok(mut guard) = PRAGMATIC_LAUNCHER_URL.lock() {
                                    *guard = Some(page_url.to_string());
                                    info!("🎲 Pragmatic launcher URL saved for room navigation");
                                }
                            }

                            // Only check pages that have WebSocket debugger URL
                            if page_type == "page" && !page_id.is_empty() {
                                let mut monitored = monitored_pages.lock().await;
                                if !monitored.contains(page_id) {
                                    // Extract table_id from page URL (for room-specific pages)
                                    let table_id = extract_table_id_from_url(page_url);

                                    // Evolution 방 페이지: WebSocket URL 캡처만 하고 메시지는 전달하지 않음
                                    // (로비 데이터 전송 간섭 방지 + 세션 캡처용)
                                    let is_room_page =
                                        table_id.is_some() && is_evo_page && !is_pragmatic_page;

                                    if is_room_page {
                                        info!(
                                            "🎰 Evolution room page detected: {} - table_id: {}",
                                            page_id,
                                            table_id.as_ref().unwrap()
                                        );
                                        monitored.insert(page_id.to_string());

                                        // Notify frontend that room tab was opened
                                        if let Some(main_window) =
                                            app_handle.get_webview_window("main")
                                        {
                                            let _ = main_window.emit(
                                                "room-tab-opened",
                                                serde_json::json!({
                                                    "pageId": page_id,
                                                    "tableId": table_id.clone(),
                                                    "url": page_url
                                                }),
                                            );
                                        }

                                        // Start lightweight monitoring for room WebSocket URL capture only
                                        if let Some(ws_debugger_url) = ws_url {
                                            let app_clone = app_handle.clone();
                                            let ws_url_owned = ws_debugger_url.to_string();
                                            let page_id_owned = page_id.to_string();
                                            let table_id_owned = table_id.clone().unwrap();

                                            tokio::spawn(async move {
                                                if let Err(e) = monitor_room_page_for_session(
                                                    &app_clone,
                                                    &ws_url_owned,
                                                    &page_id_owned,
                                                    &table_id_owned,
                                                )
                                                .await
                                                {
                                                    debug!(
                                                        "Room page {} session capture ended: {}",
                                                        page_id_owned, e
                                                    );
                                                }
                                            });
                                        }
                                        continue; // Don't do full monitoring - just session capture
                                    }

                                    // For non-room pages, try CDP monitoring to find Evolution lobby
                                    if let Some(ws_debugger_url) = ws_url {
                                        info!(
                                            "🔍 New page detected: {} url_len={}",
                                            page_id,
                                            page_url.len()
                                        );
                                        monitored.insert(page_id.to_string());

                                        // Check if this is an Evolution lobby page and set LOBBY_PAGE_ID
                                        let is_lobby_detected = is_evolution_lobby_url(page_url);
                                        info!("🔍 Lobby check for {}: is_evo_page={}, is_lobby_detected={}", page_id, is_evo_page, is_lobby_detected);

                                        // Also check if it's an Evolution page (by WebSocket URL pattern or page URL)
                                        // If it's an Evolution page without table_id, treat it as lobby
                                        // ✅ Pragmatic pages are always treated as lobby for persistent monitoring
                                        let should_be_lobby = is_lobby_detected
                                            || (is_evo_page && !page_url.contains("table_id="))
                                            || is_pragmatic_page;

                                        if should_be_lobby {
                                            if is_pragmatic_page {
                                                info!(
                                                    "🏛️ Setting LOBBY_PAGE_ID to: {} (Pragmatic)",
                                                    page_id
                                                );
                                            } else {
                                                info!("🏛️ Setting LOBBY_PAGE_ID to: {}", page_id);
                                                // ❌ 여기서는 base URL 캡처 안함!
                                                // 이건 중계사이트 URL (sloten.io)
                                                // 실제 멀티소켓 연결 URL (babylon)이 캡처될 때 저장
                                                info!(
                                                    "📍 Lobby page detected (relay site): {}",
                                                    page_url
                                                );
                                            }
                                            *LOBBY_PAGE_ID.lock().unwrap() =
                                                Some(page_id.to_string());
                                        }

                                        // Start monitoring this page for Evolution WebSocket
                                        let app_clone = app_handle.clone();
                                        let ws_url_owned = ws_debugger_url.to_string();
                                        let page_id_owned = page_id.to_string();
                                        let page_url_owned = page_url.to_string();
                                        let evolution_count_clone = evolution_count.clone();
                                        let monitored_pages_clone = monitored_pages.clone();

                                        tokio::spawn(async move {
                                            match monitor_page_continuously(
                                                &app_clone,
                                                &ws_url_owned,
                                                &page_id_owned,
                                                &page_url_owned,
                                                None,
                                                should_be_lobby,
                                            )
                                            .await
                                            {
                                                Ok(found_evolution) => {
                                                    if found_evolution {
                                                        let count =
                                                            evolution_count_clone.fetch_add(
                                                                1,
                                                                std::sync::atomic::Ordering::SeqCst,
                                                            ) + 1;
                                                        info!(
                                                            "🎯 Evolution page #{} connected: {}",
                                                            count, page_id_owned
                                                        );
                                                    }
                                                }
                                                Err(e) => {
                                                    debug!(
                                                        "Page {} monitoring ended: {}",
                                                        page_id_owned, e
                                                    );
                                                }
                                            }
                                            // Remove from monitored when connection closes (allows reconnection)
                                            monitored_pages_clone
                                                .lock()
                                                .await
                                                .remove(&page_id_owned);
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    // Chrome might have closed, stop monitoring
                    warn!("❌ CDP connection lost: {}", e);
                    if let Some(main_window) = app_handle.get_webview_window("main") {
                        let _ = main_window.emit(
                            "cdp-connection-failed",
                            serde_json::json!({
                                "error": e.to_string()
                            }),
                        );
                    }
                    break;
                }
            }

            // Poll every 2 seconds (slightly longer for stability)
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    });

    // Lane R2: register the polling task. If a previous CDP monitor task is
    // still alive (e.g. start_cdp_monitoring was called twice without an
    // explicit stop), `insert` aborts the prior handle before installing the
    // new one — guaranteeing idempotency and zero JoinHandle leaks.
    CDP_TASK_REGISTRY.insert(CDP_MONITOR_KEY, cdp_handle);

    Ok(true)
}

/// Lightweight monitoring for Evolution room pages to capture WebSocket URL for session
/// Only captures the WebSocket creation event, does NOT forward messages
/// This allows us to get the session info without interfering with lobby data
async fn monitor_room_page_for_session(
    app: &AppHandle,
    ws_debugger_url: &str,
    page_id: &str,
    table_id: &str,
) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    info!(
        "🔍 [Room Session Capture] Starting for page {} (table: {})",
        page_id, table_id
    );

    // Connect to CDP
    let (ws_stream, _) = connect_async(ws_debugger_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let (mut write, mut read) = ws_stream.split();

    // Enable Network domain
    let enable_network = serde_json::json!({
        "id": 1,
        "method": "Network.enable"
    });

    write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            enable_network.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to enable Network: {}", e))?;

    let app_handle = app.clone();
    let table_id_owned = table_id.to_string();
    let page_id_owned = page_id.to_string();

    // Listen for WebSocket creation events only (with timeout)
    let timeout = tokio::time::Duration::from_secs(30);
    let start = tokio::time::Instant::now();

    while let Some(msg) = read.next().await {
        // Check timeout
        if start.elapsed() > timeout {
            info!(
                "[Room Session Capture] Timeout waiting for WebSocket on page {}",
                page_id_owned
            );
            break;
        }

        if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                let method = json.get("method").and_then(|v| v.as_str()).unwrap_or("");

                // Only care about WebSocket creation
                if method == "Network.webSocketCreated" {
                    if let Some(params) = json.get("params") {
                        let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");

                        // Check if this is an Evolution room WebSocket
                        if url.contains("/game/") && url.contains("EVOSESSIONID") {
                            info!(
                                "🎯 [Room Session Capture] Evolution room WebSocket captured (url_len={}, has_session_query=true)",
                                url.len()
                            );

                            // Emit event for frontend to capture session
                            if let Some(main_window) = app_handle.get_webview_window("main") {
                                let _ = main_window.emit(
                                    "evolution-room-websocket-captured",
                                    serde_json::json!({
                                        "wsUrl": url,
                                        "tableId": table_id_owned,
                                        "pageId": page_id_owned
                                    }),
                                );
                            }

                            // Done - we got what we needed
                            info!(
                                "[Room Session Capture] Session captured for table {}, closing monitor",
                                table_id_owned
                            );
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

/// Extract table_id from a room page URL
/// URL format: ...#category=baccarat&game=baccarat&table_id=ndgvwvgthfuaad3q&...
fn extract_table_id_from_url(url: &str) -> Option<String> {
    // Evolution: table_id
    if let Some(start) = url.find("table_id=") {
        let after_key = &url[start + 9..]; // Skip "table_id="
        let end = after_key.find(['&', '#', ' ']).unwrap_or(after_key.len());
        let table_id = &after_key[..end];
        if !table_id.is_empty() {
            return Some(table_id.to_string());
        }
    }

    // Pragmatic: tableId
    if let Some(start) = url.find("tableId=") {
        let after_key = &url[start + 8..]; // Skip "tableId="
        let end = after_key.find(['&', '#', ' ']).unwrap_or(after_key.len());
        let table_id = &after_key[..end];
        if !table_id.is_empty() {
            return Some(table_id.to_string());
        }
    }

    None
}

/// Check if URL is an Evolution lobby page (not a specific room)
fn is_evolution_lobby_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    // Lobby URL contains evo-games but doesn't have table_id
    // More lenient: just check for evo-games and no table_id
    let is_evo = lower.contains("evo-games") || lower.contains("evolution");
    let has_table_id = lower.contains("table_id=");
    let has_lobby_indicator = lower.contains("lobby")
        || lower.contains("pobf")
        || lower.contains("frontend")
        || lower.contains("baccarat");

    let result = is_evo && !has_table_id && has_lobby_indicator;
    debug!(
        "🔍 is_evolution_lobby_url(url_len={}) -> is_evo={}, has_table_id={}, has_lobby_indicator={}, result={}",
        url.len(),
        is_evo,
        has_table_id,
        has_lobby_indicator,
        result
    );
    result
}

/// Find lobby tab WebSocket URL from CDP pages list
/// Returns the WebSocket debugger URL of the lobby tab (Evolution page without table_id=)
/// This is used to navigate the lobby tab to a room, keeping the session alive
fn find_lobby_tab_ws_url(pages: &[serde_json::Value]) -> Option<String> {
    for page in pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_debugger_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());

        if page_type == "page" && is_evolution_lobby_url(page_url) {
            if let Some(ws_url) = ws_debugger_url {
                info!("🏠 Found Evolution lobby tab (url_len={})", page_url.len());
                return Some(ws_url.to_string());
            }
        }
    }
    None
}

/// Monitor a page continuously for Evolution WebSocket messages
/// Returns true if Evolution WebSocket was found on this page
/// table_id is Some if this is a room-specific page (extracted from URL)
///
/// CRITICAL: For lobby pages, this function will NEVER return - it will keep reconnecting
/// until the application is closed. This ensures lobby WebSocket monitoring is always active.
async fn monitor_page_continuously(
    app: &AppHandle,
    ws_debugger_url: &str,
    page_id: &str,
    page_url: &str,
    table_id: Option<&str>,
    is_lobby_candidate: bool,
) -> Result<bool, String> {
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio_tungstenite::connect_async;

    // Check if this is the lobby page
    let is_lobby = {
        let lobby_id = LOBBY_PAGE_ID.lock().unwrap();
        lobby_id.as_ref().map(|id| id == page_id).unwrap_or(false)
    };

    if is_lobby {
        info!(
            "🏛️ Starting LOBBY monitoring for page {} (PERSISTENT MODE)",
            page_id
        );
    } else {
        debug!(
            "🔌 Starting continuous monitoring for page {} (table_id: {:?})",
            page_id, table_id
        );
    }

    let app_handle = app.clone();
    let is_lobby_page = is_lobby;
    let page_id_owned = page_id.to_string();
    let page_url_owned = page_url.to_string();
    let table_id_owned = table_id.map(|s| s.to_string());
    let ws_url_owned = ws_debugger_url.to_string();

    // Flag to track if Evolution is found on this page (persists across reconnects for lobby)
    let evolution_found = Arc::new(AtomicBool::new(false));

    // Reconnect loop - for lobby pages, this runs forever
    let mut reconnect_count = 0u32;
    let max_reconnects = if is_lobby_page { u32::MAX } else { 3 }; // Lobby: infinite, Room: 3 attempts

    // Track last detected provider for this page (rough heuristic)
    let mut last_ws_provider: Option<String> = None;
    let mut last_ws_url: Option<String> = None;

    loop {
        // Check if CDP monitoring should stop (Evolution session captured, using direct room sockets)
        if CDP_SHOULD_STOP.load(std::sync::atomic::Ordering::SeqCst) {
            info!(
                "🛑 CDP monitoring stopped for page {} - using direct room sockets now",
                page_id_owned
            );
            return Ok(evolution_found.load(Ordering::SeqCst));
        }

        if is_lobby_page {
            let is_still_active_lobby = {
                let lobby_id = LOBBY_PAGE_ID.lock().unwrap();
                lobby_id
                    .as_ref()
                    .map(|id| id == &page_id_owned)
                    .unwrap_or(false)
            };

            if !is_still_active_lobby {
                info!(
                    "Lobby monitor for page {} stopped because another lobby target is active",
                    page_id_owned
                );
                return Ok(evolution_found.load(Ordering::SeqCst));
            }
        }

        if reconnect_count > 0 {
            if is_lobby_page {
                info!(
                    "🔄 LOBBY reconnect attempt #{} for page {}",
                    reconnect_count, page_id_owned
                );
            } else {
                debug!(
                    "🔄 Reconnect attempt #{} for page {}",
                    reconnect_count, page_id_owned
                );
            }
            // Wait before reconnecting (exponential backoff, max 10 seconds)
            let delay = std::cmp::min(1000 * (1 << std::cmp::min(reconnect_count, 3)), 10000);
            tokio::time::sleep(tokio::time::Duration::from_millis(delay as u64)).await;
        }

        // Try to connect
        let ws_result = connect_async(&ws_url_owned).await;
        let (ws_stream, _) = match ws_result {
            Ok(stream) => stream,
            Err(e) => {
                if is_lobby_page {
                    warn!("🔴 LOBBY CDP connection failed: {}, will retry...", e);
                    reconnect_count += 1;
                    continue; // Keep trying for lobby
                } else {
                    if reconnect_count >= max_reconnects {
                        return Err(format!(
                            "Failed to connect to CDP page after {} attempts: {}",
                            reconnect_count, e
                        ));
                    }
                    reconnect_count += 1;
                    continue;
                }
            }
        };

        let (write_raw, mut read) = ws_stream.split();
        // Wrap write in Arc<Mutex> so it can be shared with spawned tasks
        let write = std::sync::Arc::new(tokio::sync::Mutex::new(write_raw));

        // Enable Page domain (required for addScriptToEvaluateOnNewDocument)
        let enable_page = serde_json::json!({
            "id": 0,
            "method": "Page.enable"
        });

        if let Err(e) = write
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                enable_page.to_string(),
            ))
            .await
        {
            debug!("Failed to enable Page domain: {}", e);
            // Continue anyway
        }

        // Enable Network domain to monitor WebSocket connections
        let enable_network = serde_json::json!({
            "id": 1,
            "method": "Network.enable"
        });

        if let Err(e) = write
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                enable_network.to_string(),
            ))
            .await
        {
            if is_lobby_page {
                warn!(
                    "🔴 LOBBY: Failed to enable Network domain: {}, will retry...",
                    e
                );
                reconnect_count += 1;
                continue;
            } else {
                return Err(format!("Failed to enable Network: {}", e));
            }
        }

        // 🔒 PREDICT MODE: Don't block browser WebSocket - let it connect so CDP can capture the URL
        // Rust will connect with the same session info, and the server will close the browser's connection
        // This is simpler and more reliable than trying to block browser WebSockets
        {
            let current_mode = CDP_APP_MODE.lock().map(|m| m.clone()).unwrap_or_default();
            if current_mode == "predict" {
                info!("📊 [PREDICT MODE] CDP monitoring started - will capture lobby WebSocket URL for Rust connection");
            }
        }

        // ✅ Enable auto-attach to iframes AND popups to capture cross-origin WebSockets
        // 🎯 Windows requires explicit filter to detect popups (new windows)
        let auto_attach = serde_json::json!({
            "id": 2,
            "method": "Target.setAutoAttach",
            "params": {
                "autoAttach": true,
                "waitForDebuggerOnStart": false,
                "flatten": true,
                // 🎯 CRITICAL for Windows: filter must include all target types
                "filter": [
                    {"type": "page"},
                    {"type": "iframe"},
                    {"type": "popup"}
                ]
            }
        });

        if let Err(e) = write
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                auto_attach.to_string(),
            ))
            .await
        {
            debug!("Failed to enable auto-attach: {}", e);
            // Continue anyway - main page monitoring still works
        }

        // ✅ Enable target discovery for new windows/tabs (especially needed for Windows)
        // This allows detection of popups that open as new browser windows
        let discover_targets = serde_json::json!({
            "id": 4,
            "method": "Target.setDiscoverTargets",
            "params": {
                "discover": true,
                "filter": [
                    {"type": "page"},
                    {"type": "iframe"}
                ]
            }
        });

        if let Err(e) = write
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                discover_targets.to_string(),
            ))
            .await
        {
            debug!("Failed to enable target discovery: {}", e);
        }

        if reconnect_count > 0 && is_lobby_page {
            info!(
                "✅ LOBBY reconnected successfully after {} attempts",
                reconnect_count
            );
            // Notify frontend that lobby reconnected
            if let Some(main_window) = app_handle.get_webview_window("main") {
                let _ = main_window.emit(
                    "lobby-websocket-reconnected",
                    serde_json::json!({
                        "pageId": page_id_owned,
                        "reconnectCount": reconnect_count
                    }),
                );
            }
        }

        // Reset reconnect count on successful connection
        reconnect_count = 0;

        let evolution_found_clone = evolution_found.clone();

        // Track attached sessions for iframe Network.enable
        let mut attached_sessions: std::collections::HashSet<String> =
            std::collections::HashSet::new();

        // Track execution contexts (main frame + iframes) for WebSocket URL queries
        let mut execution_contexts: Vec<i64> = Vec::new();
        // Map contextId -> sessionId (iframe 컨텍스트는 sessionId 필요)
        let mut context_sessions: std::collections::HashMap<i64, String> =
            std::collections::HashMap::new();

        #[derive(Clone, Default)]
        struct WsHandshakeHeaders {
            cookie: Option<String>,
            user_agent: Option<String>,
            origin: Option<String>,
            referer: Option<String>,
        }

        // Flag to track if we've already sent WebSocket URL queries
        let mut ws_query_sent = false;

        // Track pending cookie requests (request_id -> (ws_url, is_lobby))
        let mut pending_cookie_requests: std::collections::HashMap<u64, (String, bool)> =
            std::collections::HashMap::new();
        let mut cookie_request_id: u64 = 10000;

        // Track WebSocket requestId -> url, and capture handshake headers (Cookie/UA/Origin/Referer)
        // This allows multiwidget auto-connect even when EVOSESSIONID is not present in the URL query.
        let mut ws_url_by_request_id: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let ws_headers_by_request_id: std::sync::Arc<
            TokioMutex<std::collections::HashMap<String, WsHandshakeHeaders>>,
        > = std::sync::Arc::new(TokioMutex::new(std::collections::HashMap::new()));

        // Enable Runtime domain for cookie retrieval
        let enable_runtime = serde_json::json!({
            "id": 3,
            "method": "Runtime.enable"
        });
        if let Err(e) = write
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                enable_runtime.to_string(),
            ))
            .await
        {
            debug!("Failed to enable Runtime domain: {}", e);
        }

        let add_ws_blocker = serde_json::json!({
            "id": 77,
            "method": "Page.addScriptToEvaluateOnNewDocument",
            "params": {
                "source": WS_BLOCKER_SCRIPT
            }
        });
        if let Err(e) = write
            .lock()
            .await
            .send(tokio_tungstenite::tungstenite::Message::Text(
                add_ws_blocker.to_string(),
            ))
            .await
        {
            debug!("Failed to register WS blocker for new documents: {}", e);
        } else {
            info!(
                "[WS-BLOCKER] Registered new-document blocker for page {}",
                page_id_owned
            );
        }

        let can_consume_pending_url =
            page_url_owned.is_empty() || page_url_owned.starts_with("about:blank");
        let pending_url = if can_consume_pending_url {
            PENDING_CHROME_URL
                .lock()
                .ok()
                .and_then(|mut pending| pending.take())
        } else {
            None
        };
        if let Some(pending_url) = pending_url {
            info!(
                "[WS-BLOCKER] Navigating protected page to pending URL (url_len={})",
                pending_url.len()
            );
            let navigate = serde_json::json!({
                "id": 78,
                "method": "Page.navigate",
                "params": {
                    "url": pending_url
                }
            });
            if let Err(e) = write
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    navigate.to_string(),
                ))
                .await
            {
                warn!("[WS-BLOCKER] Failed to navigate protected page: {}", e);
            }
        }

        // Best-effort auto-click multi-table triggers on lobby-like pages
        // 🔥 UNIFIED: Click multiplay button in ALL modes (predict + auto)
        // Now we use multiwidget socket for ALL modes to ensure consistent subscription behavior
        // This triggers multiwidget WebSocket which CDP will detect and Rust will connect to
        if is_lobby_candidate {
            // Ensure category=baccarat in URL hash
            // BUT: Don't touch mwg= hashes (multiwidget mode)!
            let ensure_baccarat_expr = r#"
(function(){
  try{
    var loc = window.location;
    if (!loc || !loc.href || loc.href.indexOf('about:blank') === 0) return {skip:true};
    if (!(loc.hostname || '').includes('evo-games.com')) return {skip:true};
    
    var hash = loc.hash || '';
    
    // 🎯 CRITICAL: Don't modify mwg= hashes (multiwidget/multiplay mode)
    // mwg= 가 있고 .multiplay가 있으면 멀티위젯 모드 - 건드리지 않음
    if (hash.indexOf('mwg=') !== -1 && hash.indexOf('.multiplay') !== -1) {
      return {skip:true, reason:'multiwidget_mode'};
    }
    
    // Force category=baccarat in hash, preserve ua_launch_id if present
    var params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
    var ua = params.get('ua_launch_id');
    params.set('category','baccarat');
    if (ua) params.set('ua_launch_id', ua);
    var newHash = '#' + params.toString();
    if (newHash !== loc.hash) {
      loc.hash = newHash;
      return {changed:true, hash:loc.hash};
    }
    return {changed:false, hash:loc.hash};
  }catch(e){ return {error:e.message}; }
})()
"#;
            let _ = write
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    serde_json::json!({
                        "id": 90,
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": ensure_baccarat_expr,
                            "returnByValue": true,
                            "awaitPromise": true
                        }
                    })
                    .to_string(),
                ))
                .await;

            // Install watcher to keep category=baccarat once evo-games page finishes navigating
            // BUT: Don't touch mwg= hashes (multiwidget mode)!
            let watch_hash_expr = r#"
(function(){
  try{
    if (window.__bcr_hash_watcher_installed) return {installed:true};
    window.__bcr_hash_watcher_installed = true;
    setInterval(function(){
      try{
        var loc = window.location;
        if (!loc || !loc.hostname || loc.hostname.indexOf('evo-games.com') === -1) return;
        var hash = loc.hash || '';
        
        // 🎯 CRITICAL: Don't modify mwg= hashes (multiwidget/multiplay mode)
        // mwg= 가 있고 .multiplay가 있으면 멀티위젯 모드 - 건드리지 않음
        if (hash.indexOf('mwg=') !== -1 && hash.indexOf('.multiplay') !== -1) {
          return;
        }
        
        var params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
        var changed = false;
        if (params.get('category') !== 'baccarat') {
          params.set('category','baccarat');
          changed = true;
        }
        var ua = params.get('ua_launch_id');
        if (ua) params.set('ua_launch_id', ua);
        var newHash = '#' + params.toString();
        if (changed && newHash !== loc.hash) {
          loc.hash = newHash;
        }
      }catch(e){}
    }, 800);
    return {installed:true};
  }catch(e){ return {error:e.message}; }
})()
"#;
            let _ = write
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    serde_json::json!({
                        "id": 91,
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": watch_hash_expr,
                            "returnByValue": true,
                            "awaitPromise": true
                        }
                    })
                    .to_string(),
                ))
                .await;

            let auto_click_expr = r#"
(function(){
  try {
    var nodes = Array.from(document.querySelectorAll('a,button'));
    for (var i=0;i<nodes.length;i++){
      var el = nodes[i];
      var href = (el.getAttribute('href')||'').toLowerCase();
      var txt = (el.textContent||'').toLowerCase();
      if (href.indexOf('multiwidget') !== -1 ||
          href.indexOf('multi') !== -1 ||
          txt.indexOf('multiwidget') !== -1 ||
          txt.indexOf('multi') !== -1 ||
          txt.indexOf('멀티') !== -1) {
        el.click();
        return { clicked:true, href:href, text:txt };
      }
    }
    return { clicked:false };
  } catch(e){ return { clicked:false, error:e.message }; }
})()
"#;

            for attempt in 0..6 {
                let _ = write
                    .lock()
                    .await
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        serde_json::json!({
                            "id": 100 + attempt,
                            "method": "Runtime.evaluate",
                            "params": {
                                "expression": auto_click_expr,
                                "returnByValue": true,
                                "awaitPromise": true
                            }
                        })
                        .to_string(),
                    ))
                    .await;

                tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;
            }
        }

        // Listen for WebSocket events
        while let Some(msg) = read.next().await {
            // Check if CDP should stop (Evolution session captured)
            if CDP_SHOULD_STOP.load(std::sync::atomic::Ordering::SeqCst) {
                info!("🛑 CDP message loop stopped - switching to direct room sockets");
                break;
            }

            match msg {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        let method = json.get("method").and_then(|v| v.as_str()).unwrap_or("");

                        if method == "Runtime.consoleAPICalled" {
                            let args = json
                                .get("params")
                                .and_then(|p| p.get("args"))
                                .and_then(|a| a.as_array());
                            let mut captured_url: Option<String> = None;
                            if let Some(args) = args {
                                let first = args
                                    .get(0)
                                    .and_then(|v| v.get("value"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let second = args
                                    .get(1)
                                    .and_then(|v| v.get("value"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if first.starts_with("[BCR]") {
                                    info!("[BCR-CONSOLE] {} {}", first, second);
                                }
                                if first == "[BCR_WS_CAPTURE]" {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(second)
                                    {
                                        captured_url = v
                                            .get("url")
                                            .and_then(|u| u.as_str())
                                            .map(|s| s.to_string());
                                    }
                                }
                            }

                            if let Some(ws_url_for_connect) = captured_url {
                                let is_multiwidget_ws = ws_url_for_connect
                                    .contains("/multiwidget/")
                                    || ws_url_for_connect.contains("/multiplay/")
                                    || ws_url_for_connect.contains("multiwidget")
                                    || ws_url_for_connect.contains("multiplay")
                                    || ws_url_for_connect.contains("mwLayout");

                                if is_bet_capture_mode() {
                                    // 🧪 캡처 모드: Rust는 멀티위젯에 연결하지 않는다(브라우저가 유일 세션 → 베팅 UI 작동).
                                    info!("[WS-BLOCKER] 🧪 BET-CAPTURE 모드 — Rust 멀티위젯 연결 스킵(브라우저가 세션 보유)");
                                } else if is_multiwidget_ws
                                    && !MULTIWIDGET_CONNECTED
                                        .load(std::sync::atomic::Ordering::SeqCst)
                                {
                                    info!(
                                        "[WS-BLOCKER] Captured blocked Evolution socket for Rust (url_len={}, has_session_query={})",
                                        ws_url_for_connect.len(),
                                        ws_url_for_connect
                                            .to_ascii_lowercase()
                                            .contains("evosessionid=")
                                    );
                                    MULTIWIDGET_CONNECTED
                                        .store(true, std::sync::atomic::Ordering::SeqCst);

                                    let get_cookies_cmd = serde_json::json!({
                                        "id": 88888,
                                        "method": "Network.getAllCookies"
                                    });
                                    let _ = write
                                        .lock()
                                        .await
                                        .send(tokio_tungstenite::tungstenite::Message::Text(
                                            get_cookies_cmd.to_string(),
                                        ))
                                        .await;

                                    let app_handle_for_connect = app_handle.clone();
                                    tokio::spawn(async move {
                                        tokio::time::sleep(tokio::time::Duration::from_millis(500))
                                            .await;

                                        let mut options = MultiSocketOptions::default();
                                        if let Some(all_cookies) =
                                            BROWSER_ALL_COOKIES.lock().unwrap().clone()
                                        {
                                            options.cookie = Some(all_cookies);
                                        }

                                        let mut client = MULTIWIDGET_CLIENT.lock().await;
                                        if client.is_connected() {
                                            return;
                                        }

                                        let event_rx = client.create_event_channel();
                                        crate::evolution::event_bridge::spawn_event_bridge(
                                            app_handle_for_connect.clone(),
                                            event_rx,
                                        );

                                        match client.connect(ws_url_for_connect.clone(), options).await {
                                            Ok(_) => info!("[WS-BLOCKER] Rust multi-socket connection initiated from blocked browser URL"),
                                            Err(e) => {
                                                error!("[WS-BLOCKER] Rust multi-socket connection failed: {}", e);
                                                MULTIWIDGET_CONNECTED.store(false, std::sync::atomic::Ordering::SeqCst);
                                            }
                                        }
                                    });
                                }
                            }
                        }

                        // ✅ Handle CDP response (for WebSocket URL queries and cookie requests)
                        if let Some(response_id) = json.get("id").and_then(|v| v.as_u64()) {
                            // 🍪 Handle Network.getAllCookies response (id=88888)
                            if response_id == 88888 {
                                if let Some(cookies) = json
                                    .get("result")
                                    .and_then(|r| r.get("cookies"))
                                    .and_then(|c| c.as_array())
                                {
                                    // Log all cookies for debugging
                                    info!("🍪 [CDP] Total cookies in browser: {}", cookies.len());

                                    // Find _abck cookie specifically (Akamai Bot Manager) - for debugging
                                    let _abck_cookie = cookies.iter().find_map(|c| {
                                        let name = c.get("name")?.as_str()?;
                                        if name == "_abck" {
                                            let value = c.get("value")?.as_str()?;
                                            let domain = c.get("domain").and_then(|d| d.as_str()).unwrap_or("");
                                            info!("🍪 [CDP] Found _abck cookie! domain={}, value_len={}", domain, value.len());
                                            Some(format!("_abck={}", value))
                                        } else {
                                            None
                                        }
                                    });

                                    // Build cookie string - include ALL cookies from evo-games domains + _abck
                                    let cookie_parts: Vec<String> = cookies
                                        .iter()
                                        .filter_map(|c| {
                                            let name = c.get("name")?.as_str()?;
                                            let value = c.get("value")?.as_str()?;
                                            let domain = c
                                                .get("domain")
                                                .and_then(|d| d.as_str())
                                                .unwrap_or("");

                                            // Include evo-games cookies OR important Akamai cookies
                                            if domain.contains("evo-games")
                                                || domain.contains("evo-")
                                                || name == "_abck"
                                                || name == "ak_bmsc"
                                                || name == "bm_sz"
                                                || name.starts_with("bm_")
                                            {
                                                Some(format!("{}={}", name, value))
                                            } else {
                                                None
                                            }
                                        })
                                        .collect();

                                    // Log what we found
                                    let has_abck =
                                        cookie_parts.iter().any(|c| c.starts_with("_abck="));
                                    let has_ak_bmsc =
                                        cookie_parts.iter().any(|c| c.starts_with("ak_bmsc="));
                                    let has_bm_sz =
                                        cookie_parts.iter().any(|c| c.starts_with("bm_sz="));
                                    info!(
                                        "🍪 [CDP] Akamai cookies: _abck={}, ak_bmsc={}, bm_sz={}",
                                        has_abck, has_ak_bmsc, has_bm_sz
                                    );

                                    let cookie_str = cookie_parts.join("; ");

                                    if !cookie_str.is_empty() {
                                        info!(
                                            "🍪 [CDP] Captured {} relevant cookies (header_len={})",
                                            cookie_parts.len(),
                                            cookie_str.len()
                                        );

                                        // Store in global variable
                                        *BROWSER_ALL_COOKIES.lock().unwrap() = Some(cookie_str);
                                    } else {
                                        warn!("🍪 [CDP] No relevant cookies found in browser!");
                                    }
                                }
                                continue;
                            }

                            if let Some((request_type, is_lobby)) =
                                pending_cookie_requests.remove(&response_id)
                            {
                                // Extract result value from Runtime.evaluate
                                let result_value = json
                                    .get("result")
                                    .and_then(|r| r.get("result"))
                                    .and_then(|r| r.get("value"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                // Check if this is a WebSocket URL query response
                                if request_type == "__QUERY_WS_URLS__" {
                                    if let Some(urls_str) = result_value {
                                        let url_count = urls_str
                                            .split("|||")
                                            .filter(|url| !url.trim().is_empty())
                                            .count();
                                        info!(
                                            "📡 WebSocket URLs query result: count={}, payload_len={}",
                                            url_count,
                                            urls_str.len()
                                        );

                                        // Parse the URLs (separated by |||)
                                        for url in urls_str.split("|||") {
                                            let url = url.trim();

                                            // Check if this is an Evolution WebSocket URL with session info
                                            if url.starts_with("wss://")
                                                && url.contains("EVOSESSIONID=")
                                                && url.contains("client_version=")
                                                && url.contains("instance=")
                                            {
                                                info!("🎯 Found Evolution WebSocket URL from page query (Pragmatic style!)");

                                                // Mark as found
                                                evolution_found_clone.store(
                                                    true,
                                                    std::sync::atomic::Ordering::SeqCst,
                                                );
                                                last_ws_url = Some(url.to_string());
                                                last_ws_provider = Some("evolution".to_string());

                                                // Emit the URL for session capture
                                                if let Some(main_window) =
                                                    app_handle.get_webview_window("main")
                                                {
                                                    let _ = main_window.emit(
                                                        "evolution-lobby-url-captured",
                                                        serde_json::json!({
                                                            "wsUrl": url,
                                                            "originPage": page_id_owned
                                                        }),
                                                    );
                                                }
                                                break; // Found what we need
                                            }
                                        }
                                    }
                                } else {
                                    // Legacy cookie capture response
                                    if let Some(ref cookie_str) = result_value {
                                        info!(
                                            "🍪 Evolution cookies captured (header_len={})",
                                            cookie_str.len()
                                        );
                                    }

                                    // Emit event with cookies (legacy fallback)
                                    if let Some(main_window) = app_handle.get_webview_window("main")
                                    {
                                        let _ = main_window.emit(
                                            "evolution-websocket-captured",
                                            serde_json::json!({
                                                "wsUrl": request_type,
                                                "isEvolution": true,
                                                "cookies": result_value,
                                                "originPage": page_id_owned,
                                                "isLobby": is_lobby
                                            }),
                                        );
                                    }
                                }
                            }
                        }

                        // ✅ Track execution contexts (main frame + iframes) for WebSocket queries
                        if method == "Runtime.executionContextCreated" {
                            // 🎯 Check if this event came from an iframe session
                            let context_session_id = json
                                .get("sessionId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            if let Some(params) = json.get("params") {
                                if let Some(context) = params.get("context") {
                                    if let Some(context_id) =
                                        context.get("id").and_then(|v| v.as_i64())
                                    {
                                        let origin = context
                                            .get("origin")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let aux_data = context.get("auxData");
                                        let frame_id = aux_data
                                            .and_then(|a| a.get("frameId"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let is_default = aux_data
                                            .and_then(|a| a.get("isDefault"))
                                            .and_then(|v| v.as_bool())
                                            .unwrap_or(false);

                                        // 🎯 Log detailed context info for debugging
                                        info!("📦 Execution context event: id={}, origin={}, session={:?}, isDefault={}, frame={}",
                                              context_id, origin, context_session_id, is_default, frame_id);

                                        // Only track default contexts (not extensions, etc.)
                                        if is_default && !origin.starts_with("chrome-extension://")
                                        {
                                            if !execution_contexts.contains(&context_id) {
                                                execution_contexts.push(context_id);
                                                info!("📦 Execution context added: id={}, origin={}, session={:?}", context_id, origin, context_session_id);
                                            }
                                            if let Some(ref sid) = context_session_id {
                                                context_sessions.insert(context_id, sid.clone());
                                            }

                                            // Install the WebSocket blocker as soon as an Evolution context exists.
                                            // The blocker captures the WS URL via console and prevents the browser
                                            // from opening the real socket, so Rust can become the only session owner.
                                            if origin.contains("evo-games")
                                                || origin.contains("evolution")
                                            {
                                                let ws_blocker_inject = serde_json::json!({
                                                    "id": 888000 + context_id,
                                                    "method": "Runtime.evaluate",
                                                    "params": {
                                                        "expression": WS_BLOCKER_SCRIPT,
                                                        "returnByValue": true,
                                                        "contextId": context_id
                                                    }
                                                });

                                                let mut ws_blocker_msg = ws_blocker_inject.clone();
                                                if let Some(ref sid) = context_session_id {
                                                    ws_blocker_msg["sessionId"] =
                                                        serde_json::json!(sid);
                                                }

                                                let _ = write.lock().await
                                                    .send(tokio_tungstenite::tungstenite::Message::Text(
                                                        ws_blocker_msg.to_string(),
                                                    ))
                                                    .await;
                                                info!("[WS-BLOCKER] Injected to context {} (origin: {}, session: {:?})",
                                                      context_id, origin, context_session_id);
                                            }

                                            // Evo 로비 페이지: 멀티플레이 버튼 자동 클릭 (hash 조작 없음!)
                                            // 🎯 버튼 클릭만 수행 - Evolution이 알아서 올바른 hash 설정
                                            // 🔥 UNIFIED: Inject click automation in ALL modes (predict + auto)
                                            // Now we use multiwidget socket for ALL modes to ensure consistent subscription behavior
                                            if origin.contains("evo-games.com") {
                                                let enforce_multi_script = r#"
(function(){
  try {
    if (window.__bcr_auto_multi_v7) return {skip:true};
    window.__bcr_auto_multi_v7 = true;
    
    console.log('[BCR] 🎰 V7 LOADED', window.location.href);
    
    // 🎯 CRITICAL: 이미 멀티위젯 모드이면, 페이지 새로고침해서 WebSocket 재연결
    var h = window.location.hash || '';
    if (h.indexOf('mwg=') !== -1 || h.indexOf('.multiplay') !== -1) {
      console.log('[BCR] 🔄 Already in multiwidget mode, need to refresh to capture WebSocket');
      // ⚠️ 플래그는 반드시 sessionStorage 로 — window 변수는 리로드마다 초기화되므로
      //   addScriptToEvaluateOnNewDocument 재주입 → mwg 해시 잔존 → 무한 새로고침 루프가 된다.
      //   매 리로드가 Evolution 플레이어를 재인증해 서버가 Rust 세션을 logoutByPlayer 로 킥한다.
      //   sessionStorage 플래그는 리로드에도 살아남아 "게임 세션당 딱 한 번"만 새로고침한다
      //   (blocker 설치 후 WS 를 한 번 재생성해 캡처하면 그 뒤엔 리로드 불필요).
      var alreadyRefreshed = false;
      try { alreadyRefreshed = (sessionStorage.getItem('__bcr_mw_refreshed') === '1'); } catch (e) {}
      if (!alreadyRefreshed) {
        try { sessionStorage.setItem('__bcr_mw_refreshed', '1'); } catch (e) {}
        // 약간의 딜레이 후 새로고침 (1회)
        setTimeout(function() {
          console.log('[BCR] 🔄 Triggering page refresh (once per session)...');
          window.location.reload();
        }, 500);
        return {refresh:true};
      }
      console.log('[BCR] ✅ Already refreshed this session — skipping reload (Rust owns the socket)');
    }
    
    var done = false;
    var attempts = 0;
    var logged = false;
    var categoryClicked = false;
    
    function isMultiMode() {
      var h = window.location.hash || '';
      return h.indexOf('.multiplay') !== -1;
    }
    
    function click(el) {
      if (!el) return;
      console.log('[BCR] 🖱️ CLICK:', el.outerHTML.substring(0,200));
      try {
        // 스크롤해서 보이게
        el.scrollIntoView({block:'center'});
        
        // 잠시 대기 후 클릭 (스크롤 완료 대기)
        setTimeout(function(){
          var rect = el.getBoundingClientRect();
          var x = rect.left + rect.width/2;
          var y = rect.top + rect.height/2;
          
          console.log('[BCR] 📍 Button position:', x, y, 'size:', rect.width, rect.height);
          
          // 방법 1: React 내부 핸들러 찾기
          var keys = Object.keys(el);
          for (var ki = 0; ki < keys.length; ki++) {
            var k = keys[ki];
            if (k.startsWith('__reactProps')) {
              var props = el[k];
              console.log('[BCR] 🔧 Found __reactProps:', k, 'onClick?', !!props.onClick);
              if (props && props.onClick) {
                console.log('[BCR] 🎯 Calling React onClick directly!');
                try {
                  props.onClick({
                    type: 'click',
                    target: el,
                    currentTarget: el,
                    nativeEvent: new MouseEvent('click'),
                    preventDefault: function(){},
                    stopPropagation: function(){},
                    bubbles: true
                  });
                  console.log('[BCR] ✅ React onClick called!');
                } catch(re) {
                  console.log('[BCR] React onClick error:', re);
                }
              }
            }
            if (k.startsWith('__reactFiber')) {
              console.log('[BCR] 🔧 Found __reactFiber:', k);
              // Fiber에서 stateNode나 memoizedProps 탐색
              var fiber = el[k];
              if (fiber && fiber.memoizedProps && fiber.memoizedProps.onClick) {
                console.log('[BCR] 🎯 Calling fiber memoizedProps.onClick!');
                try {
                  fiber.memoizedProps.onClick({
                    type: 'click', target: el, currentTarget: el,
                    preventDefault: function(){}, stopPropagation: function(){}
                  });
                } catch(fe) {
                  console.log('[BCR] Fiber onClick error:', fe);
                }
              }
            }
          }
          
          // 방법 2: PointerEvent (더 현대적)
          var pointerDown = new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
            isPrimary: true, button: 0, buttons: 1
          });
          var pointerUp = new PointerEvent('pointerup', {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
            isPrimary: true, button: 0, buttons: 0
          });
          el.dispatchEvent(pointerDown);
          el.dispatchEvent(pointerUp);
          
          // 방법 3: 일반 클릭 (button/a 요소만)
          if (typeof el.click === 'function') {
            el.click();
          }
          
          // 방법 4: MouseEvent
          var clickEvt = new MouseEvent('click', {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, button: 0
          });
          el.dispatchEvent(clickEvt);
          
          console.log('[BCR] ✅ All click methods attempted');
        }, 100);
        
      } catch(e) {
        console.log('[BCR] Click error:', e);
      }
    }
    
    // 바카라 카테고리 클릭
    function clickBaccaratCategory() {
      if (categoryClicked) return true;
      
      // URL에 이미 baccarat 카테고리가 있으면 스킵
      var hash = window.location.hash || '';
      if (hash.indexOf('baccarat') !== -1) {
        categoryClicked = true;
        return true;
      }
      
      // 바카라 네비게이터 찾기
      var navSelectors = [
        '#category-navigator-baccarat_sicbo',
        '#category-navigator-baccarat',
        '#category-navigator-in_bar_baccarat',
        '[id*="navigator"][id*="baccarat"]',
        '[data-role="category-navigator"][id*="baccarat"]'
      ];
      
      for (var i = 0; i < navSelectors.length; i++) {
        var nav = document.querySelector(navSelectors[i]);
        if (nav) {
          console.log('[BCR] 🎲 Found baccarat navigator:', navSelectors[i]);
          // nav 자체를 클릭 (부모 요소가 클릭 핸들러를 가짐)
          click(nav);
          categoryClicked = true;
          return true;
        }
      }
      
      // 텍스트로 찾기
      var allNavs = document.querySelectorAll('[id^="category-navigator"]');
      for (var j = 0; j < allNavs.length; j++) {
        var navEl = allNavs[j];
        if (navEl.id.toLowerCase().indexOf('baccarat') !== -1) {
          console.log('[BCR] 🎲 Found baccarat by ID scan:', navEl.id);
          click(navEl);
          categoryClicked = true;
          return true;
        }
      }
      
      console.log('[BCR] ❌ Baccarat category not found');
      return false;
    }
    
    function tryClick() {
      if (done || isMultiMode()) { done = true; return true; }
      attempts++;
      
      // Step 1: 먼저 바카라 카테고리로 이동 (처음 5번 시도)
      if (!categoryClicked && attempts <= 5) {
        console.log('[BCR] 🎲 Step 1: Looking for baccarat category...');
        clickBaccaratCategory();
        return false;
      }
      
      // 모든 버튼 정보 로깅 (1회만)
      if (!logged && attempts === 7) {
        logged = true;
        var btns = document.querySelectorAll('button');
        console.log('[BCR] === ALL BUTTONS ===', btns.length);
        btns.forEach(function(b, i) {
          console.log('[BCR] BTN', i, ':', 
            'role=' + b.getAttribute('data-role'),
            'aria=' + b.getAttribute('aria-label'),
            'class=' + (b.className||'').substring(0,40),
            'text=' + (b.textContent||'').substring(0,30)
          );
        });
      }
      
      console.log('[BCR] 🎰 Step 2: Looking for multiplay button...');
      
      // 1. data-role
      var btn = document.querySelector('[data-role="multiplay-button"]');
      if (btn) { click(btn); done = true; return true; }
      
      // 2. SVG 아이콘 버튼 (Evolution 스타일) - 부모 버튼 찾기
      var svgs = document.querySelectorAll('svg');
      for (var i = 0; i < svgs.length; i++) {
        var svg = svgs[i];
        var parent = svg.closest('button');
        if (parent) {
          var ariaLabel = parent.getAttribute('aria-label') || '';
          var title = svg.querySelector('title');
          var titleText = title ? title.textContent : '';
          if (ariaLabel.indexOf('멀티') !== -1 || ariaLabel.toLowerCase().indexOf('multi') !== -1 ||
              titleText.indexOf('멀티') !== -1 || titleText.toLowerCase().indexOf('multi') !== -1) {
            console.log('[BCR] ✅ Found SVG button');
            click(parent);
            done = true;
            return true;
          }
        }
      }
      
      // 3. 텍스트 검색
      var btns = document.querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) {
        var b = btns[j];
        var txt = (b.textContent || '').toLowerCase();
        var aria = (b.getAttribute('aria-label') || '').toLowerCase();
        if (txt.indexOf('멀티') !== -1 || txt.indexOf('multi') !== -1 ||
            aria.indexOf('멀티') !== -1 || aria.indexOf('multi') !== -1) {
          console.log('[BCR] ✅ Found text button');
          click(b);
          done = true;
          return true;
        }
      }
      
      // 4. MultiPlayButton 클래스로 직접 찾기
      var multiBtn = document.querySelector('[class*="MultiPlayButton"],[class*="multiplay-button" i]');
      if (multiBtn) {
        console.log('[BCR] ✅ Found MultiPlayButton class');
        click(multiBtn);
        done = true;
        return true;
      }
      
      // 5. 카테고리 헤더 안의 버튼
      var cats = document.querySelectorAll('[id*="baccarat"]');
      for (var k = 0; k < cats.length; k++) {
        var cat = cats[k];
        var catId = cat.id || '';
        // 카테고리 안의 모든 버튼 중 data-role=multiplay-button 찾기
        var mpBtn = cat.querySelector('[data-role="multiplay-button"]');
        if (mpBtn) {
          console.log('[BCR] ✅ Found multiplay in category', catId);
          click(mpBtn);
          done = true;
          return true;
        }
      }
      
      if (attempts <= 5) console.log('[BCR] ❌ Not found yet, attempt', attempts);
      return false;
    }
    
    function loop() {
      if (done || isMultiMode() || attempts > 20) return;
      tryClick();
      setTimeout(loop, 2000);
    }
    
    setTimeout(loop, 3000);
    return {v:4};
  } catch(e) { console.error('[BCR]', e); return {e:e.message}; }
})()
"#;

                                                // 이전 스크립트 코드 삭제됨 - hash 방식으로 대체
                                                let _old_click_script = r#"
(function(){
  // OLD CLICK-BASED SCRIPT - REPLACED BY HASH NAVIGATION
  var navIds = [
    'category-navigator-baccarat_sicbo',
    'category-navigator-baccarat',
    'category-navigator-livebaccarat',
    'category-navigator-live_baccarat'
  ];
      for (var n=0; n<navIds.length; n++) {
        var nav = document.getElementById(navIds[n]);
        if (nav) {
          // #category-navigator-baccarat > div > div > svg 구조 지원
          var clickable = nav.querySelector('div > div > svg') || nav.querySelector('svg') || nav.querySelector('div > div') || nav.querySelector('div') || nav;
          categoryClicked = true;
          forceClick(clickable);
          console.log('[BCR] Category nav clicked:', navIds[n], clickable.tagName);
          return true;
        }
      }
      // id가 category-navigator로 시작하는 요소 검색
      var allNavs = document.querySelectorAll('[id^=\"category-navigator\"]');
      for (var i=0; i<allNavs.length; i++) {
        var nav = allNavs[i];
        if (nav.id.toLowerCase().indexOf('baccarat') !== -1) {
          var clickable = nav.querySelector('div > div > svg') || nav.querySelector('svg') || nav.querySelector('div') || nav;
          categoryClicked = true;
          forceClick(clickable);
          console.log('[BCR] Category nav clicked (dynamic):', nav.id);
          return true;
        }
      }
      return false;
    }

    // STEP 2: 멀티 버튼 클릭 (다양한 셀렉터 지원)
    function tryClickMultiButton() {
      if (multiClicked) return true;

      // 방법 1: 카테고리 헤더 내의 버튼 (AbstractCategoryHeader 패턴)
      // #category-baccarat > div.AbstractCategoryHeader--04845 > ... > button
      var categoryIds = ['category-baccarat_sicbo', 'category-baccarat', 'category-livebaccarat', 'category-live_baccarat'];
      for (var c=0; c<categoryIds.length; c++) {
        var cat = document.getElementById(categoryIds[c]);
        if (cat) {
          // AbstractCategoryHeader 내의 버튼 찾기
          var headerBtn = cat.querySelector('[class*=\"AbstractCategoryHeader\"] button');
          if (headerBtn) {
            multiClicked = true;
            forceClick(headerBtn);
            console.log('[BCR] Multi button clicked (header button in', categoryIds[c], ')');
            return true;
          }
          // 첫 번째 버튼 (카테고리 내 첫 버튼이 보통 멀티)
          var firstBtn = cat.querySelector('button');
          if (firstBtn) {
            multiClicked = true;
            forceClick(firstBtn);
            console.log('[BCR] Multi button clicked (first button in', categoryIds[c], ')');
            return true;
          }
        }
      }

      // 방법 2: data-role 속성
      var roleBtn = document.querySelector('[data-role=\"multiplay-button\"]');
      if (roleBtn) {
        multiClicked = true;
        forceClick(roleBtn);
        console.log('[BCR] Multi button clicked (data-role)');
        return true;
      }

      // 방법 3: 클래스명에 multi 포함
      var classBtn = document.querySelector('[class*=\"MultiPlay\"], [class*=\"multiplay\"], [class*=\"Multiplay\"]');
      if (classBtn) {
        multiClicked = true;
        var btn = classBtn.closest('button') || classBtn;
        forceClick(btn);
        console.log('[BCR] Multi button clicked (class pattern)');
        return true;
      }

      // 방법 4: id가 category-로 시작하는 요소에서 헤더 버튼 찾기 (동적)
      var allCats = document.querySelectorAll('[id^=\"category-\"]');
      for (var i=0; i<allCats.length; i++) {
        var cat = allCats[i];
        if (cat.id.toLowerCase().indexOf('baccarat') !== -1 && !cat.id.startsWith('category-navigator')) {
          var headerBtn = cat.querySelector('[class*=\"Header\"] button') || cat.querySelector('button');
          if (headerBtn) {
            multiClicked = true;
            forceClick(headerBtn);
            console.log('[BCR] Multi button clicked (dynamic cat):', cat.id);
            return true;
          }
        }
      }

      return false;
    }

    function tick() {
      if (multiClicked) return {done:true};
      clickAttempts++;
      // STEP 1: 먼저 카테고리 클릭
      if (!categoryClicked) {
        tryClickCategoryNav();
        return {step:'category', attempts: clickAttempts};
      }
      // STEP 2: 카테고리 클릭 후 멀티 버튼 클릭
      if (categoryClicked && !multiClicked) {
        tryClickMultiButton();
        return {step:'multi', attempts: clickAttempts};
      }
      return {done: multiClicked, attempts: clickAttempts};
    }

    // 1초마다 시도 (최대 60초)
    var interval = setInterval(function(){
      if (multiClicked || clickAttempts > 60) {
        clearInterval(interval);
        console.log('[BCR] Multi click done or timeout:', {multiClicked: multiClicked, attempts: clickAttempts});
      } else {
        tick();
      }
    }, 1000);

    // 초기 빠른 시도 (0.5초 간격, 10회)
    for (var k=1; k<=10; k++){
      setTimeout(tick, 500 * k);
    }

    return {installed:true};
  }catch(e){ console.error('[BCR] Error:', e); return {error:e.message}; }
})()
"#;
                                                // 🎯 FIX: sessionId가 있으면 반드시 포함해야 CDP가 올바른 context에서 실행함
                                                let eval_params = serde_json::json!({
                                                    "expression": enforce_multi_script,
                                                    "returnByValue": true,
                                                    "awaitPromise": true,
                                                    "contextId": context_id
                                                });

                                                // sessionId가 있으면 추가 (iframe context인 경우 필수)
                                                let mut eval_msg = serde_json::json!({
                                                    "id": 777001,
                                                    "method": "Runtime.evaluate",
                                                    "params": eval_params
                                                });

                                                if let Some(ref sid) = context_session_id {
                                                    eval_msg["sessionId"] = serde_json::json!(sid);
                                                    info!("🎯 [EVO CONTEXT] Injecting multi-click script to context {} with sessionId {}", context_id, sid);
                                                } else {
                                                    info!("🎯 [EVO CONTEXT] Injecting multi-click script to context {} (main page)", context_id);
                                                }

                                                let _ = write.lock().await
                                                    .send(tokio_tungstenite::tungstenite::Message::Text(
                                                        eval_msg.to_string(),
                                                    ))
                                                    .await;
                                            }

                                            // 🎯 PREDICT MODE: Do NOT block browser's lobby WebSocket
                                            // Browser connects first, CDP captures URL, then Rust connects
                                            // Server handles session deduplication with forceCloseExistingConnection: false
                                        }
                                    }
                                }
                            }
                        }
                        // ✅ Handle iframe attached - enable Network for it
                        else if method == "Target.attachedToTarget" {
                            if let Some(params) = json.get("params") {
                                let session_id = params
                                    .get("sessionId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let target_info = params.get("targetInfo");
                                let target_type = target_info
                                    .and_then(|t| t.get("type"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let target_url = target_info
                                    .and_then(|t| t.get("url"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                // 🎯 Check if this is an Evolution Gaming iframe
                                let is_evo_iframe = target_url.contains("evo-games.com")
                                    || target_url.contains("evolution");
                                info!(
                                    "🎯 Target attached: session={}, type={}, url_len={}, isEvo={}",
                                    session_id,
                                    target_type,
                                    target_url.len(),
                                    is_evo_iframe
                                );

                                // Enable Network AND Runtime for iframe to capture WebSockets and inject scripts
                                if !session_id.is_empty()
                                    && (target_type == "iframe" || target_type == "page")
                                    && !attached_sessions.contains(session_id)
                                {
                                    attached_sessions.insert(session_id.to_string());

                                    // Enable Network
                                    let enable_network_iframe = serde_json::json!({
                                        "id": 100,
                                        "sessionId": session_id,
                                        "method": "Network.enable"
                                    });
                                    let _ = write
                                        .lock()
                                        .await
                                        .send(tokio_tungstenite::tungstenite::Message::Text(
                                            enable_network_iframe.to_string(),
                                        ))
                                        .await;

                                    // Enable Runtime for script injection
                                    let enable_runtime_iframe = serde_json::json!({
                                        "id": 101,
                                        "sessionId": session_id,
                                        "method": "Runtime.enable"
                                    });
                                    let _ = write
                                        .lock()
                                        .await
                                        .send(tokio_tungstenite::tungstenite::Message::Text(
                                            enable_runtime_iframe.to_string(),
                                        ))
                                        .await;

                                    info!(
                                        "✅ Network + Runtime enabled for session: {} (isEvo={})",
                                        session_id, is_evo_iframe
                                    );

                                    // 🎯 NOTE: 스크립트 주입은 Runtime.executionContextCreated에서 처리
                                    // Target.attachedToTarget 시점에는 document가 아직 없으므로 여기서 주입하지 않음
                                    // executionContextCreated는 context가 준비된 후 발생하며, 네비게이션 시 재발생함
                                }
                            }
                        }
                        // ✅ Handle new target created (popup windows, especially on Windows)
                        // This is triggered by Target.setDiscoverTargets when new windows/tabs are opened
                        else if method == "Target.targetCreated" {
                            if let Some(params) = json.get("params") {
                                let target_info = params.get("targetInfo");
                                let target_id = target_info
                                    .and_then(|t| t.get("targetId"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let target_type = target_info
                                    .and_then(|t| t.get("type"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let target_url = target_info
                                    .and_then(|t| t.get("url"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let opener_id = target_info
                                    .and_then(|t| t.get("openerId"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                // Check if this is an Evolution Gaming page (popup)
                                let is_evo_popup = target_url.contains("evo-games.com")
                                    || target_url.contains("evolution");

                                info!(
                                    "🆕 [Target.targetCreated] type={}, id={}, opener={}, url_len={}, isEvo={}",
                                    target_type,
                                    target_id,
                                    opener_id,
                                    target_url.len(),
                                    is_evo_popup
                                );

                                // For page targets (popups), emit event for frontend to track
                                if target_type == "page" && !target_url.is_empty() {
                                    if let Some(main_window) = app_handle.get_webview_window("main")
                                    {
                                        let _ = main_window.emit(
                                            "cdp-new-target-created",
                                            serde_json::json!({
                                                "targetId": target_id,
                                                "targetType": target_type,
                                                "url": target_url,
                                                "openerId": opener_id,
                                                "isEvolution": is_evo_popup
                                            }),
                                        );
                                    }

                                    // 🎯 Auto-attach to new Evolution popups to capture their WebSocket traffic
                                    if is_evo_popup && !target_id.is_empty() {
                                        info!(
                                            "🎯 Auto-attaching to Evolution popup: {}",
                                            target_id
                                        );
                                        let attach_msg = serde_json::json!({
                                            "id": 200,
                                            "method": "Target.attachToTarget",
                                            "params": {
                                                "targetId": target_id,
                                                "flatten": true
                                            }
                                        });
                                        let _ = write
                                            .lock()
                                            .await
                                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                                attach_msg.to_string(),
                                            ))
                                            .await;
                                    }
                                }
                            }
                        }
                        // Capture WebSocket handshake request headers (Cookie/User-Agent/Origin/Referer)
                        // Some providers no longer include EVOSESSIONID in the WS URL query, so we need Cookie header.
                        else if method == "Network.webSocketWillSendHandshakeRequest"
                            || method == "Network.webSocketHandshakeRequestSent"
                        {
                            if let Some(params) = json.get("params") {
                                let request_id = params
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if request_id.is_empty() {
                                    continue;
                                }

                                let headers_obj = params
                                    .get("request")
                                    .and_then(|r| r.get("headers"))
                                    .and_then(|h| h.as_object());

                                if let Some(headers) = headers_obj {
                                    let get_header = |name: &str| -> Option<String> {
                                        headers
                                            .iter()
                                            .find(|(k, _)| k.eq_ignore_ascii_case(name))
                                            .and_then(|(_, v)| v.as_str())
                                            .map(|s| s.to_string())
                                    };

                                    let cookie = get_header("Cookie");
                                    let user_agent = get_header("User-Agent");
                                    let origin = get_header("Origin");
                                    let referer = get_header("Referer");

                                    if cookie.is_some()
                                        || user_agent.is_some()
                                        || origin.is_some()
                                        || referer.is_some()
                                    {
                                        let mut map = ws_headers_by_request_id.lock().await;
                                        let entry = map
                                            .entry(request_id.to_string())
                                            .or_insert_with(WsHandshakeHeaders::default);

                                        if entry.cookie.is_none() {
                                            entry.cookie = cookie.clone();
                                        }
                                        if entry.user_agent.is_none() {
                                            entry.user_agent = user_agent.clone();
                                        }
                                        if entry.origin.is_none() {
                                            entry.origin = origin.clone();
                                        }
                                        if entry.referer.is_none() {
                                            entry.referer = referer.clone();
                                        }

                                        // Log multiwidget handshakes at info level for debugging
                                        if let Some(url) = ws_url_by_request_id.get(request_id) {
                                            if url.contains("multiwidget")
                                                || url.contains("multiplay")
                                            {
                                                let has_session = cookie
                                                    .as_ref()
                                                    .map(|c| {
                                                        c.to_lowercase().contains("evosessionid=")
                                                    })
                                                    .unwrap_or(false);
                                                info!(
                                                    "🍪 [WS-HANDSHAKE] requestId={} multiwidget=true hasCookie={} hasSessionCookie={} hasSessionQuery={} urlLen={}",
                                                    request_id,
                                                    cookie.is_some(),
                                                    has_session,
                                                    url.to_ascii_lowercase().contains("evosessionid="),
                                                    url.len()
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        // Monitor WebSocket created
                        else if method == "Network.webSocketCreated" {
                            if let Some(params) = json.get("params") {
                                let request_id = params
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
                                // 🎯 Extract sessionId from root of message (present if event came from iframe)
                                let source_session_id = json
                                    .get("sessionId")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                if !request_id.is_empty() && !url.is_empty() {
                                    ws_url_by_request_id
                                        .insert(request_id.to_string(), url.to_string());
                                }

                                // Log only non-sensitive socket metadata. Evolution URLs may
                                // carry EVOSESSIONID in the query string.
                                info!(
                                    "🔌 [ALL-WS] WebSocket created: url_len={}, is_evolution={}, has_session_query={}",
                                    url.len(),
                                    is_evolution_url(url),
                                    url.to_ascii_lowercase().contains("evosessionid=")
                                );

                                if let Some(ref sid) = source_session_id {
                                    info!("🔌 [IFRAME] session={} url_len={}", sid, url.len());
                                } else {
                                    info!("🔌 [MAIN] page={} url_len={}", page_id_owned, url.len());
                                }

                                // Check Evolution FIRST (more specific patterns)
                                if is_evolution_url(url) {
                                    info!(
                                        "🎯 Evolution Gaming WebSocket found on page {}!",
                                        page_id_owned
                                    );
                                    evolution_found_clone.store(true, Ordering::SeqCst);

                                    // FALLBACK: If LOBBY_PAGE_ID is not set and this is NOT a room WebSocket, set it now
                                    // Room WebSocket URLs contain /game/{table_id}/socket pattern
                                    let is_room_ws =
                                        url.contains("/game/") && url.contains("/socket");
                                    let mut is_fallback_lobby = false;
                                    {
                                        let mut lobby_id = LOBBY_PAGE_ID.lock().unwrap();
                                        if lobby_id.is_none() && !is_room_ws {
                                            info!("🏛️ FALLBACK: Setting LOBBY_PAGE_ID to: {} (Evolution WS detected, not room)", page_id_owned);
                                            *lobby_id = Some(page_id_owned.clone());
                                            is_fallback_lobby = true;
                                        }
                                    }

                                    // Dynamically check if this is the lobby page (may have been set after monitoring started)
                                    let is_current_lobby = {
                                        let lobby_id = LOBBY_PAGE_ID.lock().unwrap();
                                        lobby_id
                                            .as_ref()
                                            .map(|id| id == &page_id_owned)
                                            .unwrap_or(false)
                                    };
                                    let effective_lobby_page =
                                        is_lobby_page || is_current_lobby || is_fallback_lobby;
                                    info!("🔍 Lobby status for {}: is_lobby_page={}, is_current_lobby={}, is_fallback={}, effective={}",
                                          page_id_owned, is_lobby_page, is_current_lobby, is_fallback_lobby, effective_lobby_page);

                                    // If this is the lobby page, mark lobby WebSocket as connected
                                    // NOTE: In predict mode, don't set flag here - let auto-connect handle it
                                    if effective_lobby_page {
                                        let current_mode = CDP_APP_MODE
                                            .lock()
                                            .map(|m| m.clone())
                                            .unwrap_or_default();
                                        if current_mode != "predict" {
                                            // Auto mode: multiwidget socket is used
                                            info!(
                                                "🏛️ LOBBY WebSocket detected (page: {})",
                                                page_id_owned
                                            );
                                        } else {
                                            // Predict mode: DON'T set flag here - Rust will connect directly
                                            info!(
                                                "🏛️ LOBBY WebSocket detected in predict mode (page: {}) - Rust will connect directly",
                                                page_id_owned
                                            );
                                        }

                                        // 🎯 FALLBACK 감지 - Runtime.executionContextCreated에서 이미 스크립트 주입됨
                                        // NOTE: 중복 주입 제거함 (hash 변경으로 인한 무한 새로고침 방지)
                                        if is_fallback_lobby {
                                            info!("🎯 FALLBACK: Detected lobby via WebSocket (source_session: {:?})", source_session_id);
                                            info!("🎯 FALLBACK: Script injection skipped - already handled by executionContextCreated");
                                        }
                                    }

                                    // NOTE: FALLBACK 스크립트 주입 코드 완전 삭제됨 (무한 새로고침 유발)
                                    // 스크립트는 Runtime.executionContextCreated에서 evo-games.com origin으로 주입됨

                                    // ========== DELETED FALLBACK CODE START ==========
                                    // Old code that injected scripts with ensureHash() was removed because it caused infinite refresh
                                    // The multi-click script is now ONLY injected via Runtime.executionContextCreated handler
                                    // when an evo-games.com execution context is created
                                    // ========== DELETED FALLBACK CODE END ==========

                                    /* DELETED: Original script that caused refresh:
                                    (function(){
                                      if (window.__bcr_fallback_clicker) return {skip:true};
                                      window.__bcr_fallback_clicker = true;
                                      var categoryClicked = false;
                                      var multiClicked = false;
                                      var attempts = 0;
                                      function ensureHash(){
                                        try{
                                          var loc = window.location;
                                          if (!loc || !loc.host || loc.host.indexOf('evo-games.com') === -1) return;
                                          var params = new URLSearchParams((loc.hash||'#').replace(/^#/,''));
                                          if (params.get('category') !== 'baccarat') {
                                            params.set('category','baccarat');
                                            loc.hash = '#' + params.toString();
                                          }
                                        }catch(e){}
                                      }
                                      function clickCategory() {
                                        if (categoryClicked) return true;
                                        var navIds = ['category-navigator-baccarat_sicbo', 'category-navigator-baccarat', 'category-navigator-livebaccarat'];
                                        for (var i=0;i<navIds.length;i++) {
                                          var nav = document.getElementById(navIds[i]);
                                          if (nav) {
                                            var el = nav.querySelector('svg') || nav.querySelector('div') || nav;
                                            categoryClicked = true;
                                            el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
                                            console.log('[BCR] Category clicked:', navIds[i]);
                                            return true;
                                          }
                                        }
                                        return false;
                                      }
                                      function clickMulti() {
                                        if (multiClicked) return true;
                                        var cats = ['category-baccarat_sicbo', 'category-baccarat', 'category-livebaccarat'];
                                        for (var c=0;c<cats.length;c++) {
                                          var cat = document.getElementById(cats[c]);
                                          if (cat) {
                                            var btns = cat.querySelectorAll('button');
                                            for (var b=0;b<btns.length;b++) {
                                              var btn = btns[b];
                                              if (btn.getAttribute('data-role')==='multiplay-button' || (btn.className && btn.className.toLowerCase().indexOf('multi')!==-1)) {
                                                multiClicked = true;
                                                btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
                                                console.log('[BCR] Multi button clicked');
                                                return true;
                                              }
                                            }
                                          }
                                        }
                                        var global = document.querySelector('[data-role="multiplay-button"],[class*="MultiPlay"],[class*="multiplay"]');
                                        if (global) {
                                          multiClicked = true;
                                          (global.closest('button')||global).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
                                          console.log('[BCR] Multi button clicked (global)');
                                          return true;
                                        }
                                        return false;
                                      }
                                      function tick() {
                                        if (multiClicked) return;
                                        attempts++;
                                        ensureHash();
                                        if (!categoryClicked) clickCategory();
                                        if (categoryClicked) clickMulti();
                                      }
                                      setInterval(tick, 1000);
                                      for (var k=1;k<=30;k++) setTimeout(tick, 500*k);
                                      console.log('[BCR] Auto-click script installed');
                                      return {installed:true};
                                    })()
                                    "#;
                                                                                // 🎯 PRIORITY: source_session_id가 있으면 해당 iframe에 먼저 주입 (가장 신뢰할 수 있음)
                                                                                if let Some(ref source_sid) = source_session_id {
                                                                                    info!("🎯 FALLBACK: PRIORITY inject to source iframe session: {}", source_sid);
                                                                                    let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                        serde_json::json!({
                                                                                            "id": 777005,
                                                                                            "sessionId": source_sid,
                                                                                            "method": "Runtime.evaluate",
                                                                                            "params": {
                                                                                                "expression": auto_click_script,
                                                                                                "returnByValue": true,
                                                                                                "awaitPromise": true
                                                                                            }
                                                                                        }).to_string()
                                                                                    )).await;

                                                                                    // 해시 유지/감시도 동일 세션에 주입
                                                                                    let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                        serde_json::json!({
                                                                                            "id": 777006,
                                                                                            "sessionId": source_sid,
                                                                                            "method": "Runtime.evaluate",
                                                                                            "params": {
                                                                                                "expression": r#"(function(){try{if(window.__bcr_hash_watcher_installed) return {installed:true};window.__bcr_hash_watcher_installed=true;setInterval(function(){try{var loc=window.location;if(!loc||!loc.hostname||loc.hostname.indexOf('evo-games.com')===-1) return;var hash=loc.hash||'';var params=new URLSearchParams(hash.startsWith('#')?hash.slice(1):hash);var changed=false;if(params.get('category')!=='baccarat'){params.set('category','baccarat');changed=true;}var ua=params.get('ua_launch_id');if(ua) params.set('ua_launch_id', ua);var newHash='#'+params.toString();if(changed&&newHash!==loc.hash){loc.hash=newHash;}}catch(e){}},800);return {installed:true};}catch(e){return {error:e.message};}})()"#,
                                                                                                "returnByValue": true,
                                                                                                "awaitPromise": true
                                                                                            }
                                                                                        }).to_string()
                                                                                    )).await;
                                                                                }

                                                                                // 메인 페이지에도 주입 (fallback)
                                                                                let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                    serde_json::json!({
                                                                                        "id": 777002,
                                                                                        "method": "Runtime.evaluate",
                                                                                        "params": {
                                                                                            "expression": auto_click_script,
                                                                                            "returnByValue": true,
                                                                                            "awaitPromise": true
                                                                                        }
                                                                                    }).to_string()
                                                                                )).await;

                                                                                // 모든 iframe 세션에도 주입
                                                                                for session_id in attached_sessions.iter() {
                                                                                    // source_session_id와 같으면 이미 주입됨
                                                                                    if source_session_id.as_ref().map(|s| s == session_id).unwrap_or(false) {
                                                                                        continue;
                                                                                    }
                                                                                    info!("🎯 FALLBACK: Also injecting to iframe session: {}", session_id);
                                                                                    let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                        serde_json::json!({
                                                                                            "id": 777003,
                                                                                            "sessionId": session_id,
                                                                                            "method": "Runtime.evaluate",
                                                                                            "params": {
                                                                                                "expression": auto_click_script,
                                                                                                "returnByValue": true,
                                                                                                "awaitPromise": true
                                                                                            }
                                                                                        }).to_string()
                                                                                    )).await;

                                                                                    // 해시 감시도 함께 주입
                                                                                    let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                        serde_json::json!({
                                                                                            "id": 777006,
                                                                                            "sessionId": session_id,
                                                                                            "method": "Runtime.evaluate",
                                                                                            "params": {
                                                                                                "expression": r#"(function(){try{if(window.__bcr_hash_watcher_installed) return {installed:true};window.__bcr_hash_watcher_installed=true;setInterval(function(){try{var loc=window.location;if(!loc||!loc.hostname||loc.hostname.indexOf('evo-games.com')===-1) return;var hash=loc.hash||'';var params=new URLSearchParams(hash.startsWith('#')?hash.slice(1):hash);var changed=false;if(params.get('category')!=='baccarat'){params.set('category','baccarat');changed=true;}var ua=params.get('ua_launch_id');if(ua) params.set('ua_launch_id', ua);var newHash='#'+params.toString();if(changed&&newHash!==loc.hash){loc.hash=newHash;}}catch(e){}},800);return {installed:true};}catch(e){return {error:e.message};}})()"#,
                                                                                                "returnByValue": true,
                                                                                                "awaitPromise": true
                                                                                            }
                                                                                        }).to_string()
                                                                                    )).await;
                                                                                }

                                                                                // 모든 execution context에도 주입 시도
                                                                                for ctx_id in execution_contexts.iter() {
                                                                                    info!("🎯 FALLBACK: Also injecting to context: {}", ctx_id);
                                                                                    let mut inject_ctx = serde_json::json!({
                                                                                        "id": 777004,
                                                                                        "method": "Runtime.evaluate",
                                                                                        "params": {
                                                                                            "expression": auto_click_script,
                                                                                            "returnByValue": true,
                                                                                            "awaitPromise": true,
                                                                                            "contextId": ctx_id
                                                                                        }
                                                                                    });
                                                                                    if let Some(session_id) = context_sessions.get(ctx_id) {
                                                                                        inject_ctx["sessionId"] = serde_json::json!(session_id);
                                                                                    }
                                                                                    let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                        inject_ctx.to_string()
                                                                                    )).await;

                                                                                    // 해시 감시도 함께 주입
                                                                                    let mut hash_ctx = serde_json::json!({
                                                                                        "id": 777007,
                                                                                        "method": "Runtime.evaluate",
                                                                                        "params": {
                                                                                            "expression": r#"(function(){try{if(window.__bcr_hash_watcher_installed) return {installed:true};window.__bcr_hash_watcher_installed=true;setInterval(function(){try{var loc=window.location;if(!loc||!loc.hostname||loc.hostname.indexOf('evo-games.com')===-1) return;var hash=loc.hash||'';var params=new URLSearchParams(hash.startsWith('#')?hash.slice(1):hash);var changed=false;if(params.get('category')!=='baccarat'){params.set('category','baccarat');changed=true;}var ua=params.get('ua_launch_id');if(ua) params.set('ua_launch_id', ua);var newHash='#'+params.toString();if(changed&&newHash!==loc.hash){loc.hash=newHash;}}catch(e){}},800);return {installed:true};}catch(e){return {error:e.message};}})()"#,
                                                                                            "returnByValue": true,
                                                                                            "awaitPromise": true,
                                                                                            "contextId": ctx_id
                                                                                        }
                                                                                    });
                                                                                    if let Some(session_id) = context_sessions.get(ctx_id) {
                                                                                        hash_ctx["sessionId"] = serde_json::json!(session_id);
                                                                                    }
                                                                                    let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(
                                                                                        hash_ctx.to_string()
                                                                                    )).await;
                                                                                }
                                                                            }
                                                                        }
                                    */
                                    // END OF DELETED CODE

                                    last_ws_provider = Some("evolution".to_string());
                                    last_ws_url = Some(url.to_string());

                                    // ✅ Session hint from URL query (some environments only provide it via Cookie header)
                                    let has_session_in_url =
                                        url.to_lowercase().contains("evosessionid=");

                                    // 🔍 DEBUG: Log URL characteristics for multiwidget detection
                                    info!("🔍 [WS-ANALYZE] has_session={} contains_lobby={} contains_game={} contains_multiwidget={} contains_multiplay={}",
                                        has_session_in_url,
                                        url.contains("/lobby/"),
                                        url.contains("/game/"),
                                        url.contains("multiwidget"),
                                        url.contains("multiplay")
                                    );

                                    // 🆕 LOBBY v2: Evolution unified the multi-table (multiwidget) feed into
                                    // "lobby v2" at /public/lobby/socket/v2/. That socket now carries the
                                    // multi-table data, so it MUST be treated as the multiwidget socket and
                                    // connected directly from Rust — otherwise it is misclassified as a plain
                                    // lobby socket and silently skipped, and the multi-socket never connects (v2-1).
                                    // ✅ MULTIWIDGET SOCKET: Extended patterns for multiwidget detection
                                    let is_multiwidget_ws = url.contains("/multiwidget/socket")
                                        || url.contains("/game/multiwidget/")
                                        || url.contains("/multiwidget/")
                                        || url.contains("/multiplay/")
                                        || url.contains("multiwidget")
                                        || url.contains("multiplay")
                                        || url.contains("mwLayout");

                                    // Check if this is a lobby WebSocket (not room, not multiwidget).
                                    // NOTE: lobby v2 is now classified as multiwidget above, so it never
                                    // falls into this skip branch.
                                    let is_lobby_ws = !is_multiwidget_ws
                                        && (url.contains("/lobby/")
                                            || (!url.contains("/game/")
                                                && !url.contains("/baccarat/player/")));

                                    info!(
                                        "🔍 [WS-TYPE] is_multiwidget={} is_lobby={} is_room={}",
                                        is_multiwidget_ws,
                                        is_lobby_ws,
                                        url.contains("/game/")
                                            && url.contains("/socket")
                                            && !is_multiwidget_ws
                                    );

                                    // 이미 CDP 정지 플래그가 올라가면 추가 처리를 건너뛴다 (중복 오토 연결 방지)
                                    if CDP_SHOULD_STOP.load(std::sync::atomic::Ordering::SeqCst) {
                                        debug!(
                                            "🛑 CDP stop flag set, skip WebSocket handling (url_len={})",
                                            url.len()
                                        );
                                        continue;
                                    }

                                    // 🎯 PRIORITY 1: Multiwidget socket - AUTO-CONNECT directly from Rust!
                                    // ⚠️ IMPORTANT: Only connect ONCE per session to avoid "connectionAlreadyExists" error
                                    // 🔥 UNIFIED: Always use multiwidget socket for ALL modes (predict + auto)
                                    // This ensures consistent behavior and prevents session conflicts
                                    if is_multiwidget_ws {
                                        // 🔥 REMOVED: PREDICT MODE skip logic
                                        // Now we use multiwidget socket for ALL modes to ensure consistent subscription behavior

                                        // Check if already connected - skip if so
                                        if MULTIWIDGET_CONNECTED
                                            .load(std::sync::atomic::Ordering::SeqCst)
                                        {
                                            debug!(
                                                "🎰 [SKIP] Multiwidget already connected, ignoring duplicate WebSocket (url_len={})",
                                                url.len()
                                            );
                                            continue;
                                        }

                                        // URL debouncing: Extract unique key (EVOSESSIONID) and check if recently processed
                                        let session_key = url::Url::parse(url)
                                            .ok()
                                            .and_then(|u| {
                                                u.query_pairs().find_map(|(k, v)| {
                                                    k.as_ref()
                                                        .eq_ignore_ascii_case("EVOSESSIONID")
                                                        .then(|| v.to_string())
                                                })
                                            })
                                            .unwrap_or_default();

                                        if !session_key.is_empty() {
                                            let mut processed =
                                                PROCESSED_MULTIWIDGET_URLS.lock().unwrap();
                                            let now = std::time::Instant::now();

                                            // Check if this session was processed in the last 30 seconds
                                            if let Some(last_time) = processed.get(&session_key) {
                                                if now.duration_since(*last_time).as_secs() < 30 {
                                                    debug!(
                                                        "🎰 [SKIP] Session recently processed, debouncing (session_id_len={})",
                                                        session_key.len()
                                                    );
                                                    continue;
                                                }
                                            }

                                            // Mark as processed
                                            processed.insert(session_key.clone(), now);

                                            // Cleanup old entries (older than 60 seconds)
                                            processed.retain(|_, v| {
                                                now.duration_since(*v).as_secs() < 60
                                            });
                                        }

                                        info!(
                                            "🎰 MULTIWIDGET WebSocket detected (url_len={}, has_session_query={})",
                                            url.len(),
                                            !session_key.is_empty()
                                        );
                                        info!(
                                            "🎰 AUTO-CONNECTING to multiwidget socket from CDP..."
                                        );

                                        // 🔥 CRITICAL: Capture multiwidget WebSocket domain for room navigation
                                        // wss://babylontggasia.evo-games.com/... -> https://babylontggasia.evo-games.com
                                        // This is the REAL Evolution domain to use
                                        if let Some(domain) = url
                                            .strip_prefix("wss://")
                                            .or_else(|| url.strip_prefix("ws://"))
                                        {
                                            if let Some(slash_pos) = domain.find('/') {
                                                let domain_only = &domain[..slash_pos];
                                                let base_url = format!("https://{}", domain_only);
                                                info!(
                                                    "🔒 Evolution base URL captured from multiwidget (url_len={})",
                                                    base_url.len()
                                                );
                                                if let Ok(mut guard) = EVOLUTION_BASE_URL.lock() {
                                                    *guard = Some(base_url.clone());
                                                }
                                                // Emit to frontend for room navigation
                                                if let Some(main_window) =
                                                    app_handle.get_webview_window("main")
                                                {
                                                    let _ = main_window.emit(
                                                        "evolution-base-url-captured",
                                                        serde_json::json!({
                                                            "baseUrl": base_url,
                                                            "wsUrl": url
                                                        }),
                                                    );
                                                }
                                            }
                                        }

                                        // Set flag BEFORE spawning to prevent race conditions
                                        MULTIWIDGET_CONNECTED
                                            .store(true, std::sync::atomic::Ordering::SeqCst);

                                        // 🍪 CRITICAL: Get ALL cookies from browser BEFORE closing multiwidget
                                        // This includes _abck cookie required by Akamai Bot Manager
                                        info!("🍪 Fetching all browser cookies via CDP Network.getAllCookies...");
                                        let get_cookies_cmd = serde_json::json!({
                                            "id": 88888,
                                            "method": "Network.getAllCookies"
                                        });
                                        let _ = write
                                            .lock()
                                            .await
                                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                                get_cookies_cmd.to_string(),
                                            ))
                                            .await;

                                        // Wait briefly for cookie response to be processed
                                        tokio::time::sleep(tokio::time::Duration::from_millis(300))
                                            .await;

                                        // ✅ CRITICAL: Close multiwidget by clicking multiplay toggle button in lobby
                                        // Evolution properly cleans up session when UI is closed (generates new instance ID)
                                        // The multiplay button in lobby acts as a toggle - clicking again closes the multiwidget
                                        info!("🔌 Clicking multiplay toggle button to close multiwidget...");
                                        let close_multiplay_js = r#"
                                            (function() {
                                                function shouldBlock(url) {
                                                    if (!url) return false;
                                                    url = String(url);
                                                    return url.indexOf('multiwidget') !== -1 ||
                                                           url.indexOf('multiplay') !== -1 ||
                                                           (url.indexOf('/game/') !== -1 && url.indexOf('/lobby/') === -1);
                                                }

                                                // Helper function to trigger click with all methods
                                                function clickReactButton(btn) {
                                                    console.log('[BCR] 🔧 Attempting all click methods...');

                                                    // Method 1: Dispatch real mouse events (most reliable)
                                                    try {
                                                        var rect = btn.getBoundingClientRect();
                                                        var x = rect.left + rect.width / 2;
                                                        var y = rect.top + rect.height / 2;

                                                        ['mousedown', 'mouseup', 'click'].forEach(function(type) {
                                                            var evt = new MouseEvent(type, {
                                                                view: window,
                                                                bubbles: true,
                                                                cancelable: true,
                                                                clientX: x,
                                                                clientY: y
                                                            });
                                                            btn.dispatchEvent(evt);
                                                        });
                                                        console.log('[BCR] ✅ Dispatched MouseEvents');
                                                    } catch(e) {
                                                        console.log('[BCR] ⚠️ MouseEvent dispatch failed:', e);
                                                    }

                                                    // Method 2: Try React fiber onClick
                                                    for (var key in btn) {
                                                        if (key.startsWith('__reactFiber')) {
                                                            var fiber = btn[key];
                                                            if (fiber && fiber.memoizedProps && fiber.memoizedProps.onClick) {
                                                                console.log('[BCR] 🎯 Calling React fiber onClick');
                                                                try {
                                                                    fiber.memoizedProps.onClick({
                                                                        preventDefault: function(){},
                                                                        stopPropagation: function(){},
                                                                        nativeEvent: { stopImmediatePropagation: function(){} }
                                                                    });
                                                                } catch(e) { console.log('[BCR] fiber onClick error:', e); }
                                                            }
                                                        }
                                                        if (key.startsWith('__reactProps')) {
                                                            var props = btn[key];
                                                            if (props && props.onClick) {
                                                                console.log('[BCR] 🎯 Calling React props onClick');
                                                                try {
                                                                    props.onClick({
                                                                        preventDefault: function(){},
                                                                        stopPropagation: function(){},
                                                                        nativeEvent: { stopImmediatePropagation: function(){} }
                                                                    });
                                                                } catch(e) { console.log('[BCR] props onClick error:', e); }
                                                            }
                                                        }
                                                    }

                                                    // Method 3: Native click
                                                    btn.click();
                                                    console.log('[BCR] ✅ All click methods attempted');
                                                }

                                                // 1. Try clicking the multiplay toggle button in LOBBY (main page)
                                                // This button acts as a toggle - clicking it again closes the multiwidget
                                                var toggleBtn = document.querySelector('[data-role="multiplay-button"]') ||
                                                                document.querySelector('button[class*="MultiPlayButton"]');
                                                if (toggleBtn) {
                                                    console.log('[BCR] 🔄 Found multiplay toggle button in lobby, clicking to CLOSE...');
                                                    clickReactButton(toggleBtn);

                                                    // Block future multiwidget WebSocket connections
                                                    if (!window.__BCR_WS_BLOCKED__) {
                                                        window.__BCR_WS_BLOCKED__ = true;
                                                        var OrigWebSocket = window.WebSocket;
                                                        window.WebSocket = function(url, protocols) {
                                                            if (url && shouldBlock(url)) {
                                                                console.log('[BCR] Blocked new multiwidget WS:', String(url).slice(0, 120));
                                                                var dummy = {readyState:3,CLOSED:3,send:function(){},close:function(){},
                                                                    addEventListener:function(){},removeEventListener:function(){},
                                                                    onopen:null,onclose:null,onerror:null,onmessage:null};
                                                                setTimeout(function(){ if(dummy.onclose) dummy.onclose({code:1000}); }, 10);
                                                                return dummy;
                                                            }
                                                            return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
                                                        };
                                                        window.WebSocket.prototype = OrigWebSocket.prototype;
                                                        window.WebSocket.CONNECTING = 0;
                                                        window.WebSocket.OPEN = 1;
                                                        window.WebSocket.CLOSING = 2;
                                                        window.WebSocket.CLOSED = 3;
                                                    }

                                                    return { closed: true, method: 'lobbyToggle' };
                                                }

                                                // 2. Fallback: try close button inside multiwidget iframe (exact selector)
                                                var closeBtn = document.querySelector('#root > div.container--82c3a > div.header--3d6bc > div:nth-child(3) > button');
                                                if (closeBtn) {
                                                    console.log('[BCR] Found close button in iframe, clicking...');
                                                    closeBtn.click();
                                                    return { closed: true, method: 'iframeClose' };
                                                }

                                                console.log('[BCR] No multiplay button found in this context');
                                                return { closed: false, method: 'none' };
                                            })()
                                        "#;

                                        // Execute JS to click close button in all contexts (multiwidget is inside iframe)
                                        for ctx_id in &execution_contexts {
                                            let close_cmd = serde_json::json!({
                                                "id": 99999,
                                                "method": "Runtime.evaluate",
                                                "params": {
                                                    "expression": close_multiplay_js,
                                                    "contextId": ctx_id,
                                                    "returnByValue": true
                                                }
                                            });
                                            if let Some(session_id) = context_sessions.get(ctx_id) {
                                                let mut cmd = close_cmd.clone();
                                                cmd["sessionId"] = serde_json::json!(session_id);
                                                let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(cmd.to_string())).await;
                                            } else {
                                                let _ = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(close_cmd.to_string())).await;
                                            }
                                        }

                                        // Wait for Evolution to cleanly close WebSocket and server to release session
                                        // Using close button is more reliable as Evolution sends proper disconnect signal
                                        tokio::time::sleep(tokio::time::Duration::from_millis(
                                            1500,
                                        ))
                                        .await;

                                        // Clone values for async block
                                        let ws_url_for_connect = url.to_string();
                                        let app_handle_for_connect = app_handle.clone();
                                        let ws_headers_by_request_id_for_connect =
                                            ws_headers_by_request_id.clone();
                                        let request_id_for_connect = request_id.to_string();
                                        let has_session_param_for_connect = has_session_in_url;

                                        // Spawn async task to connect multiwidget
                                        tokio::spawn(async move {
                                            // 🍪 PRIORITY: Use BROWSER_ALL_COOKIES if available (includes _abck for Akamai)
                                            let mut options = MultiSocketOptions::default();

                                            // First, try to get cookies from Network.getAllCookies
                                            if let Some(all_cookies) =
                                                BROWSER_ALL_COOKIES.lock().unwrap().clone()
                                            {
                                                let cookie_count = all_cookies
                                                    .split(';')
                                                    .filter(|cookie| !cookie.trim().is_empty())
                                                    .count();
                                                info!(
                                                    "🍪 Using full browser cookies: count={}, header_len={}, has_abck={}",
                                                    cookie_count,
                                                    all_cookies.len(),
                                                    all_cookies.contains("_abck=")
                                                );
                                                options.cookie = Some(all_cookies);
                                            }

                                            // Fallback: Wait briefly for handshake headers (Cookie/User-Agent/Origin/Referer)
                                            // Some providers no longer include EVOSESSIONID in the WS URL query.
                                            for _ in 0..10 {
                                                {
                                                    let map = ws_headers_by_request_id_for_connect
                                                        .lock()
                                                        .await;
                                                    if let Some(h) =
                                                        map.get(&request_id_for_connect)
                                                    {
                                                        // Only use handshake cookie if we don't have browser cookies
                                                        if options.cookie.is_none() {
                                                            options.cookie = h.cookie.clone();
                                                        }
                                                        if options.user_agent.is_none() {
                                                            options.user_agent =
                                                                h.user_agent.clone();
                                                        }
                                                        if options.origin.is_none() {
                                                            options.origin = h.origin.clone();
                                                        }
                                                        if options.referer.is_none() {
                                                            options.referer = h.referer.clone();
                                                        }
                                                    }
                                                }

                                                if options.cookie.is_some() {
                                                    break;
                                                }

                                                tokio::time::sleep(
                                                    tokio::time::Duration::from_millis(200),
                                                )
                                                .await;
                                            }

                                            let cookie_has_session = options
                                                .cookie
                                                .as_ref()
                                                .map(|c| c.to_lowercase().contains("evosessionid="))
                                                .unwrap_or(false);

                                            if !has_session_param_for_connect && !cookie_has_session
                                            {
                                                error!("🎰 ❌ Multiwidget detected but EVOSESSIONID not found in URL or Cookie header; skipping auto-connect");
                                                if let Some(main_window) = app_handle_for_connect
                                                    .get_webview_window("main")
                                                {
                                                    let _ = main_window.emit(
	                                                        "evolution_multi_error",
	                                                        serde_json::json!({
	                                                            "url": ws_url_for_connect,
	                                                            "error": "EVOSESSIONID missing (URL/Cookie)",
	                                                            "errorDetail": "Multiwidget WS detected but EVOSESSIONID was not found in the WebSocket URL query nor the handshake Cookie header"
	                                                        }),
	                                                    );
                                                }
                                                MULTIWIDGET_CONNECTED.store(
                                                    false,
                                                    std::sync::atomic::Ordering::SeqCst,
                                                );
                                                return;
                                            }

                                            let mut client = MULTIWIDGET_CLIENT.lock().await;

                                            // If already connected, just skip (double-check)
                                            if client.is_connected() {
                                                info!("🎰 [SKIP] Client already connected, not reconnecting");
                                                return;
                                            }

                                            // Setup event bridge for Tauri integration
                                            let event_rx = client.create_event_channel();
                                            crate::evolution::event_bridge::spawn_event_bridge(
                                                app_handle_for_connect.clone(),
                                                event_rx,
                                            );

                                            match client
                                                .connect(ws_url_for_connect.clone(), options)
                                                .await
                                            {
                                                Ok(_) => {
                                                    info!("🎰 ✅ Multiwidget auto-connection initiated!");
                                                    // 🔥 IMPORTANT: Do NOT stop CDP!
                                                    info!("🛡️ CDP continues running");
                                                }
                                                Err(e) => {
                                                    error!("🎰 ❌ Multiwidget auto-connection failed: {}", e);
                                                    // Reset flag on failure so we can retry
                                                    MULTIWIDGET_CONNECTED.store(
                                                        false,
                                                        std::sync::atomic::Ordering::SeqCst,
                                                    );
                                                    CDP_SHOULD_STOP.store(
                                                        false,
                                                        std::sync::atomic::Ordering::SeqCst,
                                                    );
                                                }
                                            }
                                        });

                                        // Also emit event to frontend for UI update
                                        if let Some(main_window) =
                                            app_handle.get_webview_window("main")
                                        {
                                            let _ = main_window.emit(
                                                "evolution-multiwidget-detected",
                                                serde_json::json!({
                                                    "wsUrl": url,
                                                    "autoConnecting": true
                                                }),
                                            );
                                        }
                                        // Skip further processing - multiwidget is the target
                                        continue;
                                    }

                                    // 🔥 UNIFIED: Lobby socket logic removed
                                    // Now we ONLY use multiwidget socket for ALL modes
                                    // This ensures consistent subscription behavior for testing

                                    // Emit lobby URL if it has session info (for compatibility)
                                    if has_session_in_url && is_lobby_ws {
                                        // 🔥 REMOVED: PREDICT MODE lobby socket connection
                                        // Multiwidget socket is now used for ALL modes
                                        info!("🎯 [UNIFIED] Lobby WebSocket detected but SKIPPING - using multiwidget only");
                                        // Just emit event to frontend for compatibility
                                        info!("🎯 Evolution lobby URL has session info (Pragmatic style!) - AUTO-EMIT for room connections!");
                                        if let Some(main_window) =
                                            app_handle.get_webview_window("main")
                                        {
                                            let _ = main_window.emit(
                                                "evolution-lobby-url-captured",
                                                serde_json::json!({
                                                    "wsUrl": url,
                                                    "originPage": page_id_owned
                                                }),
                                            );
                                        }
                                    } else if has_session_in_url && effective_lobby_page {
                                        // Fallback for lobby pages without /lobby/ in URL
                                        info!("🎯 Evolution lobby URL (by page detection) - emitting for room connections");
                                        if let Some(main_window) =
                                            app_handle.get_webview_window("main")
                                        {
                                            let _ = main_window.emit(
                                                "evolution-lobby-url-captured",
                                                serde_json::json!({
                                                    "wsUrl": url,
                                                    "originPage": page_id_owned
                                                }),
                                            );
                                        }
                                    } else {
                                        // Fallback: emit generic event (for room pages or URLs without full session)
                                        if let Some(main_window) =
                                            app_handle.get_webview_window("main")
                                        {
                                            let _ = main_window.emit(
                                                "evolution-websocket-captured",
                                                serde_json::json!({
                                                    "wsUrl": url,
                                                    "isEvolution": true,
                                                    "cookies": null,
                                                    "originPage": page_id_owned,
                                                    "isLobby": effective_lobby_page
                                                }),
                                            );
                                        }
                                    }
                                }
                                // Only check Pragmatic if NOT Evolution
                                else if is_pragmatic_url(url) {
                                    info!(
                                        "🎯 Pragmatic WebSocket found on page {}!",
                                        page_id_owned
                                    );
                                    last_ws_provider = Some("pragmatic".to_string());
                                    last_ws_url = Some(url.to_string());

                                    if let Ok(mut guard) = PRAGMATIC_LAST_WS_URL.lock() {
                                        *guard = Some(url.to_string());
                                    }

                                    // Cache Pragmatic launcher URL from WS session params (enables first-click navigation)
                                    if let Ok(mut guard) = PRAGMATIC_LAUNCHER_URL.lock() {
                                        if let Some(launcher_url) =
                                            build_pragmatic_launcher_url_from_ws(url)
                                        {
                                            let current_has_jsession = guard
                                                .as_ref()
                                                .map(|u| u.contains("JSESSIONID="))
                                                .unwrap_or(false);
                                            let next_has_jsession =
                                                launcher_url.contains("JSESSIONID=");

                                            let should_update = guard.is_none()
                                                || (!current_has_jsession && next_has_jsession);

                                            if should_update {
                                                info!(
                                                    "🎲 Cached Pragmatic launcher URL from WS (url_len={}, has_jsession={})",
                                                    launcher_url.len(),
                                                    launcher_url
                                                        .to_ascii_lowercase()
                                                        .contains("jsessionid=")
                                                );
                                                *guard = Some(launcher_url);
                                            }
                                        } else {
                                            debug!(
                                                "🎲 Could not build Pragmatic launcher URL from WS"
                                            );
                                        }
                                    }

                                    if let Some(main_window) = app_handle.get_webview_window("main")
                                    {
                                        let _ = main_window.emit(
                                            "evolution-websocket-captured",
                                            serde_json::json!({
                                                "wsUrl": url,
                                                "isEvolution": false,
                                                "isPragmatic": true,
                                                "cookies": null,
                                                "originPage": page_id_owned,
                                                "isLobby": is_lobby_page
                                            }),
                                        );
                                    }
                                }
                            }
                        }
                        // Monitor WebSocket frames SENT by browser (to see subscribe messages)
                        else if method == "Network.webSocketFrameSent" {
                            if let Some(params) = json.get("params") {
                                if let Some(response) = params.get("response") {
                                    if let Some(payload) =
                                        response.get("payloadData").and_then(|v| v.as_str())
                                    {
                                        // Browser frames can contain session and betting data.
                                        // Keep only the size for diagnostics.
                                        debug!("📤 [BROWSER-SENT] payload_len={}", payload.len());

                                        // Parse CLIENT_* messages for auto-betting config capture
                                        if let Ok(json_msg) =
                                            serde_json::from_str::<serde_json::Value>(payload)
                                        {
                                            if let Some(log) = json_msg.get("log") {
                                                if let Some(msg_type) =
                                                    log.get("type").and_then(|v| v.as_str())
                                                {
                                                    // CLIENT_UNAVAILABLE_CHIPS_HIDDEN - chipStack, channel, orientation
                                                    if msg_type == "CLIENT_UNAVAILABLE_CHIPS_HIDDEN"
                                                    {
                                                        if let Some(value) = log.get("value") {
                                                            info!("🎰 [CDP] CLIENT_UNAVAILABLE_CHIPS_HIDDEN captured");
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit("evolution-table-config", serde_json::json!({
                                                                    "type": "chips_hidden",
                                                                    "originalChipStack": value.get("originalChipStack"),
                                                                    "hiddenChips": value.get("hiddenChips"),
                                                                    "channel": value.get("channel"),
                                                                    "orientation": value.get("orientation")
                                                                }));
                                                            }
                                                        }
                                                    }
                                                    // CLIENT_BET_CHIP - tableMinLimit, tableMaxLimit, gameDimensions, currency, gameId
                                                    else if msg_type == "CLIENT_BET_CHIP" {
                                                        if let Some(value) = log.get("value") {
                                                            info!("🎰 [CDP] CLIENT_BET_CHIP captured: tableId={}",
                                                                value.get("tableId").and_then(|v| v.as_str()).unwrap_or("unknown"));
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit("evolution-table-config", serde_json::json!({
                                                                    "type": "bet_chip",
                                                                    "tableId": value.get("tableId"),
                                                                    "gameId": value.get("gameId"),
                                                                    "chipStack": value.get("chipStack"),
                                                                    "tableMinLimit": value.get("tableMinLimit"),
                                                                    "tableMaxLimit": value.get("tableMaxLimit"),
                                                                    "currency": value.get("currency"),
                                                                    "channel": value.get("channel"),
                                                                    "orientation": value.get("orientation"),
                                                                    "gameDimensions": value.get("gameDimensions"),
                                                                    "balance": value.get("balance")
                                                                }));
                                                            }
                                                        }
                                                    }
                                                    // CLIENT_BET_ACCEPTED / CLIENT_BALANCE_UPDATED — 실시간 '게임 잔액'(value.balance).
                                                    // 라이브 캡처(2026-06-02)로 확인: 게임 잔액은 이 두 메시지로 흐른다(예 balance:41580).
                                                    // 앱은 CLIENT_BET_CHIP(수동 칩)만 잡아서 자동 실배팅 땐 잔액이 안 갱신됐다(근본원인).
                                                    // → 여기서 balance를 evolution_multi_event(type:balance)로 forward하면 프론트
                                                    //   parseMessage가 game/total을 동적 추출해 실시간 반영한다(테이블/경로 하드코딩 없음).
                                                    else if msg_type == "CLIENT_BET_ACCEPTED"
                                                        || msg_type == "CLIENT_BALANCE_UPDATED"
                                                    {
                                                        if let Some(bal) = log
                                                            .get("value")
                                                            .and_then(|v| v.get("balance"))
                                                            .and_then(|v| v.as_f64())
                                                        {
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit(
                                                                    "evolution_multi_event",
                                                                    serde_json::json!({
                                                                        "eventType": "balance",
                                                                        "data": {"type": "balance", "game": bal, "total": bal}
                                                                    }),
                                                                );
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        // Monitor WebSocket frames for game data
                        else if method == "Network.webSocketFrameReceived" {
                            if let Some(params) = json.get("params") {
                                let request_id = params
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if let Some(response) = params.get("response") {
                                    if let Some(payload) =
                                        response.get("payloadData").and_then(|v| v.as_str())
                                    {
                                        // 🔍 DEBUG: Log received frame info
                                        debug!(
                                            "📥 WS frame received: provider={:?}, page={}, len={}",
                                            last_ws_provider,
                                            page_id_owned,
                                            payload.len()
                                        );

                                        // Track if message was handled as Pragmatic (to skip Evolution handling)
                                        let mut handled_as_pragmatic = false;

                                        // Parse JSON once for reuse
                                        let parsed_json =
                                            serde_json::from_str::<serde_json::Value>(payload).ok();

                                        // Check for "type" field to identify message
                                        if let Some(ref json_msg) = parsed_json {
                                            if let Some(msg_type_val) =
                                                json_msg.get("type").and_then(|v| v.as_str())
                                            {
                                                // Only log important types, skip lobby noise
                                                if !msg_type_val.starts_with("lobby.") {
                                                    debug!(
                                                        "📦 WS frame type='{}' from page {}",
                                                        msg_type_val, page_id_owned
                                                    );
                                                }
                                            }
                                        }

                                        // 💰 실시간 잔액 forward (2026-06-02, 라이브 확인):
                                        // 중계사이트 소켓(wss://hl-101.com/ws)이 보내는
                                        //   {"type":"balance","total":N,"local":N,"game":N,"breakdown":{...}}
                                        // 프레임은 아래 Evolution forward 필터(historyUpdated/result/winner…)에
                                        // "balance" 키워드가 없어 프론트로 전달되지 않았다 → 자동 실배팅 시
                                        // realBalance가 안 갱신되던 근본 원인. 모드(predict/auto) 무관하게,
                                        // 그리고 Pragmatic/Evolution 분기 이전에 명시적으로 forward한다.
                                        // (프론트 EvolutionAdapter.parseMessage가 game/total을 동적 추출)
                                        if let Some(ref j) = parsed_json {
                                            if j.get("type").and_then(|v| v.as_str())
                                                == Some("balance")
                                            {
                                                if let Some(main_window) =
                                                    app_handle.get_webview_window("main")
                                                {
                                                    let _ = main_window.emit(
                                                        "evolution_multi_event",
                                                        serde_json::json!({
                                                            "eventType": "balance",
                                                            "data": j
                                                        }),
                                                    );
                                                }
                                            }
                                        }

                                        // ✅ Pragmatic detection: URL-based OR content-based
                                        let is_pragmatic_by_url = matches!(
                                            last_ws_provider.as_deref(),
                                            Some("pragmatic")
                                        );
                                        let is_pragmatic_by_content = parsed_json
                                            .as_ref()
                                            .map(|j| is_pragmatic_message_content(j))
                                            .unwrap_or(false);

                                        // 🔍 DEBUG: Log Pragmatic detection result
                                        if is_pragmatic_by_url || is_pragmatic_by_content {
                                            info!(
                                                "🎲 Pragmatic frame: by_url={}, by_content={}, payload_len={}",
                                                is_pragmatic_by_url, is_pragmatic_by_content,
                                                payload.len()
                                            );
                                        }

                                        if is_pragmatic_by_url || is_pragmatic_by_content {
                                            handled_as_pragmatic = true;

                                            if is_pragmatic_by_content && !is_pragmatic_by_url {
                                                info!("🎰 Pragmatic message detected by content (tableId+tableType pattern)");
                                            }

                                            // Capture mapping: operatorGameId(=payload.tableId) -> WS query tableId + session (JSESSIONID)
                                            if let (Some(op_id), Some(ws_url)) = (
                                                parsed_json
                                                    .as_ref()
                                                    .and_then(|j| j.get("tableId"))
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string()),
                                                (!request_id.is_empty())
                                                    .then(|| ws_url_by_request_id.get(request_id))
                                                    .flatten()
                                                    .cloned(),
                                            ) {
                                                let mut updated_ws = false;
                                                if let Ok(mut map) =
                                                    PRAGMATIC_WS_URL_BY_OPERATOR_GAME_ID.lock()
                                                {
                                                    let should_update = map
                                                        .get(&op_id)
                                                        .map(|existing| existing != &ws_url)
                                                        .unwrap_or(true);
                                                    if should_update {
                                                        map.insert(op_id.clone(), ws_url.clone());
                                                        updated_ws = true;
                                                    }
                                                }

                                                let mut mapped_table_id: Option<String> = None;
                                                if let Ok(parsed_ws) = url::Url::parse(&ws_url) {
                                                    let mut ws_table_id: Option<String> = None;
                                                    let mut has_jsession = false;
                                                    for (k, v) in parsed_ws.query_pairs() {
                                                        if k.eq_ignore_ascii_case("tableId") {
                                                            ws_table_id = Some(v.into_owned());
                                                        } else if k
                                                            .eq_ignore_ascii_case("JSESSIONID")
                                                        {
                                                            has_jsession = true;
                                                        }
                                                    }

                                                    if let Some(ws_table_id) = ws_table_id {
                                                        mapped_table_id = Some(ws_table_id.clone());
                                                        if let Ok(mut map) =
                                                            PRAGMATIC_TABLE_ID_BY_OPERATOR_GAME_ID
                                                                .lock()
                                                        {
                                                            let should_update = map
                                                                .get(&op_id)
                                                                .map(|existing| {
                                                                    existing != &ws_table_id
                                                                })
                                                                .unwrap_or(true);
                                                            if should_update {
                                                                map.insert(
                                                                    op_id.clone(),
                                                                    ws_table_id,
                                                                );
                                                            }
                                                        }
                                                    }

                                                    if has_jsession {
                                                        if let Ok(mut guard) =
                                                            PRAGMATIC_LAST_WS_URL.lock()
                                                        {
                                                            *guard = Some(ws_url);
                                                        }
                                                    }
                                                }

                                                if updated_ws {
                                                    if let Some(ws_table_id) = mapped_table_id {
                                                        info!(
                                                            "🎲 Pragmatic mapping captured: operatorGameId={} -> tableId={}",
                                                            op_id, ws_table_id
                                                        );
                                                    } else {
                                                        info!(
                                                            "🎲 Pragmatic mapping captured: operatorGameId={} (ws url stored)",
                                                            op_id
                                                        );
                                                    }
                                                }
                                            }

                                            if let Some(main_window) =
                                                app_handle.get_webview_window("main")
                                            {
                                                let _ = main_window.emit(
                                                    "pragmatic_raw_message",
                                                    serde_json::json!({
                                                        "pageId": page_id_owned,
                                                        "roomId": table_id_owned,
                                                        "url": last_ws_url,
                                                        "message": payload
                                                    }),
                                                );
                                            }

                                            // ✅ Pragmatic: 바로 파싱/정규화해서 pragmatic_event로 송출 (직접 소켓 연결 실패 대비)
                                            match pragmatic_parser::parse_message(payload) {
                                                Some(parsed) => {
                                                    debug!("🎲 Pragmatic parsed: {:?}", parsed);
                                                    match pragmatic_normalizer::normalize_message(
                                                        parsed,
                                                    ) {
                                                        Some(event) => {
                                                            info!(
                                                                "🎲 Emitting pragmatic_event: {:?}",
                                                                event
                                                            );
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window
                                                                    .emit("pragmatic_event", event);
                                                            }
                                                        }
                                                        None => {
                                                            debug!("🎲 Pragmatic normalize returned None (filtered out)");
                                                        }
                                                    }
                                                }
                                                None => {
                                                    debug!(
                                                        "🎲 Pragmatic parse returned None (payload_len={})",
                                                        payload.len()
                                                    );
                                                }
                                            }
                                        }

                                        // Skip Evolution handling if already handled as Pragmatic
                                        if handled_as_pragmatic {
                                            continue;
                                        }

                                        // 📡 [ROOM-FIX 2026-06-10] CDP가 캡처한 '실제' Evolution 프레임을 프론트로 raw forward.
                                        // 프론트 EvolutionAdapter가 단일 파서 — 라이브 덤프로 확인된 실제 타입을 그대로 넘기면 처리한다:
                                        //   widget.availableTables(방 목록 · args.availableTables[]),
                                        //   baccarat.shoeState/encodedShoeState/tableState/newGame(게임·결과·gameId), tableState, 잔액.
                                        // 아래 구(舊) predict 블록은 실재하지 않는 키(args["lobbydata.categories"]·args.historyUpdated)를
                                        // 찾아 어떤 실제 프레임도 매칭 못 했다 → 방·결과가 영영 전달 안 됨 = "방 안 보임"의 직접 원인.
                                        // 모드 무관하게 forward(예측·자동 둘 다 데이터 필요). 프론트는 gameId 기반으로 중복 제거.
                                        if let Some(ref json_msg) = parsed_json {
                                            let mtype = json_msg
                                                .get("type")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            let forward = mtype.starts_with("baccarat.")
                                                || mtype == "widget.availableTables"
                                                || mtype == "widget.resolved"
                                                || mtype == "tableState"
                                                || mtype == "game.result"
                                                || mtype == "game.state"
                                                || mtype == "lobby.historyUpdated"
                                                || mtype == "lobby.balanceUpdated"
                                                || mtype == "balanceUpdated";
                                            if forward {
                                                let tid = json_msg
                                                    .get("args")
                                                    .and_then(|a| {
                                                        a.get("tableId")
                                                            .or_else(|| a.get("table_id"))
                                                    })
                                                    .and_then(|v| v.as_str());
                                                if let Some(main_window) =
                                                    app_handle.get_webview_window("main")
                                                {
                                                    let _ = main_window.emit(
                                                        "evolution_multi_event",
                                                        serde_json::json!({
                                                            "eventType": mtype,
                                                            "tableId": tid,
                                                            "data": json_msg,
                                                        }),
                                                    );
                                                }
                                            }
                                        }

                                        // 📊 PREDICT MODE: Forward Evolution lobby WS messages to frontend
                                        // This allows real-time updates without separate Rust socket connection
                                        let current_mode = CDP_APP_MODE
                                            .lock()
                                            .map(|m| m.clone())
                                            .unwrap_or_default();
                                        if current_mode == "predict" {
                                            // Parse and forward Evolution lobby messages
                                            if let Ok(json_msg) =
                                                serde_json::from_str::<serde_json::Value>(payload)
                                            {
                                                if let Some(args) = json_msg.get("args") {
                                                    // historyUpdated - new game result (most important for real-time)
                                                    if let Some(history_updated) =
                                                        args.get("historyUpdated")
                                                    {
                                                        if let Some(table_id) = history_updated
                                                            .get("tableId")
                                                            .and_then(|id| id.as_str())
                                                        {
                                                            debug!("[PREDICT-CDP] 📊 History updated for table: {}", table_id);
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit(
                                                                    "evolution_multi_event",
                                                                    serde_json::json!({
                                                                        "eventType": "historyUpdated",
                                                                        "tableId": table_id,
                                                                        "data": {
                                                                            "type": "lobby.historyUpdated",
                                                                            "args": history_updated
                                                                        }
                                                                    }),
                                                                );
                                                            }
                                                        }
                                                    }

                                                    // lobbydata.categories - room list
                                                    if let Some(categories) =
                                                        args.get("lobbydata.categories")
                                                    {
                                                        if let Some(tables) = categories
                                                            .get("tables")
                                                            .and_then(|t| t.as_array())
                                                        {
                                                            for table in tables {
                                                                if let Some(table_id) = table
                                                                    .get("table")
                                                                    .and_then(|t| t.get("id"))
                                                                    .and_then(|id| id.as_str())
                                                                {
                                                                    if let Some(main_window) =
                                                                        app_handle
                                                                            .get_webview_window(
                                                                                "main",
                                                                            )
                                                                    {
                                                                        let _ = main_window.emit(
                                                                            "evolution_multi_event",
                                                                            serde_json::json!({
                                                                                "eventType": "tableOpened",
                                                                                "tableId": table_id,
                                                                                "data": {
                                                                                    "type": "tableOpened",
                                                                                    "args": table
                                                                                }
                                                                            }),
                                                                        );
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }

                                                    // tableUpdated - room state change
                                                    if let Some(table_updated) =
                                                        args.get("tableUpdated")
                                                    {
                                                        if let Some(table_id) = table_updated
                                                            .get("id")
                                                            .and_then(|id| id.as_str())
                                                        {
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit(
                                                                    "evolution_multi_event",
                                                                    serde_json::json!({
                                                                        "eventType": "tableUpdated",
                                                                        "tableId": table_id,
                                                                        "data": {
                                                                            "type": "tableUpdated",
                                                                            "args": table_updated
                                                                        }
                                                                    }),
                                                                );
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // ✅ AUTO-CAPTURE (Pragmatic style): When we receive lobby messages, query WebSocket URLs from page
                                        // This handles the case where WebSocket was already connected before CDP monitoring started
                                        // CDP는 로비 URL 추출용으로만 사용 - 추출 후 바로 중지하고 룸 소켓으로 전환
                                        if (payload.contains("lobby.categories")
                                            || payload.contains("lobby.historyUpdated")
                                            || payload.contains("lobby.playerData"))
                                            && !payload.contains("table_id")
                                        {
                                            // Check if we already have a URL or already sent query
                                            let need_ws_query =
                                                last_ws_url.is_none() && !ws_query_sent;

                                            if need_ws_query {
                                                ws_query_sent = true; // Mark as queried to avoid duplicate queries
                                                info!("🏛️ AUTO-QUERY: Lobby message received but no WebSocket URL captured yet. Querying all {} contexts...", execution_contexts.len().max(1));

                                                // Set LOBBY_PAGE_ID
                                                {
                                                    let mut lobby_id =
                                                        LOBBY_PAGE_ID.lock().unwrap();
                                                    if lobby_id.is_none() {
                                                        *lobby_id = Some(page_id_owned.clone());
                                                    }
                                                }

                                                // JavaScript to find WebSocket URLs
                                                let js_query = r#"
                                                    (function() {
                                                        var urls = [];
                                                        if (window.__EVOLUTION_WS_URL__) urls.push(window.__EVOLUTION_WS_URL__);
                                                        for (var key in window) {
                                                            try {
                                                                if (window[key] instanceof WebSocket && window[key].url) {
                                                                    urls.push(window[key].url);
                                                                }
                                                            } catch(e) {}
                                                        }
                                                        if (performance && performance.getEntriesByType) {
                                                            var resources = performance.getEntriesByType('resource');
                                                            for (var i = 0; i < resources.length; i++) {
                                                                var r = resources[i];
                                                                if (r.name && (r.name.includes('wss://') || r.name.includes('ws://'))) {
                                                                    urls.push(r.name);
                                                                }
                                                            }
                                                        }
                                                        urls.push('CONTEXT_URL:' + window.location.href);
                                                        return urls.join('|||');
                                                    })()
                                                "#;

                                                // Query each execution context (main frame + iframes)
                                                if execution_contexts.is_empty() {
                                                    // Fallback: query without contextId (main frame only)
                                                    cookie_request_id += 1;
                                                    pending_cookie_requests.insert(
                                                        cookie_request_id,
                                                        ("__QUERY_WS_URLS__".to_string(), true),
                                                    );

                                                    let query_ws = serde_json::json!({
                                                        "id": cookie_request_id,
                                                        "method": "Runtime.evaluate",
                                                        "params": {
                                                            "expression": js_query,
                                                            "returnByValue": true
                                                        }
                                                    });

                                                    if let Err(e) = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(query_ws.to_string())).await {
                                                        warn!("Failed to query WebSocket URLs (main): {}", e);
                                                    } else {
                                                        info!("📡 Querying WebSocket URLs from main context...");
                                                    }
                                                } else {
                                                    // Query each context with its contextId
                                                    for context_id in &execution_contexts {
                                                        cookie_request_id += 1;
                                                        pending_cookie_requests.insert(
                                                            cookie_request_id,
                                                            ("__QUERY_WS_URLS__".to_string(), true),
                                                        );

                                                        let mut query_ws = serde_json::json!({
                                                            "id": cookie_request_id,
                                                            "method": "Runtime.evaluate",
                                                            "params": {
                                                                "expression": js_query,
                                                                "contextId": context_id,
                                                                "returnByValue": true
                                                            }
                                                        });
                                                        if let Some(session_id) =
                                                            context_sessions.get(context_id)
                                                        {
                                                            query_ws["sessionId"] =
                                                                serde_json::json!(session_id);
                                                        }

                                                        if let Err(e) = write.lock().await.send(tokio_tungstenite::tungstenite::Message::Text(query_ws.to_string())).await {
                                                            warn!("Failed to query WebSocket URLs (context {}): {}", context_id, e);
                                                        } else {
                                                            info!("📡 Querying WebSocket URLs from context {}...", context_id);
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        // Log only important message types (skip lobby noise)
                                        let msg_type = if payload.contains("game.result") {
                                            "🎯 game.result (REAL-TIME)"
                                        } else if payload.contains("bettingStats")
                                            && !payload.contains("lobby.")
                                        {
                                            "⏱️ bettingStats"
                                        } else {
                                            "" // Skip lobby messages to reduce noise
                                        };

                                        // Check for Evolution Gaming messages
                                        // Include all possible message types for real-time updates
                                        if payload.contains("historyUpdated")
                                            || payload.contains("baccarat")
                                            || payload.contains("lobby.categories")
                                            || payload.contains("gameResult")
                                            || payload.contains("game.result")
                                            || payload.contains("bettingStats")
                                            || payload.contains("betting")
                                            || payload.contains("tableList")
                                            || payload.contains("lobby.tables")
                                            || payload.contains("resolved")
                                            || payload.contains("winner")
                                            || payload.contains("result")
                                            || payload.contains("dealing")
                                            || payload.contains("gameState")
                                        {
                                            if !msg_type.is_empty() {
                                                info!(
                                                    "{} from page {}: {} bytes",
                                                    msg_type,
                                                    page_id_owned,
                                                    payload.len()
                                                );
                                            } else {
                                                debug!(
                                                    "📨 Evolution message from page {}: {} bytes",
                                                    page_id_owned,
                                                    payload.len()
                                                );
                                            }

                                            // Mark as Evolution page if not already
                                            if !evolution_found_clone.load(Ordering::SeqCst) {
                                                evolution_found_clone.store(true, Ordering::SeqCst);
                                            }

                                            if let Some(main_window) =
                                                app_handle.get_webview_window("main")
                                            {
                                                // Legacy event for backward compatibility
                                                let _ = main_window.emit(
                                                    "evolution-websocket-message",
                                                    serde_json::json!({
                                                        "url": "",
                                                        "message": payload,
                                                        "pageId": page_id_owned,
                                                        "tableId": table_id_owned
                                                    }),
                                                );

                                                // ✅ Also emit in evolution_multi_event format for frontend compatibility
                                                // This allows CDP-captured messages to be processed by the same handler as Rust client messages
                                                if let Ok(json_msg) =
                                                    serde_json::from_str::<serde_json::Value>(
                                                        payload,
                                                    )
                                                {
                                                    let msg_type = json_msg
                                                        .get("type")
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or("unknown");

                                                    // Extract tableId from args or top-level
                                                    let extracted_table_id = json_msg
                                                        .get("args")
                                                        .and_then(|a| {
                                                            a.get("tableId")
                                                                .or_else(|| a.get("table_id"))
                                                                .or_else(|| a.get("id"))
                                                        })
                                                        .and_then(|v| v.as_str())
                                                        .or_else(|| {
                                                            json_msg
                                                                .get("tableId")
                                                                .and_then(|v| v.as_str())
                                                        });

                                                    let _ = main_window.emit(
                                                        "evolution_multi_event",
                                                        serde_json::json!({
                                                            "tableId": extracted_table_id,
                                                            "eventType": msg_type,
                                                            "data": json_msg
                                                        }),
                                                    );
                                                }
                                            }

                                            // ✅ Parse lobby.histories for all room data
                                            if payload.contains("\"type\":\"lobby.histories\"")
                                                || payload.contains("\"type\": \"lobby.histories\"")
                                            {
                                                if let Ok(json_val) =
                                                    serde_json::from_str::<serde_json::Value>(
                                                        payload,
                                                    )
                                                {
                                                    if let Some(args) = json_val.get("args") {
                                                        if let Some(obj) = args.as_object() {
                                                            info!("📊 lobby.histories received: {} rooms", obj.len());

                                                            // Emit parsed histories to frontend
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit(
                                                                    "evolution-lobby-histories",
                                                                    serde_json::json!({
                                                                        "histories": args,
                                                                        "roomCount": obj.len()
                                                                    }),
                                                                );
                                                            }
                                                        }
                                                    }
                                                }
                                            }

                                            // ✅ Parse lobby.tableUpdated for real-time updates
                                            if payload.contains("\"type\":\"lobby.tableUpdated\"")
                                                || payload
                                                    .contains("\"type\": \"lobby.tableUpdated\"")
                                            {
                                                if let Ok(json_val) =
                                                    serde_json::from_str::<serde_json::Value>(
                                                        payload,
                                                    )
                                                {
                                                    if let Some(args) = json_val.get("args") {
                                                        if let Some(table_id) =
                                                            args.get("id").and_then(|v| v.as_str())
                                                        {
                                                            // Emit to frontend without debug logging (too noisy)
                                                            if let Some(main_window) = app_handle
                                                                .get_webview_window("main")
                                                            {
                                                                let _ = main_window.emit(
                                                                    "evolution-table-updated",
                                                                    serde_json::json!({
                                                                        "tableId": table_id,
                                                                        "data": args
                                                                    }),
                                                                );
                                                            }
                                                        }
                                                    }
                                                }
                                            }

                                            // ✅ Parse lobby.historyUpdated for game results
                                            if payload.contains("\"type\":\"lobby.historyUpdated\"")
                                                || payload
                                                    .contains("\"type\": \"lobby.historyUpdated\"")
                                            {
                                                if let Ok(json_val) =
                                                    serde_json::from_str::<serde_json::Value>(
                                                        payload,
                                                    )
                                                {
                                                    if let Some(args) = json_val.get("args") {
                                                        // Emit to frontend without debug logging (too noisy)
                                                        if let Some(main_window) =
                                                            app_handle.get_webview_window("main")
                                                        {
                                                            let _ = main_window.emit(
                                                                "evolution-history-updated",
                                                                serde_json::json!({
                                                                    "data": args
                                                                }),
                                                            );
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                    if is_lobby_page {
                        warn!("🔴 LOBBY CDP connection closed");
                    } else {
                        info!("🔴 CDP page {} closed", page_id_owned);
                    }
                    break; // Break inner loop to trigger reconnect for lobby
                }
                Err(e) => {
                    if is_lobby_page {
                        warn!("🔴 LOBBY CDP error: {}", e);
                    } else {
                        debug!("CDP page {} ended: {}", page_id_owned, e);
                    }
                    break; // Break inner loop to trigger reconnect for lobby
                }
                _ => {}
            }
        }

        // For non-lobby pages, exit the reconnect loop after connection ends
        if !is_lobby_page {
            break;
        }

        // For lobby pages, increment reconnect count and continue the loop
        reconnect_count += 1;

        // Notify frontend that lobby connection was lost (will reconnect)
        if let Some(main_window) = app_handle.get_webview_window("main") {
            let _ = main_window.emit(
                "lobby-websocket-disconnected",
                serde_json::json!({
                    "pageId": page_id_owned,
                    "reason": "connection_lost",
                    "willReconnect": true
                }),
            );
        }
    }

    Ok(evolution_found.load(Ordering::SeqCst))
}

/// Stop CDP monitoring (call after Evolution session is captured)
#[tauri::command]
pub async fn stop_cdp_monitoring() -> Result<(), String> {
    info!(
        "🛑 Stopping CDP monitoring - Evolution session captured, switching to direct room sockets"
    );
    CDP_SHOULD_STOP.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut lobby_id) = LOBBY_PAGE_ID.lock() {
        *lobby_id = None;
    }
    // Lane R2: belt-and-suspenders abort. The atomic flag is the primary
    // cooperative cancellation; aborting via the registry is the safety net
    // for a poller stuck in a syscall (e.g. blocked HTTP read).
    CDP_TASK_REGISTRY.abort(CDP_MONITOR_KEY);
    Ok(())
}

/// Restart CDP monitoring (call when Rust multiwidget disconnects)
#[tauri::command]
pub async fn restart_cdp_monitoring() -> Result<(), String> {
    info!("🔄 Restarting CDP monitoring - Rust connection disconnected");
    // Lane R2: abort any lingering CDP monitor task before resetting flags.
    // Without this, a stale task from a prior session could race the new one.
    CDP_TASK_REGISTRY.abort(CDP_MONITOR_KEY);
    // Reset flags to allow reconnection
    CDP_SHOULD_STOP.store(false, std::sync::atomic::Ordering::SeqCst);
    MULTIWIDGET_CONNECTED.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut lobby_id) = LOBBY_PAGE_ID.lock() {
        *lobby_id = None;
    }
    info!("🔄 Reset connection flags for restart");
    Ok(())
}

/// Rotate the short-lived Evolution session without allowing the browser and
/// Rust clients to own the same session concurrently.
///
/// Order is intentional: stop the old CDP capture, disconnect the real shared
/// multi-client, start a fresh capture loop, then click the relay launcher.
/// The replacement socket is therefore observed only after the previous Rust
/// client has released its session.
#[tauri::command]
pub async fn rotate_evolution_session(
    app: AppHandle,
    app_mode: Option<String>,
) -> Result<bool, String> {
    let _rotation_guard = try_acquire_atomic_flag(&SESSION_ROTATION_IN_PROGRESS)
        .ok_or_else(|| "Evolution session rotation is already in progress".to_string())?;

    let mode = app_mode.unwrap_or_else(|| "auto".to_string());
    info!(
        "[SESSION-ROTATE] Starting atomic session handover (mode={})",
        mode
    );

    stop_cdp_monitoring().await?;
    {
        let mut client = MULTIWIDGET_CLIENT.lock().await;
        client.disconnect().await;
    }
    MULTIWIDGET_CONNECTED.store(false, Ordering::SeqCst);

    start_cdp_monitoring(app, Some(mode)).await?;
    // start_cdp_monitoring spawns a poller with a two-second Chrome startup
    // grace period. Do not click until that poller has had time to attach and
    // enable Network events, otherwise the replacement socket can be missed.
    tokio::time::sleep(tokio::time::Duration::from_millis(2_500)).await;

    match click_evolution_launch().await {
        Ok(true) => {
            info!("[SESSION-ROTATE] Relay launch clicked; waiting for fresh session capture");
            Ok(true)
        }
        Ok(false) => {
            Err("Evolution launcher was not found; CDP monitoring remains active".to_string())
        }
        Err(error) => Err(format!(
            "Evolution session rotation could not click the launcher: {}",
            error
        )),
    }
}

/// Navigate to a Pragmatic room using the captured launcher URL
/// Replaces operatorGameId in the stored launcher URL and navigates via CDP
#[tauri::command]
pub async fn navigate_pragmatic_room(
    app: AppHandle,
    mut room_id: String,
    state: State<'_, PragmaticManagerState>,
) -> Result<String, String> {
    if room_id.starts_with("pragmatic:") {
        room_id = room_id.replace("pragmatic:", "");
    }
    info!("🎲 Navigating to Pragmatic room: {}", room_id);

    let requested_table_id = room_id.clone();
    let mut operator_game_id = room_id.clone();

    // ROSE room lists are keyed by Pragmatic tableId, while launcher URLs need
    // operatorGameId. Resolve both directions so selecting "401" can still
    // produce a valid Pragmatic launcher URL.
    let mut table_id_override = PRAGMATIC_TABLE_ID_BY_OPERATOR_GAME_ID
        .lock()
        .ok()
        .and_then(|m| {
            if let Some(table_id) = m.get(&room_id) {
                return Some(table_id.clone());
            }

            for (op_id, table_id) in m.iter() {
                if table_id == &requested_table_id {
                    operator_game_id = op_id.clone();
                    return Some(table_id.clone());
                }
            }

            None
        });

    // If no mapping found OR launcher URL is missing, try to capture from DOM dynamically
    // capture_pragmatic_table_mappings_from_dom also captures JSESSIONID now.
    let launcher_missing = PRAGMATIC_LAUNCHER_URL
        .lock()
        .map(|g| g.is_none())
        .unwrap_or(true);

    if table_id_override.is_none() || launcher_missing {
        info!(
            "🎲 Mapping or Launcher missing for {}, capturing from DOM...",
            room_id
        );
        let mappings = capture_pragmatic_table_mappings_from_dom().await;

        // Store all mappings in cache
        if let Ok(mut map) = PRAGMATIC_TABLE_ID_BY_OPERATOR_GAME_ID.lock() {
            for (table_id, op_id) in &mappings {
                map.insert(op_id.clone(), table_id.clone());
            }
        }

        // Find the mapping for our room_id
        if table_id_override.is_none() {
            for (table_id, op_id) in mappings {
                if op_id == room_id || table_id == requested_table_id {
                    operator_game_id = op_id.clone();
                    info!(
                        "🎲 Found tableId {} for operatorGameId {} from DOM",
                        table_id, room_id
                    );
                    table_id_override = Some(table_id);
                    break;
                }
            }
        }
    }

    // 1) Prefer an actual launcher URL (contains casino_id etc.) if we have/can capture it.
    // 2) Only fall back to WS-derived minimal launcher URL when nothing else is available.
    let mut base_url: Option<String> = PRAGMATIC_LAUNCHER_URL
        .lock()
        .map_err(|e| format!("Failed to lock PRAGMATIC_LAUNCHER_URL: {}", e))?
        .clone();

    if base_url.is_none() {
        base_url = try_capture_pragmatic_launcher_url_from_open_pages(&operator_game_id).await;
        if let Some(ref captured) = base_url {
            if let Ok(mut guard) = PRAGMATIC_LAUNCHER_URL.lock() {
                *guard = Some(captured.clone());
            }
        }
    }

    let new_url =
        if let Some(base_url) = base_url {
            info!(
                "🎲 Base Pragmatic URL available (url_len={}, has_jsession={})",
                base_url.len(),
                base_url.to_ascii_lowercase().contains("jsessionid=")
            );

            let mut parsed_url = url::Url::parse(&base_url)
                .map_err(|e| format!("Failed to parse Pragmatic URL: {}", e))?;

            let table_id_for_url = table_id_override.clone();
            let mut has_operator_game_id = false;
            let mut has_table_id = false;

            let new_query: Vec<(String, String)> = parsed_url
                .query_pairs()
                .map(|(k, v)| {
                    if k == "operatorGameId" {
                        has_operator_game_id = true;
                        (k.into_owned(), operator_game_id.clone())
                    } else if k == "tableId" {
                        has_table_id = true;
                        if let Some(ref table_id) = table_id_for_url {
                            (k.into_owned(), table_id.clone())
                        } else {
                            (k.into_owned(), v.into_owned())
                        }
                    } else {
                        (k.into_owned(), v.into_owned())
                    }
                })
                .collect();

            parsed_url.query_pairs_mut().clear();
            for (k, v) in new_query {
                parsed_url.query_pairs_mut().append_pair(&k, &v);
            }

            if !has_operator_game_id {
                parsed_url
                    .query_pairs_mut()
                    .append_pair("operatorGameId", &operator_game_id);
            }
            if !has_table_id {
                if let Some(ref table_id) = table_id_for_url {
                    parsed_url
                        .query_pairs_mut()
                        .append_pair("tableId", table_id);
                }
            }

            parsed_url.to_string()
        } else {
            let ws_url_for_room = PRAGMATIC_WS_URL_BY_OPERATOR_GAME_ID
                .lock()
                .ok()
                .and_then(|m| {
                    m.get(&operator_game_id)
                        .cloned()
                        .or_else(|| m.get(&requested_table_id).cloned())
                })
                .or_else(|| PRAGMATIC_LAST_WS_URL.lock().ok().and_then(|g| g.clone()));

            if let Some(ws_url) = ws_url_for_room {
                build_pragmatic_launcher_url_for_operator_game_id(
                    &ws_url,
                    &operator_game_id,
                    table_id_override.as_deref(),
                )
                .ok_or_else(|| "프라그마틱 런처 URL 생성에 실패했습니다.".to_string())?
            } else {
                let manager = state.manager.lock().await;
                manager.construct_launcher_url(&requested_table_id).ok_or_else(|| {
                "프라그마틱 세션이 없습니다. 프라그마틱 소켓이 먼저 캡처되었는지 확인해주세요."
                    .to_string()
            })?
            }
        };
    info!(
        "🎲 New Pragmatic room URL built (url_len={}, has_jsession={})",
        new_url.len(),
        new_url.to_ascii_lowercase().contains("jsessionid=")
    );

    // Cache the launcher URL so subsequent navigations work without a fallback
    if let Ok(mut guard) = PRAGMATIC_LAUNCHER_URL.lock() {
        *guard = Some(new_url.clone());
    }

    // Find Pragmatic launcher page and navigate it
    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    // Find Pragmatic launcher page - ONLY reuse if it's already a room tab
    // Reusing the lobby tab (tableId=lobby) kills the lobby socket.
    let mut target_ws_url: Option<String> = None;
    for page in &pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());

        let is_launcher = page_url.contains("pragmaticplaylive.net/desktop/launcher");
        let is_lobby = !page_url.contains("tableId=") || page_url.contains("tableId=lobby");

        if page_type == "page" && is_launcher && !is_lobby {
            if let Some(ws) = ws_url {
                info!("🎲 Found existing Pragmatic room tab, reusing it.");
                target_ws_url = Some(ws.to_string());
                break;
            }
        }
    }

    // If no launcher page is open, create a new Pragmatic window via browser-level CDP
    if target_ws_url.is_none() {
        info!("🎲 Pragmatic launcher tab not found. Creating new window via Target.createTarget");
        create_new_room_tab_via_browser(app, new_url.clone()).await?;
        return Ok(new_url);
    }

    let ws_debugger_url =
        target_ws_url.ok_or_else(|| "프라그마틱 테이블 페이지를 찾을 수 없습니다.".to_string())?;

    // Connect to the page via WebSocket and navigate
    let (ws_stream, _) = match tokio_tungstenite::connect_async(&ws_debugger_url).await {
        Ok(v) => v,
        Err(e) => {
            warn!("🎲 Failed to connect to Pragmatic launcher page CDP: {}. Creating new window instead.", e);
            create_new_room_tab_via_browser(app, new_url.clone()).await?;
            return Ok(new_url);
        }
    };

    let (mut ws_write, mut ws_read) = futures_util::StreamExt::split(ws_stream);

    use futures_util::SinkExt;
    let add_script_cmd = serde_json::json!({
        "id": 2,
        "method": "Page.addScriptToEvaluateOnNewDocument",
        "params": {
            "source": WS_BLOCKER_SCRIPT,
        }
    });

    let _ = ws_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            add_script_cmd.to_string(),
        ))
        .await;

    // Navigate using Page.navigate
    let navigate_msg = serde_json::json!({
        "id": 3,
        "method": "Page.navigate",
        "params": {
            "url": new_url
        }
    });

    if let Err(e) = ws_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            navigate_msg.to_string(),
        ))
        .await
    {
        warn!(
            "🎲 CDP navigate send failed: {}. Creating new window instead.",
            e
        );
        create_new_room_tab_via_browser(app, new_url.clone()).await?;
        return Ok(new_url);
    }

    // Wait for response
    use futures_util::StreamExt;
    let timeout = tokio::time::timeout(std::time::Duration::from_secs(5), ws_read.next()).await;

    let mut navigate_ok = false;
    match timeout {
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
            info!(
                "🎲 CDP navigate response: {}...",
                &text[..text.len().min(200)]
            );

            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if json.get("error").is_some() {
                    warn!("🎲 CDP Page.navigate returned error: {}", text);
                } else {
                    navigate_ok = true;
                }
            }
        }
        _ => {
            warn!("🎲 CDP response timeout or error");
        }
    }

    if !navigate_ok {
        warn!("🎲 Pragmatic navigation not confirmed. Creating new window instead.");
        create_new_room_tab_via_browser(app, new_url.clone()).await?;
        return Ok(new_url);
    }

    // Update stored URL with new operatorGameId
    if let Ok(mut guard) = PRAGMATIC_LAUNCHER_URL.lock() {
        *guard = Some(new_url.clone());
    }

    Ok(new_url)
}

/// 🔥 ENHANCED: Block ALL Evolution WebSockets (game, lobby, multiwidget)
/// Rust backend handles all Evolution connections to prevent session conflicts
#[tauri::command]
pub async fn click_pragmatic_room_in_lobby(mut room_id: String) -> Result<String, String> {
    if room_id.starts_with("pragmatic:") {
        room_id = room_id.replace("pragmatic:", "");
    }
    let requested_id = room_id.clone();
    let mut operator_game_id = room_id.clone();
    if let Ok(map) = PRAGMATIC_TABLE_ID_BY_OPERATOR_GAME_ID.lock() {
        for (op_id, table_id) in map.iter() {
            if table_id == &requested_id {
                operator_game_id = op_id.clone();
                break;
            }
        }
    }

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;
    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    let target_ws = pages
        .iter()
        .filter(|page| page.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|page| {
            let url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let ws = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str())?;
            let is_pragmatic = url.contains("pragmaticplaylive.net")
                || url.contains("play.vg-asia1.com")
                || url.contains("iwg711.com");
            let score = if url.contains("/desktop/lobby") {
                3
            } else if url.contains("pragmaticplaylive.net") {
                2
            } else if is_pragmatic {
                1
            } else {
                0
            };
            (score > 0).then_some((score, ws.to_string()))
        })
        .max_by_key(|(score, _)| *score)
        .ok_or_else(|| "Pragmatic lobby page not found in Chrome.".to_string())?;

    let (ws_stream, _) = tokio_tungstenite::connect_async(&target_ws.1)
        .await
        .map_err(|e| format!("Failed to connect to Pragmatic lobby CDP: {}", e))?;
    let (mut ws_write, mut ws_read) = futures_util::StreamExt::split(ws_stream);
    use futures_util::{SinkExt, StreamExt};

    let room_id_json = serde_json::to_string(&operator_game_id).map_err(|e| e.to_string())?;
    let table_id_json = serde_json::to_string(&requested_id).map_err(|e| e.to_string())?;
    let script = format!(
        r#"(function() {{
  const roomId = {room_id_json};
  const tableId = {table_id_json};
  const ids = [roomId, tableId].filter(Boolean).map(String);
  window.__BCR_ORIG_OPEN__ = window.__BCR_ORIG_OPEN__ || window.open;
  window.open = function(url) {{
    if (url) {{
      try {{ location.href = url; }} catch (e) {{}}
    }}
    return window;
  }};

  const visible = (el) => {{
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 24 && r.height > 24 && s.visibility !== 'hidden' && s.display !== 'none';
  }};
  const attrs = (el) => Array.from(el.attributes || []).map(a => `${{a.name}}=${{a.value}}`).join(' ');
  const textOf = (el) => `${{el.id || ''}} ${{attrs(el)}} ${{el.textContent || ''}}`.toLowerCase();
  const clickTarget = (el) => el.closest('button,a,[role="button"],[tabindex]') || el;
  const all = Array.from(document.querySelectorAll('button,a,[role="button"],[tabindex],article,section,div'));

  let best = null;
  let bestScore = 0;
  for (const el of all) {{
    if (!visible(el)) continue;
    const hay = textOf(el);
    let score = 0;
    for (const id of ids) {{
      const lower = id.toLowerCase();
      if ((el.id || '').startsWith(id + '-')) score += 100;
      if (hay.includes('tableid=' + id) || hay.includes('table-id=' + id)) score += 80;
      if (hay.includes('operatorgameid=' + id) || hay.includes('operator-game-id=' + id)) score += 80;
      if (hay.includes('tableid":"' + id) || hay.includes('tableid:' + id)) score += 60;
      if (hay.includes('operatorgameid":"' + id) || hay.includes('operatorgameid:' + id)) score += 60;
      if (hay.includes(lower)) score += 18;
    }}
    if (/[\uAC00-\uD7A3]/.test(hay) || hay.includes('baccarat')) score += 8;
    if (score > bestScore) {{
      best = el;
      bestScore = score;
    }}
  }}

  if (!best) {{
    return JSON.stringify({{ ok: false, reason: 'room-card-not-found', roomId, url: location.href }});
  }}

  const target = clickTarget(best);
  target.scrollIntoView({{ block: 'center', inline: 'center' }});
  setTimeout(() => target.click(), 120);
  return JSON.stringify({{
    ok: true,
    roomId,
    score: bestScore,
    clickedText: (target.textContent || '').trim().slice(0, 120),
    clickedId: target.id || best.id || '',
    url: location.href
  }});
}})()"#
    );

    let bring_to_front = serde_json::json!({
        "id": 51,
        "method": "Page.bringToFront"
    });
    let _ = ws_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            bring_to_front.to_string(),
        ))
        .await;

    let eval = serde_json::json!({
        "id": 52,
        "method": "Runtime.evaluate",
        "params": {
            "expression": script,
            "awaitPromise": true,
            "returnByValue": true
        }
    });
    ws_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            eval.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to send Runtime.evaluate: {}", e))?;

    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(message) = ws_read.next().await {
            let text = match message {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => text,
                Ok(_) => continue,
                Err(e) => return Err(e.to_string()),
            };
            let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if json.get("id").and_then(|v| v.as_i64()) == Some(52) {
                return Ok(json);
            }
        }
        Err("CDP socket closed".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for Pragmatic lobby click result".to_string())??;

    let value = result
        .get("result")
        .and_then(|v| v.get("result"))
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Invalid click result: {}", result))?;

    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|e| format!("Invalid click payload: {}", e))?;
    if parsed.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(value.to_string())
    } else {
        Err(parsed
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("Pragmatic room click failed")
            .to_string())
    }
}

#[tauri::command]
pub async fn refresh_pragmatic_lobby_rooms_from_dom() -> Result<Vec<serde_json::Value>, String> {
    use futures_util::{SinkExt, StreamExt};

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;
    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    let target_ws = pages
        .iter()
        .filter(|page| page.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|page| {
            let url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let ws = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str())?;
            let score = if url.contains("client.pragmaticplaylive.net/desktop/lobby") {
                4
            } else if url.contains("pragmaticplaylive.net") {
                3
            } else if url.contains("play.vg-asia1.com") {
                2
            } else {
                0
            };
            (score > 0).then_some((score, ws.to_string()))
        })
        .max_by_key(|(score, _)| *score)
        .ok_or_else(|| "Pragmatic lobby page not found in Chrome.".to_string())?;

    let (ws_stream, _) = tokio_tungstenite::connect_async(&target_ws.1)
        .await
        .map_err(|e| format!("Failed to connect to Pragmatic lobby CDP: {}", e))?;
    let (mut ws_write, mut ws_read) = futures_util::StreamExt::split(ws_stream);

    let script = r#"(function() {
  const rooms = new Map();
  const namePattern = /[\uAC00-\uD7A3]|baccarat/i;
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const findName = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const lines = clean(node.innerText || node.textContent || '').split(' ').filter(Boolean);
      const joined = clean(node.innerText || node.textContent || '');
      const candidates = joined.split(/\n| {2,}/).map(clean).filter(Boolean);
      const found = candidates.find((line) => namePattern.test(line) && !/[₩$]/.test(line));
      if (found) return found;
      const compact = lines.slice(0, 8).join(' ');
      if (namePattern.test(compact)) return compact;
    }
    return '';
  };

  document.querySelectorAll('[id]').forEach((el) => {
    const match = String(el.id || '').match(/^(\d+)-(.+)/);
    if (!match) return;
    const tableId = match[1];
    const operatorGameId = match[2];
    const name = findName(el);
    if (!name) return;
    rooms.set(tableId, {
      id: tableId,
      name,
      status: 'active',
      history: [],
      operatorGameId
    });
  });

  return JSON.stringify(Array.from(rooms.values()));
})()"#;

    let eval = serde_json::json!({
        "id": 71,
        "method": "Runtime.evaluate",
        "params": {
            "expression": script,
            "awaitPromise": true,
            "returnByValue": true
        }
    });

    ws_write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            eval.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to send Runtime.evaluate: {}", e))?;

    let result = tokio::time::timeout(std::time::Duration::from_secs(4), async {
        while let Some(message) = ws_read.next().await {
            let text = match message {
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => text,
                Ok(_) => continue,
                Err(e) => return Err(e.to_string()),
            };
            let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if json.get("id").and_then(|v| v.as_i64()) == Some(71) {
                return Ok(json);
            }
        }
        Err("CDP socket closed".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for Pragmatic lobby DOM rooms".to_string())??;

    let value = result
        .get("result")
        .and_then(|v| v.get("result"))
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("Invalid DOM room result: {}", result))?;

    serde_json::from_str::<Vec<serde_json::Value>>(value)
        .map_err(|e| format!("Invalid DOM room payload: {}", e))
}

/// 🔬 프론트엔드 진단 로그를 파일(bcr-runtime.log)에 남긴다(슬롯/정산 실시간 흐름 디버그용 임시).
/// 프론트 콘솔은 Tauri 웹뷰에만 떠서 파일로 안 남으므로, AutoMode가 이 커맨드로 핵심 결정을 포워딩한다.
#[tauri::command]
pub fn fe_diag(line: String) {
    tracing::info!("[FE-DIAG] {}", line.chars().take(600).collect::<String>());
}

/// 🧪 베팅 포맷 캡처 모드 여부(env `BCR_BET_CAPTURE=1`). 켜지면 Rust는 멀티위젯에 연결하지 않아
/// 브라우저가 유일 세션이 되어 Evolution 베팅 UI가 정상 작동한다(중복세션 킥 방지). 캡처 후엔 변수 빼고 재실행.
fn is_bet_capture_mode() -> bool {
    std::env::var("BCR_BET_CAPTURE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

const WS_BLOCKER_SCRIPT: &str = r#"
    (function() {
        if (window.__BCR_ALL_WS_BLOCKED__) return 'already_blocked';
        window.__BCR_ALL_WS_BLOCKED__ = true;

        var OrigWebSocket = window.WebSocket;
        window.__BCR_ORIG_WS__ = OrigWebSocket;

        // Create a dummy WebSocket that looks real but does nothing
        function createDummyWebSocket(url) {
            var dummy = {
                url: url,
                readyState: 1,
                CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
                bufferedAmount: 0,
                extensions: '',
                protocol: '',
                binaryType: 'blob',
                send: function(data) {
                    console.log('[BCR] 🚫 Blocked send:', url.substring(0, 60));
                },
                close: function(code, reason) {
                    this.readyState = 3;
                    var self = this;
                    if (this.onclose) {
                        setTimeout(function() {
                            self.onclose({ code: code || 1000, reason: reason || '', wasClean: true });
                        }, 10);
                    }
                },
                addEventListener: function(type, listener) {
                    if (type === 'open') this.onopen = listener;
                    else if (type === 'close') this.onclose = listener;
                    else if (type === 'error') this.onerror = listener;
                    else if (type === 'message') this.onmessage = listener;
                },
                removeEventListener: function() {},
                dispatchEvent: function() { return true; },
                onopen: null,
                onclose: null,
                onerror: null,
                onmessage: null
            };

            // Simulate successful connection
            setTimeout(function() {
                if (dummy.onopen) {
                    dummy.onopen({ target: dummy });
                }
            }, 100);

            return dummy;
        }

        window.WebSocket = function(url, protocols) {
            url = String(url || '');

            var isBlockedSocket = (
                (url.indexOf('/multiwidget/socket') !== -1) ||
                (url.indexOf('/multiwidget/') !== -1) ||
                (url.indexOf('/multiplay/') !== -1) ||
                (url.indexOf('multiwidget') !== -1) ||
                (url.indexOf('multiplay') !== -1) ||
                (url.indexOf('mwLayout') !== -1)
            );

            if (isBlockedSocket) {
                // 🧪 [BET-CAPTURE] 베팅 포맷 캡처 모드: sessionStorage 플래그가 켜져 있으면 멀티위젯 소켓을
                //   '진짜'로 열되 send()를 가로채 모든 송신 프레임을 로그로 남기고, playerBetRequest(실제 베팅)는
                //   '기록만 하고 전송 차단'한다(서버로 안 나감 = 실제 돈 안 빠짐). 캡처 끝나면 플래그 제거+리로드.
                //   켜기(Chrome devtools): sessionStorage.setItem('__BCR_BET_CAPTURE__','1'); location.reload();
                //   끄기: sessionStorage.removeItem('__BCR_BET_CAPTURE__'); location.reload();
                var captureOn = false;
                try { captureOn = (sessionStorage.getItem('__BCR_BET_CAPTURE__') === '1'); } catch (e) {}
                if (captureOn) {
                    try { console.log('[BCR_CAPTURE_MODE_ON]'); } catch (e) {}
                    var realWs = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);

                    // 📥 수신(IN) 캡처: 베팅 수락/거절 응답 포맷을 따온다(로직에 녹이려면 reject/accept 형식이 필요).
                    //   playerBettingState(acceptedBets/rejectedBets/HasBet) + betResponse/denied/notAuthorised 류만.
                    try {
                        realWs.addEventListener('message', function(ev) {
                            try {
                                var d = ev && ev.data;
                                if (typeof d !== 'string') return;
                                if (d.indexOf('layerBettingState') !== -1 || d.indexOf('cceptedBets') !== -1
                                    || d.indexOf('ejectedBets') !== -1 || d.indexOf('etResponse') !== -1
                                    || d.indexOf('etDenied') !== -1 || d.indexOf('otAuthor') !== -1
                                    || d.indexOf('HasBet') !== -1) {
                                    console.log('[BCR_RECV_FRAME] ' + (d.length > 1500 ? d.substring(0, 1500) : d));
                                }
                            } catch (e) {}
                        });
                    } catch (e) {}

                    // 📤 송신(OUT) 캡처: 모든 송신 프레임 로그 + playerBetRequest 포맷 캡처.
                    //   기본은 DROP(서버 안 감=돈 안 빠짐). __BCR_BET_SEND__=1 이면 실제 전송 →
                    //   거절 시 무료로 reject 응답 캡처, 수락 시에만 돈 나감.
                    var origSend = realWs.send.bind(realWs);
                    realWs.send = function(data) {
                        try {
                            var s = (typeof data === 'string') ? data : ('[binary ' + (data && data.byteLength) + 'B]');
                            console.log('[BCR_SENT_FRAME] ' + (s.length > 1500 ? s.substring(0, 1500) : s));
                            if (typeof s === 'string' && s.indexOf('playerBetRequest') !== -1) {
                                console.log('[BCR_BET_CAPTURED] ' + s);
                                var doSend = false;
                                try { doSend = (sessionStorage.getItem('__BCR_BET_SEND__') === '1'); } catch (e) {}
                                if (!doSend) {
                                    console.log('[BCR] 🧪 [BET-CAPTURE] playerBetRequest 캡처+DROP(돈 안 나감). 거절/수락 응답까지 보려면 sessionStorage.setItem(\'__BCR_BET_SEND__\',\'1\') 후 베팅(거절=무료, 수락=돈나감).');
                                    return; // drop → 서버 전송 안 함
                                }
                                console.log('[BCR] 🧪 [BET-CAPTURE] __BCR_BET_SEND__ on → 실제 전송(거절이면 무료로 reject 캡처, 수락이면 돈 나감).');
                            }
                        } catch (e) {}
                        return origSend(data);
                    };
                    return realWs;
                }
                var socketType = 'multiwidget';
                try { console.log('[BCR_WS_CAPTURE]', JSON.stringify({ url: url, socketType: socketType, href: location.href })); } catch (e) {}
                console.log('[BCR] Blocked ' + socketType + ' WebSocket (Rust handles this):', url.substring(0, 80));
                return createDummyWebSocket(url);
            }

            // Allow all other WebSockets (including game sockets)
            console.log('[BCR] ✅ Allowed WebSocket:', url.substring(0, 100));
            return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
        };

        window.WebSocket.prototype = OrigWebSocket.prototype;
        window.WebSocket.CONNECTING = 0;
        window.WebSocket.OPEN = 1;
        window.WebSocket.CLOSING = 2;
        window.WebSocket.CLOSED = 3;

        console.log('[BCR] 🛡️ Evolution WebSocket blocker installed (lobby + multiwidget blocked)');
        return 'blocker_installed';
    })();
"#;

/// Navigate Chrome to a URL via CDP Page.navigate
/// Finds Evolution Gaming tab (lobby or room) and navigates it
#[tauri::command]
pub async fn navigate_chrome(url: String) -> Result<(), String> {
    info!("🌐 Navigating Chrome (url_len={})", url.len());

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);

    // Get list of pages
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    // Priority order for finding Evolution tab:
    // 1. Existing room tab (has table_id=)
    // 2. Lobby tab (has /frontend/evo or evolutiongaming)
    // 3. Any page as fallback
    let mut room_tab: Option<String> = None;
    let mut lobby_tab: Option<String> = None;
    let mut any_tab: Option<String> = None;

    for page in &pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());

        if page_type != "page" {
            continue;
        }

        if let Some(ws_debugger_url) = ws_url {
            // Check if this is a room tab
            if page_url.contains("table_id=") {
                info!("🎰 Found existing room tab (url_len={})", page_url.len());
                room_tab = Some(ws_debugger_url.to_string());
            }
            // Check if this is Evolution lobby/game page
            else if page_url.contains("/frontend/evo")
                || page_url.contains("evolutiongaming")
                || page_url.contains("/lobby")
            {
                info!("🏠 Found Evolution lobby tab (url_len={})", page_url.len());
                lobby_tab = Some(ws_debugger_url.to_string());
            }
            // Keep any tab as fallback
            else if any_tab.is_none() {
                any_tab = Some(ws_debugger_url.to_string());
            }
        }
    }

    // Select tab in priority order
    let target_ws_url = room_tab
        .or(lobby_tab)
        .or(any_tab)
        .ok_or_else(|| "No Chrome page found to navigate".to_string())?;

    info!("📌 Using tab for navigation");

    // Connect and navigate
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    let (mut ws_stream, _) = connect_async(&target_ws_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP page: {}", e))?;

    let navigate_cmd = serde_json::json!({
        "id": 1,
        "method": "Page.navigate",
        "params": {
            "url": url
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            navigate_cmd.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to send navigate command: {}", e))?;

    info!("✅ Chrome navigation completed (url_len={})", url.len());
    Ok(())
}

/// 🧪 [실험 — 라이브 검증 필수] 브라우저 로비 탭을 about:blank로 '주차'한다.
///
/// 목적: lobby v2는 단일 세션(EVOSESSIONID) 소켓이라, 브라우저 로비와 Rust 멀티소켓이 같은 세션을
/// 동시에 구독하면 서버가 중복으로 보고 한쪽을 킥한다(킥 워 → 베팅 소켓이 죽음). Rust 연결 후
/// 브라우저 로비 탭을 빈 페이지로 navigate해 '주차'(차단=0.6s 리로드 루프라 navigate 사용)하면
/// Rust가 유일 구독자가 된다. 룸 데이터는 Rust가 lobby.subscribe로 받으므로 브라우저 로비를 비워도
/// 무방하다는 게 설계 가정(evolution_lobby_v2_protocol) — 단 **방 목록이 유지되는지 반드시 라이브로
/// 검증**해야 한다. 잘못되면(방 증발/리로드 루프) 호출부(useCasino)의 park 호출만 제거하면 즉시 원복.
///
/// 안전: 룸 탭(table_id=)·이미 about:blank·빈 URL은 절대 건드리지 않는다. 전체 page URL을 로그로 남겨
/// 라이브에서 실제 로비 탭 URL을 확인할 수 있게 한다(휴리스틱이 못 맞히면 패턴 보강용).
#[tauri::command]
pub async fn park_browser_lobby() -> Result<String, String> {
    info!("🅿️ [PARK] 브라우저 로비 주차 시도(실험 — 라이브 검증 필요)");

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("CDP 연결 실패: {}", e))?;
    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("CDP 응답 파싱 실패: {}", e))?;

    let mut all_page_urls: Vec<String> = Vec::new();
    let mut targets: Vec<(String, String)> = Vec::new(); // (webSocketDebuggerUrl, page_url)

    for page in &pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if page_type != "page" {
            continue;
        }
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        all_page_urls.push(page_url.to_string());

        // 룸 탭·이미 주차된 탭·빈 URL은 건드리지 않는다(세션/베팅 보호).
        if page_url.contains("table_id=")
            || page_url.is_empty()
            || page_url.starts_with("about:blank")
        {
            continue;
        }
        // Evolution 로비/릴레이로 보이는 페이지만 주차 대상.
        let is_lobby = page_url.contains("/frontend/evo")
            || page_url.contains("evolutiongaming")
            || page_url.contains("evo-games")
            || page_url.contains("/lobby");
        if !is_lobby {
            continue;
        }
        if let Some(ws_dbg) = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
            targets.push((ws_dbg.to_string(), page_url.to_string()));
        }
    }

    info!(
        "🅿️ [PARK] page 탭 {}개 / 주차 대상 {}개",
        all_page_urls.len(),
        targets.len()
    );

    if targets.is_empty() {
        let msg = format!(
            "주차 대상(로비 탭) 없음. 확인한 page 탭 수: {}",
            all_page_urls.len()
        );
        warn!("🅿️ [PARK] {}", msg);
        return Ok(msg);
    }

    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    let mut parked = 0usize;
    for (ws_dbg, page_url) in &targets {
        let short: String = page_url.chars().take(80).collect();
        match connect_async(ws_dbg).await {
            Ok((mut ws_stream, _)) => {
                let navigate_cmd = serde_json::json!({
                    "id": 1,
                    "method": "Page.navigate",
                    "params": { "url": "about:blank" }
                });
                match ws_stream
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        navigate_cmd.to_string(),
                    ))
                    .await
                {
                    Ok(_) => {
                        parked += 1;
                        info!("🅿️ [PARK] ✅ 주차됨: {}", short);
                    }
                    Err(e) => warn!("🅿️ [PARK] navigate 전송 실패({}): {}", short, e),
                }
            }
            Err(e) => warn!("🅿️ [PARK] CDP 페이지 연결 실패({}): {}", short, e),
        }
    }

    let msg = format!(
        "로비 탭 {}/{}개 주차(about:blank). 라이브에서 방 목록 유지·중복세션 킥 멈춤 확인 필요.",
        parked,
        targets.len()
    );
    info!("🅿️ [PARK] {}", msg);
    Ok(msg)
}

/// Navigate to Evolution room with game WebSocket blocked
/// This prevents the browser from creating a conflicting game socket
/// while Rust multiwidget socket stays connected
///
/// IMPORTANT: This function NEVER touches the lobby tab to preserve session.
/// - If a room tab exists (table_id= in URL), navigate within that tab
/// - If no room tab exists, create a NEW window (don't touch lobby)
#[tauri::command]
pub async fn navigate_to_room_with_ws_block(app: AppHandle, url: String) -> Result<(), String> {
    info!(
        "🎰 Navigating to room with WS blocker (url_len={}, has_table_id={})",
        url.len(),
        url.contains("table_id=")
    );

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);

    // Get list of pages
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    // Find ONLY room tab (table_id= in URL) - DO NOT fallback to lobby!
    let mut room_tab: Option<String> = None;

    for page in &pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());

        if page_type != "page" {
            continue;
        }

        if let Some(ws_debugger_url) = ws_url {
            // Only look for existing room tabs (has table_id=)
            if page_url.contains("table_id=") {
                info!("🎰 Found existing room tab (url_len={})", page_url.len());
                room_tab = Some(ws_debugger_url.to_string());
                break;
            }
        }
    }

    // If no room tab exists, try lobby tab first to keep session alive
    // Evolution Gaming sessions expire after 30 minutes of lobby inactivity
    let target_ws_url = match room_tab {
        Some(ws_url) => ws_url,
        None => {
            // Try lobby tab first
            if let Some(lobby_ws_url) = find_lobby_tab_ws_url(&pages) {
                info!("🏠 No room tab found, navigating LOBBY tab with WS blocker to keep session alive");
                lobby_ws_url
            } else {
                // Fallback: create new window
                info!(
                    "⚠️ No lobby tab found, creating new window (session may expire after 30min)"
                );
                return create_new_room_tab_with_ws_block(app, url).await;
            }
        }
    };

    // Connect to CDP
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    let (mut ws_stream, _) = connect_async(&target_ws_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP page: {}", e))?;

    // Step 1: Inject WebSocket blocker script
    // 🔥 ENHANCED: Block ALL Evolution WebSockets (game, lobby, multiwidget)
    // Rust backend handles all Evolution connections to prevent session conflicts
    let ws_blocker_script = r#"
        (function() {
            if (window.__BCR_ALL_WS_BLOCKED__) return 'already_blocked';
            window.__BCR_ALL_WS_BLOCKED__ = true;

            var OrigWebSocket = window.WebSocket;
            window.__BCR_ORIG_WS__ = OrigWebSocket;

            // Create a dummy WebSocket that looks real but does nothing
            function createDummyWebSocket(url) {
                var dummy = {
                    url: url,
                    readyState: 1,
                    CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
                    bufferedAmount: 0,
                    extensions: '',
                    protocol: '',
                    binaryType: 'blob',
                    send: function(data) {
                        console.log('[BCR] 🚫 Blocked send:', url.substring(0, 60));
                    },
                    close: function(code, reason) {
                        this.readyState = 3;
                        var self = this;
                        if (this.onclose) {
                            setTimeout(function() {
                                self.onclose({ code: code || 1000, reason: reason || '', wasClean: true });
                            }, 10);
                        }
                    },
                    addEventListener: function(type, listener) {
                        if (type === 'open') this.onopen = listener;
                        else if (type === 'close') this.onclose = listener;
                        else if (type === 'error') this.onerror = listener;
                        else if (type === 'message') this.onmessage = listener;
                    },
                    removeEventListener: function() {},
                    dispatchEvent: function() { return true; },
                    onopen: null,
                    onclose: null,
                    onerror: null,
                    onmessage: null
                };

                // Simulate successful connection
                setTimeout(function() {
                    if (dummy.onopen) {
                        dummy.onopen({ target: dummy });
                    }
                }, 100);

                return dummy;
            }

            window.WebSocket = function(url, protocols) {
                url = String(url || '');

                // 🔥 Block lobby and multiwidget sockets only
                // Game socket is ALLOWED so user can enter rooms and see the game
                // Rust handles multiwidget for multi-table data
                var isBlockedSocket = (
                    // Lobby socket: /public/lobby/socket
                    (url.indexOf('/lobby/socket') !== -1) ||
                    // Multiwidget socket: /multiwidget/socket
                    (url.indexOf('/multiwidget/socket') !== -1)
                );

                if (isBlockedSocket) {
                    var socketType = url.indexOf('/multiwidget/') !== -1 ? 'multiwidget' : 'lobby';
                    console.log('[BCR] 🚫 Blocked ' + socketType + ' WebSocket (Rust handles this):', url.substring(0, 80));
                    return createDummyWebSocket(url);
                }

                console.log('[BCR] ✅ Allowed WebSocket:', url.substring(0, 100));
                return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
            };

            window.WebSocket.prototype = OrigWebSocket.prototype;
            window.WebSocket.CONNECTING = 0;
            window.WebSocket.OPEN = 1;
            window.WebSocket.CLOSING = 2;
            window.WebSocket.CLOSED = 3;

            console.log('[BCR] 🛡️ Evolution WebSocket blocker installed (lobby + multiwidget blocked)');
            return 'blocker_installed';
        })();
    "#;

    // Step 1: Register script to run on every new document load
    let add_script_cmd = serde_json::json!({
        "id": 1,
        "method": "Page.addScriptToEvaluateOnNewDocument",
        "params": {
            "source": ws_blocker_script,
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            add_script_cmd.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to inject WS blocker: {}", e))?;

    // Wait for response
    if let Some(Ok(msg)) = ws_stream.next().await {
        if let tokio_tungstenite::tungstenite::Message::Text(response) = msg {
            info!(
                "📜 WS blocker registered: {}",
                &response[..response.len().min(100)]
            );
        }
    }

    // Step 2: Navigate to room URL
    let navigate_cmd = serde_json::json!({
        "id": 2,
        "method": "Page.navigate",
        "params": {
            "url": url
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            navigate_cmd.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to navigate: {}", e))?;

    // Wait for navigation response
    if let Some(Ok(msg)) = ws_stream.next().await {
        if let tokio_tungstenite::tungstenite::Message::Text(response) = msg {
            info!(
                "📜 Navigation response: {}",
                &response[..response.len().min(100)]
            );
        }
    }

    // Step 3: Wait a bit then reload to ensure script is applied before WebSocket connects
    // Evolution SPA may not trigger full page load on hash navigation
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    // Force reload to apply the blocker script BEFORE any WebSocket connections
    let reload_cmd = serde_json::json!({
        "id": 3,
        "method": "Page.reload",
        "params": {
            "ignoreCache": false
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            reload_cmd.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to reload: {}", e))?;

    info!(
        "✅ Navigated to room with WS blocker (reload triggered, url_len={})",
        url.len()
    );
    Ok(())
}

/// Open a new tab in the CDP-enabled Chrome instance
/// This keeps the lobby tab open while opening the room in a new tab
/// Uses URL-based tab detection via HTTP API: finds existing tab with table_id= in URL and navigates it
#[tauri::command]
pub async fn open_new_tab_cdp(app: AppHandle, url: String) -> Result<(), String> {
    info!(
        "🌐 Opening/navigating room tab in CDP Chrome (url_len={})",
        url.len()
    );

    // Get list of pages via HTTP API (simpler and more reliable than WebSocket)
    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);

    let response = reqwest::get(&cdp_url).await.map_err(|e| {
        format!(
            "Failed to connect to CDP: {}. Is Chrome running with CDP?",
            e
        )
    })?;

    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP pages: {}", e))?;

    // Find existing room tab by URL pattern (contains "table_id=")
    let mut existing_room_ws_url: Option<String> = None;
    for page in &pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_debugger_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());

        if page_type == "page" && page_url.contains("table_id=") {
            if let Some(ws_url) = ws_debugger_url {
                info!("🎰 Found existing room tab (url_len={})", page_url.len());
                existing_room_ws_url = Some(ws_url.to_string());
                break;
            }
        }
    }

    // If found existing room tab, navigate it directly via page-level CDP
    if let Some(ws_debugger_url) = existing_room_ws_url {
        info!("📌 Navigating existing room tab via Page.navigate");

        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;

        let (mut ws_stream, _) = connect_async(&ws_debugger_url)
            .await
            .map_err(|e| format!("Failed to connect to page CDP: {}", e))?;

        // Send Page.navigate directly to the page
        let navigate_cmd = serde_json::json!({
            "id": 1,
            "method": "Page.navigate",
            "params": {
                "url": url
            }
        });

        ws_stream
            .send(tokio_tungstenite::tungstenite::Message::Text(
                navigate_cmd.to_string(),
            ))
            .await
            .map_err(|e| format!("Failed to send navigate: {}", e))?;

        // Wait for response
        if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(response))) =
            ws_stream.next().await
        {
            info!("📥 Page.navigate response: {}", response);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response) {
                if let Some(error) = json.get("error") {
                    let message = error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    warn!("⚠️ Page.navigate failed: {}, creating new tab", message);
                    return create_new_room_tab_via_browser(app, url).await;
                }
            }
        }

        // ✅ Step 2: Inject WebSocket blocker script (Same as navigate_to_room_with_ws_block)
        let ws_blocker_script = WS_BLOCKER_SCRIPT;

        let add_script_cmd = serde_json::json!({
            "id": 2,
            "method": "Page.addScriptToEvaluateOnNewDocument",
            "params": {
                "source": ws_blocker_script,
            }
        });

        let _ = ws_stream
            .send(tokio_tungstenite::tungstenite::Message::Text(
                add_script_cmd.to_string(),
            ))
            .await;

        info!("✅ Navigated existing room tab (url_len={})", url.len());

        // Notify frontend
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.emit(
                "cdp-tab-navigated",
                serde_json::json!({
                    "url": url,
                    "reused": true
                }),
            );
        }

        return Ok(());
    }

    // No existing room tab found - try lobby tab first to keep session alive
    // Evolution Gaming sessions expire after 30 minutes of lobby inactivity
    if let Some(lobby_ws_url) = find_lobby_tab_ws_url(&pages) {
        info!("🏠 No room tab found, navigating LOBBY tab to keep session alive");

        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::connect_async;

        let (mut ws_stream, _) = connect_async(&lobby_ws_url)
            .await
            .map_err(|e| format!("Failed to connect to lobby tab CDP: {}", e))?;

        // Navigate lobby tab to room URL
        let navigate_cmd = serde_json::json!({
            "id": 1,
            "method": "Page.navigate",
            "params": {
                "url": url
            }
        });

        ws_stream
            .send(tokio_tungstenite::tungstenite::Message::Text(
                navigate_cmd.to_string(),
            ))
            .await
            .map_err(|e| format!("Failed to navigate lobby tab: {}", e))?;

        // Wait for response
        if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(response))) =
            ws_stream.next().await
        {
            info!("📥 Lobby Page.navigate response: {}", response);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response) {
                if let Some(error) = json.get("error") {
                    let message = error
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    warn!(
                        "⚠️ Lobby navigation failed: {}, creating new window",
                        message
                    );
                    return create_new_room_tab_via_browser(app, url).await;
                }
            }
        }

        // 🔥 FIX: Reload after navigation to ensure Evolution SPA properly initializes
        tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

        let reload_cmd = serde_json::json!({
            "id": 2,
            "method": "Page.reload",
            "params": {
                "ignoreCache": false
            }
        });

        let _ = ws_stream
            .send(tokio_tungstenite::tungstenite::Message::Text(
                reload_cmd.to_string(),
            ))
            .await;

        info!(
            "✅ Navigated LOBBY tab to room and reloaded (url_len={})",
            url.len()
        );

        // Notify frontend
        if let Some(main_window) = app.get_webview_window("main") {
            let _ = main_window.emit(
                "cdp-tab-navigated",
                serde_json::json!({
                    "url": url,
                    "reused": true,
                    "wasLobby": true
                }),
            );
        }

        return Ok(());
    }

    // Fallback: No lobby tab found, create a new window
    info!("⚠️ No lobby tab found, creating new window (session may expire after 30min)");
    create_new_room_tab_via_browser(app, url).await
}

/// Helper function to create a new room tab via browser-level CDP
async fn create_new_room_tab_via_browser(app: AppHandle, url: String) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    // Get browser WebSocket URL
    let cdp_url = format!("http://127.0.0.1:{}/json/version", CDP_PORT);

    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let version_info: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP version: {}", e))?;

    let browser_ws_url = version_info
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or("Browser WebSocket URL not found")?;

    let (mut ws_stream, _) = connect_async(browser_ws_url)
        .await
        .map_err(|e| format!("Failed to connect to browser CDP: {}", e))?;

    // Create new target (new window - separate from lobby to keep lobby WebSocket active)
    let create_target_cmd = serde_json::json!({
        "id": 1,
        "method": "Target.createTarget",
        "params": {
            "url": url,
            "newWindow": true,
            "background": false
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            create_target_cmd.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to create new tab: {}", e))?;

    // Wait for response
    if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(response))) =
        ws_stream.next().await
    {
        info!("📥 CDP Target.createTarget response: {}", response);
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response) {
            if let Some(result) = json.get("result") {
                if let Some(target_id) = result.get("targetId").and_then(|v| v.as_str()) {
                    info!("✅ New room tab created with targetId: {}", target_id);

                    // Notify frontend
                    if let Some(main_window) = app.get_webview_window("main") {
                        let _ = main_window.emit(
                            "cdp-new-tab-created",
                            serde_json::json!({
                                "targetId": target_id,
                                "url": url
                            }),
                        );
                    }

                    // ✅ Step 2: Inject WebSocket blocker script into the new tab
                    // We need to wait a bit for the target to be available for connection
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                    let target_ws_url =
                        format!("ws://127.0.0.1:{}/devtools/page/{}", CDP_PORT, target_id);
                    if let Ok((mut target_ws, _)) = connect_async(&target_ws_url).await {
                        let add_script_cmd = serde_json::json!({
                            "id": 100,
                            "method": "Page.addScriptToEvaluateOnNewDocument",
                            "params": {
                                "source": WS_BLOCKER_SCRIPT,
                            }
                        });
                        let _ = target_ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                add_script_cmd.to_string(),
                            ))
                            .await;

                        // Also evaluate immediately in case it's already loading
                        let eval_cmd = serde_json::json!({
                            "id": 101,
                            "method": "Runtime.evaluate",
                            "params": {
                                "expression": WS_BLOCKER_SCRIPT,
                                "returnByValue": true
                            }
                        });
                        let _ = target_ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                eval_cmd.to_string(),
                            ))
                            .await;
                    }
                }
            } else if let Some(error) = json.get("error") {
                let message = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");
                return Err(format!("CDP error: {}", message));
            }
        }
    }

    Ok(())
}

/// Helper function to create a new room tab with WebSocket blocker
/// Used by navigate_to_room_with_ws_block when no room tab exists
async fn create_new_room_tab_with_ws_block(app: AppHandle, url: String) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    // Get browser WebSocket URL
    let cdp_url = format!("http://127.0.0.1:{}/json/version", CDP_PORT);

    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let version_info: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP version: {}", e))?;

    let browser_ws_url = version_info
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or("Browser WebSocket URL not found")?;

    let (mut ws_stream, _) = connect_async(browser_ws_url)
        .await
        .map_err(|e| format!("Failed to connect to browser CDP: {}", e))?;

    // Create new target (new window - separate from lobby to keep lobby WebSocket active)
    let create_target_cmd = serde_json::json!({
        "id": 1,
        "method": "Target.createTarget",
        "params": {
            "url": url,
            "newWindow": true,
            "background": false
        }
    });

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            create_target_cmd.to_string(),
        ))
        .await
        .map_err(|e| format!("Failed to create new tab: {}", e))?;

    // Wait for response
    if let Some(Ok(tokio_tungstenite::tungstenite::Message::Text(response))) =
        ws_stream.next().await
    {
        info!("📥 CDP Target.createTarget response: {}", response);
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response) {
            if let Some(result) = json.get("result") {
                if let Some(target_id) = result.get("targetId").and_then(|v| v.as_str()) {
                    info!("✅ New room window created with targetId: {}", target_id);

                    // Notify frontend
                    if let Some(main_window) = app.get_webview_window("main") {
                        let _ = main_window.emit(
                            "cdp-new-tab-created",
                            serde_json::json!({
                                "targetId": target_id,
                                "url": url
                            }),
                        );
                    }

                    // Wait for the target to be available for connection
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                    // Inject WebSocket blocker script into the new tab
                    let target_ws_url =
                        format!("ws://127.0.0.1:{}/devtools/page/{}", CDP_PORT, target_id);
                    if let Ok((mut target_ws, _)) = connect_async(&target_ws_url).await {
                        let add_script_cmd = serde_json::json!({
                            "id": 100,
                            "method": "Page.addScriptToEvaluateOnNewDocument",
                            "params": {
                                "source": WS_BLOCKER_SCRIPT,
                            }
                        });
                        let _ = target_ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                add_script_cmd.to_string(),
                            ))
                            .await;

                        // Also evaluate immediately in case it's already loading
                        let eval_cmd = serde_json::json!({
                            "id": 101,
                            "method": "Runtime.evaluate",
                            "params": {
                                "expression": WS_BLOCKER_SCRIPT,
                                "returnByValue": true
                            }
                        });
                        let _ = target_ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                eval_cmd.to_string(),
                            ))
                            .await;

                        info!("✅ WebSocket blocker injected into new room window");
                    }
                }
            } else if let Some(error) = json.get("error") {
                let message = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");
                return Err(format!("CDP error: {}", message));
            }
        }
    }

    Ok(())
}

/// Refresh the lobby page to reconnect WebSocket
/// This is used when lobby WebSocket connection is lost
#[tauri::command]
pub async fn refresh_lobby_page() -> Result<bool, String> {
    info!("🔄 Attempting to refresh lobby page");

    // Note: We don't check LOBBY_PAGE_ID anymore - we search by URL instead
    // This allows refreshing even if the page ID wasn't captured properly

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);

    // Get list of pages
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    // Find the lobby page
    for page in pages {
        let page_id = page.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let ws_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");

        // Check if this is an Evolution lobby page
        if let Some(ws_debugger_url) = ws_url {
            if is_evolution_lobby_url(page_url) {
                info!(
                    "🏛️ Found lobby page: {} (url_len={})",
                    page_id,
                    page_url.len()
                );

                // Connect and reload
                use futures_util::SinkExt;
                use tokio_tungstenite::connect_async;

                let (mut ws_stream, _) = connect_async(ws_debugger_url)
                    .await
                    .map_err(|e| format!("Failed to connect to CDP page: {}", e))?;

                let reload_cmd = serde_json::json!({
                    "id": 1,
                    "method": "Page.reload"
                });

                ws_stream
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        reload_cmd.to_string(),
                    ))
                    .await
                    .map_err(|e| format!("Failed to send reload command: {}", e))?;

                info!("✅ Lobby page reloaded");

                // Reset lobby page tracking
                *LOBBY_PAGE_ID.lock().unwrap() = None;

                return Ok(true);
            }
        }
    }

    warn!("⚠️ Lobby page not found in CDP targets");
    Ok(false)
}

/// 중계사이트의 "게임입장 에볼루션" 요소를 CDP로 클릭해 **새 EVOSESSIONID**를 발급받는다.
///
/// EVOSESSIONID는 카지노/중계사이트가 발급하는 ~10분 수명 쿠키다. 만료되면 브라우저+Rust 둘 다
/// connection.kickout(inactivity) 당하고, 같은 세션 재연결/단순 reload는 같은 토큰을 재사용해
/// 즉시 또 킥된다(라이브 확인). 반면 중계사이트의 게임입장 버튼을 다시 누르면 **새 세션이 발급됨**을
/// 라이브로 확인했다(s3k2ju… → subde2…). 그래서 만료 직전(~8.5분)에 이걸 눌러 세션을 선제 회전시킨다.
/// 이후 restart_cdp_monitoring으로 CDP가 새 세션의 lobby v2 소켓을 재캡처 → Rust 재연결.
#[tauri::command]
pub async fn click_evolution_launch() -> Result<bool, String> {
    info!("🎰 [SESSION-ROTATE] Clicking '게임입장 에볼루션' on relay site for a fresh EVOSESSIONID...");
    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);
    let pages: Vec<serde_json::Value> = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    // 가장 구체적인(텍스트 짧은) "게임입장 … 에볼루션" 요소를 찾아 클릭.
    // ⚠️ 중계사이트 런처 버튼이 iframe 안에 있는 경우가 있어 top document만 훑으면 NONE이 떠
    //    세션 회전이 통째로 실패한다. 그래서 findIn()이 (1) top document를 보고, (2) 같은 출처
    //    중첩 iframe(contentDocument 접근 가능)을 재귀로 들어간다. 교차 출처 OOPIF는 별도 CDP
    //    타깃(type:"iframe")으로 분리되므로 아래 루프에서 type을 "page"+"iframe" 둘 다 받아 커버한다.
    let click_js = r#"(function(){function findIn(doc){try{var a=[].slice.call(doc.querySelectorAll('div,a,button,span,li,p'));var c=a.filter(function(e){var t=(e.innerText||e.textContent||'').replace(/\s+/g,'');return t.indexOf('게임입장')>=0&&t.indexOf('에볼루션')>=0;});c.sort(function(x,y){return (x.innerText||x.textContent||'').length-(y.innerText||y.textContent||'').length;});if(c.length){c[0].click();return true;}}catch(e){}try{var fr=[].slice.call(doc.querySelectorAll('iframe'));for(var i=0;i<fr.length;i++){try{var d=fr[i].contentDocument;if(d&&findIn(d))return true;}catch(e){}}}catch(e){}return false;}return findIn(document)?'CLICKED':'NONE';})()"#;

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::connect_async;

    for page in pages {
        // type:"page"(메인 탭)과 type:"iframe"(교차 출처 OOPIF로 분리된 프레임)을 모두 받는다.
        // 중계사이트 런처가 OOPIF 안에 있으면 별도 타깃으로만 노출되므로 page만 보면 놓친다.
        let ptype = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ptype != "page" && ptype != "iframe" {
            continue;
        }
        let url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        // evo 게임 페이지는 건너뛴다(런처 버튼은 중계사이트 페이지에 있음).
        if url.contains("evo-games") {
            continue;
        }
        let ws = match page.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
            Some(w) => w,
            None => continue,
        };
        let (mut stream, _) = match connect_async(ws).await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let cmd = serde_json::json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": { "expression": click_js, "returnByValue": true }
        });
        if stream
            .send(tokio_tungstenite::tungstenite::Message::Text(
                cmd.to_string(),
            ))
            .await
            .is_err()
        {
            continue;
        }
        // 결과(id:1) 메시지를 몇 개 안에서 찾는다.
        for _ in 0..5 {
            match tokio::time::timeout(std::time::Duration::from_secs(3), stream.next()).await {
                Ok(Some(Ok(msg))) => {
                    let txt = msg.to_string();
                    if txt.contains("CLICKED") {
                        info!(
                            "🎰 [SESSION-ROTATE] ✅ Clicked launch on relay page (url_len={})",
                            url.len()
                        );
                        let _ = stream.close(None).await;
                        return Ok(true);
                    }
                    if txt.contains("\"NONE\"") {
                        break; // 이 페이지엔 요소 없음 → 다음 페이지
                    }
                }
                _ => break,
            }
        }
        let _ = stream.close(None).await;
    }

    warn!("🎰 [SESSION-ROTATE] ⚠️ '게임입장 에볼루션' element not found on any page");
    Ok(false)
}

/// Navigate the current Evolution ROOM tab to lobby (exit room)
/// This is used when user clicks the lobby button to return to lobby
/// Only navigates tabs that have table_id= in URL (actual room tabs)
#[tauri::command]
pub async fn navigate_to_evolution_lobby() -> Result<bool, String> {
    info!("🏠 Attempting to navigate Evolution room tab to lobby");

    let cdp_url = format!("http://127.0.0.1:{}/json", CDP_PORT);

    // Get list of pages
    let response = reqwest::get(&cdp_url)
        .await
        .map_err(|e| format!("Failed to connect to CDP: {}", e))?;

    let pages: Vec<serde_json::Value> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    // Find Evolution ROOM tab (must have table_id= in URL)
    for page in &pages {
        let page_type = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let page_url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let ws_url = page.get("webSocketDebuggerUrl").and_then(|v| v.as_str());

        if page_type != "page" {
            continue;
        }

        // Only look for room tabs (has table_id=)
        if !page_url.contains("table_id=") {
            continue;
        }

        if let Some(ws_debugger_url) = ws_url {
            info!("🎰 Found Evolution room tab (url_len={})", page_url.len());

            // Generate lobby URL by removing table_id from current URL
            let lobby_url = generate_lobby_url(page_url);
            info!("🏠 Navigating to lobby URL (url_len={})", lobby_url.len());

            // Connect and navigate
            use futures_util::{SinkExt, StreamExt};
            use tokio_tungstenite::connect_async;

            let (mut ws_stream, _) = connect_async(ws_debugger_url)
                .await
                .map_err(|e| format!("Failed to connect to CDP page: {}", e))?;

            // Step 1: Navigate to lobby URL
            let navigate_cmd = serde_json::json!({
                "id": 1,
                "method": "Page.navigate",
                "params": {
                    "url": lobby_url
                }
            });

            ws_stream
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    navigate_cmd.to_string(),
                ))
                .await
                .map_err(|e| format!("Failed to send navigate command: {}", e))?;

            // Wait for navigation response
            if let Some(Ok(msg)) = ws_stream.next().await {
                if let tokio_tungstenite::tungstenite::Message::Text(response) = msg {
                    info!(
                        "📜 Navigation response: {}",
                        &response[..response.len().min(100)]
                    );
                }
            }

            // Step 2: Reload to ensure clean state (Evolution SPA may cache state)
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

            let reload_cmd = serde_json::json!({
                "id": 2,
                "method": "Page.reload",
                "params": {
                    "ignoreCache": false
                }
            });

            ws_stream
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    reload_cmd.to_string(),
                ))
                .await
                .map_err(|e| format!("Failed to reload: {}", e))?;

            info!("✅ Navigated to lobby and reloaded");
            return Ok(true);
        }
    }

    warn!("⚠️ Evolution room tab not found in CDP targets (no table_id= in any URL)");
    Ok(false)
}

/// Generate lobby URL from room URL by removing table_id and other room params
fn generate_lobby_url(room_url: &str) -> String {
    // Room URL format: https://xxx.evo-games.com/frontend/evo/r2/#category=baccarat&game=baccarat&table_id=xxx&lobby_launch_id=xxx
    // Lobby URL format: https://xxx.evo-games.com/frontend/evo/r2/#category=baccarat

    if let Some(hash_pos) = room_url.find('#') {
        let base = &room_url[..hash_pos];
        // Return base URL with just category=baccarat
        format!("{}#category=baccarat", base)
    } else {
        // No hash, just return as-is with lobby fragment
        format!("{}#category=baccarat", room_url)
    }
}

// NOTE: is_lobby_connected, reconnect_lobby_socket, send_lobby_heartbeat removed
// Lobby client is no longer used - only multiwidget socket is active

/// Kill Chrome process that was started by this app
#[tauri::command]
pub async fn kill_chrome() -> Result<(), String> {
    let pid = CHROME_PID.load(Ordering::SeqCst);
    if pid > 0 {
        info!("🔴 Killing Chrome process: {}", pid);

        #[cfg(target_os = "macos")]
        {
            // Kill Chrome process tree
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();

            // Also try to kill any child processes
            let _ = std::process::Command::new("pkill")
                .args(["-P", &pid.to_string()])
                .output();
        }

        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }

        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }

        CHROME_PID.store(0, Ordering::SeqCst);
        // Clear room tab target ID
        *ROOM_TAB_TARGET_ID.lock().unwrap() = None;
        info!("✅ Chrome killed");
    }

    Ok(())
}

/// Cleanup function to be called on app exit
pub fn cleanup_on_exit() {
    let pid = CHROME_PID.load(Ordering::SeqCst);
    if pid > 0 {
        info!("🧹 Cleanup: Killing Chrome process: {}", pid);

        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }

        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }

        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }
}

// ============================================================================
// MULTIWIDGET AUTO-CONNECTION COMMANDS
// These use the global MULTIWIDGET_CLIENT for CDP auto-connection
// ============================================================================

/// Get multiwidget connection status (auto-connected from CDP)
#[tauri::command]
pub async fn get_multiwidget_status() -> Result<bool, String> {
    let client = MULTIWIDGET_CLIENT.lock().await;
    Ok(client.is_connected())
}

/// Get Evolution base URL for room navigation
/// Returns the HTTPS domain extracted from multiwidget WebSocket URL
/// Example: wss://babylontggasia.evo-games.com/... -> https://babylontggasia.evo-games.com
#[tauri::command]
pub fn get_evolution_base_url() -> Result<Option<String>, String> {
    EVOLUTION_BASE_URL
        .lock()
        .map(|g| g.clone())
        .map_err(|e| format!("Failed to get Evolution base URL: {}", e))
}

/// Disconnect multiwidget (auto-connected from CDP)
#[tauri::command]
pub async fn disconnect_multiwidget() -> Result<(), String> {
    // Reset connection flag so we can reconnect later
    MULTIWIDGET_CONNECTED.store(false, std::sync::atomic::Ordering::SeqCst);

    let mut client = MULTIWIDGET_CLIENT.lock().await;
    client.disconnect().await;
    info!("🔌 Multiwidget disconnected, connection flag reset");
    Ok(())
}

/// Send message to multiwidget socket (auto-connected from CDP)
#[tauri::command]
pub async fn send_multiwidget_message(message: String) -> Result<(), String> {
    let client = MULTIWIDGET_CLIENT.lock().await;
    client.send_message(message).await
}

/// Manually connect to multiwidget socket (if auto-connection failed)
#[tauri::command]
pub async fn connect_multiwidget_manual(
    app: AppHandle,
    ws_url: String,
    mwg_params: Option<String>,
) -> Result<(), String> {
    info!(
        "📡 Manual multiwidget connection requested (url_len={}, has_session_query={})",
        ws_url.len(),
        ws_url.to_ascii_lowercase().contains("evosessionid=")
    );

    let mut client = MULTIWIDGET_CLIENT.lock().await;

    if client.is_connected() {
        info!("📡 Disconnecting existing multiwidget connection...");
        client.disconnect().await;
    }

    // Set connection flag
    MULTIWIDGET_CONNECTED.store(true, std::sync::atomic::Ordering::SeqCst);

    // Setup event bridge for Tauri integration
    let event_rx = client.create_event_channel();
    crate::evolution::event_bridge::spawn_event_bridge(app.clone(), event_rx);

    let options = MultiSocketOptions {
        mwg_params,
        ..Default::default()
    };

    match client.connect(ws_url, options).await {
        Ok(_) => Ok(()),
        Err(e) => {
            // Reset flag on failure
            MULTIWIDGET_CONNECTED.store(false, std::sync::atomic::Ordering::SeqCst);
            Err(e)
        }
    }
}

#[cfg(test)]
mod session_rotation_tests {
    use super::*;

    #[test]
    fn atomic_flag_allows_only_one_rotation_and_releases_on_drop() {
        let flag = AtomicBool::new(false);

        let first = try_acquire_atomic_flag(&flag).expect("first rotation should acquire the flag");
        assert!(try_acquire_atomic_flag(&flag).is_none());

        drop(first);
        assert!(try_acquire_atomic_flag(&flag).is_some());
    }
}
