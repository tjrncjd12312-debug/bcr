//! Game Entity - Represents game state and events
//!
//! Maps to Android: GameLogic.java game state

use super::room::GameResult;
use serde::{Deserialize, Serialize};

/// Game event from WebSocket
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GameEvent {
    /// Room history updated
    HistoryUpdated {
        room_id: String,
        history: Vec<GameResult>,
    },

    /// Betting phase started
    BettingPhase {
        room_id: String,
        remaining_seconds: u32,
    },

    /// Game result announced
    GameResult {
        room_id: String,
        winner: GameResult,
        player_score: u8,
        banker_score: u8,
    },

    /// VT_ID mapping updated (for room connections)
    VtIdUpdated { room_id: String, vt_id: String },

    /// Connection status changed
    ConnectionStatus { connected: bool, message: String },

    /// Balance updated (from lobby.balanceUpdated)
    BalanceUpdated { balance: f64 },
}

/// Game statistics for a room
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GameStats {
    /// Total games played
    pub total_games: u32,

    /// Banker win count
    pub banker_wins: u32,

    /// Player win count
    pub player_wins: u32,

    /// Tie count
    pub ties: u32,

    /// Current streak (type and count)
    pub current_streak: Option<(GameResult, u32)>,

    /// Maximum banker streak observed
    pub max_banker_streak: u32,

    /// Maximum player streak observed
    pub max_player_streak: u32,
}

impl GameStats {
    /// Calculate from history
    pub fn from_history(history: &[GameResult]) -> Self {
        let mut current_streak_type: Option<GameResult> = None;
        let mut current_streak_count = 0u32;
        let mut max_banker = 0u32;
        let mut max_player = 0u32;
        let mut banker_wins = 0u32;
        let mut player_wins = 0u32;
        let mut ties = 0u32;

        for result in history {
            match result {
                GameResult::Banker => {
                    banker_wins += 1;
                    if current_streak_type == Some(GameResult::Banker) {
                        current_streak_count += 1;
                    } else {
                        current_streak_type = Some(GameResult::Banker);
                        current_streak_count = 1;
                    }
                    max_banker = max_banker.max(current_streak_count);
                }
                GameResult::Player => {
                    player_wins += 1;
                    if current_streak_type == Some(GameResult::Player) {
                        current_streak_count += 1;
                    } else {
                        current_streak_type = Some(GameResult::Player);
                        current_streak_count = 1;
                    }
                    max_player = max_player.max(current_streak_count);
                }
                GameResult::Tie => {
                    ties += 1;
                }
            }
        }

        Self {
            total_games: history.len() as u32,
            banker_wins,
            player_wins,
            ties,
            current_streak: current_streak_type.map(|t| (t, current_streak_count)),
            max_banker_streak: max_banker,
            max_player_streak: max_player,
        }
    }

    /// Get banker win rate (excluding ties)
    pub fn banker_win_rate(&self) -> f64 {
        let total = self.banker_wins + self.player_wins;
        if total == 0 {
            return 0.5;
        }
        self.banker_wins as f64 / total as f64
    }
}

/// Martin tracking (matches Android GameLogic martin/win tracking)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MartinTracking {
    /// Martin count (consecutive losses)
    pub martin: u32,

    /// Win count (consecutive wins)
    pub win_count: u32,

    /// Total wins in session
    pub total_wins: u32,

    /// Total losses in session
    pub total_losses: u32,

    /// Total ties in session
    pub total_ties: u32,

    /// Last prediction made
    pub last_prediction: Option<GameResult>,

    /// Was last prediction correct?
    pub last_prediction_correct: Option<bool>,

    /// Is first round in room? (skip prediction)
    pub is_first_round: bool,

    /// Has made prediction for current round?
    pub prediction_made_for_round: bool,
}

impl MartinTracking {
    /// Reset for new room
    pub fn reset(&mut self) {
        self.martin = 0;
        self.win_count = 0;
        self.last_prediction = None;
        self.last_prediction_correct = None;
        self.is_first_round = true;
        self.prediction_made_for_round = false;
    }

    /// Record prediction result
    pub fn record_result(&mut self, prediction: GameResult, actual: GameResult) {
        // Skip counting for Tie predictions (as per Android logic)
        if prediction == GameResult::Tie {
            self.total_ties += 1;
            return;
        }

        // Actual result is Tie - maintain counts
        if actual == GameResult::Tie {
            self.total_ties += 1;
            return;
        }

        if prediction == actual {
            // Correct prediction
            self.last_prediction_correct = Some(true);
            self.martin = 0;
            self.win_count += 1;
            self.total_wins += 1;
        } else {
            // Incorrect prediction
            self.last_prediction_correct = Some(false);
            self.martin += 1;
            self.win_count = 0;
            self.total_losses += 1;
        }
    }

    /// Get win rate
    pub fn win_rate(&self) -> f64 {
        let total = self.total_wins + self.total_losses;
        if total == 0 {
            return 0.0;
        }
        self.total_wins as f64 / total as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_game_stats() {
        let history = vec![
            GameResult::Banker,
            GameResult::Banker,
            GameResult::Player,
            GameResult::Banker,
            GameResult::Tie,
        ];

        let stats = GameStats::from_history(&history);

        assert_eq!(stats.total_games, 5);
        assert_eq!(stats.banker_wins, 3);
        assert_eq!(stats.player_wins, 1);
        assert_eq!(stats.ties, 1);
        assert_eq!(stats.max_banker_streak, 2);
    }

    #[test]
    fn test_martin_tracking() {
        let mut tracking = MartinTracking::default();

        tracking.record_result(GameResult::Banker, GameResult::Banker);
        assert_eq!(tracking.total_wins, 1);
        assert_eq!(tracking.martin, 0);

        tracking.record_result(GameResult::Banker, GameResult::Player);
        assert_eq!(tracking.total_losses, 1);
        assert_eq!(tracking.martin, 1);

        tracking.record_result(GameResult::Player, GameResult::Player);
        assert_eq!(tracking.total_wins, 2);
        assert_eq!(tracking.martin, 0);
    }
}
