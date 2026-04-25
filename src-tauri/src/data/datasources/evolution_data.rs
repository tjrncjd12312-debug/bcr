//! Evolution 게임 데이터 수집 및 관리
//!
//! WebSocket에서 수신한 베팅, 카드, 슈 상태 데이터를 저장하고
//! V2 API 호출 시 사용할 수 있도록 관리

use crate::data::datasources::prediction_api::{
    BettingStats, CardInfo, GameRound, ShoeStats, V2PredictionRequest,
};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{debug, info};

// ==================== 방별 게임 데이터 ====================

/// 방별 게임 상태
///
/// Lane R3 (perf-plan): `history` 필드는 `Arc<Vec<GameRound>>`로 보관됩니다.
/// Evolution WebSocket hot path에서 메시지당 발생하던 Vec 전체 복제를
/// refcount 증가(O(1))로 대체하기 위해 *internal storage* 레벨에서 Arc로
/// 감쌌습니다. 이 Arc는 **불변(snapshot) 취급**이며, 히스토리 갱신은 항상
/// 새 `Arc::new(Vec<..>)`으로 교체합니다(`Arc::make_mut` 금지 — 공유 중인
/// 스냅샷의 내부를 변경하면 이전 consumer가 보는 데이터가 오염됩니다).
/// 공개 Tauri 커맨드 시그니처와 `V2PredictionRequest`의 필드 타입은
/// 동결되어 있으므로, JSON 직렬화 시점에 단 1회 `(*arc).clone()`으로
/// 소유 Vec을 생성합니다(boundary clone; 허용).
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
    /// 히스토리 (V2 형식, 공유 스냅샷).
    /// R3: `Arc<Vec<GameRound>>`로 저장해 핫패스 복제를 제거.
    pub history: Arc<Vec<GameRound>>,
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
    ///
    /// R3: `self.history`는 `Arc<Vec<GameRound>>`이며, 공개 `V2PredictionRequest`
    /// 의 `history: Vec<GameRound>` 필드(동결)에 맞추기 위해 `from_shared` 경로로
    /// 위임한다. 내부적으로 Arc를 1회만 소유 Vec으로 풀어낸다(boundary clone).
    pub fn to_v2_request(&self) -> V2PredictionRequest {
        V2PredictionRequest::from_shared(
            self.room_id.clone(),
            self.room_name.clone(),
            self.game_id.clone(),
            self.game_number.clone(),
            Arc::clone(&self.history),
            self.last_game_cards.clone(),
            self.betting_stats.clone(),
            self.shoe_stats.clone(),
            None,
        )
    }

    /// V2 예측 요청 생성 (베팅 타입 포함)
    pub fn to_v2_request_with_bet_type(&self, bet_type: Option<String>) -> V2PredictionRequest {
        V2PredictionRequest::from_shared(
            self.room_id.clone(),
            self.room_name.clone(),
            self.game_id.clone(),
            self.game_number.clone(),
            Arc::clone(&self.history),
            self.last_game_cards.clone(),
            self.betting_stats.clone(),
            self.shoe_stats.clone(),
            bet_type,
        )
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
    ///
    /// R3: 기존 공유 스냅샷(Arc)을 새 빈 Arc로 교체한다. 이전 Arc를
    /// 참조 중인 consumer가 있다면 그들은 이전 스냅샷을 계속 보고,
    /// 새 소비자는 빈 히스토리를 본다(immutable snapshot semantics).
    pub fn reset_for_new_shoe(&mut self) {
        self.history = Arc::new(Vec::new());
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
            // R3: 새 Vec을 빌드해 Arc로 감싼다. 이전 Arc는 마지막 consumer가
            // drop하면 자연 해제된다(refcount). 이전 스냅샷을 잡고 있던 소비자가
            // 있다면 계속 이전 데이터를 본다 — immutable snapshot 계약.
            let new_history: Vec<GameRound> =
                history.iter().filter_map(parse_game_round).collect();
            let new_len = new_history.len();
            room.history = Arc::new(new_history);

            // 슈 체인지 감지
            if new_len < prev_len && prev_len > 10 {
                info!(
                    "🔄 슈 체인지 감지: {} ({}게임 → {}게임)",
                    room.room_name, prev_len, new_len
                );
                shoe_changed = true;
            }

            room.prev_history_length = new_len;
            debug!(
                "📊 {} 히스토리 업데이트: {}게임",
                room.room_name, new_len
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
        // R3: history는 Arc<Vec<GameRound>> — 초기에는 빈 Arc.
        room.history = Arc::new(vec![GameRound {
            winner: "Banker".to_string(),
            player_score: Some(5),
            banker_score: Some(7),
            natural: None,
            player_pair: None,
            banker_pair: None,
        }]);

        let request = room.to_v2_request();
        assert_eq!(request.room_id, "test-room");
        assert_eq!(request.history.len(), 1);
    }

    #[test]
    fn test_shoe_change_detection() {
        let mut room = RoomGameData::new("test".to_string(), "테스트".to_string());

        // 히스토리 추가 (Arc로 새로 생성해 할당)
        let full: Vec<GameRound> = (0..20)
            .map(|_| GameRound {
                winner: "Banker".to_string(),
                player_score: None,
                banker_score: None,
                natural: None,
                player_pair: None,
                banker_pair: None,
            })
            .collect();
        room.history = Arc::new(full);
        room.prev_history_length = 20;

        // 히스토리 감소 (새 슈) — R3: 새 Arc로 교체
        let truncated = room.history[..5].to_vec();
        room.history = Arc::new(truncated);

        assert!(room.detect_shoe_change());
    }

    /// R3: 저장된 history를 두 번 읽었을 때 같은 Arc(스냅샷)을 가리키는지 검증.
    /// `Arc::ptr_eq`가 true → Vec 복제 없이 refcount 증가로 공유됨을 증명.
    #[test]
    fn test_history_storage_is_shared_arc_snapshot() {
        let manager = EvolutionDataManager::new();
        let table_id = "arc-test-room";

        // 100개 이상 히스토리를 주입
        let history_json: Vec<serde_json::Value> = (0..100)
            .map(|i| {
                serde_json::json!({
                    "winner": if i % 2 == 0 { "Banker" } else { "Player" },
                    "playerScore": 5,
                    "bankerScore": 7
                })
            })
            .collect();
        let payload = serde_json::json!({
            "stats": {"gameCount": 100, "playerWins": 50, "bankerWins": 50},
            "history_v2": history_json
        });
        manager.handle_shoe_state(table_id, &payload);

        // 두 번 읽기 — get_room_data는 RoomGameData를 clone 하지만
        // `history`는 Arc이므로 refcount만 증가해야 한다.
        let snapshot_a = manager.get_room_data(table_id).expect("room exists");
        let snapshot_b = manager.get_room_data(table_id).expect("room exists");

        assert_eq!(snapshot_a.history.len(), 100);
        assert!(
            Arc::ptr_eq(&snapshot_a.history, &snapshot_b.history),
            "두 스냅샷은 동일 Arc를 공유해야 함 (Vec 복제 없음)"
        );

        // 새 히스토리를 주입하면 이전 스냅샷은 여전히 이전 데이터를 본다(불변 snapshot).
        let new_history_json: Vec<serde_json::Value> = (0..50)
            .map(|_| serde_json::json!({"winner": "Tie"}))
            .collect();
        let payload2 = serde_json::json!({
            "history_v2": new_history_json
        });
        manager.handle_shoe_state(table_id, &payload2);

        // 이전 스냅샷은 원본(100개) 유지, 새 스냅샷은 50개.
        assert_eq!(snapshot_a.history.len(), 100);
        assert_eq!(snapshot_b.history.len(), 100);
        let snapshot_c = manager.get_room_data(table_id).expect("room exists");
        assert_eq!(snapshot_c.history.len(), 50);

        // 이전 Arc와 새 Arc는 서로 다른 인스턴스여야 한다.
        assert!(
            !Arc::ptr_eq(&snapshot_a.history, &snapshot_c.history),
            "새 히스토리는 새 Arc여야 함"
        );
    }
}
