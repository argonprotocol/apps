use crate::authentication::SystemAuthenticationOption;
use crate::ssh::SSH;
use log::trace;
use nosleep::{NoSleep, NoSleepType};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindow;
use secrecy::{ExposeSecret, SecretString};
use sp_core::{Pair, ed25519, sr25519};
use std::fs;
#[cfg(any(test, all(target_os = "macos", not(debug_assertions))))]
use std::path::Path;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager};
use tauri::{Emitter, State};
use tauri_plugin_log::fern::colors::ColoredLevelConfig;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use utils::Utils;
#[cfg(target_os = "macos")]
use window_vibrancy::*;
use zip::DateTime;

mod authentication;
#[cfg(feature = "e2e-screenshots")]
mod e2e_screenshots;
mod encryption_key;
mod keychain;
#[cfg(target_os = "macos")]
mod keychain_mac;
#[cfg(target_os = "windows")]
mod keychain_windows;
mod migrations;
mod sql;
mod ssh;
mod ssh_access;
mod ssh_pool;
mod troubleshooting;
mod utils;
mod vm;
mod wallet_files;

struct NoSleepState {
    nosleep: Mutex<Option<NoSleep>>,
}

#[tauri::command]
async fn system_authentication_option() -> Result<Option<SystemAuthenticationOption>, String> {
    authentication::available_option().await
}

#[tauri::command]
fn export_sr25519_seed(suri: String) -> Result<[u8; 32], String> {
    let suri = SecretString::from(suri);
    let (_, seed) = sr25519::Pair::from_string_with_seed(suri.expose_secret(), None)
        .map_err(|error| error.to_string())?;
    seed.ok_or_else(|| "A private seed cannot be exported from a soft derivation".to_string())
}

