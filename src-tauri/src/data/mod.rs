//! Data Layer
//!
//! Clean Architecture: Data access and external integrations
//! - Data sources (WebSocket, HTTP API, Local Storage)
//! - Repository implementations

pub mod datasources;
pub mod repositories;

// Re-export commonly used items
pub use datasources::*;
pub use repositories::*;
