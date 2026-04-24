//! Room Repository Interface
//!
//! Abstract interface for room data access

use crate::domain::entities::Room;
use async_trait::async_trait;

/// Room repository interface
#[async_trait]
pub trait RoomRepository: Send + Sync {
    /// Connect to data source
    async fn connect(&self, ws_url: &str, cookies: Option<&str>) -> Result<(), String>;

    /// Disconnect from data source
    async fn disconnect(&self) -> Result<(), String>;

    /// Check if connected
    fn is_connected(&self) -> bool;

    /// Get all rooms
    fn get_rooms(&self) -> Vec<Room>;

    /// Get room by ID
    fn get_room_by_id(&self, room_id: &str) -> Option<Room>;

    /// Set multi-room mode
    fn set_multi_room_mode(&self, enabled: bool);

    /// Subscribe to room updates
    fn subscribe_to_room(&self, room_id: &str) -> Result<(), String>;

    /// Unsubscribe from room
    fn unsubscribe_from_room(&self, room_id: &str) -> Result<(), String>;
}
