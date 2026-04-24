//! Domain Layer
//!
//! Clean Architecture: Core business logic
//! - No external dependencies (only std library)
//! - Contains entities, repository interfaces, and domain services

pub mod entities;
pub mod error; // Custom error types (for future migration)
pub mod repositories;
pub mod services;

// Re-export commonly used items
pub use entities::*;
pub use repositories::*;
pub use services::*;
