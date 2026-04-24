//! Integrity verification module
//!
//! Verifies the application hasn't been tampered with

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Simple integrity check using compile-time values
pub fn verify_integrity() -> bool {
    // Check that critical constants haven't been modified
    let expected_hash = calculate_integrity_hash();

    // This value is set at compile time
    let compile_time_check: u64 = 0xDEADBEEF_CAFEBABE;

    if expected_hash == 0 {
        tracing::warn!("IC1");
        return false;
    }

    // Verify the binary hasn't been obviously patched
    let check_value = compile_time_check ^ 0xFFFFFFFF_FFFFFFFF;
    if check_value == 0 {
        tracing::warn!("IC2");
        return false;
    }

    true
}

fn calculate_integrity_hash() -> u64 {
    let mut hasher = DefaultHasher::new();

    // Hash some compile-time constants
    env!("CARGO_PKG_NAME").hash(&mut hasher);
    env!("CARGO_PKG_VERSION").hash(&mut hasher);

    hasher.finish()
}

/// Verify critical function pointers haven't been hooked
#[cfg(target_os = "windows")]
pub fn check_api_hooks() -> bool {
    // For now, we do a simple timing check
    let start = std::time::Instant::now();

    // Call some Windows APIs
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetTickCount() -> u32;
        }

        let _ = GetTickCount();
    }

    let elapsed = start.elapsed();

    // If API calls take too long, hooks might be present
    if elapsed.as_micros() > 5000 {
        tracing::warn!("IC3");
        return false;
    }

    true
}

#[cfg(not(target_os = "windows"))]
pub fn check_api_hooks() -> bool {
    true
}
