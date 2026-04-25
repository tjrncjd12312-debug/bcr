// VERSION: 1.4.1 - SYNC VERIFICATION
//! Prediction API Client V2
//!
//! V2 API를 사용하는 향상된 예측 클라이언트
//! - 히스토리 + 카드 + 베팅 쏠림 + 슈 상태 전송
//! - 결과 보고 및 슈 체인지 알림

use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

// ==================== API 설정 ====================

/// API 설정
#[derive(Debug, Clone)]
pub struct PredictionApiConfig {
    /// 서버 기본 URL
    pub base_url: String,
    /// JWT 인증 토큰
    pub auth_token: Option<String>,
    /// 요청 타임아웃 (초)
    pub timeout_secs: u64,
}

impl Default for PredictionApiConfig {
    fn default() -> Self {
        Self {
            base_url: "http://bcra.store".to_string(),
            auth_token: None,
            timeout_secs: 30,
        }
    }
}

// ==================== V2 요청 구조체 ====================

/// V2 예측 요청
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2PredictionRequest {
    /// 방 ID
    pub room_id: String,
    /// 방 이름
    pub room_name: String,
    /// 게임 ID (Evolution)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_id: Option<String>,
    /// 게임 번호
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_number: Option<String>,
    /// 히스토리 (최근 게임 결과)
    pub history: Vec<GameRound>,
    /// 마지막 게임 카드 정보
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_game_cards: Option<CardInfo>,
    /// 베팅 쏠림 통계
    #[serde(skip_serializing_if = "Option::is_none")]
    pub betting_stats: Option<BettingStats>,
    /// 슈 상태
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shoe_stats: Option<ShoeStats>,
    /// 🆕 베팅 전략 타입 (martingale, fibonacci, paroli, flat, custom)
    /// 10만건 ML 데이터 기반 최적화 설정 반환에 사용
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bet_type: Option<String>,
    /// 🆕 마틴 레벨 (3, 5, 7, 10 등)
    /// SKIP 임계값 동적 조정에 사용 - martinLevel = SKIP 임계값
    #[serde(skip_serializing_if = "Option::is_none")]
    pub martin_level: Option<i32>,
    /// 🆕 최소 신뢰도 (50-100)
    /// 클라이언트에서 설정한 최소 신뢰도 - 서버의 동적 설정보다 우선 적용
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<i32>,
    /// 🆕 오토모드 여부 (동시방 제한 적용)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_mode: Option<bool>,
    /// 🆕 v3.7.0: 사용자 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// 🆕 v3.7.0: 사용자명
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// 🆕 v3.7.0: 세션 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 🆕 v3.7.0: 현재 잔액 (원)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_balance: Option<i64>,
    /// 🆕 v3.7.0: 베팅 금액 (원)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bet_amount: Option<i64>,
    /// 🆕 v3.7.0: 클라이언트 타입
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_type: Option<String>,
}

impl V2PredictionRequest {
    /// Lane R3 (perf-plan): 공유 히스토리 스냅샷(`Arc<Vec<GameRound>>`) 로부터
    /// 요청을 생성한다.
    ///
    /// # 계약
    /// - `history` 는 `EvolutionDataManager` 가 저장한 불변 스냅샷의 `Arc::clone` 이어야 한다.
    /// - 공개 `V2PredictionRequest::history` 필드 타입(`Vec<GameRound>`, serde 직렬화
    ///   대상)은 동결이므로, 이 생성자는 JSON 직렬화 직전 단 1회 소유 Vec으로
    ///   전환한다(*boundary clone*, 정당함).
    /// - `auto_mode`/`martin_level`/`min_confidence`/`user_*`/`bet_amount` 등
    ///   커맨드 레이어에서 추가로 주입되는 필드는 `None`으로 초기화되며, 호출자가
    ///   필요에 따라 필드 접근으로 설정한다.
    ///
    /// # 왜 `&Arc<Vec<_>>`가 아닌 `Arc<Vec<_>>`를 받는가
    /// 소유권 이동으로 호출자 측의 Arc를 `drop` 시점까지 정확히 1회만 bump한다.
    /// 호출자가 스냅샷을 계속 보유해야 하면 미리 `Arc::clone` 해서 넘기면 된다.
    #[allow(clippy::too_many_arguments)]
    pub fn from_shared(
        room_id: String,
        room_name: String,
        game_id: Option<String>,
        game_number: Option<String>,
        history: Arc<Vec<GameRound>>,
        last_game_cards: Option<CardInfo>,
        betting_stats: Option<BettingStats>,
        shoe_stats: Option<ShoeStats>,
        bet_type: Option<String>,
    ) -> Self {
        // Boundary clone: Arc<Vec<GameRound>> -> Vec<GameRound>.
        // refcount == 1 이면 내부 Vec을 옮기고(그 경우 복제 0회),
        // refcount > 1 이면 Vec을 1회 복제한다. R3의 목적은
        // "핫패스에서의 메시지당 복제 제거" 이며, 이 지점은 HTTP 직렬화 직전의
        // 1회성 경계 복제이므로 허용된다(plan.md §3 Lane R3 참고).
        let history: Vec<GameRound> =
            Arc::try_unwrap(history).unwrap_or_else(|arc| (*arc).clone());

        Self {
            room_id,
            room_name,
            game_id,
            game_number,
            history,
            last_game_cards,
            betting_stats,
            shoe_stats,
            bet_type,
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
    }
}

/// 게임 라운드 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameRound {
    /// 승자 (Banker/Player/Tie)
    pub winner: String,
    /// 플레이어 점수 (0-9)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_score: Option<i32>,
    /// 뱅커 점수 (0-9)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_score: Option<i32>,
    /// 내추럴 여부
    #[serde(skip_serializing_if = "Option::is_none")]
    pub natural: Option<bool>,
    /// 플레이어 페어
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_pair: Option<bool>,
    /// 뱅커 페어
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_pair: Option<bool>,
}

