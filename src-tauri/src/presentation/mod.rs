//! Presentation Layer
//!
//! Clean Architecture: UI and Tauri Commands
//! - Tauri command handlers
//! - State management
//! - Event emission to frontend

pub mod commands;
pub mod state;

pub use commands::*;
pub use state::*;
