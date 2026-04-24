//! Security module for anti-reverse engineering protection
//!
//! This module provides:
//! - Anti-debugging detection
//! - Integrity checks
//! - Obfuscated sensitive operations

pub mod anti_debug;
pub mod integrity;

pub use anti_debug::check_debugger;
pub use integrity::verify_integrity;