/// 카드 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    /// 플레이어 카드 (예: ["5H", "2C"])
    pub player_cards: Vec<String>,
    /// 뱅커 카드 (예: ["QS", "5D", "QH"])
    pub banker_cards: Vec<String>,
    /// 플레이어 점수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_score: Option<i32>,
    /// 뱅커 점수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_score: Option<i32>,
}

/// 베팅 쏠림 통계
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BettingStats {
    /// 플레이어 베팅 비율 (0-100)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_percentage: Option<i32>,
    /// 뱅커 베팅 비율 (0-100)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_percentage: Option<i32>,
    /// 타이 베팅 비율 (0-100)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tie_percentage: Option<i32>,
    /// 플레이어 베팅 금액
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_amount: Option<f64>,
    /// 뱅커 베팅 금액
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_amount: Option<f64>,
    /// 타이 베팅 금액
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tie_amount: Option<f64>,
    /// 플레이어 베팅 인원
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_players: Option<i32>,
    /// 뱅커 베팅 인원
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_players: Option<i32>,
    /// 타이 베팅 인원
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tie_players: Option<i32>,
    /// 총 베팅 인원
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bettors: Option<i32>,
    /// 관전자 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watchers: Option<i32>,
}

/// 슈 상태 통계
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoeStats {
    /// 슈에서 나온 카드 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cards_out: Option<i32>,
    /// 총 게임 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_count: Option<i32>,
    /// 플레이어 승리 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_wins: Option<i32>,
    /// 뱅커 승리 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_wins: Option<i32>,
    /// 타이 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ties: Option<i32>,
    /// 플레이어 페어 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player_pairs: Option<i32>,
    /// 뱅커 페어 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banker_pairs: Option<i32>,
}

// ==================== V2 응답 구조체 ====================

/// V2 예측 응답
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V2PredictionResponse {
    /// 예측 결과 (Banker/Player/Skip)
    pub prediction: Option<String>,
    /// 신뢰도 (0-100)
    pub confidence: Option<i32>,
    /// 스킵 여부
    pub is_skip: Option<bool>,
    /// 스킵 사유
    pub skip_reason: Option<String>,
    /// 확률 정보
    pub probabilities: Option<Probabilities>,
    /// 예측 근거 (한글)
    pub reasoning: Option<String>,
    /// 응답 시간 (ms)
    pub response_time_ms: Option<i64>,
    /// 알고리즘 버전
    pub algorithm_version: Option<String>,
    /// 방 ID
    pub room_id: Option<String>,
    /// 요소별 기여도
    pub factors: Option<PredictionFactors>,
    /// 패턴 정보
    pub pattern_info: Option<PatternInfo>,
    /// 카드 카운팅 정보
    pub card_count_info: Option<CardCountInfo>,
    /// 베팅 쏠림 분석
    pub crowd_analysis: Option<CrowdAnalysis>,
    /// 🎰 연패/연승 추적 정보 (마틴 베팅용)
    pub streak_tracking: Option<StreakTracking>,
    /// 🆕 베팅 타입별 최적화 설정 (10만건 ML 데이터 기반)
    pub bet_type_optimization: Option<BetTypeOptimization>,
    /// 🆕 사용된 예측 전략 (프론트엔드 전략 필터용)
    /// ensemble_default, streak_reversal, streak_following, alternating_pattern, combined_signal 등
    pub strategy_used: Option<String>,
}

