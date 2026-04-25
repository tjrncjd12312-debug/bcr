//! Presentation Layer
//!
//! Clean Architecture: UI and Tauri Commands
//! - Tauri command handlers
//! - State management
//! - Event emission to frontend

pub mod commands;
pub mod event_aggregator;
pub mod metrics;
pub mod state;
pub mod task_registry;


pub use commands::*;
pub use state::*;
