//! Prediction Commands V2
//!
//! V2 API를 사용하는 예측 명령어
//! - 히스토리 + 카드 + 베팅 쏠림 + 슈 상태 전송
//! - 결과 보고 및 슈 체인지 알림

use crate::application::usecases::MultiRoomState;
// V2 API types are used internally by the commands
use crate::domain::entities::GameResult;
use crate::presentation::state::AppState;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::{info, warn};

/// Multi room prediction state (managed separately)
pub struct MultiRoomPredictionState {
    pub state: RwLock<MultiRoomState>,
}

impl Default for MultiRoomPredictionState {
    fn default() -> Self {
        Self {
            state: RwLock::new(MultiRoomState::default()),
        }
    }
}

/// Prediction result for frontend (V2)
#[derive(Debug, Clone, Serialize)]
pub struct PredictionResult {
    pub room_id: String,
    pub prediction: Option<String>, // "Banker", "Player", or null for skip
    pub confidence: f64,
    pub reasoning: String,
    pub is_skip: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probabilities: Option<ProbabilitiesInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern_info: Option<PatternInfoResult>,
    /// 🎰 서버의 연패/연승 추적 정보 (클라이언트 동기화용)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streak_tracking: Option<StreakTrackingInfo>,
    /// 🆕 베팅 타입별 최적화 설정 (10만건 ML 데이터 기반)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bet_type_optimization: Option<BetTypeOptimizationInfo>,
}

/// 연패/연승 추적 정보 (프론트엔드용)
#[derive(Debug, Clone, Serialize)]
pub struct StreakTrackingInfo {
    pub consecutive_losses: i32,
    pub consecutive_wins: i32,
    pub total_predictions: i32,
    pub total_wins: i32,
    pub win_rate: f64,
    pub in_skip_mode: bool,
    pub martin_level: i32,
    pub recommended_multiplier: i32,
}

/// 베팅 타입별 최적화 설정 (100,000판 시뮬레이션 검증)
/// 핵심 원칙: 파산율 0% 유지하면서 수익 극대화
/// ML 데이터 기반: 70%+ 신뢰도 = 55.24% 승률
#[derive(Debug, Clone, Serialize)]
pub struct BetTypeOptimizationInfo {
    /// 베팅 타입 (martingale, fibonacci, paroli, flat, custom)
    pub bet_type: String,
    /// 권장 연패 SKIP 기준
    pub recommended_skip_after_losses: i32,
    /// 권장 최소 신뢰도 (0-100)
    pub recommended_min_confidence: i32,
    /// 권장 최대 마틴/피보 레벨 (1-10)
    pub recommended_max_level: i32,
    /// 권장 최대 동시 배팅 방 수 (1-10)
    pub recommended_max_rooms: i32,
    /// 100만원 자본 기준 권장 기본 베팅금
    pub recommended_base_bet: i64,
    /// 안전 자본 비율 (자본 = 기본베팅 × 이 값)
    pub safe_capital_ratio: i32,
    /// 시뮬레이션 기반 예상 수익률 (%)
    pub expected_profit_rate: f64,
    /// 시뮬레이션 기반 예상 승률 (%)
    pub expected_win_rate: f64,
    /// 시뮬레이션 기반 최대 연패
    pub expected_max_loss_streak: i32,
    /// 시뮬레이션 기반 파산율 (%) - 100K 시뮬: 모두 0%
    pub expected_bust_rate: f64,
    /// SKIP 비율 (%)
    pub skip_rate: f64,
    /// 최적화 근거 설명
    pub rationale: String,
}

/// 확률 정보 (V2)
#[derive(Debug, Clone, Serialize)]
pub struct ProbabilitiesInfo {
    pub player: f64,
    pub banker: f64,
    pub tie: f64,
}

/// 패턴 정보 (V2)
#[derive(Debug, Clone, Serialize)]
pub struct PatternInfoResult {
    pub current_streak: i32,
    pub streak_type: Option<String>,
}

/// 예측 결과 비교 (성공/실패)
#[derive(Debug, Clone, Serialize)]
pub struct PredictionResultComparison {
    pub room_id: String,
    pub prediction: Option<String>,
    pub actual_result: String,
    pub is_correct: bool,
    pub is_push: bool, // Tie일 때
    pub consecutive_wins: u32,
    pub consecutive_losses: u32,
    pub total_predictions: u32,
    pub correct_predictions: u32,
    pub win_rate: f64,
}