// ==================== 방 선택 API 구조체 ====================

/// 방 선택 요청
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSelectionRequest {
    pub candidates: Vec<V2PredictionRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_skipped: Option<bool>,
}

/// 방 선택 결과
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSelectionResponse {
    pub best_room_id: Option<String>,
    pub best_room_name: Option<String>,
    pub results: Vec<RoomSelectionResult>,
    pub evaluated: Option<i32>,
    pub skipped: Option<i32>,
    pub response_time_ms: Option<i64>,
    pub reason: Option<String>,
}

/// 방별 예측 결과
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSelectionResult {
    pub room_id: Option<String>,
    pub room_name: Option<String>,
    pub prediction: Option<String>,
    pub confidence: Option<i32>,
    pub is_skip: Option<bool>,
    pub skip_reason: Option<String>,
    pub score: Option<f64>,
}

/// 확률 정보
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probabilities {
    pub player: Option<f64>,
    pub banker: Option<f64>,
    pub tie: Option<f64>,
}

/// 요소별 기여도
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionFactors {
    pub base_probability: Option<FactorDetail>,
    pub pattern_analysis: Option<FactorDetail>,
    pub card_counting: Option<FactorDetail>,
    pub crowd_wisdom: Option<FactorDetail>,
    pub shoe_state: Option<FactorDetail>,
}

/// 개별 요소 상세
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactorDetail {
    pub prediction: Option<String>,
    pub weight: Option<f64>,
    pub confidence: Option<i32>,
    pub description: Option<String>,
}

/// 패턴 정보
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternInfo {
    pub pattern_type: Option<String>,
    pub current_streak: Option<i32>,
    pub streak_type: Option<String>,
    pub pattern_strength: Option<f64>,
    pub description: Option<String>,
}

/// 카드 카운팅 정보
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCountInfo {
    pub running_count: Option<i32>,
    pub true_count: Option<f64>,
    pub remaining_decks: Option<f64>,
    pub shoe_progress: Option<f64>,
    pub count_favorability: Option<String>,
    pub description: Option<String>,
}

/// 베팅 쏠림 분석
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrowdAnalysis {
    pub dominant_side: Option<String>,
    pub dominant_percentage: Option<i32>,
    pub trend_strength: Option<String>,
    pub recommended_strategy: Option<String>,
    pub should_contrary: Option<bool>,
    pub description: Option<String>,
}

/// 연패/연승 추적 정보 (마틴 베팅용)
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreakTracking {
    /// 현재 연패 수
    pub consecutive_losses: Option<i32>,
    /// 현재 연승 수
    pub consecutive_wins: Option<i32>,
    /// 총 예측 수
    pub total_predictions: Option<i32>,
    /// 총 승리 수
    pub total_wins: Option<i32>,
    /// 승률 (0.0 ~ 1.0)
    pub win_rate: Option<f64>,
    /// SKIP 모드 여부
    pub in_skip_mode: Option<bool>,
    /// 마틴 레벨 (0~5)
    pub martin_level: Option<i32>,
    /// 추천 베팅 배수 (1, 2, 4, 8, 16...)
    pub recommended_multiplier: Option<i32>,
}

/// 베팅 타입별 최적화 설정 (100,000판 시뮬레이션 검증)
/// 핵심 원칙: 파산율 0% 유지하면서 수익 극대화
/// ML 데이터 기반: 70%+ 신뢰도 = 55.24% 승률
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BetTypeOptimization {
    /// 베팅 타입 (martingale, fibonacci, paroli, flat, custom)
    pub bet_type: Option<String>,
    /// 권장 연패 SKIP 기준 (이 횟수 연패 후 1게임 SKIP)
    pub recommended_skip_after_losses: Option<i32>,
    /// 권장 최소 신뢰도 (0-100, 이 신뢰도 미만이면 SKIP)
    pub recommended_min_confidence: Option<i32>,
    /// 권장 최대 마틴/피보 레벨 (1-10)
    pub recommended_max_level: Option<i32>,
    /// 권장 최대 동시 배팅 방 수 (1-10)
    pub recommended_max_rooms: Option<i32>,
    /// 100만원 자본 기준 권장 기본 베팅금
    pub recommended_base_bet: Option<i64>,
    /// 안전 자본 비율 (자본 = 기본베팅 × 이 값)
    pub safe_capital_ratio: Option<i32>,
    /// 시뮬레이션 기반 예상 수익률 (%)
    pub expected_profit_rate: Option<f64>,
    /// 시뮬레이션 기반 예상 승률 (%)
    pub expected_win_rate: Option<f64>,
    /// 시뮬레이션 기반 최대 연패
    pub expected_max_loss_streak: Option<i32>,
    /// 시뮬레이션 기반 파산율 (%) - 100K 시뮬: 모두 0%
    pub expected_bust_rate: Option<f64>,
    /// SKIP 비율 (%)
    pub skip_rate: Option<f64>,
    /// 최적화 근거 설명
    pub rationale: Option<String>,
}

