//! Domain Repositories - Abstract interfaces for data access
//!
//! Clean Architecture: Domain Layer (Interfaces)
//! - Define contracts that data layer must implement
//! - No implementation details here

mod prediction_repository;
mod room_repository;
mod user_repository;

pub use prediction_repository::*;
pub use room_repository::*;
pub use user_repository::*;