#[tauri::command]
async fn request_system_authentication(
    window: WebviewWindow,
    reason: String,
) -> Result<(), String> {
    if reason.trim().is_empty() {
        return Err("An authentication reason is required.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let window_handle = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        authentication::confirm(reason, window_handle).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        authentication::confirm(reason).await
    }
}

#[cfg(any(test, all(target_os = "macos", not(debug_assertions))))]
fn is_running_from_mounted_volume(executable_path: &Path) -> bool {
    executable_path
        .strip_prefix("/Volumes")
        .is_ok_and(|relative_path| relative_path.components().next().is_some())
}

#[tauri::command]
async fn open_ssh_connection(
    address: &str,
    host: &str,
    port: u16,
    username: String,
    private_key_seed: [u8; 32],
) -> Result<String, String> {
    log::info!("ensure_ssh_connection");
    let (private_key, _) = SSH::format_as_openssh(ed25519::Pair::from_seed(&private_key_seed))
        .map_err(|e| e.to_string())?;
    let private_key = SecretString::new(private_key.into());
    ssh_pool::open_connection(address, host, port, username, private_key)
        .await
        .map_err(|e| {
            log::error!("Error connecting to SSH: {e:#}");
            e.to_string()
        })?;

    Ok("success".to_string())
}

#[tauri::command]
async fn close_ssh_connection(address: &str) -> Result<String, String> {
    log::info!("close_ssh_connection");
    ssh_pool::close_connection(address)
        .await
        .map_err(|e| e.to_string())?;

    Ok("success".to_string())
}

#[tauri::command]
async fn ssh_run_command(address: &str, command: String) -> Result<(String, u32), String> {
    let ssh: SSH = ssh_pool::get_connection(address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No SSH connection")?;
    let response = ssh.run_command(&command).await.map_err(|e| e.to_string())?;
    Ok(response)
}

#[tauri::command]
async fn ssh_upload_file(
    address: &str,
    contents: String,
    remote_path: String,
    timeout_ms: u64,
) -> Result<String, String> {
    log::info!("ssh_upload_file: {remote_path}");
    let ssh: SSH = ssh_pool::get_connection(address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No SSH connection")?;
    ssh.upload_file(
        contents.as_bytes(),
        &remote_path,
        Duration::from_millis(timeout_ms),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok("success".to_string())
}

#[tauri::command]
async fn ssh_download_file(
    app: AppHandle,
    address: &str,
    remote_path: String,
    download_path: String,
    event_progress_key: String,
) -> Result<String, String> {
    log::info!("ssh_download_file: {remote_path}, {download_path}");
    let ssh: SSH = ssh_pool::get_connection(address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No SSH connection")?;
    ssh.download_remote_file(&app, &remote_path, &download_path, event_progress_key)
        .await
        .map_err(|e| e.to_string())?;
    Ok("success".to_string())
}

#[tauri::command]
async fn ssh_upload_embedded_file(
    app: AppHandle,
    address: &str,
    local_relative_path: String,
    remote_path: String,
    event_progress_key: String,
    timeout_ms: u64,
) -> Result<String, String> {
    log::info!("ssh_upload_embedded_file: {local_relative_path}, {remote_path}");
    let ssh: SSH = ssh_pool::get_connection(address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No SSH connection")?;
    ssh.upload_embedded_file(
        &app,
        &local_relative_path,
        &remote_path,
        event_progress_key,
        Duration::from_millis(timeout_ms),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok("success".to_string())
}

#[tauri::command]
async fn measure_latency(url: String) -> Result<u128, String> {
    let client = reqwest::Client::new();
    let start = Instant::now();

    let _ = client.head(&url).send().await.ok();

    let elapsed = start.elapsed().as_millis();
    Ok(elapsed)
}

#[tauri::command]
async fn read_embedded_file(app: AppHandle, local_relative_path: String) -> Result<String, String> {
    log::info!("read_embedded_file: {local_relative_path}");
    let absolute_local_path = Utils::get_embedded_path(&app, local_relative_path.clone())
        .map_err(|e| format!("Error resolving embedded path: {e}"))?;

    if !absolute_local_path.exists() {
        return Err(format!("File does not exist: {local_relative_path}").to_string());
    }

    let content = fs::read_to_string(&absolute_local_path)
        .map_err(|e| format!("Error reading file {local_relative_path}: {e}"))?;
    Ok(content)
}

#[tauri::command]
async fn backup_current_instance_database_for_import(app: AppHandle) -> Result<(), String> {
    migrations::backup_current_instance_database_for_import(&app)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn run_db_migrations(app: AppHandle) -> Result<(), String> {
    log::info!("run_db_migrations");
    migrations::backup_current_instance_database(&app).map_err(|e| e.to_string())?;
    let absolute_db_path = Utils::get_absolute_config_instance_dir(&app).join("database.sqlite");
    log::info!("Running DB migrations for {}", absolute_db_path.display());
    migrations::run_db_migrations(absolute_db_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn toggle_nosleep(
    nosleep_state: State<'_, NoSleepState>,
    enable: bool,
) -> Result<(), String> {
    let Some(ref mut nosleep) = *nosleep_state.nosleep.lock().await else {
        return Err("NoSleep not initialized".to_string());
    };
    if enable {
        log::info!("KeepAwake enabled");
        nosleep.start(NoSleepType::PreventUserIdleSystemSleep)
    } else {
        log::info!("KeepAwake disabled");
        nosleep.stop()
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn create_zip(
    app: AppHandle,
    paths_with_prefixes: Vec<(PathBuf, PathBuf)>,
    zip_name: PathBuf,
    event_progress_key: Option<String>,
) -> Result<PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = fs::File::create(&zip_name).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();

        let total_bytes = paths_with_prefixes
            .iter()
            .flat_map(|(_, path)| walkdir::WalkDir::new(path).into_iter().flatten())
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.metadata().map(|metadata| metadata.len()).unwrap_or(0))
            .sum::<u64>();

        let mut copied_bytes = 0u64;
        let mut last_percent = u8::MAX;

        for (prefix, path_root) in paths_with_prefixes {
            for entry in walkdir::WalkDir::new(&path_root).into_iter().flatten() {
                if entry.file_type().is_dir() {
                    continue;
                }
                let path = entry.path();
                let rel = if path_root.is_file() {
                    path.strip_prefix(path_root.parent().unwrap_or(&PathBuf::from("")))
                } else {
                    path.strip_prefix(&path_root)
                }
                .unwrap_or(path);

                if rel.as_os_str().is_empty() {
                    continue;
                }

                let name = prefix.join(rel).to_string_lossy().replace("\\", "/");
                let mut file_opts = opts;
                if let Ok(mtime) = entry.metadata().map_err(|e| e.to_string())?.modified()
                    && let Ok(zdt) = DateTime::try_from(OffsetDateTime::from(mtime))
                {
                    file_opts = file_opts.last_modified_time(zdt);
                }
                zip.start_file(name, file_opts).map_err(|e| e.to_string())?;

                let mut source = fs::File::open(path).map_err(|e| e.to_string())?;
                let mut buffer = [0u8; 64 * 1024];

                loop {
                    let read =
                        std::io::Read::read(&mut source, &mut buffer).map_err(|e| e.to_string())?;
                    if read == 0 {
                        break;
                    }

                    std::io::Write::write_all(&mut zip, &buffer[..read])
                        .map_err(|e| e.to_string())?;
                    copied_bytes += read as u64;

                    if total_bytes > 0 {
                        let percent =
                            ((copied_bytes.saturating_mul(100)) / total_bytes).min(100) as u8;
                        if percent != last_percent {
                            last_percent = percent;
                            if let Some(event_key) = &event_progress_key {
                                app.emit(event_key, percent).map_err(|e| e.to_string())?;
                            }
                        }
                    }
                }
            }
        }

        zip.finish().map_err(|e| e.to_string())?;

        if let Some(event_key) = &event_progress_key {
            app.emit(event_key, 100u8).map_err(|e| e.to_string())?;
        }

        Ok(zip_name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn collect_troubleshooting_os_profile(app: AppHandle) -> Result<String, String> {
    troubleshooting::collect_os_profile(&app)
}

#[tauri::command]
fn calculate_free_space(path: Option<String>) -> Result<u64, String> {
    let p = path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    fs2::available_space(&p).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_instance(app: AppHandle, name: String) -> Result<(), String> {
    log::info!(
        "--------------------------------------------------------------\nLoading instance: {name}"
    );
    unsafe {
        std::env::set_var("ARGON_APP_INSTANCE", &name);
    }
    run_db_migrations(app.clone()).await?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    window
        .eval("window.location.reload()")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn report_empty_app_root_after_activation() {
    log::warn!(
        "[WakeRecovery] Empty #app detected after activation for instance '{}'; reloading webview",
        Utils::get_instance_name()
    );
}

#[tauri::command]
async fn e2e_capture_main_window_screenshot(
    _app: AppHandle,
    output_path: Option<String>,
    name: Option<String>,
) -> Result<String, String> {
    #[cfg(feature = "e2e-screenshots")]
    {
        e2e_screenshots::capture_main_window_screenshot(output_path, name)
    }

    #[cfg(not(feature = "e2e-screenshots"))]
    {
        let _ = (&_app, &output_path, &name);
        Err("E2E screenshot support is disabled in this build".to_string())
    }
}

#[cfg(all(target_os = "linux", feature = "e2e-insecure-gateway-certs"))]
fn allow_e2e_insecure_gateway_certs(window: &WebviewWindow) {
    if let Err(error) = window.with_webview(|webview| {
        use webkit2gtk::{TLSErrorsPolicy, WebContextExt, WebViewExt, WebsiteDataManagerExt};

        let webview = webview.inner();
        if let Some(context) = webview.context() {
            if let Some(data_manager) = context.website_data_manager() {
                data_manager.set_tls_errors_policy(TLSErrorsPolicy::Ignore);
                log::warn!("Linux WebKitGTK e2e mode is ignoring gateway certificate errors");
            } else {
                log::warn!("Unable to enable Linux WebKitGTK e2e certificate bypass: web context has no data manager");
            }
        } else {
            log::warn!("Unable to enable Linux WebKitGTK e2e certificate bypass: webview has no context");
        }
    }) {
        log::warn!("Unable to enable Linux WebKitGTK e2e certificate bypass: {error}");
    }
}

////////////////////////////////////////////////////////////

fn init_logger(file_name: &str) -> tauri_plugin_log::Builder {
    let mut logger = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(file_name.to_string()),
            },
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        // Keep recent oversized sessions instead of deleting them on the next app launch.
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .max_file_size(50_000_000)
        .with_colors(ColoredLevelConfig::default());

    // load rust log from runtime env, then build, then default
    let rust_log = std::env::var("RUST_LOG").unwrap_or(
        std::option_env!("RUST_LOG")
            .unwrap_or("info, russh=error, hyper=info, hyper_util=info")
            .to_string(),
    );

    for part in rust_log.split(',') {
        if let Some((target, level)) = part.split_once('=') {
            if let Ok(level) = level.parse::<log::LevelFilter>() {
                logger = logger.level_for(target.trim().to_owned(), level);
            }
        } else if let Ok(level) = part.parse::<log::LevelFilter>() {
            logger = logger.level(level);
        }
    }

    logger
}

fn init_config_instance_dir(
    app: &AppHandle,
    relative_config_dir: &PathBuf,
) -> Result<(), tauri::Error> {
    let config_instance_dir = app
        .path()
        .resolve(relative_config_dir, tauri::path::BaseDirectory::AppConfig)?;
    if !config_instance_dir.exists() {
        trace!(
            "Creating config directory at: {}",
            config_instance_dir.to_string_lossy()
        );
        std::fs::create_dir_all(&config_instance_dir).expect("Failed to create config directory");
    }
    Ok(())
}

fn reload_if_app_root_empty(window: WebviewWindow) {
    let reload_if_empty = r#"
      (() => {
        window.clearTimeout(window.__argonEmptyRootReloadTimer__);
        window.__argonEmptyRootReloadTimer__ = window.setTimeout(() => {
          if (document.readyState !== 'complete') return;

          const appRoot = document.querySelector('#app');
          if (appRoot?.firstElementChild) return;

          const cleanup = () => {
            delete window.__argonEmptyRootReloadTimer__;
            window.location.reload();
          };

          const invoke = window.__TAURI_INTERNALS__?.invoke;
          if (typeof invoke !== 'function') {
            cleanup();
            return;
          }

          invoke('report_empty_app_root_after_activation')
            .catch(() => null)
            .finally(cleanup);
        }, 2000);
      })();
    "#;

    if let Err(error) = window.eval(reload_if_empty) {
        log::warn!("Failed to inspect main webview after activation: {error}. Reloading window.");
        if let Err(reload_error) = window.reload() {
            log::error!("Failed to reload main webview after activation: {reload_error}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    color_backtrace::install();

    let context: tauri::Context = tauri::generate_context!();
    let app_id = context.config().identifier.clone();
    let network_name = Utils::get_network_name(&app_id);
    let instance_name = Utils::get_instance_name();
    let enable_auto_update = std::env::var("ARGON_APP_ENABLE_AUTOUPDATE")
        .ok()
        .is_none_or(|v| v == "true" || v == "1");
    let is_test = std::env::var("CI")
        .ok()
        .is_some_and(|v| v == "true" || v == "1");
    let e2e_headless = std::env::var("ARGON_E2E_HEADLESS")
        .ok()
        .is_some_and(|v| v == "true" || v == "1");
    #[cfg(target_os = "macos")]
    let e2e_driver_mode = std::env::var("ARGON_DRIVER_WS")
        .ok()
        .is_some_and(|v| !v.trim().is_empty());
    #[cfg(target_os = "macos")]
    let focus_e2e_app_window = std::env::var("ARGON_E2E_FOCUS_APP_WINDOW")
        .ok()
        .is_some_and(|v| v == "true" || v == "1");
    let log_file_prefix = format!("{network_name}-{instance_name}");
    let logger = init_logger(&log_file_prefix);

    let app_name = context.config().product_name.clone().unwrap_or_default();

    let relative_config_dir = Utils::get_relative_config_instance_dir(&app_id);
    let db_relative_path = relative_config_dir.join("database.sqlite");
    let db_url = format!("sqlite:{}", db_relative_path.display()).replace("\\", "/");
    let migrations = migrations::get_migrations();
    let network_name_clone = network_name.clone();
    let env_vars = Utils::get_server_env_vars(&app_id).unwrap_or_default();
    let env_vars_json = serde_json::to_string(&env_vars).unwrap_or_default();
    let network_config_override_json = std::env::var("ARGON_NETWORK_CONFIG_OVERRIDE")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map_or("null".to_string(), |v| v.to_string());

    let updater_target = tauri_plugin_updater::target().unwrap_or_default();
    println!("Updater target = {updater_target}");
    let app_name_clone = app_name.clone();
    let network_config_override_json_clone = network_config_override_json.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .on_page_load(move |window, _payload| {
            if window.label() != "main" {
                return;
            }

            #[cfg(target_os = "macos")]
            if e2e_driver_mode && !e2e_headless && !focus_e2e_app_window {
                let webview = window.clone();
                let webview_for_order = webview.clone();
                let _ = webview.run_on_main_thread(move || {
                    if let Ok(ns_window) = webview_for_order.window().ns_window() {
                        let ns_window = unsafe { &*(ns_window as *mut NSWindow) };
                        ns_window.orderBack(None);
                    }
                });
            }

            let handle = window.app_handle();
            let instance_name = Utils::get_instance_name();
            let app_id = &handle.config().identifier;

            log::info!("Page loaded for instance '{instance_name}'");
            window.emit("tauri://page-loaded", ()).unwrap();
            window
                .eval(format!(
                    r#"
        Object.assign(window, {{
            __LOG_DEBUG__: false,
            __ARGON_APP_ID__: '{app_id}',
            __ARGON_APP_NAME__: '{app_name_clone}',
            __ARGON_APP_INSTANCE__: '{instance_name}',
            __ARGON_LOG_FILE_PREFIX__: '{log_file_prefix}',
            __ARGON_APP_ENABLE_AUTOUPDATE__: {enable_auto_update},
            __ARGON_E2E_HEADLESS__: {e2e_headless},
            __ARGON_NETWORK_NAME__: '{network_name_clone}',
            __ARGON_NETWORK_CONFIG_OVERRIDE__: {network_config_override_json_clone},
            __SERVER_ENV_VARS__: {env_vars_json},
            __IS_TEST__: {is_test},
        }});
        "#
                ))
                .expect("Failed to initialize window globals");
        })
        .setup(move |app| {
            #[cfg(all(target_os = "macos", not(debug_assertions)))]
            if std::env::current_exe()
                .as_deref()
                .is_ok_and(is_running_from_mounted_volume)
            {
                use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

                log::error!("Refusing to start from a mounted macOS volume");
                let handle = app.handle().clone();
                app.dialog()
                    .message(
                        "Drag Argon Desktop into your Applications folder, eject the installer, \
                         and then open the copy from Applications.",
                    )
                    .title("Argon can’t run from the disk image")
                    .kind(MessageDialogKind::Error)
                    .show(move |_| handle.exit(1));
                return Ok(());
            }

            let handle = app.handle();
            let config_path = Utils::get_absolute_config_instance_dir(handle);
            log::info!(
                "Starting instance '{instance_name}' on network '{network_name}'. Config = {config_path:?}"
            );
            log::info!("Database URL = {}", db_relative_path.display());

            let nosleep = NoSleep::new().map_err(|e| e.to_string())?;
            app.manage(NoSleepState { nosleep: Mutex::new(Some(nosleep)) });
            app.manage(sql::SqliteWriter::default());
            app.manage(keychain::KeychainLock::default());
            app.manage(ssh_access::SshAccessState {
                access: Mutex::new(None),
            });

            init_config_instance_dir(handle, &relative_config_dir)?;
            tauri::async_runtime::block_on(run_db_migrations(handle.clone()))?;

            let window = app.get_webview_window("main").unwrap();

            #[cfg(all(target_os = "linux", feature = "e2e-insecure-gateway-certs"))]
            allow_e2e_insecure_gateway_certs(&window);

            let reload_window = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(true)) {
                    reload_if_app_root_empty(reload_window.clone());
                }
            });

            if e2e_headless {
                log::info!("E2E headless mode enabled (ARGON_E2E_HEADLESS)");

                if let Err(error) = window.hide() {
                    log::warn!("Unable to hide main window in e2e mode: {error}");
                }
            }

            #[cfg(target_os = "macos")]
            if e2e_driver_mode
                && !e2e_headless
                && let Ok(ns_window) = window.ns_window()
            {
                let ns_window = unsafe { &*(ns_window as *mut NSWindow) };
                ns_window.orderBack(None);
            }

            // Adjust window height if it exceeds available screen space
            if let Some(monitor) = window.current_monitor().ok().flatten() {
                let screen_size = monitor.size();
                let work_area = monitor.position();
                let current_size = window.outer_size().unwrap_or(tauri::PhysicalSize { width: 1400, height: 1000 });

                // Calculate available height (screen size minus any system UI)
                // work_area.y gives us the offset from top (menubar height on macOS)
                let available_height = screen_size.height.saturating_sub(work_area.y as u32);
                let new_height = current_size.height.min(available_height);

                if new_height != current_size.height {
                    log::info!("Adjusting window height from {} to {} (available height: {}, menubar offset: {})",
                        current_size.height, new_height, available_height, work_area.y);
                    let _ = window.set_size(tauri::PhysicalSize { width: current_size.width, height: new_height });
                }
            }

            #[cfg(target_os = "macos")]{
                apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, Some(16.0))
                    .expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");
            }

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(logger.build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new()
                .app_name(app_name)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().target(updater_target).build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&db_url, migrations)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_macos_permissions::init());

    builder
        .invoke_handler(tauri::generate_handler![
            system_authentication_option,
            request_system_authentication,
            keychain::keychain_info,
            keychain::keychain_create,
            keychain::keychain_write,
            keychain::keychain_set_protection,
            keychain::keychain_delete,
            keychain::keychain_encrypt,
            keychain::keychain_decrypt,
            keychain::keychain_authenticate,
            export_sr25519_seed,
            wallet_files::read_wallet_file,
            wallet_files::read_mnemonic_file,
            wallet_files::write_wallet_file,
            wallet_files::delete_wallet_file,
            wallet_files::cleanup_mnemonic_files,
            open_ssh_connection,
            close_ssh_connection,
            ssh_run_command,
            ssh_upload_file,
            ssh_download_file,
            ssh_upload_embedded_file,
            read_embedded_file,
            backup_current_instance_database_for_import,
            run_db_migrations,
            create_zip,
            collect_troubleshooting_os_profile,
            ssh_access::ssh_access_status,
            ssh_access::ssh_access_activate,
            ssh_access::ssh_access_deactivate,
            toggle_nosleep,
            calculate_free_space,
            vm::create_local_vm,
            vm::has_local_vm,
            vm::activate_local_vm,
            vm::remove_local_vm,
            vm::is_docker_running,
            vm::find_available_port,
            measure_latency,
            load_instance,
            report_empty_app_root_after_activation,
            e2e_capture_main_window_screenshot,
            sql::sql_begin_transaction,
            sql::sql_start_transaction_session,
            sql::sql_execute_write,
            sql::sql_select_write,
            sql::sql_execute,
            sql::sql_select,
            sql::sql_commit_transaction,
            sql::sql_rollback_transaction,
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{export_sr25519_seed, is_running_from_mounted_volume};
    use sp_core::{Pair, sr25519};
    use std::path::Path;

    #[test]
    fn exports_the_supplied_sr25519_path_without_loading_a_wallet() {
        let suri = "test test test test test test test test test test test junk//vaulting";
        let seed = export_sr25519_seed(suri.to_string()).unwrap();
        assert_eq!(
            sr25519::Pair::from_seed(&seed).public(),
            sr25519::Pair::from_string(suri, None).unwrap().public()
        );
        assert!(export_sr25519_seed(format!("{suri}/soft")).is_err());
    }

    #[test]
    fn detects_an_app_running_from_a_mounted_volume() {
        assert!(is_running_from_mounted_volume(Path::new(
            "/Volumes/Argon Desktop/Argon Desktop.app/Contents/MacOS/Argon Desktop"
        )));
    }

    #[test]
    fn allows_an_app_running_from_applications() {
        assert!(!is_running_from_mounted_volume(Path::new(
            "/Applications/Argon Desktop.app/Contents/MacOS/Argon Desktop"
        )));
    }

    #[test]
    fn does_not_match_a_similarly_named_directory() {
        assert!(!is_running_from_mounted_volume(Path::new(
            "/VolumesBackup/Argon Desktop.app/Contents/MacOS/Argon Desktop"
        )));
    }
}