/// 결과 보고 응답
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultReportResponse {
    pub success: bool,
    pub message: Option<String>,
    pub room_id: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
}

/// 슈 체인지 응답
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoeChangeResponse {
    pub success: bool,
    pub message: Option<String>,
    pub room_id: Option<String>,
    pub shoe_id: Option<String>,
    pub error: Option<String>,
}

// ==================== 도메인 변환용 구조체 ====================

use crate::domain::entities::{GameResult, PredictionResponse};

impl V2PredictionResponse {
    /// 도메인 PredictionResponse로 변환
    pub fn to_domain(&self, room_id: &str) -> PredictionResponse {
        let prediction = self.prediction.as_deref().unwrap_or("");
        let is_skip = self.is_skip.unwrap_or(false) || prediction.eq_ignore_ascii_case("skip");

        let game_result = if is_skip {
            None
        } else {
            match prediction.to_lowercase().as_str() {
                "banker" | "b" | "red" => Some(GameResult::Banker),
                "player" | "p" | "blue" => Some(GameResult::Player),
                _ => None,
            }
        };

        let confidence = self.confidence.unwrap_or(0) as f64 / 100.0;

        let reasoning = if is_skip {
            self.skip_reason
                .clone()
                .unwrap_or_else(|| "패스".to_string())
        } else {
            self.reasoning
                .clone()
                .unwrap_or_else(|| format!("서버 예측 ({}ms)", self.response_time_ms.unwrap_or(0)))
        };

        // 패턴 정보 문자열 생성
        let pattern_info = self.pattern_info.as_ref().map(|p| {
            format!(
                "스트릭: {} {}연속",
                p.streak_type.as_deref().unwrap_or("없음"),
                p.current_streak.unwrap_or(0)
            )
        });

        PredictionResponse {
            room_id: room_id.to_string(),
            prediction: game_result,
            confidence,
            reasoning,
            pattern_info,
            is_skip,
        }
    }
}

// ==================== API 클라이언트 ====================

/// Prediction API 클라이언트
pub struct PredictionApi {
    client: Client,
    config: PredictionApiConfig,
}

