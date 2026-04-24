//! Room Entity - Represents a baccarat game room/table
//!
//! Maps to Android: Configuration.roomMapping

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Game result color (matches Evolution Gaming format)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameResult {
    /// Banker win (Red)
    Banker,
    /// Player win (Blue)
    Player,
    /// Tie (Green)
    Tie,
}

impl GameResult {
    /// Convert from Evolution color string
    pub fn from_color(color: &str) -> Option<Self> {
        match color.to_lowercase().as_str() {
            "red" | "banker" => Some(Self::Banker),
            "blue" | "player" => Some(Self::Player),
            "green" | "tie" => Some(Self::Tie),
            _ => None,
        }
    }

    /// Convert to color string
    pub fn to_color(&self) -> &'static str {
        match self {
            Self::Banker => "Red",
            Self::Player => "Blue",
            Self::Tie => "Green",
        }
    }

    /// Convert to Korean display name
    pub fn to_korean(&self) -> &'static str {
        match self {
            Self::Banker => "뱅커",
            Self::Player => "플레이어",
            Self::Tie => "타이",
        }
    }
}

/// Game phase
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum GamePhase {
    /// Idle/Waiting for next round
    #[default]
    Idle,
    /// Betting phase with remaining seconds
    Betting { remaining_seconds: u32 },
    /// Cards being dealt
    Dealing,
    /// Game result announced
    Result { winner: GameResult },
}

/// Room/Table entity
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    /// Unique table ID (e.g., "leqhceumaq6qfoug")
    pub id: String,

    /// Display name (e.g., "스피드 A")
    pub name: String,

    /// Current game phase
    pub phase: GamePhase,

    /// Game history (most recent last)
    /// Using VecDeque for efficient front removal when limiting history
    pub history: VecDeque<GameResult>,

    /// Maximum history to keep
    #[serde(skip)]
    max_history: usize,

    /// Last update timestamp
    pub last_updated: chrono::DateTime<chrono::Utc>,

    /// Is room active/online
    pub is_active: bool,
}

impl Room {
    /// Create new room
    pub fn new(id: String, name: String) -> Self {
        Self {
            id,
            name,
            phase: GamePhase::default(),
            history: VecDeque::with_capacity(100),
            max_history: 100,
            last_updated: chrono::Utc::now(),
            is_active: true,
        }
    }

    /// Add game result to history
    pub fn add_result(&mut self, result: GameResult) {
        self.history.push_back(result);

        // Limit history size
        while self.history.len() > self.max_history {
            self.history.pop_front();
        }

        self.last_updated = chrono::Utc::now();
    }

    /// Get history as color strings
    pub fn get_history_colors(&self) -> Vec<String> {
        self.history
            .iter()
            .map(|r| r.to_color().to_string())
            .collect()
    }

    /// Calculate current streak
    pub fn current_streak(&self) -> (GameResult, u32) {
        if self.history.is_empty() {
            return (GameResult::Tie, 0);
        }

        let last = *self.history.back().unwrap();
        let mut streak = 0;

        for result in self.history.iter().rev() {
            if *result == last {
                streak += 1;
            } else {
                break;
            }
        }

        (last, streak)
    }
}

/// Room configuration mapping
/// Maps table IDs to display names
#[derive(Debug, Clone)]
pub struct RoomMapping {
    pub mappings: std::collections::HashMap<String, String>,
}