/// Multi room status for frontend
#[derive(Debug, Serialize)]
pub struct MultiRoomStatus {
    pub total_rooms: usize,
    pub predictable_rooms: usize,
    pub banker_predictions: usize,
    pub player_predictions: usize,
    pub skip_count: usize,
    pub average_confidence: f64,
    pub best_room_id: Option<String>,
    pub last_updated: i64,
}

/// Room prediction for frontend
#[derive(Debug, Serialize)]
pub struct RoomPredictionInfo {
    pub room_id: String,
    pub room_name: String,
    pub history_count: usize,
    pub prediction: Option<String>,
    pub confidence: f64,
    pub status: String,
    pub score: i32,
}

/// 방 선택 후보 (프론트엔드 입력)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSelectionCandidate {
    pub room_id: String,
    pub room_name: String,
    pub history: Vec<String>,
}

/// 방 선택 결과 (프론트엔드 출력)
#[derive(Debug, Serialize)]
pub struct RoomSelectionResultInfo {
    pub room_id: String,
    pub room_name: String,
    pub prediction: Option<String>,
    pub confidence: f64,
    pub is_skip: bool,
    pub skip_reason: Option<String>,
    pub score: f64,
}

/// 방 선택 응답 (프론트엔드 출력)
#[derive(Debug, Serialize)]
pub struct RoomSelectionResponseInfo {
    pub best_room_id: Option<String>,
    pub best_room_name: Option<String>,
    pub results: Vec<RoomSelectionResultInfo>,
    pub evaluated: usize,
    pub skipped: usize,
    pub response_time_ms: i64,
    pub reason: Option<String>,
}

// ==================== Multi Room Commands ====================

/// Enable multi-room prediction mode
#[tauri::command]
pub fn enable_multi_room_prediction(
    app_state: State<'_, AppState>,
    _pred_state: State<'_, MultiRoomPredictionState>,
) {
    info!("📲 Enable multi-room prediction");
    app_state.multi_room_prediction.enable();
}

/// Disable multi-room prediction mode
#[tauri::command]
pub fn disable_multi_room_prediction(app_state: State<'_, AppState>) {
    info!("📲 Disable multi-room prediction");
    app_state.multi_room_prediction.disable();
}

/// Request predictions for all rooms
#[tauri::command]
pub async fn request_all_predictions(
    app_state: State<'_, AppState>,
    pred_state: State<'_, MultiRoomPredictionState>,
) -> Result<MultiRoomStatus, String> {
    info!("📲 Request all predictions");

    // Clone state to avoid holding lock across await
    let state_snapshot = {
        let state = pred_state.state.read();
        state.clone()
    };

    // Call async function with cloned state
    let mut state_copy = state_snapshot;
    app_state
        .multi_room_prediction
        .predict_all(&mut state_copy)
        .await?;

    let summary = app_state.multi_room_prediction.get_summary(&state_copy);

    // Update original state with changes
    {
        let mut state = pred_state.state.write();
        *state = state_copy;
    }

    Ok(MultiRoomStatus {
        total_rooms: summary.total_rooms,
        predictable_rooms: summary.predictable_rooms,
        banker_predictions: summary.banker_predictions,
        player_predictions: summary.player_predictions,
        skip_count: summary.skip_count,
        average_confidence: summary.average_confidence,
        best_room_id: summary.best_room,
        last_updated: summary.last_updated,
    })
}

/// Get multi-room prediction status
#[tauri::command]
pub fn get_multi_room_status(
    app_state: State<'_, AppState>,
    pred_state: State<'_, MultiRoomPredictionState>,
) -> MultiRoomStatus {
    let state = pred_state.state.read();
    let summary = app_state.multi_room_prediction.get_summary(&state);

    MultiRoomStatus {
        total_rooms: summary.total_rooms,
        predictable_rooms: summary.predictable_rooms,
        banker_predictions: summary.banker_predictions,
        player_predictions: summary.player_predictions,
        skip_count: summary.skip_count,
        average_confidence: summary.average_confidence,
        best_room_id: summary.best_room,
        last_updated: summary.last_updated,
    }
}