impl PredictionApi {
    /// 새 클라이언트 생성
    pub fn new(config: PredictionApiConfig) -> Result<Self, String> {
        let mut headers = header::HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("application/json"),
        );

        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(config.timeout_secs))
            .build()
            .map_err(|e| format!("HTTP 클라이언트 생성 실패: {}", e))?;

        Ok(Self { client, config })
    }

    /// 인증 토큰 설정
    pub fn set_auth_token(&mut self, token: String) {
        info!("🔑 토큰 설정: {}...", &token[..token.len().min(20)]);
        self.config.auth_token = Some(token);
    }

    /// 기본 URL 설정
    pub fn set_base_url(&mut self, url: String) {
        self.config.base_url = url;
    }

    /// 토큰 가져오기
    fn get_token(&self) -> Result<&str, String> {
        self.config
            .auth_token
            .as_deref()
            .ok_or_else(|| "인증 토큰이 설정되지 않았습니다".to_string())
    }

    // ==================== V2 API 호출 ====================

    /// V2 예측 요청
    pub async fn predict_v2(
        &self,
        request: &V2PredictionRequest,
    ) -> Result<V2PredictionResponse, String> {
        let url = format!("{}/api/v2/predict", self.config.base_url);
        let token = self.get_token()?;

        info!(
            "📡 V2 예측 요청: 방={}, 히스토리={}, 카드={}, 베팅={}",
            request.room_name,
            request.history.len(),
            request.last_game_cards.is_some(),
            request.betting_stats.is_some()
        );

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(request)
            .send()
            .await
            .map_err(|e| format!("요청 실패: {}", e))?;

        let status = response.status();

        // 401 - 토큰 만료
        if status.as_u16() == 401 {
            warn!("⚠️ 토큰 만료 (401)");
            return Err("token-expired".to_string());
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            error!("❌ V2 예측 API 오류: {} - {}", status, body);
            return Err(format!("server-{}", status.as_u16()));
        }

        let api_response: V2PredictionResponse = response
            .json()
            .await
            .map_err(|e| format!("응답 파싱 실패: {}", e))?;

        info!(
            "📥 V2 예측 응답: {} (신뢰도: {}%) {}",
            api_response.prediction.as_deref().unwrap_or("없음"),
            api_response.confidence.unwrap_or(0),
            if api_response.is_skip.unwrap_or(false) {
                "- SKIP"
            } else {
                ""
            }
        );

        Ok(api_response)
    }

    /// 방 선택 요청 (복수 방 후보 중 최적 방 반환)
    pub async fn select_best_room(
        &self,
        request: &RoomSelectionRequest,
    ) -> Result<RoomSelectionResponse, String> {
        let url = format!("{}/api/v2/predict/best-room", self.config.base_url);
        let token = self.get_token()?;

        info!(
            "📡 방 선택 요청: 후보 {}개",
            request.candidates.len()
        );

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(request)
            .send()
            .await
            .map_err(|e| format!("요청 실패: {}", e))?;

        let status = response.status();

        if status.as_u16() == 401 {
            warn!("⚠️ 토큰 만료 (401)");
            return Err("token-expired".to_string());
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            error!("❌ 방 선택 API 오류: {} - {}", status, body);
            return Err(format!("server-{}", status.as_u16()));
        }

        let api_response: RoomSelectionResponse = response
            .json()
            .await
            .map_err(|e| format!("응답 파싱 실패: {}", e))?;

        Ok(api_response)
    }

    /// V2 결과 보고
    pub async fn report_result_v2(
        &self,
        request: &V2PredictionRequest,
        actual_result: &str,
    ) -> Result<ResultReportResponse, String> {
        let url = format!(
            "{}/api/v2/result?actualResult={}",
            self.config.base_url, actual_result
        );
        let token = self.get_token()?;

        info!(
            "📊 V2 결과 보고: 방={}, 결과={}",
            request.room_name, actual_result
        );

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .json(request)
            .send()
            .await
            .map_err(|e| format!("요청 실패: {}", e))?;

        let status = response.status();

        if status.as_u16() == 401 {
            warn!("⚠️ 토큰 만료 (401)");
            return Err("token-expired".to_string());
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            error!("❌ 결과 보고 실패: {} - {}", status, body);
            return Err(format!("server-{}", status.as_u16()));
        }

        let result: ResultReportResponse = response
            .json()
            .await
            .map_err(|e| format!("응답 파싱 실패: {}", e))?;

        if result.success {
            info!("✅ 결과 보고 완료");
        } else {
            warn!("⚠️ 결과 보고 실패: {:?}", result.error);
        }

        Ok(result)
    }

    /// 슈 체인지 알림
    pub async fn notify_shoe_change(
        &self,
        room_id: &str,
        room_name: &str,
    ) -> Result<ShoeChangeResponse, String> {
        let url = format!(
            "{}/api/v2/shoe-change?roomId={}&roomName={}",
            self.config.base_url,
            urlencoding::encode(room_id),
            urlencoding::encode(room_name)
        );
        let token = self.get_token()?;

        info!("🔄 슈 체인지 알림: 방={}", room_name);

        let response = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| format!("요청 실패: {}", e))?;

        let status = response.status();

        if status.as_u16() == 401 {
            warn!("⚠️ 토큰 만료 (401)");
            return Err("token-expired".to_string());
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            error!("❌ 슈 체인지 알림 실패: {} - {}", status, body);
            return Err(format!("server-{}", status.as_u16()));
        }

        let result: ShoeChangeResponse = response
            .json()
            .await
            .map_err(|e| format!("응답 파싱 실패: {}", e))?;

        if result.success {
            info!("✅ 슈 체인지 처리 완료: {:?}", result.shoe_id);
        }

        Ok(result)
    }

    // ==================== 레거시 API 래핑 (V2 내부 호출) ====================

    /// 예측 요청 (레거시 - V2 래핑)
    /// 기존 코드 호환성을 위해 PredictionRequest를 V2 형식으로 변환하여 호출
    pub async fn predict(
        &self,
        request: &crate::domain::entities::PredictionRequest,
    ) -> Result<crate::domain::entities::PredictionResponse, String> {
        // PredictionRequest를 V2PredictionRequest로 변환
        let v2_request = V2PredictionRequest {
            room_id: request.room_id.clone(),
            room_name: request.room_name.clone(),
            game_id: None,
            game_number: None,
            history: request
                .history
                .iter()
                .map(|r| GameRound {
                    winner: match r {
                        crate::domain::entities::GameResult::Banker => "Banker".to_string(),
                        crate::domain::entities::GameResult::Player => "Player".to_string(),
                        crate::domain::entities::GameResult::Tie => "Tie".to_string(),
                    },
                    player_score: None,
                    banker_score: None,
                    natural: None,
                    player_pair: None,
                    banker_pair: None,
                })
                .collect(),
            last_game_cards: None,
            betting_stats: None,
            shoe_stats: None,
            bet_type: None, // 레거시 API는 기본값 사용
            martin_level: None, // 레거시 API는 기본값 사용
            min_confidence: None, // 레거시 API는 기본값 사용
            auto_mode: None, // 레거시 API는 기본값 사용
            user_id: None, // 🆕 v3.7.0
            username: None, // 🆕 v3.7.0
            session_id: None, // 🆕 v3.7.0
            current_balance: None, // 🆕 v3.7.0
            bet_amount: None, // 🆕 v3.7.0
            client_type: None, // 🆕 v3.7.0
        };

        // V2 API 호출
        let v2_response = self.predict_v2(&v2_request).await?;

        // V2 응답을 도메인 응답으로 변환
        Ok(v2_response.to_domain(&request.room_id))
    }

    /// 배치 예측 (레거시 - V2 래핑)
    pub async fn predict_batch(
        &self,
        requests: &[crate::domain::entities::PredictionRequest],
    ) -> Vec<Result<crate::domain::entities::PredictionResponse, String>> {
        let mut results = Vec::with_capacity(requests.len());

        for request in requests {
            results.push(self.predict(request).await);
        }

        results
    }

    // ==================== 토큰 검증 ====================

    /// 토큰 검증 (상세 정보 포함)
    pub async fn validate_token_with_time(
        &self,
        token: &str,
    ) -> Result<TokenValidationResponse, String> {
        let url = format!("{}/api/validate-token", self.config.base_url);

        info!("🔍 토큰 검증 중...");

        let response = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| format!("토큰 검증 요청 실패: {}", e))?;

        let status = response.status();

        if status.as_u16() == 401 {
            warn!("⚠️ 토큰 무효: 401 Unauthorized");
            return Ok(TokenValidationResponse {
                valid: false,
                expired: false,
                remaining_seconds: 0,
            });
        }

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            error!("❌ 토큰 검증 오류: {} - {}", status, body);
            return Err(format!("server-{}", status.as_u16()));
        }

        let body = response
            .text()
            .await
            .map_err(|e| format!("응답 읽기 실패: {}", e))?;

        let api_response: TokenValidationApiResponse = serde_json::from_str(&body)
            .map_err(|e| format!("토큰 검증 응답 파싱 실패: {} - Body: {}", e, body))?;

        Ok(TokenValidationResponse {
            valid: api_response.valid,
            expired: api_response.expired.unwrap_or(false),
            remaining_seconds: api_response.remaining_seconds.unwrap_or(0),
        })
    }

    // ==================== 버전 체크 ====================

    /// 클라이언트 버전 (Cargo.toml에서 가져옴)
    pub const CLIENT_VERSION: &'static str = env!("CARGO_PKG_VERSION");

    /// 서버에 버전 호환성 체크
    pub async fn check_version(&self) -> Result<VersionCheckResponse, String> {
        let url = format!("{}/api/version/check", self.config.base_url);

        info!("🔍 버전 체크: {} (클라이언트 버전: {})", url, Self::CLIENT_VERSION);

        let payload = serde_json::json!({
            "clientVersion": Self::CLIENT_VERSION,
            "platform": "desktop"
        });

        let response = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("버전 체크 요청 실패: {}", e))?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| format!("응답 읽기 실패: {}", e))?;

        info!("📥 버전 체크 응답 (HTTP {}): {}", status, response_text);

        if !status.is_success() {
            // 서버가 버전 체크 API를 지원하지 않는 경우 호환으로 처리
            if status.as_u16() == 404 {
                info!("⚠️ 버전 체크 API 없음 - 호환으로 처리");
                return Ok(VersionCheckResponse {
                    required_version: Self::CLIENT_VERSION.to_string(),
                    compatible: true,
                    message: None,
                    download_url: None,
                    file_name: None,
                });
            }
            return Err(format!("버전 체크 실패: HTTP {}", status));
        }

        let version_response: VersionCheckResponse = serde_json::from_str(&response_text)
            .map_err(|e| format!("버전 응답 파싱 실패: {} - Body: {}", e, response_text))?;

        info!(
            "✅ 버전 체크 완료: required={}, compatible={}",
            version_response.required_version, version_response.compatible
        );

        Ok(version_response)
    }

    // ==================== 로그인 ====================

    /// 로그인 (버전 체크 포함)
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginApiResponse, String> {
        // 🔥 로그인 전 버전 체크
        match self.check_version().await {
            Ok(version_check) => {
                if !version_check.compatible {
                    let msg = version_check.message.clone().unwrap_or_else(|| {
                        format!(
                            "업데이트 필요: {} -> {}",
                            Self::CLIENT_VERSION,
                            version_check.required_version
                        )
                    });
                    
                    // 버전 불일치 정보를 JSON 형태로 에러 메시지에 담아 전달
                    // auth_commands에서 이를 파싱하여 업데이트 UI를 띄울 수 있음
                    let err_data = serde_json::json!({
                        "type": "version_mismatch",
                        "message": msg,
                        "requiredVersion": version_check.required_version,
                        "downloadUrl": version_check.download_url,
                        "fileName": version_check.file_name
                    });
                    return Err(err_data.to_string());
                }
            }
            Err(e) => {
                warn!("⚠️ 버전 체크 실패 (무시하고 진행): {}", e);
            }
        }

        let url = format!("{}/api/login", self.config.base_url);
        
        // ... (rest of the login logic)

        // ✅ Security: URL은 내부 로그에만 기록, 에러 메시지에는 노출하지 않음
        info!("🔐 로그인 시도: {}", url);

        let payload = serde_json::json!({
            "username": username,
            "password": password
        });

        let response = self
            .client
            .post(&url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| {
                // ✅ Security: 네트워크 오류에서 URL 제거
                error!("❌ 로그인 요청 실패 (내부): {}", e);
                "서버 연결에 실패했습니다. 네트워크 상태를 확인해주세요.".to_string()
            })?;

        let status = response.status();
        let response_text = response
            .text()
            .await
            .map_err(|e| {
                error!("❌ 응답 읽기 실패 (내부): {}", e);
                "서버 응답을 읽는데 실패했습니다.".to_string()
            })?;

        // ✅ Security: 응답 내용은 내부 로그에만 기록
        info!("📥 로그인 응답 (HTTP {}): {}", status, response_text);

        if !status.is_success() {
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err("아이디 또는 비밀번호가 올바르지 않습니다.".to_string());
            } else if status.as_u16() >= 500 {
                return Err("서버에 일시적인 문제가 발생했습니다.".to_string());
            }
            // ✅ Security: HTTP 상태 코드만 표시, URL 없음
            return Err("로그인에 실패했습니다. 잠시 후 다시 시도해주세요.".to_string());
        }

        let mut login_response: LoginApiResponse = serde_json::from_str(&response_text)
            .map_err(|e| {
                // ✅ Security: 파싱 오류 상세 내용은 내부 로그에만 기록
                error!("❌ 로그인 응답 파싱 실패 (내부): {} - Body: {}", e, response_text);
                "서버 응답 처리 중 오류가 발생했습니다.".to_string()
            })?;

        login_response.success = login_response.token.is_some();

        info!("✅ 로그인 응답: success={}", login_response.success);

        Ok(login_response)
    }

    /// 파일 다운로드
    pub async fn download_file(&self, download_url: &str) -> Result<Vec<u8>, String> {
        let url = if download_url.starts_with("http") {
            download_url.to_string()
        } else {
            format!("{}{}", self.config.base_url, download_url)
        };

        info!("📡 파일 다운로드 시작: {}", url);

        let mut request = self.client.get(&url);

        if let Some(token) = &self.config.auth_token {
            request = request.header("Authorization", format!("Bearer {}", token));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("다운로드 요청 실패: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("다운로드 실패: HTTP {}", response.status()));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("데이터 읽기 실패: {}", e))?;

        info!("✅ 파일 다운로드 완료: {} bytes", bytes.len());
        Ok(bytes.to_vec())
    }
}

// ==================== 추가 응답 구조체 ====================

/// 토큰 검증 응답
#[derive(Debug, Clone)]
pub struct TokenValidationResponse {
    pub valid: bool,
    pub expired: bool,
    pub remaining_seconds: i64,
}

/// 토큰 검증 API 응답 (서버에서 받는 형식)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenValidationApiResponse {
    valid: bool,
    #[serde(default)]
    expired: Option<bool>,
    #[serde(default)]
    remaining_seconds: Option<i64>,
}

