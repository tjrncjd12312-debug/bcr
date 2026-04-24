//! Pattern Analyzer Service
//!
//! Analyzes game patterns for filtering and scoring

use crate::domain::entities::GameResult;

/// Pattern analysis service
pub struct PatternAnalyzer;

impl PatternAnalyzer {
    /// Calculate volatility (0.0 = stable, 1.0 = highly volatile)
    pub fn calculate_volatility(history: &[GameResult]) -> f64 {
        if history.len() <= 1 {
            return 0.0;
        }

        let non_tie_count = history.iter().filter(|r| **r != GameResult::Tie).count();

        if non_tie_count <= 1 {
            return 0.0;
        }

        let changes = Self::count_pattern_changes(history);
        changes as f64 / (non_tie_count - 1) as f64
    }

    /// Count pattern changes (internal helper)
    fn count_pattern_changes(history: &[GameResult]) -> usize {
        if history.len() <= 1 {
            return 0;
        }

        let mut changes = 0;
        let mut last: Option<&GameResult> = None;

        for result in history {
            if *result == GameResult::Tie {
                continue;
            }

            if let Some(l) = last {
                if l != result {
                    changes += 1;
                }
            }
            last = Some(result);
        }

        changes
    }

    /// Calculate banker win rate (excluding ties)
    pub fn banker_rate(history: &[GameResult]) -> f64 {
        let banker = history.iter().filter(|r| **r == GameResult::Banker).count();
        let player = history.iter().filter(|r| **r == GameResult::Player).count();

        let total = banker + player;
        if total == 0 {
            return 0.5;
        }

        banker as f64 / total as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_volatility() {
        // Low volatility (streaky)
        let stable = vec![
            GameResult::Banker,
            GameResult::Banker,
            GameResult::Banker,
            GameResult::Player,
            GameResult::Player,
            GameResult::Player,
        ];
        let vol = PatternAnalyzer::calculate_volatility(&stable);
        assert!(vol < 0.3);

        // High volatility (alternating)
        let volatile = vec![
            GameResult::Banker,
            GameResult::Player,
            GameResult::Banker,
            GameResult::Player,
            GameResult::Banker,
            GameResult::Player,
        ];
        let vol = PatternAnalyzer::calculate_volatility(&volatile);
        assert!(vol > 0.8);
    }
}
