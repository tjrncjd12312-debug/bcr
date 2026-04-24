//! Anti-debugging detection for Windows
//!
//! Detects common debugging techniques and analysis tools

#[cfg(target_os = "windows")]
use std::ffi::c_void;

/// Check if a debugger is attached to the process
#[cfg(target_os = "windows")]
pub fn check_debugger() -> bool {
    unsafe {
        // Windows API: IsDebuggerPresent
        #[link(name = "kernel32")]
        extern "system" {
            fn IsDebuggerPresent() -> i32;
            fn CheckRemoteDebuggerPresent(
                hProcess: *mut c_void,
                pbDebuggerPresent: *mut i32,
            ) -> i32;
            fn GetCurrentProcess() -> *mut c_void;
        }

        // Check 1: IsDebuggerPresent
        if IsDebuggerPresent() != 0 {
            tracing::warn!("SC1");
            return true;
        }

        // Check 2: Remote debugger
        let mut is_remote_debugger: i32 = 0;
        let process = GetCurrentProcess();
        if CheckRemoteDebuggerPresent(process, &mut is_remote_debugger) != 0 {
            if is_remote_debugger != 0 {
                tracing::warn!("SC2");
                return true;
            }
        }

        // Check 3: Timing-based detection (debuggers slow execution)
        let start = std::time::Instant::now();
        for _ in 0..1000 {
            std::hint::black_box(0);
        }
        let elapsed = start.elapsed();
        if elapsed.as_micros() > 10000 {
            tracing::warn!("SC3");
            return true;
        }

        false
    }
}

#[cfg(not(target_os = "windows"))]
pub fn check_debugger() -> bool {
    // macOS/Linux: Check for ptrace
    #[cfg(target_os = "linux")]
    {
        use std::fs;
        if let Ok(status) = fs::read_to_string("/proc/self/status") {
            if !status.contains("TracerPid:\t0") {
                return true;
            }
        }
    }
    false
}

/// Check for common analysis tools by process name
#[cfg(target_os = "windows")]
pub fn check_analysis_tools() -> bool {
    use std::process::Command;

    // XOR-encoded tool names (decoded at runtime)
    const KEY: u8 = 0x5A;
    let tools: &[&[u8]] = &[
        &[0x32, 0x3e, 0x34, 0x0e, 0x0c, 0x0f],       // x64dbg
        &[0x32, 0x6b, 0x32, 0x0e, 0x0c, 0x0f],       // x32dbg
        &[0x35, 0x36, 0x36, 0x31, 0x0e, 0x0c, 0x0f], // ollydbg
        &[0x33, 0x0e, 0x0b, 0x6e, 0x34],             // ida64
        &[0x3f, 0x38, 0x33, 0x0e, 0x28, 0x0b],       // ghidra
        &[0x2d, 0x33, 0x28, 0x39, 0x29, 0x38, 0x0b, 0x28, 0x35], // wireshark
        &[0x3c, 0x33, 0x0e, 0x0e, 0x36, 0x39, 0x28], // fiddler
        &[0x2a, 0x28, 0x35, 0x03, 0x37, 0x35, 0x34], // procmon
        &[0x2a, 0x28, 0x35, 0x03, 0x39, 0x32, 0x2a], // procexp
    ];

    if let Ok(output) = Command::new("tasklist").output() {
        let task_list = String::from_utf8_lossy(&output.stdout).to_lowercase();

        for tool in tools {
            let decoded: String = tool.iter().map(|b| (b ^ KEY) as char).collect();
            if task_list.contains(&decoded) {
                tracing::warn!("SC4");
                return true;
            }
        }
    }

    false
}

#[cfg(not(target_os = "windows"))]
pub fn check_analysis_tools() -> bool {
    false
}

/// Periodic security check that can be run in background
pub fn run_security_checks() -> bool {
    if check_debugger() {
        return false;
    }

    #[cfg(target_os = "windows")]
    if check_analysis_tools() {
        return false;
    }

    true
}