/// 로그인 API 응답
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginApiResponse {
    #[serde(default)]
    pub success: bool,
    pub token: Option<String>,
    #[serde(default)]
    pub seconds: Option<i64>,
    #[serde(default)]
    pub file: Option<serde_json::Value>,
    #[serde(default)]
    pub url_list: Option<Vec<String>>,
    #[serde(default)]
    pub notice: Option<NoticeApiResponse>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

/// 공지사항 API 응답
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeApiResponse {
    pub id: i64,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub reg_date: Option<String>,
    #[serde(default)]
    pub reg_user: Option<String>,
}

/// 버전 체크 API 응답
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCheckResponse {
    /// 서버 필수 버전
    pub required_version: String,
    /// 현재 클라이언트 버전 호환 여부
    pub compatible: bool,
    /// 업데이트 필요 메시지
    pub message: Option<String>,
    /// 다운로드 URL (업데이트 필요 시)
    pub download_url: Option<String>,
    /// 파일 이름 (확장자 판별용)
    pub file_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_game_round_serialization() {
        let round = GameRound {
            winner: "Banker".to_string(),
            player_score: Some(5),
            banker_score: Some(7),
            natural: Some(false),
            player_pair: None,
            banker_pair: None,
        };

        let json = serde_json::to_string(&round).unwrap();
        assert!(json.contains("\"winner\":\"Banker\""));
        assert!(json.contains("\"playerScore\":5"));
    }

    #[test]
    fn test_v2_request_serialization() {
        let request = V2PredictionRequest {
            room_id: "test-room".to_string(),
            room_name: "테스트 방".to_string(),
            game_id: None,
            game_number: None,
            history: vec![GameRound {
                winner: "Banker".to_string(),
                player_score: Some(5),
                banker_score: Some(7),
                natural: None,
                player_pair: None,
                banker_pair: None,
            }],
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
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("\"roomId\":\"test-room\""));
        assert!(json.contains("\"roomName\":\"테스트 방\""));
        // Optional fields should not be present when None
        assert!(!json.contains("\"gameId\""));
    }

    /// Lane R3: `from_shared`는 Arc에서 소유 Vec로 단 1회 경계 복제만 수행한다.
    /// 호출자가 Arc의 마지막 보유자인 경우 복제 없이 inner Vec이 이동되어야 한다.
    #[test]
    fn test_from_shared_unique_arc_moves_vec_without_clone() {
        let history = Arc::new(vec![GameRound {
            winner: "Banker".to_string(),
            player_score: Some(5),
            banker_score: Some(7),
            natural: None,
            player_pair: None,
            banker_pair: None,
        }]);
        // Arc refcount == 1 이므로 try_unwrap 성공 → Vec 복제 없이 move
        assert_eq!(Arc::strong_count(&history), 1);

        let request = V2PredictionRequest::from_shared(
            "rid".to_string(),
            "rname".to_string(),
            None,
            None,
            history,
            None,
            None,
            None,
            None,
        );
        assert_eq!(request.history.len(), 1);
        assert_eq!(request.history[0].winner, "Banker");
    }

    /// Lane R3: 공유 중인 Arc(refcount > 1)일 때는 Vec을 1회 복제한다.
    /// 원본 Arc는 변하지 않고 유지되어야 한다 (snapshot 불변성).
    #[test]
    fn test_from_shared_shared_arc_clones_vec_once() {
        let history = Arc::new(vec![
            GameRound {
                winner: "Player".to_string(),
                player_score: None,
                banker_score: None,
                natural: None,
                player_pair: None,
                banker_pair: None,
            };
            100
        ]);
        let retained = Arc::clone(&history);
        assert_eq!(Arc::strong_count(&history), 2);

        let request = V2PredictionRequest::from_shared(
            "rid".to_string(),
            "rname".to_string(),
            None,
            None,
            history,
            None,
            None,
            None,
            None,
        );
        assert_eq!(request.history.len(), 100);
        // 원본 Arc(retained)는 여전히 100개를 보유
        assert_eq!(retained.len(), 100);
        // from_shared 호출 후 retained만 남아 refcount == 1
        assert_eq!(Arc::strong_count(&retained), 1);
    }
}
