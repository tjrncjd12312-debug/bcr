//! Prediction Entity - V2 예측 요청/응답
//!
//! 클린 아키텍처: 도메인 엔티티 (순수 데이터 구조)

use super::room::GameResult;
use serde::{Deserialize, Serialize};

// ==================== 예측 요청 ====================

/// 예측 요청 (V2)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionRequest {
    /// 방 ID
    pub room_id: String,
    /// 방 이름
    pub room_name: String,
    /// 게임 히스토리
    pub history: Vec<GameResult>,
}

impl PredictionRequest {
    /// 새 예측 요청 생성
    pub fn new(room_id: String, room_name: String, history: Vec<GameResult>) -> Self {
        Self {
            room_id,
            room_name,
            history,
        }
    }
}

// ==================== 예측 응답 ====================

/// 예측 응답 (V2)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionResponse {
    /// 방 ID
    pub room_id: String,
    /// 예측 결과 (None = Skip)
    pub prediction: Option<GameResult>,
    /// 신뢰도 (0.0 - 1.0)
    pub confidence: f64,
    /// 예측 근거 (한글)
    pub reasoning: String,
    /// 패턴 정보
    pub pattern_info: Option<String>,
    /// 스킵 여부
    pub is_skip: bool,
}

impl PredictionResponse {
    /// 유효한 예측인지 확인
    pub fn is_valid(&self) -> bool {
        !self.is_skip && self.prediction.is_some()
    }

    /// 스킵 응답 생성
    pub fn skip(room_id: String, reason: String) -> Self {
        Self {
            room_id,
            prediction: None,
            confidence: 0.0,
            reasoning: reason,
            pattern_info: None,
            is_skip: true,
        }
    }
}

// ==================== 방별 예측 상태 ====================

/// 방별 예측 상태 (다중 방 모드용)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomPrediction {
    /// 방 ID
    pub room_id: String,
    /// 방 이름
    pub room_name: String,
    /// 현재 히스토리
    pub current_history: Vec<GameResult>,
    /// 현재 예측 응답
    pub prediction: Option<PredictionResponse>,
    /// 예측 상태
    pub status: PredictionStatus,
    /// 마지막 예측
    pub last_prediction: Option<GameResult>,
    /// 마지막 예측 정확도
    pub last_prediction_correct: Option<bool>,
    /// 연속 승리 수
    pub consecutive_wins: u32,
    /// 연속 패배 수
    pub consecutive_losses: u32,
}

impl RoomPrediction {
    /// 새 방 예측 상태 생성
    pub fn new(room_id: String, room_name: String) -> Self {
        Self {
            room_id,
            room_name,
            current_history: Vec::new(),
            prediction: None,
            status: PredictionStatus::Pending,
            last_prediction: None,
            last_prediction_correct: None,
            consecutive_wins: 0,
            consecutive_losses: 0,
        }
    }

    /// 예측 결과 기록
    pub fn record_result(&mut self, actual_result: GameResult) {
        if let Some(pred) = &self.last_prediction {
            // Tie는 무승부 처리 (예측 성공/실패 계산 안함)
            if actual_result == GameResult::Tie {
                self.last_prediction_correct = None;
                return;
            }

            let correct = *pred == actual_result;
            self.last_prediction_correct = Some(correct);

            if correct {
                self.consecutive_wins += 1;
                self.consecutive_losses = 0;
            } else {
                self.consecutive_losses += 1;
                self.consecutive_wins = 0;
            }
        }
    }

    /// 상태 리셋
    pub fn reset(&mut self) {
        self.current_history.clear();
        self.prediction = None;
        self.status = PredictionStatus::Pending;
        self.last_prediction = None;
        self.last_prediction_correct = None;
        self.consecutive_wins = 0;
        self.consecutive_losses = 0;
    }
}

// ==================== 예측 상태 ====================

/// 예측 상태
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum PredictionStatus {
    /// 대기 중
    #[default]
    Pending,
    /// 예측 완료
    Ready,
    /// 스킵
    Skip,
    /// 오류
    Error(String),
}

// ==================== 예측 결과 추적 ====================

