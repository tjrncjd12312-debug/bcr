use serde::Serialize;
use tauri::{command, AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct ChromeEmbedResult {
    pub hwnd: isize,
    pub embedded: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[cfg(windows)]
mod platform {
    use super::ChromeEmbedResult;
    use std::sync::Mutex;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowRect,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        MoveWindow, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_STYLE, HWND_TOP,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOW, WS_CAPTION, WS_CHILD,
        WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP,
        WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
    };

    static EMBEDDED_CHROME_HWND: Mutex<Option<isize>> = Mutex::new(None);
    static ORIGINAL_STYLE: Mutex<Option<isize>> = Mutex::new(None);
    const TOP_CROP: i32 = 82;
    const LEFT_OVERSCAN: i32 = 11;
    const RIGHT_OVERSCAN: i32 = 11;
    const BOTTOM_OVERSCAN: i32 = 11;

    #[derive(Default)]
    struct SearchContext {
        target_pid: Option<u32>,
        title_hint: Option<String>,
        found: Option<HWND>,
        found_area: i64,
    }

    unsafe extern "system" fn enum_chrome_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut SearchContext);

        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if let Some(target_pid) = ctx.target_pid {
            if pid != target_pid {
                return BOOL(1);
            }
        }

        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
        if class_name != "Chrome_WidgetWin_1" {
            return BOOL(1);
        }

        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return BOOL(1);
        }

        let mut title_buf = vec![0u16; title_len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..copied as usize]);
        if title.trim().is_empty() || title.contains("DevTools") {
            return BOOL(1);
        }
        if let Some(title_hint) = &ctx.title_hint {
            if !title.to_ascii_lowercase().contains(title_hint) {
                return BOOL(1);
            }
        }

        let mut rect = RECT::default();
        let area = if GetWindowRect(hwnd, &mut rect).is_ok() {
            let width = (rect.right - rect.left).max(0) as i64;
            let height = (rect.bottom - rect.top).max(0) as i64;
            width * height
        } else {
            0
        };

        if area > ctx.found_area {
            ctx.found = Some(hwnd);
            ctx.found_area = area;
        }

        BOOL(1)
    }

    fn find_chrome_window(target_pid: Option<u32>, title_hint: Option<&str>) -> Option<HWND> {
        let mut ctx = SearchContext {
            target_pid,
            title_hint: title_hint.map(|value| value.to_ascii_lowercase()),
            found: None,
            found_area: 0,
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_chrome_windows),
                LPARAM((&mut ctx as *mut SearchContext) as isize),
            );
        }
        ctx.found
    }

    fn window_title(hwnd: HWND) -> Option<String> {
        unsafe {
            let title_len = GetWindowTextLengthW(hwnd);
            if title_len <= 0 {
                return None;
            }
            let mut title_buf = vec![0u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut title_buf);
            let title = String::from_utf16_lossy(&title_buf[..copied as usize]);
            (!title.trim().is_empty()).then_some(title)
        }
    }

    fn title_matches(hwnd: HWND, title_hint: &str) -> bool {
        let Some(title) = window_title(hwnd) else {
            return false;
        };
        let title = title.to_ascii_lowercase();
        title_hint
            .split('|')
            .map(|part| part.trim().to_ascii_lowercase())
            .filter(|part| !part.is_empty())
            .any(|part| title.contains(&part))
    }

    fn hwnd_from_isize(value: isize) -> HWND {
        HWND(value as *mut std::ffi::c_void)
    }

    pub fn embed(
        parent: HWND,
        chrome_pid: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        title_hint: Option<String>,
    ) -> Result<ChromeEmbedResult, String> {
        let existing_raw = *EMBEDDED_CHROME_HWND
            .lock()
            .map_err(|e| format!("embed lock failed: {}", e))?;
        let title_hint_ref = title_hint.as_deref();
        if let (Some(raw), Some(hint)) = (existing_raw, title_hint_ref) {
            let hwnd = hwnd_from_isize(raw);
            if !title_matches(hwnd, hint) {
                let _ = detach();
            }
        }

        let existing = *EMBEDDED_CHROME_HWND
            .lock()
            .map_err(|e| format!("embed lock failed: {}", e))?;
        let existing = existing
            .map(hwnd_from_isize)
            .filter(|hwnd| title_hint_ref.map_or(true, |hint| title_matches(*hwnd, hint)));

        let child = if let Some(hint) = title_hint_ref {
            existing
                .or_else(|| find_chrome_window(None, Some(hint)))
                .ok_or_else(|| format!("Pragmatic Chrome window not found for title: {}", hint))?
        } else {
            existing
                .or_else(|| find_chrome_window((chrome_pid > 0).then_some(chrome_pid), None))
                .or_else(|| find_chrome_window(None, None))
                .ok_or_else(|| "Chrome window not found. Open the casino window first.".to_string())?
        };

        unsafe {
            let current_style = GetWindowLongPtrW(child, GWL_STYLE);
            {
                let mut original = ORIGINAL_STYLE
                    .lock()
                    .map_err(|e| format!("style lock failed: {}", e))?;
                if original.is_none() {
                    *original = Some(current_style);
                }
            }

            let mut style = current_style as u32;
            style &= !(WS_POPUP.0
                | WS_CAPTION.0
                | WS_THICKFRAME.0
                | WS_MINIMIZEBOX.0
                | WS_MAXIMIZEBOX.0
                | WS_SYSMENU.0);
            style |= WS_CHILD.0 | WS_VISIBLE.0 | WS_CLIPCHILDREN.0 | WS_CLIPSIBLINGS.0;

            SetWindowLongPtrW(child, GWL_STYLE, style as isize);
            let _ = SetParent(child, Some(parent));
            let _ = ShowWindow(child, SW_SHOW);
            let _ = BringWindowToTop(child);
            let embed_x = x - LEFT_OVERSCAN;
            let embed_y = y - TOP_CROP;
            let embed_width = width + LEFT_OVERSCAN + RIGHT_OVERSCAN;
            let embed_height = height + TOP_CROP + BOTTOM_OVERSCAN;

            let _ = MoveWindow(child, embed_x, embed_y, embed_width.max(1), embed_height.max(1), true);
            let _ = SetWindowPos(
                child,
                Some(HWND_TOP),
                embed_x,
                embed_y,
                embed_width.max(1),
                embed_height.max(1),
                SWP_FRAMECHANGED | SWP_NOACTIVATE,
            );
        }

        let hwnd = child.0 as isize;
        *EMBEDDED_CHROME_HWND
            .lock()
            .map_err(|e| format!("embed lock failed: {}", e))? = Some(hwnd);

        Ok(ChromeEmbedResult {
            hwnd,
            embedded: true,
            x,
            y,
            width,
            height,
        })
    }

    pub fn resize(x: i32, y: i32, width: i32, height: i32) -> Result<ChromeEmbedResult, String> {
        let hwnd = EMBEDDED_CHROME_HWND
            .lock()
            .map_err(|e| format!("embed lock failed: {}", e))?
            .ok_or_else(|| "No embedded Chrome window".to_string())?;
        let child = hwnd_from_isize(hwnd);

        unsafe {
            let embed_x = x - LEFT_OVERSCAN;
            let embed_y = y - TOP_CROP;
            let embed_width = width + LEFT_OVERSCAN + RIGHT_OVERSCAN;
            let embed_height = height + TOP_CROP + BOTTOM_OVERSCAN;

            let _ = MoveWindow(child, embed_x, embed_y, embed_width.max(1), embed_height.max(1), true);
            let _ = SetWindowPos(
                child,
                None,
                embed_x,
                embed_y,
                embed_width.max(1),
                embed_height.max(1),
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }

        Ok(ChromeEmbedResult {
            hwnd,
            embedded: true,
            x,
            y,
            width,
            height,
        })
    }

    pub fn detach() -> Result<bool, String> {
        let hwnd = match EMBEDDED_CHROME_HWND
            .lock()
            .map_err(|e| format!("embed lock failed: {}", e))?
            .take()
        {
            Some(hwnd) => hwnd,
            None => return Ok(false),
        };
        let child = hwnd_from_isize(hwnd);
        let original_style = ORIGINAL_STYLE
            .lock()
            .map_err(|e| format!("style lock failed: {}", e))?
            .take();

        unsafe {
            let _ = SetParent(child, None);
            if let Some(style) = original_style {
                SetWindowLongPtrW(child, GWL_STYLE, style);
            }
            let _ = ShowWindow(child, SW_SHOW);
            let _ = SetWindowPos(
                child,
                None,
                80,
                80,
                1280,
                820,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }

        Ok(true)
    }
}

#[command]
pub async fn embed_chrome_window(
    app: AppHandle,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    title_hint: Option<String>,
) -> Result<ChromeEmbedResult, String> {
    #[cfg(windows)]
    {
        let main = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        let parent = main.hwnd().map_err(|e| e.to_string())?;
        let chrome_pid = super::webview_commands::chrome_pid();
        platform::embed(parent, chrome_pid, x, y, width, height, title_hint)
    }

    #[cfg(not(windows))]
    {
        let _ = (app, x, y, width, height, title_hint);
        Err("ROSE screen embedding is only supported on Windows.".to_string())
    }
}

#[command]
pub async fn resize_embedded_chrome(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<ChromeEmbedResult, String> {
    #[cfg(windows)]
    {
        platform::resize(x, y, width, height)
    }

    #[cfg(not(windows))]
    {
        let _ = (x, y, width, height);
        Err("ROSE screen embedding is only supported on Windows.".to_string())
    }
}

#[command]
pub async fn detach_embedded_chrome() -> Result<bool, String> {
    #[cfg(windows)]
    {
        platform::detach()
    }

    #[cfg(not(windows))]
    {
        Err("ROSE screen embedding is only supported on Windows.".to_string())
    }
}
