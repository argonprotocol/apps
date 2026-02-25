use std::path::{Component, Path, PathBuf};
use time::OffsetDateTime;
use xcap::Monitor as XcapMonitor;
use xcap::Window as XcapWindow;
use xcap::image::RgbaImage;

pub fn capture_main_window_screenshot(
    output_path: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    let base_dir = configured_output_base_dir()?;

    let path = output_path
        .and_then(non_empty_path)
        .map(|value| resolve_output_path(value, &base_dir))
        .transpose()?
        .unwrap_or_else(|| default_output_path(&base_dir, name.as_deref()));
    ensure_output_parent_exists(&path)?;

    let image = capture_window_image().or_else(|window_error| {
        capture_monitor_image().map_err(|monitor_error| {
            format!(
                "window capture failed: {window_error}; monitor fallback failed: {monitor_error}"
            )
        })
    })?;
    image.save(&path).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

fn capture_window_image() -> Result<RgbaImage, String> {
    let mut windows = XcapWindow::all().map_err(|e| e.to_string())?;
    let window = select_capture_window(&mut windows)?;
    window.capture_image().map_err(|e| e.to_string())
}

fn capture_monitor_image() -> Result<RgbaImage, String> {
    let monitor = XcapMonitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "No monitors available for screenshot capture".to_string())?;
    monitor.capture_image().map_err(|e| e.to_string())
}

fn select_capture_window(windows: &mut Vec<XcapWindow>) -> Result<XcapWindow, String> {
    if windows.is_empty() {
        return Err("No windows available for screenshot capture".to_string());
    }

    let current_pid = std::process::id();
    let selected_index = windows
        .iter()
        .position(|window| window.pid().is_ok_and(|pid| pid == current_pid))
        .or_else(|| {
            windows
                .iter()
                .position(|window| window.is_focused().unwrap_or(false))
        })
        .unwrap_or(0);

    Ok(windows.swap_remove(selected_index))
}

fn ensure_output_parent_exists(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "output_path must include a filename".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())
}

fn non_empty_path(value: String) -> Option<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn configured_output_base_dir() -> Result<PathBuf, String> {
    let configured_dir = std::env::var("E2E_SCREENSHOT_DIR")
        .ok()
        .and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        })
        .unwrap_or_else(default_output_base_dir);

    to_absolute_path(configured_dir)
}

fn default_output_base_dir() -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push("e2e-screenshots");
    path
}

fn resolve_output_path(path: PathBuf, base_dir: &Path) -> Result<PathBuf, String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("output_path may not contain parent directory traversal ('..')".to_string());
    }

    let absolute_path = if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    };

    if !absolute_path.starts_with(base_dir) {
        return Err(format!(
            "output_path must be within {}",
            base_dir.to_string_lossy()
        ));
    }

    Ok(absolute_path)
}

fn default_output_path(base_dir: &Path, name: Option<&str>) -> PathBuf {
    let stamp = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let label = name
        .map(normalize_output_label)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "screenshot".to_string());
    base_dir.join(format!("{label}-{stamp}.png"))
}

fn normalize_output_label(value: &str) -> String {
    let normalized = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = normalized.trim_matches('-');
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.chars().take(96).collect::<String>()
    }
}

fn to_absolute_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        return Ok(path);
    }

    std::env::current_dir()
        .map(|current_dir| current_dir.join(path))
        .map_err(|e| e.to_string())
}
