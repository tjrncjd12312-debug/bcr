//! Evolution Gaming WebSocket Module
//!
//! Provides WebSocket connections to Evolution Gaming with Clean Architecture.
//!
//! ## Module Structure (Layer-based)
//!
//! ### Domain Layer
//! - `events`: Domain events (EvolutionEvent enum)
//! - `connection_state`: State machine for connection management
//!
//! ### Application Layer
//! - `protocol`: Message types and initialization sequences
//! - `message_parser`: Incoming message parsing
//! - `table_filter`: Baccarat table filtering logic
//!
//! ### Infrastructure Layer
//! - `multi_client`: WebSocket client implementation
//!
//! ### Presentation Layer
//! - `event_bridge`: Tauri event bridge (domain events -> Tauri events)
//! - `commands`: Tauri command handlers
//!
//! ## Architecture
//! ```text
//! [Tauri Commands] -> [Event Bridge] -> [Multi Client] -> [WebSocket]
//!                          |                  |
//!                          v                  v
//!                    [Tauri Events]    [Domain Events]
//! ```
//!
//! ## URL Pattern
//! - Multiwidget: wss://{domain}/public/baccarat/player/game/multiwidget/socket
//!
//! 🔥 IMPORTANT: Browser WebSockets are now blocked by WS_BLOCKER_SCRIPT
//! to prevent session conflicts. Only Rust manages Evolution connections.

pub mod commands;
pub mod connection_state;
pub mod crypto;
pub mod event_bridge;
pub mod events;
pub mod message_parser;
pub mod multi_client;
pub mod protocol;
pub mod table_filter;
