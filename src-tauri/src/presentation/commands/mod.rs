// VERSION: 1.4.2 - ROBUST MSI DETECTION
//! Tauri Commands
//!
//! Command handlers exposed to the frontend

mod auth_commands;
mod connection_commands;
mod embed_commands;
mod prediction_commands;
mod room_commands;
mod session_commands;
mod webview_commands;

pub use auth_commands::*;
pub use connection_commands::*;
pub use embed_commands::*;
pub use prediction_commands::*;
pub use room_commands::*;
pub use session_commands::*;
pub use webview_commands::*;

// ==================== Update Commands (Merged for Sync) ====================
use crate::domain::PredictionRepository;
use crate::presentation::state::AppState;
use std::fs;
use tauri::State;
use tracing::info;

/// Download and perform update
#[tauri::command]
pub async fn download_client_update(
    download_url: String,
    file_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    info!(
        "🚀 자가 업데이트 시작: {} (파일명: {})",
        download_url, file_name
    );

    // 1. PredictionApi를 통해 파일 다운로드
    let bytes = state
        .prediction_repository
        .download_file(&download_url)
        .await?;

    if bytes.is_empty() {
        return Err("다운로드된 파일이 비어 있습니다.".to_string());
    }

    // 2. 파일 형식 및 저장 경로 결정
    // Check by filename extension
    let mut is_msi =
        file_name.to_lowercase().ends_with(".msi") || download_url.to_lowercase().ends_with(".msi");

    // Check by MSI Magic Bytes (D0 CF 11 E0) if filename check fails
    if !is_msi && bytes.len() > 8 {
        if bytes[0] == 0xD0 && bytes[1] == 0xCF && bytes[2] == 0x11 && bytes[3] == 0xE0 {
            info!("📦 파일 헤더 확인: MSI 패키지로 감지됨 (Magic Bytes)");
            is_msi = true;
        }
    }

    if is_msi {
        // MSI 설치 파일 처리
        let temp_dir = std::env::temp_dir();
        let msi_path = temp_dir.join("SmartHelper_Setup.msi");

        info!("💾 MSI 파일을 임시 폴더에 저장합니다: {:?}", msi_path);
        fs::write(&msi_path, &bytes).map_err(|e| format!("MSI 파일 저장 실패: {}", e))?;

        info!("🎬 MSI 설치 프로그램을 실행합니다...");

        // Windows에서 msiexec 실행
        #[cfg(windows)]
        {
            use std::process::Command;
            let status = Command::new("msiexec")
                .arg("/i")
                .arg(&msi_path)
                // .arg("/passive") // 주석 처리: 전체 UI(마법사) 표시 모드로 변경하여 설치 과정 확실히 보여줌
                .spawn();

            match status {
                Ok(_) => info!("✅ MSI 설치 프로그램 실행 성공"),
                Err(e) => return Err(format!("설치 프로그램 실행 실패: {}", e)),
            }
        }

        #[cfg(not(windows))]
        {
            return Err("MSI 설치는 Windows에서만 지원됩니다.".to_string());
        }

        #[cfg(windows)]
        return Ok(
            "설치 프로그램이 실행되었습니다. 앱이 종료됩니다. 설치를 완료해 주세요.".to_string(),
        );
    }

    // 3. EXE 파일 교체 처리 (기존 로직)
    let current_exe =
        std::env::current_exe().map_err(|e| format!("현재 실행 경로 획득 실패: {}", e))?;
    let mut new_exe = current_exe.clone();
    new_exe.set_extension("new");

    info!("💾 새 파일을 저장합니다: {:?}", new_exe);
    fs::write(&new_exe, &bytes).map_err(|e| format!("파일 저장 실패: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perrs = fs::metadata(&new_exe)
            .map_err(|e| e.to_string())?
            .permissions();
        perrs.set_mode(0o755);
        fs::set_permissions(&new_exe, perrs).map_err(|e| e.to_string())?;
    }

    let old_exe = current_exe.with_extension("old");
    if old_exe.exists() {
        let _ = fs::remove_file(&old_exe);
    }

    fs::rename(&current_exe, &old_exe).map_err(|e| format!("기존 파일 백업 실패: {}", e))?;
    fs::rename(&new_exe, &current_exe).map_err(|e| format!("새 파일 교체 실패: {}", e))?;

    info!("✅ 업데이트 파일 교체 완료. 재시작이 필요합니다.");

    Ok("업데이트가 완료되었습니다. 앱을 재시작해주세요.".to_string())
}
