//! Game Logic Service
//!
//! Core business rules for game state management
//! Migrated from Android: GameLogic.java

use crate::domain::entities::{GameStats, Room};

/// Game logic service (stateless business rules)
pub struct GameLogicService;

impl GameLogicService {
    /// Calculate room score for filtering/sorting
    /// Higher score = better room for prediction
    pub fn calculate_room_score(room: &Room) -> i32 {
        let history = room.get_history_colors();
        if history.len() < 10 {
            return 0;
        }

        let mut score = 50;
        let stats = GameStats::from_history(&room.history.iter().copied().collect::<Vec<_>>());

        // 1. Streak analysis
        let (_streak_type, streak_len) = room.current_streak();
        if streak_len >= 5 {
            score += 15;
        } else if streak_len >= 3 {
            score += 10;
        } else if streak_len == 1 {
            score -= 5;
        }

        // 2. Balance check
        let banker_rate = stats.banker_win_rate();
        let deviation = (banker_rate - 0.459).abs();

        if deviation < 0.05 {
            score -= 10;
        } else if deviation > 0.15 {
            score += 15;
        } else if deviation > 0.10 {
            score += 5;
        }

        // 3. Round count
        let round = history.len();
        if (20..=50).contains(&round) {
            score += 10;
        } else if round > 60 {
            score -= 20;
        }

        // 4. Recent activity
        if history.len() >= 10 {
            let recent: Vec<_> = history.iter().rev().take(10).collect();
            let recent_banker = recent.iter().filter(|&c| *c == "Red").count();
            let recent_player = recent.iter().filter(|&c| *c == "Blue").count();

            if recent_banker >= 7 || recent_player >= 7 {
                score += 10;
            }
        }

        score.clamp(0, 100)
    }

    /// Check if should change room
    pub fn should_change_room(win_count: u32, win_threshold: u32, round: usize) -> bool {
        if win_threshold > 0 && win_count >= win_threshold {
            return true;
        }
        round >= 60
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::entities::GameResult;

    #[test]
    fn test_room_score() {
        let mut room = Room::new("test".to_string(), "Test".to_string());

        for _ in 0..15 {
            room.add_result(GameResult::Banker);
        }
        for _ in 0..10 {
            room.add_result(GameResult::Player);
        }

        let score = GameLogicService::calculate_room_score(&room);
        assert!(score > 0);
        assert!(score <= 100);
    }
}