impl Default for RoomMapping {
    fn default() -> Self {
        let mut mappings = std::collections::HashMap::new();

        // Evolution Gaming Speed Baccarat tables
        // (Migrated from Android Configuration.java)
        mappings.insert("leqhceumaq6qfoug".to_string(), "스피드 A".to_string());
        mappings.insert("lv2kzclunt2qnxo5".to_string(), "스피드 B".to_string());
        mappings.insert("ndgvwvgthfuaad3q".to_string(), "스피드 C".to_string());
        mappings.insert("ndgvz5mlhfuaad6e".to_string(), "스피드 D".to_string());
        mappings.insert("ndgv45bghfuaaebf".to_string(), "스피드 E".to_string());
        mappings.insert("nmwde3fd7hvqhq43".to_string(), "스피드 F".to_string());
        mappings.insert("nmwdzhbg7hvqh6a7".to_string(), "스피드 G".to_string());
        mappings.insert("nxpj4wumgclak2lx".to_string(), "스피드 H".to_string());
        mappings.insert("nxpkul2hgclallno".to_string(), "스피드 I".to_string());
        mappings.insert("obj64qcnqfunjelj".to_string(), "스피드 J".to_string());
        mappings.insert("ocye2ju2bsoyq6vv".to_string(), "스피드 K".to_string());
        mappings.insert("ovu5cwp54ccmymck".to_string(), "스피드 L".to_string());
        mappings.insert("ovu5dsly4ccmynil".to_string(), "스피드 M".to_string());
        mappings.insert("ovu5eja74ccmyoiq".to_string(), "스피드 N".to_string());
        mappings.insert("ovu5fbxm4ccmypmb".to_string(), "스피드 O".to_string());
        mappings.insert("ovu5fzje4ccmyqnr".to_string(), "스피드 P".to_string());
        mappings.insert("o4kyj7tgpwqqy4m4".to_string(), "스피드 Q".to_string());
        mappings.insert("o4kylkahpwqqy57w".to_string(), "스피드 R".to_string());
        mappings.insert("o4kymodby2fa2c7g".to_string(), "스피드 S".to_string());
        mappings.insert("qgonc7t4ucdiel4o".to_string(), "스피드 T".to_string());
        mappings.insert("qgqrhfvsvltnueqf".to_string(), "스피드 U".to_string());
        mappings.insert("qgqrrnuqvltnvejx".to_string(), "스피드 V".to_string());
        mappings.insert("qgqrucipvltnvnvq".to_string(), "스피드 W".to_string());
        mappings.insert("qgqrv4asvltnvuty".to_string(), "스피드 X".to_string());
        mappings.insert("qsf63ownyvbqnz33".to_string(), "스피드 Z".to_string());
        mappings.insert("qsf65xtoyvbqoaop".to_string(), "스피드 1".to_string());
        mappings.insert("qsf7alptyvbqohva".to_string(), "스피드 2".to_string());
        mappings.insert("qsf7bpfvyvbqolwp".to_string(), "스피드 3".to_string());
        mappings.insert("rdjda6zq7jdyo6cs".to_string(), "스피드 4".to_string());
        mappings.insert("rep45wbxnyjl7hr2".to_string(), "스피드 5".to_string());
        mappings.insert("rep5aor7nyjl7qli".to_string(), "스피드 6".to_string());
        mappings.insert("rep5ca4ynyjl7wdw".to_string(), "스피드 7".to_string());
        mappings.insert("rep5eiecnyjl75lq".to_string(), "스피드 8".to_string());
        mappings.insert("rep5gu47nyjmalgt".to_string(), "스피드 9".to_string());
        mappings.insert("rep5iuhinyjmalz4".to_string(), "스피드 10".to_string());
        mappings.insert("rep5kwmdnyjmasxi".to_string(), "스피드 11".to_string());
        mappings.insert("rep5m2cdnyjmazzo".to_string(), "스피드 12".to_string());

        Self { mappings }
    }
}

impl RoomMapping {
    /// Check if table ID is configured
    pub fn contains(&self, table_id: &str) -> bool {
        self.mappings.contains_key(table_id)
    }

    /// Get display name for table ID
    pub fn get_name(&self, table_id: &str) -> Option<&String> {
        self.mappings.get(table_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_game_result_from_color() {
        assert_eq!(GameResult::from_color("Red"), Some(GameResult::Banker));
        assert_eq!(GameResult::from_color("Blue"), Some(GameResult::Player));
        assert_eq!(GameResult::from_color("Green"), Some(GameResult::Tie));
        assert_eq!(GameResult::from_color("Invalid"), None);
    }

    #[test]
    fn test_room_history() {
        let mut room = Room::new("test".to_string(), "Test Room".to_string());

        room.add_result(GameResult::Banker);
        room.add_result(GameResult::Player);
        room.add_result(GameResult::Banker);

        assert_eq!(room.history.len(), 3);
        assert_eq!(room.current_streak(), (GameResult::Banker, 1));
    }

    #[test]
    fn test_room_mapping() {
        let mapping = RoomMapping::default();

        assert!(mapping.contains("leqhceumaq6qfoug"));
        assert_eq!(
            mapping.get_name("leqhceumaq6qfoug"),
            Some(&"스피드 A".to_string())
        );
    }
}