/// Get all room predictions
#[tauri::command]
pub fn get_all_predictions(
    app_state: State<'_, AppState>,
    pred_state: State<'_, MultiRoomPredictionState>,
) -> Vec<RoomPredictionInfo> {
    let state = pred_state.state.read();

    state
        .predictions
        .values()
        .map(|p| {
            let prediction = p.prediction.as_ref().and_then(|resp| {
                resp.prediction.map(|r| match r {
                    GameResult::Banker => "Banker".to_string(),
                    GameResult::Player => "Player".to_string(),
                    GameResult::Tie => "Tie".to_string(),
                })
            });

            let confidence = p.prediction.as_ref().map(|r| r.confidence).unwrap_or(0.0);

            let status = match &p.status {
                crate::domain::entities::PredictionStatus::Pending => "pending",
                crate::domain::entities::PredictionStatus::Ready => "ready",
                crate::domain::entities::PredictionStatus::Skip => "skip",
                crate::domain::entities::PredictionStatus::Error(_) => "error",
            };

            // Get score from room
            let score = app_state
                .room_repository
                .get_room(&p.room_id)
                .map(|r| crate::domain::services::GameLogicService::calculate_room_score(&r))
                .unwrap_or(0);

            RoomPredictionInfo {
                room_id: p.room_id.clone(),
                room_name: p.room_name.clone(),
                history_count: p.current_history.len(),
                prediction,
                confidence,
                status: status.to_string(),
                score,
            }
        })
        .collect()
}

/// Get top N rooms by score
#[tauri::command]
pub fn get_top_predictions(
    n: usize,
    app_state: State<'_, AppState>,
    pred_state: State<'_, MultiRoomPredictionState>,
) -> Vec<RoomPredictionInfo> {
    let mut predictions = get_all_predictions(app_state, pred_state);
    predictions.sort_by(|a, b| b.score.cmp(&a.score));
    predictions.truncate(n);
    predictions
}

