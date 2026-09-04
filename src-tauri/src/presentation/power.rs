//! ☕ 절전 억제(keep-awake)
//!
//! 카지노 세션(앱이 띄운 CDP 크롬)이 살아 있는 동안 OS의 시스템 대기 모드 진입을 막는다.
//! 창을 최소화하고 자리를 비우면 PC가 대기 모드로 들어가 소켓이 끊기고, 돌아왔을 때
//! "소켓이 끊겼다"로 보인다(2026-09-05 유저 이슈). 화면 꺼짐은 막지 않는다(시스템 대기만).
//!
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` — 스레드 단위 플래그라
//!   전용 스레드가 해제 신호까지 살아 있으면서 상태를 유지한다.
//! - macOS: `caffeinate -i -w <pid>` 자식 프로세스 — 앱이 죽으면 함께 종료(-w).
//! - 그 외: 동작 없음.

use std::sync::Mutex;
use tracing::{info, warn};

static KEEP_AWAKE: Mutex<Option<KeepAwakeHandle>> = Mutex::new(None);

enum KeepAwakeHandle {
    #[cfg(target_os = "macos")]
    Child(std::process::Child),
    #[cfg(windows)]
    Thread(std::sync::mpsc::Sender<()>),
    #[cfg(not(any(target_os = "macos", windows)))]
    Noop,
}

/// 절전 억제를 켜거나(true) 끈다(false). 멱등 — 이미 같은 상태면 아무 일도 하지 않는다.
pub fn keep_awake(enable: bool) {
    let mut guard = match KEEP_AWAKE.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if enable {
        if guard.is_some() {
            return;
        }
        match start() {
            Some(handle) => {
                info!("☕ 절전 억제 시작 — 카지노 세션 동안 시스템 대기 모드 진입을 막는다");
                *guard = Some(handle);
            }
            None => warn!("☕ 절전 억제 시작 실패 — 장시간 방치 시 OS 대기 모드로 소켓이 끊길 수 있다"),
        }
    } else if let Some(handle) = guard.take() {
        stop(handle);
        info!("☕ 절전 억제 해제");
    }
}

#[cfg(target_os = "macos")]
fn start() -> Option<KeepAwakeHandle> {
    std::process::Command::new("caffeinate")
        .args(["-i", "-w", &std::process::id().to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
        .map(KeepAwakeHandle::Child)
}

#[cfg(target_os = "macos")]
fn stop(handle: KeepAwakeHandle) {
    let KeepAwakeHandle::Child(mut child) = handle;
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn start() -> Option<KeepAwakeHandle> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("bcr-keep-awake".to_string())
        .spawn(move || {
            use windows::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
            };
            // SAFETY: 인자 없는 단순 Win32 호출. 이 스레드가 살아 있는 동안만 유효한 스레드 단위 상태.
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            }
            // 해제 신호(또는 송신자 드롭)까지 대기 → 상태 원복 후 종료.
            let _ = rx.recv();
            unsafe {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        })
        .ok()
        .map(|_| KeepAwakeHandle::Thread(tx))
}

#[cfg(windows)]
fn stop(handle: KeepAwakeHandle) {
    let KeepAwakeHandle::Thread(tx) = handle;
    let _ = tx.send(());
}

#[cfg(not(any(target_os = "macos", windows)))]
fn start() -> Option<KeepAwakeHandle> {
    Some(KeepAwakeHandle::Noop)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn stop(_handle: KeepAwakeHandle) {}
