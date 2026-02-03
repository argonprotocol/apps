use log::trace;
use nosleep::{NoSleep, NoSleepType};
use secrecy::ExposeSecret;
use sp_core::Pair;
use sp_core::crypto::Ss58Codec;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tauri::{Emitter, State};
use tauri_plugin_log::fern::colors::ColoredLevelConfig;
use time::OffsetDateTime;
use tokio::sync::Mutex;
use utils::Utils;
#[cfg(target_os = "macos")]
use window_vibrancy::*;
use zip::DateTime;

mod migrations;
mod security;
mod ssh;
mod ssh_access;
mod ssh_pool;
mod utils;
mod vm;

struct NoSleepState {
    nosleep: Mutex<Option<NoSleep>>,
}

#[tauri::command]
async fn open_ssh_connection(
    app: AppHandle,
    address: &str,
    host: &str,
    port: u16,
    username: String,
) -> Result<String, String> {
    log::info!("ensure_ssh_connection");
    let private_key =
        security::Security::expose_private_key_openssh(&app).map_err(|e| e.to_string())?;
    ssh_pool::open_connection(address, host, port, username, private_key)
        .await
        .map_err(|e| {
            log::error!("Error connecting to SSH: {:#}", e);
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
    let ssh: ssh::SSH = ssh_pool::get_connection(address)
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
) -> Result<String, String> {
    log::info!("ssh_upload_file: {}", remote_path);
    let ssh: ssh::SSH = ssh_pool::get_connection(address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No SSH connection")?;
    ssh.upload_file(contents.as_bytes(), &remote_path)
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
    log::info!("ssh_download_file: {}, {}", remote_path, download_path);
    let ssh: ssh::SSH = ssh_pool::get_connection(address)
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
) -> Result<String, String> {
    log::info!(
        "ssh_upload_embedded_file: {}, {}",
        local_relative_path,
        remote_path
    );
    let ssh: ssh::SSH = ssh_pool::get_connection(address)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No SSH connection")?;
    ssh.upload_embedded_file(&app, &local_relative_path, &remote_path, event_progress_key)
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
    log::info!("read_embedded_file: {}", local_relative_path);
    let absolute_local_path = Utils::get_embedded_path(&app, local_relative_path.clone())
        .map_err(|e| format!("Error resolving embedded path: {}", e))?;

    if !absolute_local_path.exists() {
        return Err(format!("File does not exist: {}", local_relative_path).to_string());
    }

    let content = fs::read_to_string(&absolute_local_path)
        .map_err(|e| format!("Error reading file {}: {}", local_relative_path, e))?;
    Ok(content)
}

#[tauri::command]
async fn overwrite_mnemonic(
    app: AppHandle,
    mnemonic: String,
) -> Result<security::Security, String> {
    log::info!("overwrite_mnemonic");
    let security =
        security::Security::save_with_mnemonic(&app, &mnemonic).map_err(|e| e.to_string())?;
    Ok(security)
}

#[tauri::command]
async fn expose_mnemonic(app: AppHandle) -> Result<String, String> {
    let master_mnemonic = Security::expose_mnemonic(&app).map_err(|err| err.to_string())?;
    Ok(master_mnemonic)
}

#[tauri::command]
async fn derive_sr25519_seed(app: AppHandle, suri: &str) -> Result<[u8; 32], String> {
    let (_pair, seed) = Security::sr_derive(&app, suri).map_err(|e| e.to_string())?;
    Ok(seed)
}

#[tauri::command]
async fn derive_sr25519_address(app: AppHandle, suris: Vec<String>) -> Result<Vec<String>, String> {
    let result = suris
        .into_iter()
        .map(|suri| {
            let (pair, _seed) = Security::sr_derive(&app, &suri).map_err(|e| e.to_string())?;
            let address = pair.public().to_ss58check();
            Ok(address)
        })
        .collect::<Result<Vec<String>, String>>()?;
    Ok(result)
}

#[tauri::command]
async fn derive_ed25519_seed(app: AppHandle, suri: &str) -> Result<[u8; 32], String> {
    let (_pair, seed) = Security::ed_derive(&app, suri).map_err(|e| e.to_string())?;
    Ok(seed)
}

#[tauri::command]
async fn derive_bitcoin_extended_key(
    app: AppHandle,
    hd_path: &str,
    version: u32,
) -> Result<String, String> {
    let extended_key =
        Security::derive_bitcoin_extended_key(&app, hd_path, version).map_err(|e| e.to_string())?;
    let bs58_key = format!("{}", extended_key);
    Ok(bs58_key)
}

#[tauri::command]
async fn run_db_migrations(app: AppHandle) -> Result<(), String> {
    log::info!("run_db_migrations");
    let absolute_db_path = Utils::get_absolute_config_instance_dir(&app).join("database.sqlite");
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
    paths_with_prefixes: Vec<(PathBuf, PathBuf)>,
    zip_name: PathBuf,
) -> Result<PathBuf, String> {
    let file = fs::File::create(&zip_name).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default();

    for (prefix, p) in paths_with_prefixes {
        // Walk children and prefix entries with the root directory name
        for entry in walkdir::WalkDir::new(&p).into_iter().flatten() {
            if entry.file_type().is_dir() {
                continue;
            }
            let path = entry.path();
            let rel = if p.is_file() {
                // If the path is a file, we need to strip the parent directory
                path.strip_prefix(p.parent().unwrap_or(&PathBuf::from("")))
            } else {
                path.strip_prefix(&p)
            }
            .unwrap_or(path);

            println!(
                "Processing entry: {} {}",
                rel.display(),
                path.to_string_lossy()
            );

            // Skip the directory itself; it"s already added
            if rel.as_os_str().is_empty() {
                continue;
            }

            let name = prefix.join(rel).to_string_lossy().replace("\\", "/");
            let mut file_opts = opts;
            if let Ok(mtime) = entry.metadata().map_err(|e| e.to_string())?.modified() {
                if let Ok(zdt) = DateTime::try_from(OffsetDateTime::from(mtime)) {
                    file_opts = file_opts.last_modified_time(zdt);
                }
            }
            zip.start_file(name, file_opts).map_err(|e| e.to_string())?;
            let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(zip_name)
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
    log::info!("Loading instance: {}", name);
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

////////////////////////////////////////////////////////////

fn init_logger(network_name: &String, instance_name: &String) -> tauri_plugin_log::Builder {
    let mut logger = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(format!("{}-{}", network_name, instance_name)),
            },
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        .max_file_size(10_000_000)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    color_backtrace::install();

    let context: tauri::Context = tauri::generate_context!();
    let app_id = context.config().identifier.clone();
    let network_name = Utils::get_network_name(&app_id);
    let instance_name = Utils::get_instance_name();
    let enable_auto_update =
        option_env!("ARGON_APP_ENABLE_AUTOUPDATE").map_or(true, |v| v == "true");
    let is_test = option_env!("CI").map_or(false, |v| v == "true" || v == "1");
    let logger = init_logger(&network_name, &instance_name);

    let app_name = context.config().product_name.clone().unwrap_or_default();

    let relative_config_dir = Utils::get_relative_config_instance_dir(&app_id);
    let db_relative_path = relative_config_dir.join("database.sqlite");
    let db_url = format!("sqlite:{}", db_relative_path.display()).replace("\\", "/");
    let migrations = migrations::get_migrations();

    let network_name_clone = network_name.clone();
    let env_vars = Utils::get_server_env_vars(&app_id).unwrap_or_default();
    let env_vars_json = serde_json::to_string(&env_vars).unwrap_or_default();

    let mut updater_target = tauri_plugin_updater::target().unwrap_or_default();
    if cfg!(debug_assertions) {
        updater_target += "-debug";
    }

    println!("Updater target = {}", updater_target);
    let app_name_clone = app_name.clone();

    tauri::Builder::default()
        .on_page_load(move |window, _payload| {
            if window.label() != "main" {
              return;
            }
            let handle = window.app_handle();
            let instance_name = Utils::get_instance_name();
            let security = security::Security::load(handle);
            let security_json = match security {
                Ok(sec) => serde_json::to_string(&sec).unwrap_or_else(|e| {
                    log::error!("Failed to serialize security config: {}", e);
                    "null".to_string()
                }),
                Err(e) => {
                    log::error!("Failed to load security config: {}", e);
                    "null".to_string()
                }
            };
            let app_id = &handle.config().identifier;

            log::info!("Page loaded for instance '{}'", instance_name);
            window.emit("tauri://page-loaded", ()).unwrap();
            window
                .eval(format!(
                    r#"
        Object.assign(window, {{
            __LOG_DEBUG__: false,
            __ARGON_APP_ID__: '{app_id}',
            __ARGON_APP_NAME__: '{app_name_clone}',
            __ARGON_APP_SECURITY__: {security_json},
            __ARGON_APP_INSTANCE__: '{instance_name}',
            __ARGON_APP_ENABLE_AUTOUPDATE__: {enable_auto_update},
            __ARGON_NETWORK_NAME__: '{network_name_clone}',
            __SERVER_ENV_VARS__: {env_vars_json},
            __IS_TEST__: {is_test},
        }});
        "#
                ))
                .expect("Failed to initialize window globals");
          })
        .setup(move |app| {
            let handle = app.handle();
            let config_path = Utils::get_absolute_config_instance_dir(handle);
            log::info!(
                "Starting instance '{}' on network '{}'. Config = {:?}",
                instance_name,
                network_name,
                config_path
            );
            log::info!("Database URL = {}", db_relative_path.display());

            let nosleep = NoSleep::new().map_err(|e| e.to_string())?;
            app.manage(NoSleepState { nosleep: Mutex::new(Some(nosleep)) });
            app.manage(ssh_access::SshAccessState {
                access: Mutex::new(None),
            });

            init_config_instance_dir(handle, &relative_config_dir)?;

            let window = app.get_webview_window("main").unwrap();

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
        .invoke_handler(tauri::generate_handler![
            open_ssh_connection,
            close_ssh_connection,
            ssh_run_command,
            ssh_upload_file,
            ssh_download_file,
            ssh_upload_embedded_file,
            read_embedded_file,
            run_db_migrations,
            create_zip,
            ssh_access::ssh_access_status,
            ssh_access::ssh_access_activate,
            ssh_access::ssh_access_deactivate,
            toggle_nosleep,
            calculate_free_space,
            vm::create_local_vm,
            vm::activate_local_vm,
            vm::remove_local_vm,
            vm::is_docker_running,
            vm::check_needed_ports,
            derive_sr25519_seed,
            derive_sr25519_address,
            derive_ed25519_seed,
            derive_bitcoin_extended_key,
            expose_mnemonic,
            overwrite_mnemonic,
            measure_latency,
            load_instance,
            ssh_access::ssh_access_activate,
            ssh_access::ssh_access_status,
            ssh_access::ssh_access_deactivate,
        ])
        .run(context)
        .expect("error while running tauri application");
}
