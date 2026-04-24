//! Evolution 게임 데이터 수집 및 관리
//!
//! WebSocket에서 수신한 베팅, 카드, 슈 상태 데이터를 저장하고
//! V2 API 호출 시 사용할 수 있도록 관리

use crate::data::datasources::prediction_api::{
    BettingStats, CardInfo, GameRound, ShoeStats, V2PredictionRequest,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use tracing::{debug, info};

// ==================== 방별 게임 데이터 ====================

/// 방별 게임 상태
#[derive(Debug, Clone, Default)]
pub struct RoomGameData {
    /// 방 ID
    pub room_id: String,
    /// 방 이름
    pub room_name: String,
    /// 게임 ID (현재)
    pub game_id: Option<String>,
    /// 게임 번호
    pub game_number: Option<String>,
    /// 히스토리 (V2 형식)
    pub history: Vec<GameRound>,
    /// 슈 상태
    pub shoe_stats: Option<ShoeStats>,
    /// 현재 베팅 쏠림
    pub betting_stats: Option<BettingStats>,
    /// 마지막 게임 카드 정보
    pub last_game_cards: Option<CardInfo>,
    /// 슈 카드 아웃
    pub shoe_cards_out: Option<i32>,
    /// 이전 히스토리 길이 (슈 체인지 감지용)
    pub prev_history_length: usize,
}

impl RoomGameData {
    /// 새 방 데이터 생성
    pub fn new(room_id: String, room_name: String) -> Self {
        Self {
            room_id,
            room_name,
            ..Default::default()
        }
    }

    /// V2 예측 요청 생성
    pub fn to_v2_request(&self) -> V2PredictionRequest {
        V2PredictionRequest {
            room_id: self.room_id.clone(),
            room_name: self.room_name.clone(),
            game_id: self.game_id.clone(),
            game_number: self.game_number.clone(),
            history: self.history.clone(),
            last_game_cards: self.last_game_cards.clone(),
            betting_stats: self.betting_stats.clone(),
            shoe_stats: self.shoe_stats.clone(),
            bet_type: None, // 커맨드에서 설정
            martin_level: None, // 커맨드에서 설정
            min_confidence: None, // 커맨드에서 설정
            auto_mode: None, // 커맨드에서 설정
            // 🆕 v3.7.0: 사용자 추적 (커맨드에서 설정)
            user_id: None,
            username: None,
            session_id: None,
            current_balance: None,
            bet_amount: None,
            client_type: None,
        }
    }

    /// V2 예측 요청 생성 (베팅 타입 포함)
    pub fn to_v2_request_with_bet_type(&self, bet_type: Option<String>) -> V2PredictionRequest {
        V2PredictionRequest {
            room_id: self.room_id.clone(),
            room_name: self.room_name.clone(),
            game_id: self.game_id.clone(),
            game_number: self.game_number.clone(),
            history: self.history.clone(),
            last_game_cards: self.last_game_cards.clone(),
            betting_stats: self.betting_stats.clone(),
            shoe_stats: self.shoe_stats.clone(),
            bet_type,
            martin_level: None, // 커맨드에서 설정
            min_confidence: None, // 커맨드에서 설정
            auto_mode: None, // 커맨드에서 설정
            // 🆕 v3.7.0: 사용자 추적 (커맨드에서 설정)
            user_id: None,
            username: None,
            session_id: None,
            current_balance: None,
            bet_amount: None,
            client_type: None,
        }
    }

    /// 슈 체인지 감지
    pub fn detect_shoe_change(&mut self) -> bool {
        let current_len = self.history.len();
        let prev_len = self.prev_history_length;

        // 히스토리가 줄어들면 새 슈
        if current_len < prev_len && prev_len > 10 {
            info!(
                "🔄 슈 체인지 감지: {} (이전 {}게임 → 현재 {}게임)",
                self.room_name, prev_len, current_len
            );
            self.prev_history_length = current_len;
            return true;
        }

        self.prev_history_length = current_len;
        false
    }

    /// 데이터 리셋 (새 슈)
    pub fn reset_for_new_shoe(&mut self) {
        self.history.clear();
        self.shoe_stats = None;
        self.last_game_cards = None;
        self.betting_stats = None;
        self.prev_history_length = 0;
        info!("🔄 {} 슈 데이터 리셋", self.room_name);
    }
}

// ==================== Evolution 데이터 매니저 ====================

/// Evolution 데이터 매니저
/// 모든 방의 게임 데이터를 관리
pub struct EvolutionDataManager {
    /// 방별 게임 데이터
    rooms: RwLock<HashMap<String, RoomGameData>>,
}

impl EvolutionDataManager {
    /// 새 매니저 생성
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
        }
    }

    /// 방 데이터 가져오기 (없으면 생성)
    pub fn get_or_create_room(&self, room_id: &str, room_name: &str) -> RoomGameData {
        let mut rooms = self.rooms.write();
        rooms
            .entry(room_id.to_string())
            .or_insert_with(|| RoomGameData::new(room_id.to_string(), room_name.to_string()))
            .clone()
    }

    /// 방 데이터 업데이트
    pub fn update_room(&self, room_id: &str, data: RoomGameData) {
        let mut rooms = self.rooms.write();
        rooms.insert(room_id.to_string(), data);
    }

    /// V2 예측 요청 생성
    pub fn get_v2_request(&self, room_id: &str) -> Option<V2PredictionRequest> {
        let rooms = self.rooms.read();
        rooms.get(room_id).map(|r| r.to_v2_request())
    }

    /// V2 예측 요청 생성 (베팅 타입 포함)
    pub fn get_v2_request_with_bet_type(&self, room_id: &str, bet_type: Option<String>) -> Option<V2PredictionRequest> {
        let rooms = self.rooms.read();
        rooms.get(room_id).map(|r| r.to_v2_request_with_bet_type(bet_type))
    }

    // ==================== Evolution WebSocket 메시지 처리 ====================

    /// baccarat.encodedShoeState 메시지 처리
    /// 히스토리 및 슈 통계 업데이트
    pub fn handle_shoe_state(&self, table_id: &str, data: &serde_json::Value) -> bool {
        let mut shoe_changed = false;

        // stats 파싱
        let stats = data.get("stats");
        let history_v2 = data.get("history_v2").and_then(|v| v.as_array());

        let mut rooms = self.rooms.write();
        let room = rooms
            .entry(table_id.to_string())
            .or_insert_with(|| RoomGameData::new(table_id.to_string(), table_id.to_string()));

        // 슈 통계 업데이트
        if let Some(stats) = stats {
            room.shoe_stats = Some(ShoeStats {
                game_count: stats
                    .get("gameCount")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                player_wins: stats
                    .get("playerWins")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                banker_wins: stats
                    .get("bankerWins")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                ties: stats.get("ties").and_then(|v| v.as_i64()).map(|v| v as i32),
                player_pairs: stats
                    .get("playerPairs")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                banker_pairs: stats
                    .get("bankerPairs")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                cards_out: room.shoe_cards_out,
            });
        }

        // 히스토리 업데이트
        if let Some(history) = history_v2 {
            let prev_len = room.history.len();
            room.history = history.iter().filter_map(|r| parse_game_round(r)).collect();

            // 슈 체인지 감지
            if room.history.len() < prev_len && prev_len > 10 {
                info!(
                    "🔄 슈 체인지 감지: {} ({}게임 → {}게임)",
                    room.room_name,
                    prev_len,
                    room.history.len()
                );
                shoe_changed = true;
            }

            room.prev_history_length = room.history.len();
            debug!(
                "📊 {} 히스토리 업데이트: {}게임",
                room.room_name,
                room.history.len()
            );
        }

        shoe_changed
    }

    /// baccarat.tableState 메시지 처리
    /// 방 이름, 게임 ID, 슈 카드 아웃 등 업데이트
    pub fn handle_table_state(&self, table_id: &str, data: &serde_json::Value) {
        let table_name = data.get("tableName").and_then(|v| v.as_str());
        let shoe_cards_out = data
            .get("shoeCardsOut")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);

        let current_game = data.get("currentGame");
        let game_id = current_game
            .and_then(|g| g.get("gameId"))
            .and_then(|v| v.as_str());
        let game_number = current_game
            .and_then(|g| g.get("gameNumber"))
            .and_then(|v| v.as_str());

        let mut rooms = self.rooms.write();
        let room = rooms
            .entry(table_id.to_string())
            .or_insert_with(|| RoomGameData::new(table_id.to_string(), table_id.to_string()));

        if let Some(name) = table_name {
            room.room_name = name.to_string();
        }
        if let Some(id) = game_id {
            room.game_id = Some(id.to_string());
        }
        if let Some(num) = game_number {
            room.game_number = Some(num.to_string());
        }
        if let Some(cards) = shoe_cards_out {
            room.shoe_cards_out = Some(cards);
            // shoe_stats에도 업데이트
            if let Some(ref mut stats) = room.shoe_stats {
                stats.cards_out = Some(cards);
            }
        }
    }

    /// baccarat.bettingStats 메시지 처리
    /// 베팅 쏠림 업데이트
    pub fn handle_betting_stats(&self, table_id: &str, data: &serde_json::Value) {
        let stats = data.get("stats");
        let watchers = data
            .get("watchers")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);
        let bettors = data
            .get("bettors")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);

        if let Some(stats) = stats {
            let player = stats.get("Player");
            let banker = stats.get("Banker");
            let tie = stats.get("Tie");

            let betting_stats = BettingStats {
                player_percentage: player
                    .and_then(|p| p.get("percentage"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                banker_percentage: banker
                    .and_then(|p| p.get("percentage"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                tie_percentage: tie
                    .and_then(|p| p.get("percentage"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                player_amount: player
                    .and_then(|p| p.get("amount"))
                    .and_then(|v| v.as_f64()),
                banker_amount: banker
                    .and_then(|p| p.get("amount"))
                    .and_then(|v| v.as_f64()),
                tie_amount: tie.and_then(|p| p.get("amount")).and_then(|v| v.as_f64()),
                player_players: player
                    .and_then(|p| p.get("players"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                banker_players: banker
                    .and_then(|p| p.get("players"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                tie_players: tie
                    .and_then(|p| p.get("players"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32),
                total_bettors: bettors,
                watchers,
            };

            let mut rooms = self.rooms.write();
            if let Some(room) = rooms.get_mut(table_id) {
                room.betting_stats = Some(betting_stats);
            }
        }
    }

    /// baccarat.gameState (Finished) 메시지 처리
    /// 마지막 게임 카드 정보 업데이트
    pub fn handle_game_state(&self, table_id: &str, data: &serde_json::Value) {
        let dealing = data.get("dealing").and_then(|v| v.as_str());

        // Finished 상태일 때만 카드 정보 저장
        if dealing != Some("Finished") {
            return;
        }

        let game_data = data.get("gameData");
        if let Some(gd) = game_data {
            let player_hand = gd.get("playerHand");
            let banker_hand = gd.get("bankerHand");

            let player_cards = player_hand
                .and_then(|h| h.get("cards"))
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let banker_cards = banker_hand
                .and_then(|h| h.get("cards"))
                .and_then(|c| c.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let player_score = player_hand
                .and_then(|h| h.get("score"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);

            let banker_score = banker_hand
                .and_then(|h| h.get("score"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);

            if !player_cards.is_empty() || !banker_cards.is_empty() {
                let card_info = CardInfo {
                    player_cards,
                    banker_cards,
                    player_score,
                    banker_score,
                };

                let mut rooms = self.rooms.write();
                if let Some(room) = rooms.get_mut(table_id) {
                    room.last_game_cards = Some(card_info);
                    debug!("🃏 {} 카드 정보 저장됨", room.room_name);
                }
            }
        }
    }

    /// baccarat.resolved 메시지 처리
    /// 게임 결과 확정 - 결과 보고 트리거
    pub fn handle_resolved(&self, table_id: &str, data: &serde_json::Value) -> Option<String> {
        let result = data.get("result");
        let winner = result
            .and_then(|r| r.get("winner"))
            .and_then(|v| v.as_str());

        if let Some(winner) = winner {
            info!("🎲 {} 게임 결과: {}", table_id, winner);
            return Some(winner.to_string());
        }

        None
    }

    /// 방 목록 조회
    pub fn get_room_ids(&self) -> Vec<String> {
        self.rooms.read().keys().cloned().collect()
    }

    /// 방 데이터 조회
    pub fn get_room_data(&self, room_id: &str) -> Option<RoomGameData> {
        self.rooms.read().get(room_id).cloned()
    }

    /// 슈 체인지 알림
    pub fn notify_shoe_change(&self, room_id: &str) {
        let mut rooms = self.rooms.write();
        if let Some(room) = rooms.get_mut(room_id) {
            room.reset_for_new_shoe();
        }
    }
}

impl Default for EvolutionDataManager {
    fn default() -> Self {
        Self::new()
    }
}

// ==================== 유틸리티 함수 ====================

/// Evolution history_v2 엔트리를 GameRound로 변환
fn parse_game_round(value: &serde_json::Value) -> Option<GameRound> {
    let winner = value.get("winner").and_then(|v| v.as_str())?;

    Some(GameRound {
        winner: winner.to_string(),
        player_score: value
            .get("playerScore")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32),
        banker_score: value
            .get("bankerScore")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32),
        natural: value.get("natural").and_then(|v| v.as_bool()),
        player_pair: value.get("playerPair").and_then(|v| v.as_bool()),
        banker_pair: value.get("bankerPair").and_then(|v| v.as_bool()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_game_round() {
        let json = serde_json::json!({
            "winner": "Banker",
            "playerScore": 5,
            "bankerScore": 7,
            "natural": false,
            "playerPair": true
        });

        let round = parse_game_round(&json).unwrap();
        assert_eq!(round.winner, "Banker");
        assert_eq!(round.player_score, Some(5));
        assert_eq!(round.banker_score, Some(7));
        assert_eq!(round.player_pair, Some(true));
    }

    #[test]
    fn test_room_game_data_to_v2_request() {
        let mut room = RoomGameData::new("test-room".to_string(), "테스트방".to_string());
        room.history.push(GameRound {
            winner: "Banker".to_string(),
            player_score: Some(5),
            banker_score: Some(7),
            natural: None,
            player_pair: None,
            banker_pair: None,
        });

        let request = room.to_v2_request();
        assert_eq!(request.room_id, "test-room");
        assert_eq!(request.history.len(), 1);
    }

    #[test]
    fn test_shoe_change_detection() {
        let mut room = RoomGameData::new("test".to_string(), "테스트".to_string());

        // 히스토리 추가
        for _ in 0..20 {
            room.history.push(GameRound {
                winner: "Banker".to_string(),
                player_score: None,
                banker_score: None,
                natural: None,
                player_pair: None,
                banker_pair: None,
            });
        }
        room.prev_history_length = 20;

        // 히스토리 감소 (새 슈)
        room.history = room.history[..5].to_vec();

        assert!(room.detect_shoe_change());
    }
}
