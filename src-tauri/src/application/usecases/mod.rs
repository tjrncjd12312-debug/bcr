//! Use Cases
//!
//! Application use cases that orchestrate domain logic
//! Note: WebSocket connection is handled by evolution/multi_client.rs

mod multi_room_prediction;
mod session_monitor;
mod single_room_prediction;
mod user_authentication;

pub use multi_room_prediction::{
    MultiRoomPredictionUseCase, MultiRoomState, MultiRoomStats, RoomAnalysis,
};
pub use session_monitor::{ServerValidationResponse, SessionMonitorUseCase};
pub use single_room_prediction::{
    PredictionMode, ResultComparison, SingleRoomPredictionUseCase, SingleRoomState,
};
pub use user_authentication::UserAuthenticationUseCase;
