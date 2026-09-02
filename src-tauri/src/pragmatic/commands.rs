use super::manager::{PragmaticBetReceipt, PragmaticManagerState};
use tauri::{command, AppHandle, State};

// Connect to a specific room (or lobby connection if room_id="lobby")
#[command]
pub async fn connect_pragmatic_room(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    room_id: String,
    ws_url: String,
) -> Result<(), String> {
    if pragmatic_passive_mode() {
        tracing::info!("🔬 [PRAG] passive mode — connect_pragmatic_room 생략(브라우저 트래픽만 관찰)");
        return Ok(());
    }
    let manager_arc = state.manager.clone();
    let mut manager = state.manager.lock().await;
    manager
        .connect_room(app, room_id, ws_url, manager_arc)
        .await
}

// Disconnect a specific room
#[command]
pub async fn disconnect_pragmatic_room(
    state: State<'_, PragmaticManagerState>,
    room_id: String,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.disconnect_room(&room_id).await;
    Ok(())
}

// Disconnect all pragmatic connections
#[command]
pub async fn disconnect_all_pragmatic(
    state: State<'_, PragmaticManagerState>,
) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.disconnect_all().await;
    Ok(())
}

/// Connect by tableId using stored session (constructs WS URL dynamically)
#[command]
pub async fn connect_pragmatic_table(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    table_id: String,
) -> Result<(), String> {
    if pragmatic_passive_mode() {
        tracing::info!("🔬 [PRAG] passive mode — connect_pragmatic_table 생략(브라우저 트래픽만 관찰)");
        return Ok(());
    }
    let manager_arc = state.manager.clone();
    let mut manager = state.manager.lock().await;
    manager.connect_table_id(app, &table_id, manager_arc).await
}

/// 🔬 수동 캡처 모드(env `BCR_PRAGMATIC_PASSIVE=1`): Rust가 프라그마틱 소켓을 직접 열지 않는다.
/// 브라우저가 유일한 클라이언트여야 킥/중복세션 없이 실제 프레임을 관찰할 수 있다(에볼루션에서
/// 2-클라이언트 구조가 킥·403의 원인이었음). 캡처 후 파싱/브릿지 설계는 그 프레임을 근거로 한다.
fn pragmatic_passive_mode() -> bool {
    // 브릿지 모드(기본)면 Rust 직접 소켓을 열지 않는다. BCR_PRAGMATIC_PASSIVE=1도 같은 뜻(캡처용 별칭).
    super::bridge::bridge_mode_enabled()
        || std::env::var("BCR_PRAGMATIC_PASSIVE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

// Legacy command wrapper for compatibility (treats as "lobby" connection)
#[command]
pub async fn connect_pragmatic(
    app: AppHandle,
    state: State<'_, PragmaticManagerState>,
    ws_url: String,
) -> Result<(), String> {
    if pragmatic_passive_mode() {
        tracing::info!("🔬 [PRAG] passive mode — Rust 직접 소켓 생략(브라우저 트래픽만 관찰)");
        return Ok(());
    }
    let manager_arc = state.manager.clone();
    let mut manager = state.manager.lock().await;
    // Use the smart connection handler that parses URL and session
    manager
        .handle_new_connection(app, ws_url, manager_arc)
        .await
}

#[command]
pub async fn disconnect_pragmatic(state: State<'_, PragmaticManagerState>) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager.disconnect_all().await;
    Ok(())
}
#[command]
pub async fn send_pragmatic_message(
    state: State<'_, PragmaticManagerState>,
    room_id: String,
    message: String,
) -> Result<(), String> {
    let manager = state.manager.lock().await;
    manager.send_message(&room_id, message).await
}

#[command]
pub async fn set_pragmatic_user_id(
    state: State<'_, PragmaticManagerState>,
    user_id: String,
) -> Result<(), String> {
    super::bridge::PRAGMATIC_BRIDGE.lock().await.set_user_id(&user_id);
    let mut manager = state.manager.lock().await;
    manager.set_user_id(user_id);
    Ok(())
}

#[command]
pub async fn place_pragmatic_bet(
    state: State<'_, PragmaticManagerState>,
    table_id: String,
    bet_type: String,
    amount: u64,
) -> Result<serde_json::Value, String> {
    // 브릿지(기본): 브라우저 게임 소켓에 XML 주입. 레거시: Rust 직접 소켓.
    if super::bridge::bridge_mode_enabled() {
        let receipt = super::bridge::PRAGMATIC_BRIDGE
            .lock()
            .await
            .place_bet(&table_id, &bet_type, amount)?;
        return serde_json::to_value(receipt).map_err(|e| e.to_string());
    }
    let mut manager = state.manager.lock().await;
    let receipt: PragmaticBetReceipt = manager.place_bet(&table_id, &bet_type, amount).await?;
    serde_json::to_value(receipt).map_err(|e| e.to_string())
}

/// 프라그마틱 배팅 취소(브릿지 전용). 같은 lpbet 형식에 amt=0, bc=8.
#[command]
pub async fn cancel_pragmatic_bet(table_id: String) -> Result<String, String> {
    super::bridge::PRAGMATIC_BRIDGE.lock().await.cancel_bet(&table_id)
}

/// 브릿지 상태 스냅샷(진단·UI용): 부착 여부, 훅 컨텍스트, 사용자 id, 테이블별 창/마감.
#[command]
pub async fn get_pragmatic_bridge_snapshot() -> Result<serde_json::Value, String> {
    Ok(super::bridge::PRAGMATIC_BRIDGE.lock().await.snapshot())
}