/// 방 선택: 복수 방 후보 중 서버 추천 방 반환
#[tauri::command]
pub async fn request_best_room_selection(
    candidates: Vec<RoomSelectionCandidate>,
    bet_type: Option<String>,
    martin_level: Option<i32>,
    min_confidence: Option<i32>,
    max_results: Option<i32>,
    include_skipped: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<RoomSelectionResponseInfo, String> {
    use crate::data::datasources::{GameRound, RoomSelectionRequest, V2PredictionRequest};

    if candidates.is_empty() {
        return Ok(RoomSelectionResponseInfo {
            best_room_id: None,
            best_room_name: None,
            results: Vec::new(),
            evaluated: 0,
            skipped: 0,
            response_time_ms: 0,
            reason: Some("NO_CANDIDATES".to_string()),
        });
    }

    let mut v2_candidates: Vec<V2PredictionRequest> = Vec::new();

    for candidate in candidates {
        if candidate.history.len() < 5 {
            continue;
        }

        let history_v2: Vec<GameRound> = candidate
            .history
            .iter()
            .map(|s| GameRound {
                winner: match s.to_lowercase().as_str() {
                    "banker" | "b" | "red" => "Banker".to_string(),
                    "player" | "p" | "blue" => "Player".to_string(),
                    _ => "Tie".to_string(),
                },
                player_score: None,
                banker_score: None,
                natural: None,
                player_pair: None,
                banker_pair: None,
            })
            .collect();

        let evolution_data = app_state.evolution_data.get_v2_request(&candidate.room_id);
        let (betting_stats, shoe_stats, last_game_cards) = if let Some(ref evo) = evolution_data {
            (
                evo.betting_stats.clone(),
                evo.shoe_stats.clone(),
                evo.last_game_cards.clone(),
            )
        } else {
            (None, None, None)
        };

        v2_candidates.push(V2PredictionRequest {
            room_id: candidate.room_id.clone(),
            room_name: candidate.room_name.clone(),
            game_id: None,
            game_number: None,
            history: history_v2,
            last_game_cards,
            betting_stats,
            shoe_stats,
            bet_type: bet_type.clone(),
            martin_level,
            min_confidence,
            auto_mode: Some(false),
            // 🆕 v3.7.0: 방 선택 시에는 사용자 추적 불필요
            user_id: None,
            username: None,
            session_id: None,
            current_balance: None,
            bet_amount: None,
            client_type: None,
        });
    }

    if v2_candidates.is_empty() {
        return Ok(RoomSelectionResponseInfo {
            best_room_id: None,
            best_room_name: None,
            results: Vec::new(),
            evaluated: 0,
            skipped: 0,
            response_time_ms: 0,
            reason: Some("NO_VALID_CANDIDATES".to_string()),
        });
    }

    let selection_request = RoomSelectionRequest {
        candidates: v2_candidates,
        max_results,
        include_skipped,
    };

    let response = app_state
        .prediction_repository
        .select_best_room(&selection_request)
        .await?;

    let results: Vec<RoomSelectionResultInfo> = response
        .results
        .into_iter()
        .map(|r| {
            let prediction = r
                .prediction
                .as_ref()
                .and_then(|p| match p.to_lowercase().as_str() {
                    "banker" => Some("Banker".to_string()),
                    "player" => Some("Player".to_string()),
                    _ => None,
                });
            let is_skip = r.is_skip.unwrap_or(false) || prediction.is_none();

            RoomSelectionResultInfo {
                room_id: r.room_id.clone().unwrap_or_default(),
                room_name: r
                    .room_name
                    .clone()
                    .unwrap_or_else(|| r.room_id.clone().unwrap_or_default()),
                prediction,
                confidence: r.confidence.unwrap_or(0) as f64,
                is_skip,
                skip_reason: r.skip_reason.clone(),
                score: r.score.unwrap_or(0.0),
            }
        })
        .collect();

    let evaluated = response
        .evaluated
        .map(|v| v as usize)
        .unwrap_or_else(|| results.len());
    let skipped = response
        .skipped
        .map(|v| v as usize)
        .unwrap_or_else(|| results.iter().filter(|r| r.is_skip).count());

    Ok(RoomSelectionResponseInfo {
        best_room_id: response.best_room_id,
        best_room_name: response.best_room_name,
        results,
        evaluated,
        skipped,
        response_time_ms: response.response_time_ms.unwrap_or(0),
        reason: response.reason,
    })
}

// ==================== History-Based Prediction (Frontend SSOT) ====================

/// Request prediction with history from frontend
/// This is the new approach where frontend provides fresh history data
/// to avoid stale data issues in backend
/// 🔧 Enhanced: Also includes betting/shoe data from EvolutionDataManager if available
/// 🆕 bet_type: 베팅 전략 타입 (martingale, fibonacci, paroli, flat, custom)
/// 🆕 martin_level: 마틴 레벨 (SKIP 임계값 조정용)
/// 🆕 min_confidence: 최소 신뢰도 (프론트 설정 우선 적용)
/// 🆕 auto_mode: 오토모드 여부 (동시방 제한 적용)
/// 🆕 v3.7.0: 사용자/잔액 추적 필드 추가
#[tauri::command]
pub async fn request_prediction_with_history(
    room_id: String,
    room_name: String,
    history: Vec<String>, // ["Banker", "Player", "Tie", ...]
    _remaining_seconds: u32,
    bet_type: Option<String>,    // 🆕 베팅 전략 타입
    martin_level: Option<i32>,   // 🆕 마틴 레벨
    min_confidence: Option<i32>, // 🆕 최소 신뢰도
    auto_mode: Option<bool>,     // 🆕 오토모드 여부
    // 🆕 v3.7.0: 사용자/잔액 추적
    user_id: Option<String>,
    username: Option<String>,
    session_id: Option<String>,
    current_balance: Option<i64>,
    bet_amount: Option<i64>,
    client_type: Option<String>,
    app_state: State<'_, AppState>,
) -> Result<Option<PredictionResult>, String> {
    use crate::data::datasources::{GameRound, V2PredictionRequest};

    info!(
        "🔮 Prediction with frontend history for room: {} ({} results)",
        room_id,
        history.len()
    );

    // Check minimum history requirement
    if history.len() < 5 {
        info!(
            "⏸️ Not enough history ({} < 5) for prediction",
            history.len()
        );
        return Ok(None);
    }

    // Convert string history to V2 GameRound format
    let history_v2: Vec<GameRound> = history
        .iter()
        .map(|s| GameRound {
            winner: match s.to_lowercase().as_str() {
                "banker" | "b" | "red" => "Banker".to_string(),
                "player" | "p" | "blue" => "Player".to_string(),
                _ => "Tie".to_string(),
            },
            player_score: None,
            banker_score: None,
            natural: None,
            player_pair: None,
            banker_pair: None,
        })
        .collect();

    // 🔧 Try to get additional data from EvolutionDataManager (betting, shoe, cards)
    let evolution_data = app_state.evolution_data.get_v2_request(&room_id);
    let (betting_stats, shoe_stats, last_game_cards) = if let Some(ref evo) = evolution_data {
        info!(
            "📊 EvolutionData 사용: 베팅={}, 슈={}, 카드={}",
            evo.betting_stats.is_some(),
            evo.shoe_stats.is_some(),
            evo.last_game_cards.is_some()
        );
        (
            evo.betting_stats.clone(),
            evo.shoe_stats.clone(),
            evo.last_game_cards.clone(),
        )
    } else {
        info!("📊 EvolutionData 없음 - 히스토리만 사용");
        (None, None, None)
    };

    // 🆕 v3.7.0: 현재 로그인 사용자 정보 자동 포함
    let current_user = app_state.user_authentication.get_current_user();
    let (resolved_user_id, resolved_username, resolved_session_id) =
        if let Some(ref user) = current_user {
            (
                user_id.or_else(|| Some(user.id.clone())),
                username.or_else(|| Some(user.username.clone())),
                // session_id가 없으면 auth_token 앞 16자 + 타임스탬프로 생성
                session_id.or_else(|| {
                    let token_prefix = user.auth_token.chars().take(16).collect::<String>();
                    Some(format!(
                        "{}_{}",
                        token_prefix,
                        chrono::Utc::now().format("%Y%m%d%H%M")
                    ))
                }),
            )
        } else {
            (user_id, username, session_id)
        };

    info!(
        "📊 v3.7.0 User tracking: user_id={:?}, username={:?}, session_id={:?}",
        resolved_user_id, resolved_username, resolved_session_id
    );

    // Create V2 prediction request with frontend history + evolution data
    let v2_request = V2PredictionRequest {
        room_id: room_id.clone(),
        room_name: room_name.clone(),
        game_id: None,
        game_number: None,
        history: history_v2,
        last_game_cards,
        betting_stats,
        shoe_stats,
        bet_type: bet_type.clone(), // 🆕 베팅 전략 타입 전달
        martin_level,               // 🆕 마틴 레벨 전달 (SKIP 임계값 조정용)
        min_confidence,             // 🆕 최소 신뢰도 전달 (프론트 설정 우선)
        auto_mode,                  // 🆕 오토모드 여부 전달
        // 🆕 v3.7.0: 사용자/잔액 추적 필드 (자동 포함)
        user_id: resolved_user_id,
        username: resolved_username,
        session_id: resolved_session_id,
        current_balance,
        bet_amount,
        client_type: client_type.or(Some("desktop".to_string())),
    };

    // Call V2 prediction API
    let response = app_state
        .prediction_repository
        .predict_v2(&v2_request)
        .await?;

    info!(
        "🎯 Hybrid prediction for {}: {} (confidence: {}%)",
        room_id,
        response.prediction.as_deref().unwrap_or("SKIP"),
        response.confidence.unwrap_or(0)
    );

    Ok(Some(PredictionResult {
        room_id: response.room_id.clone().unwrap_or(room_id),
        prediction: response
            .prediction
            .clone()
            .and_then(|p| match p.to_lowercase().as_str() {
                "banker" => Some("Banker".to_string()),
                "player" => Some("Player".to_string()),
                _ => None,
            }),
        confidence: response.confidence.unwrap_or(0) as f64 / 100.0,
        reasoning: response
            .reasoning
            .clone()
            .unwrap_or_else(|| "서버 예측".to_string()),
        is_skip: response.is_skip.unwrap_or(false),
        skip_reason: response.skip_reason.clone(),
        probabilities: response.probabilities.as_ref().map(|p| ProbabilitiesInfo {
            player: p.player.unwrap_or(44.62),
            banker: p.banker.unwrap_or(45.86),
            tie: p.tie.unwrap_or(9.52),
        }),
        pattern_info: response.pattern_info.as_ref().map(|p| PatternInfoResult {
            current_streak: p.current_streak.unwrap_or(0),
            streak_type: p.streak_type.clone(),
        }),
        streak_tracking: response
            .streak_tracking
            .as_ref()
            .map(|s| StreakTrackingInfo {
                consecutive_losses: s.consecutive_losses.unwrap_or(0),
                consecutive_wins: s.consecutive_wins.unwrap_or(0),
                total_predictions: s.total_predictions.unwrap_or(0),
                total_wins: s.total_wins.unwrap_or(0),
                win_rate: s.win_rate.unwrap_or(0.0),
                in_skip_mode: s.in_skip_mode.unwrap_or(false),
                martin_level: s.martin_level.unwrap_or(0),
                recommended_multiplier: s.recommended_multiplier.unwrap_or(1),
            }),
        // 🆕 베팅 타입별 최적화 설정 (100K 시뮬레이션 검증)
        bet_type_optimization: response.bet_type_optimization.as_ref().map(|o| {
            BetTypeOptimizationInfo {
                bet_type: o.bet_type.clone().unwrap_or_else(|| "flat".to_string()),
                recommended_skip_after_losses: o.recommended_skip_after_losses.unwrap_or(4),
                recommended_min_confidence: o.recommended_min_confidence.unwrap_or(0),
                recommended_max_level: o.recommended_max_level.unwrap_or(3),
                recommended_max_rooms: o.recommended_max_rooms.unwrap_or(5),
                recommended_base_bet: o.recommended_base_bet.unwrap_or(10000),
                safe_capital_ratio: o.safe_capital_ratio.unwrap_or(100),
                expected_profit_rate: o.expected_profit_rate.unwrap_or(645.0),
                expected_win_rate: o.expected_win_rate.unwrap_or(49.59),
                expected_max_loss_streak: o.expected_max_loss_streak.unwrap_or(4),
                expected_bust_rate: o.expected_bust_rate.unwrap_or(0.0),
                skip_rate: o.skip_rate.unwrap_or(0.9),
                rationale: o
                    .rationale
                    .clone()
                    .unwrap_or_else(|| "4연패SKIP=SKIP0.9%,수익+645%".to_string()),
            }
        }),
    }))
}

// ==================== V2 API Commands ====================

/// V2 예측 요청 (향상된 데이터 포함)
/// Evolution WebSocket에서 수집한 모든 데이터를 포함하여 예측 요청
/// 🆕 bet_type: 베팅 전략 타입 (martingale, fibonacci, paroli, flat, custom)
#[tauri::command]
pub async fn request_prediction_v2(
    room_id: String,
    bet_type: Option<String>, // 🆕 베팅 전략 타입
    app_state: State<'_, AppState>,
) -> Result<Option<PredictionResult>, String> {
    info!("🔮 V2 예측 요청: {} (bet_type: {:?})", room_id, bet_type);

    // Evolution 데이터 매니저에서 방 데이터 가져오기 (bet_type 포함)
    let v2_request = app_state
        .evolution_data
        .get_v2_request_with_bet_type(&room_id, bet_type)
        .ok_or_else(|| format!("방 데이터 없음: {}", room_id))?;

    // 히스토리 최소 요구사항 확인
    if v2_request.history.len() < 5 {
        info!(
            "⏸️ 히스토리 부족 ({} < 5): {}",
            v2_request.history.len(),
            room_id
        );
        return Ok(Some(PredictionResult {
            room_id: room_id.clone(),
            prediction: None,
            confidence: 0.0,
            reasoning: "히스토리 부족 (최소 5게임 필요)".to_string(),
            is_skip: true,
            skip_reason: Some("히스토리 부족".to_string()),
            probabilities: None,
            pattern_info: None,
            streak_tracking: None,
            bet_type_optimization: None,
        }));
    }

    // V2 API 호출
    let response = app_state
        .prediction_repository
        .predict_v2(&v2_request)
        .await?;

    // 응답 변환
    let result = PredictionResult {
        room_id: response.room_id.clone().unwrap_or(room_id.clone()),
        prediction: response
            .prediction
            .clone()
            .and_then(|p| match p.to_lowercase().as_str() {
                "banker" => Some("Banker".to_string()),
                "player" => Some("Player".to_string()),
                _ => None,
            }),
        confidence: response.confidence.unwrap_or(0) as f64 / 100.0,
        reasoning: response
            .reasoning
            .clone()
            .unwrap_or_else(|| "서버 예측".to_string()),
        is_skip: response.is_skip.unwrap_or(false),
        skip_reason: response.skip_reason.clone(),
        probabilities: response.probabilities.as_ref().map(|p| ProbabilitiesInfo {
            player: p.player.unwrap_or(44.62),
            banker: p.banker.unwrap_or(45.86),
            tie: p.tie.unwrap_or(9.52),
        }),
        pattern_info: response.pattern_info.as_ref().map(|p| PatternInfoResult {
            current_streak: p.current_streak.unwrap_or(0),
            streak_type: p.streak_type.clone(),
        }),
        streak_tracking: response
            .streak_tracking
            .as_ref()
            .map(|s| StreakTrackingInfo {
                consecutive_losses: s.consecutive_losses.unwrap_or(0),
                consecutive_wins: s.consecutive_wins.unwrap_or(0),
                total_predictions: s.total_predictions.unwrap_or(0),
                total_wins: s.total_wins.unwrap_or(0),
                win_rate: s.win_rate.unwrap_or(0.0),
                in_skip_mode: s.in_skip_mode.unwrap_or(false),
                martin_level: s.martin_level.unwrap_or(0),
                recommended_multiplier: s.recommended_multiplier.unwrap_or(1),
            }),
        // 🆕 베팅 타입별 최적화 설정
        bet_type_optimization: response.bet_type_optimization.as_ref().map(|o| {
            BetTypeOptimizationInfo {
                bet_type: o.bet_type.clone().unwrap_or_else(|| "flat".to_string()),
                recommended_skip_after_losses: o.recommended_skip_after_losses.unwrap_or(4),
                recommended_min_confidence: o.recommended_min_confidence.unwrap_or(0),
                recommended_max_level: o.recommended_max_level.unwrap_or(3),
                recommended_max_rooms: o.recommended_max_rooms.unwrap_or(5),
                recommended_base_bet: o.recommended_base_bet.unwrap_or(10000),
                safe_capital_ratio: o.safe_capital_ratio.unwrap_or(100),
                expected_profit_rate: o.expected_profit_rate.unwrap_or(0.0),
                expected_win_rate: o.expected_win_rate.unwrap_or(50.0),
                expected_max_loss_streak: o.expected_max_loss_streak.unwrap_or(5),
                expected_bust_rate: o.expected_bust_rate.unwrap_or(0.0),
                skip_rate: o.skip_rate.unwrap_or(0.55),
                rationale: o
                    .rationale
                    .clone()
                    .unwrap_or_else(|| "4연패SKIP=SKIP0.9%,수익+645%".to_string()),
            }
        }),
    };

    info!(
        "🎯 V2 예측 결과: {} -> {:?} (신뢰도: {:.1}%)",
        room_id,
        result.prediction,
        result.confidence * 100.0
    );

    Ok(Some(result))
}

/// V2 결과 보고 (게임 결과 확정 시)
#[tauri::command]
pub async fn report_result_v2(
    room_id: String,
    actual_result: String,
    app_state: State<'_, AppState>,
) -> Result<PredictionResultComparison, String> {
    info!("📊 V2 결과 보고: {} -> {}", room_id, actual_result);

    // 정규화된 결과
    let normalized_result = match actual_result.to_lowercase().as_str() {
        "banker" | "b" | "red" => "Banker",
        "player" | "p" | "blue" => "Player",
        _ => "Tie",
    };

    // Evolution 데이터에서 방 데이터 가져오기 (없으면 최소 데이터로 생성)
    let v2_request = app_state
        .evolution_data
        .get_v2_request(&room_id)
        .unwrap_or_else(|| {
            info!("⚠️ 방 데이터 없음, 최소 요청 생성: {}", room_id);
            crate::data::datasources::V2PredictionRequest {
                room_id: room_id.clone(),
                room_name: room_id.clone(), // room_id를 이름으로 사용
                game_id: None,
                game_number: None,
                history: vec![],
                last_game_cards: None,
                betting_stats: None,
                shoe_stats: None,
                bet_type: None,
                martin_level: None,
                min_confidence: None,
                auto_mode: None,
                user_id: None,
                username: None,
                session_id: None,
                current_balance: None,
                bet_amount: None,
                client_type: None,
            }
        });

    // V2 결과 보고 API 호출
    let _report_response = app_state
        .prediction_repository
        .report_result_v2(&v2_request, normalized_result)
        .await;

    // TODO: 실제 예측 추적 상태에서 성공/실패 계산
    // 현재는 더미 응답 반환
    let comparison = PredictionResultComparison {
        room_id: room_id.clone(),
        prediction: None, // TODO: 이전 예측 저장 후 사용
        actual_result: normalized_result.to_string(),
        is_correct: false,
        is_push: normalized_result == "Tie",
        consecutive_wins: 0,
        consecutive_losses: 0,
        total_predictions: 0,
        correct_predictions: 0,
        win_rate: 0.0,
    };

    Ok(comparison)
}

/// 슈 체인지 알림
#[tauri::command]
pub async fn notify_shoe_change_v2(
    room_id: String,
    room_name: String,
    app_state: State<'_, AppState>,
) -> Result<bool, String> {
    info!("🔄 V2 슈 체인지 알림: {}", room_name);

    // 로컬 데이터 리셋
    app_state.evolution_data.notify_shoe_change(&room_id);

    // 서버에 슈 체인지 알림
    let result = app_state
        .prediction_repository
        .notify_shoe_change(&room_id, &room_name)
        .await;

    match result {
        Ok(_) => {
            info!("✅ 슈 체인지 처리 완료: {}", room_name);
            Ok(true)
        }
        Err(e) => {
            warn!("⚠️ 슈 체인지 알림 실패: {}", e);
            Ok(false)
        }
    }
}

/// Evolution WebSocket 메시지 처리 (Rust에서 데이터 수집)
#[tauri::command]
pub fn process_evolution_message(
    message_type: String,
    table_id: String,
    data: serde_json::Value,
    app_state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // 메시지 타입에 따라 데이터 수집
    match message_type.as_str() {
        "baccarat.encodedShoeState" => {
            let shoe_changed = app_state.evolution_data.handle_shoe_state(&table_id, &data);
            if shoe_changed {
                return Ok(Some("shoe_changed".to_string()));
            }
        }
        "baccarat.tableState" => {
            app_state
                .evolution_data
                .handle_table_state(&table_id, &data);
        }
        "baccarat.bettingStats" => {
            app_state
                .evolution_data
                .handle_betting_stats(&table_id, &data);
        }
        "baccarat.gameState" => {
            app_state.evolution_data.handle_game_state(&table_id, &data);
        }
        "baccarat.resolved" => {
            if let Some(winner) = app_state.evolution_data.handle_resolved(&table_id, &data) {
                return Ok(Some(format!("resolved:{}", winner)));
            }
        }
        _ => {}
    }

    Ok(None)
}

/// 방 게임 데이터 조회 (디버깅용)
#[tauri::command]
pub fn get_room_game_data(
    room_id: String,
    app_state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let data = app_state
        .evolution_data
        .get_room_data(&room_id)
        .ok_or_else(|| format!("방 데이터 없음: {}", room_id))?;

    Ok(serde_json::json!({
        "roomId": data.room_id,
        "roomName": data.room_name,
        "gameId": data.game_id,
        "gameNumber": data.game_number,
        "historyLength": data.history.len(),
        "hasBettingStats": data.betting_stats.is_some(),
        "hasCardInfo": data.last_game_cards.is_some(),
        "hasShoeStats": data.shoe_stats.is_some(),
        "shoeCardsOut": data.shoe_cards_out,
    }))
}

/// 모든 방 ID 조회
#[tauri::command]
pub fn get_tracked_rooms(app_state: State<'_, AppState>) -> Vec<String> {
    app_state.evolution_data.get_room_ids()
}