/// 예측 결과 추적
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PredictionTracking {
    /// 총 예측 수
    pub total_predictions: u32,
    /// 정확한 예측 수
    pub correct_predictions: u32,
    /// 틀린 예측 수
    pub incorrect_predictions: u32,
    /// 스킵 수
    pub skipped: u32,
    /// 현재 연승
    pub current_win_streak: u32,
    /// 현재 연패
    pub current_loss_streak: u32,
    /// 최대 연승
    pub max_win_streak: u32,
    /// 최대 연패
    pub max_loss_streak: u32,
}

impl PredictionTracking {
    /// 예측 결과 기록
    pub fn record(&mut self, predicted: Option<GameResult>, actual: GameResult) {
        // 예측이 없으면 (스킵) 카운트 안함
        let Some(pred) = predicted else {
            self.skipped += 1;
            return;
        };

        // Tie 결과는 무승부 처리
        if actual == GameResult::Tie {
            return;
        }

        self.total_predictions += 1;

        if pred == actual {
            self.correct_predictions += 1;
            self.current_win_streak += 1;
            self.current_loss_streak = 0;
            self.max_win_streak = self.max_win_streak.max(self.current_win_streak);
        } else {
            self.incorrect_predictions += 1;
            self.current_loss_streak += 1;
            self.current_win_streak = 0;
            self.max_loss_streak = self.max_loss_streak.max(self.current_loss_streak);
        }
    }

    /// 승률 계산
    pub fn win_rate(&self) -> f64 {
        if self.total_predictions == 0 {
            return 0.0;
        }
        self.correct_predictions as f64 / self.total_predictions as f64
    }

    /// 리셋
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prediction_request() {
        let history = vec![GameResult::Banker, GameResult::Player, GameResult::Banker];
        let request = PredictionRequest::new(
            "abc123".to_string(),
            "스피드 A".to_string(),
            history.clone(),
        );

        assert_eq!(request.room_id, "abc123");
        assert_eq!(request.history.len(), 3);
    }

    #[test]
    fn test_prediction_response() {
        let response = PredictionResponse {
            room_id: "abc123".to_string(),
            prediction: Some(GameResult::Banker),
            confidence: 0.75,
            reasoning: "패턴 분석 기반".to_string(),
            pattern_info: None,
            is_skip: false,
        };

        assert!(response.is_valid());
        assert!(!response.is_skip);
    }

    #[test]
    fn test_skip_response() {
        let response = PredictionResponse::skip("abc123".to_string(), "히스토리 부족".to_string());

        assert!(!response.is_valid());
        assert!(response.is_skip);
    }

    #[test]
    fn test_prediction_tracking() {
        let mut tracking = PredictionTracking::default();

        // 예측 성공
        tracking.record(Some(GameResult::Banker), GameResult::Banker);
        assert_eq!(tracking.correct_predictions, 1);
        assert_eq!(tracking.current_win_streak, 1);

        // 예측 실패
        tracking.record(Some(GameResult::Banker), GameResult::Player);
        assert_eq!(tracking.incorrect_predictions, 1);
        assert_eq!(tracking.current_loss_streak, 1);
        assert_eq!(tracking.current_win_streak, 0);

        // 연속 성공
        tracking.record(Some(GameResult::Player), GameResult::Player);
        tracking.record(Some(GameResult::Banker), GameResult::Banker);
        assert_eq!(tracking.current_win_streak, 2);
        assert_eq!(tracking.max_win_streak, 2);

        // 승률 확인
        assert!((tracking.win_rate() - 0.75).abs() < 0.01); // 3/4 = 0.75
    }

    #[test]
    fn test_room_prediction_record_result() {
        let mut room = RoomPrediction::new("room1".to_string(), "테스트방".to_string());
        room.last_prediction = Some(GameResult::Banker);

        room.record_result(GameResult::Banker);
        assert_eq!(room.last_prediction_correct, Some(true));
        assert_eq!(room.consecutive_wins, 1);

        room.last_prediction = Some(GameResult::Player);
        room.record_result(GameResult::Banker);
        assert_eq!(room.last_prediction_correct, Some(false));
        assert_eq!(room.consecutive_losses, 1);
        assert_eq!(room.consecutive_wins, 0);
    }
}
