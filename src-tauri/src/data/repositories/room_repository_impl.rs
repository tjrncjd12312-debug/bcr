//! Room Repository Implementation
//!
//! Provides room data from static mapping.
//! Note: WebSocket connection is handled by evolution/multi_client.rs

use crate::domain::entities::{Room, RoomMapping};
use crate::domain::repositories::RoomRepository;
use async_trait::async_trait;
use parking_lot::RwLock;
use std::collections::HashMap;
use tracing::info;

/// Room repository implementation using static room mapping
/// WebSocket functionality moved to evolution/multi_client.rs
pub struct RoomRepositoryImpl {
    /// Room mapping (tableId -> Korean name)
    room_mapping: RoomMapping,

    /// Active rooms with their history
    rooms: RwLock<HashMap<String, Room>>,

    /// Multi-room mode flag
    multi_room_mode: RwLock<bool>,

    /// Currently active room (single-room mode)
    active_room: RwLock<Option<String>>,
}

impl RoomRepositoryImpl {
    /// Create new room repository
    pub fn new() -> Self {
        let room_mapping = RoomMapping::default();

        // Initialize rooms from mapping
        let mut rooms = HashMap::new();
        for (table_id, name) in room_mapping.mappings.iter() {
            rooms.insert(table_id.clone(), Room::new(table_id.clone(), name.clone()));
        }

        Self {
            room_mapping,
            rooms: RwLock::new(rooms),
            multi_room_mode: RwLock::new(false),
            active_room: RwLock::new(None),
        }
    }

    /// Get room by ID
    pub fn get_room(&self, room_id: &str) -> Option<Room> {
        self.rooms.read().get(room_id).cloned()
    }

    /// Get all rooms
    pub fn get_all_rooms(&self) -> Vec<Room> {
        self.rooms.read().values().cloned().collect()
    }

    /// Set active room for single-room mode
    pub fn set_active_room(&self, room_id: Option<String>) {
        *self.active_room.write() = room_id;
    }

    /// Get active room
    pub fn get_active_room(&self) -> Option<Room> {
        let active_id = self.active_room.read().clone();
        active_id.and_then(|id| self.get_room(&id))
    }

    /// Check if multi-room mode is enabled
    pub fn is_multi_room_mode(&self) -> bool {
        *self.multi_room_mode.read()
    }

    /// Set multi-room mode
    pub fn set_multi_room_mode(&self, enabled: bool) {
        info!(
            "🔄 Setting multi-room mode: {}",
            if enabled { "ENABLED" } else { "DISABLED" }
        );
        *self.multi_room_mode.write() = enabled;
    }

    /// Get rooms with minimum history for prediction
    pub fn get_predictable_rooms(&self, min_history: usize) -> Vec<Room> {
        self.rooms
            .read()
            .values()
            .filter(|r| r.history.len() >= min_history)
            .cloned()
            .collect()
    }
}

#[async_trait]
impl RoomRepository for RoomRepositoryImpl {
    async fn connect(&self, _ws_url: &str, _cookies: Option<&str>) -> Result<(), String> {
        // Legacy - connection now handled by evolution/multi_client.rs
        Ok(())
    }

    async fn disconnect(&self) -> Result<(), String> {
        // Legacy - disconnection now handled by evolution/multi_client.rs
        Ok(())
    }

    fn is_connected(&self) -> bool {
        // Legacy - connection status from multi_client events
        false
    }

    fn get_rooms(&self) -> Vec<Room> {
        self.get_all_rooms()
    }

    fn get_room_by_id(&self, room_id: &str) -> Option<Room> {
        self.get_room(room_id)
    }

    fn set_multi_room_mode(&self, enabled: bool) {
        self.set_multi_room_mode(enabled);
    }

    fn subscribe_to_room(&self, room_id: &str) -> Result<(), String> {
        if !self.room_mapping.contains(room_id) {
            return Err(format!("Unknown room: {}", room_id));
        }

        self.set_active_room(Some(room_id.to_string()));
        info!("📡 Subscribed to room: {}", room_id);
        Ok(())
    }

    fn unsubscribe_from_room(&self, room_id: &str) -> Result<(), String> {
        let active = self.active_room.read().clone();
        if active.as_deref() == Some(room_id) {
            self.set_active_room(None);
        }
        info!("📡 Unsubscribed from room: {}", room_id);
        Ok(())
    }
}

impl Default for RoomRepositoryImpl {
    fn default() -> Self {
        Self::new()
    }
}
