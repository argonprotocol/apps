use crate::utils::Utils;
use include_dir::{Dir, include_dir};
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Instant;
use tauri::AppHandle;

static VM_FILES: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../local-machine");
static VM_ACTIVATION: Mutex<()> = Mutex::new(());

pub struct Vm {
    pub ssh_port: u16,
}

#[tauri::command]
pub fn is_docker_running(_app: AppHandle) -> bool {
    // check if docker is running first
    let docker_check = Command::new("docker").arg("info").output();
    docker_check.is_ok() && docker_check.unwrap().status.success()
}

#[tauri::command]
pub fn find_available_port(starting_port: u16) -> Result<u16, String> {
    for port in starting_port..u16::MAX {
        if TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return Ok(port);
        }
    }

    Err(format!(
        "No available port found starting at {starting_port}"
    ))
}

#[tauri::command]
pub async fn create_local_vm(app: AppHandle, env_text: String) -> Result<u16, String> {
    let vm_path = get_vm_path(&app);
    let work_dir = get_vm_work_dir(&app);
    let vm = Vm::create(vm_path, work_dir, env_text)?;
    Ok(vm.ssh_port)
}

#[tauri::command]
pub fn has_local_vm(app: AppHandle) -> bool {
    has_vm_definition(&get_vm_path(&app))
}

#[tauri::command]
pub async fn activate_local_vm(app: AppHandle) -> Result<Option<u16>, String> {
    let vm_path = get_vm_path(&app);
    if !has_vm_definition(&vm_path) {
        return Ok(None);
    }
    let work_dir = get_vm_work_dir(&app);
    let vm = tauri::async_runtime::spawn_blocking(move || Vm::activate(&vm_path, &work_dir))
        .await
        .map_err(|e| format!("Local VM activation failed: {e}"))??;
    Ok(Some(vm.ssh_port))
}

#[tauri::command]
pub async fn remove_local_vm(app: AppHandle) -> Result<(), String> {
    let vm_path = get_vm_path(&app);
    Vm::destroy(&vm_path)?;
    Ok(())
}

fn get_vm_path(app: &AppHandle) -> PathBuf {
    Utils::get_absolute_config_instance_dir(app).join("virtual-machine")
}

fn get_vm_work_dir(app: &AppHandle) -> PathBuf {
    get_vm_path(app).join("app")
}

fn has_vm_definition(vm_path: &Path) -> bool {
    vm_path.join("docker-compose.yml").is_file()
}

#[cfg(unix)]
fn get_uid_gid() -> (u32, u32) {
    (unsafe { libc::getuid() }, unsafe { libc::getgid() })
}

#[cfg(windows)]
fn get_uid_gid() -> (u32, u32) {
    // Windows has no UID/GID. Return a sentinel
    (1000, 1000)
}

impl Vm {
    pub fn activate(vm_path: &Path, work_dir: &Path) -> anyhow::Result<Vm, String> {
        // Native commands survive webview reloads; serialize the Docker check/start boundary.
        let _activation = VM_ACTIVATION.lock().map_err(|e| e.to_string())?;
        if !vm_path.exists() {
            return Err(format!("VM path {} does not exist", vm_path.display()));
        }
        Self::start_inactive_services(vm_path)?;
        let server_dir = work_dir.join("server");
        if let Some(compose_dir) = [work_dir, server_dir.as_path()].into_iter().find(|dir| {
            [
                "compose.yaml",
                "compose.yml",
                "docker-compose.yaml",
                "docker-compose.yml",
            ]
            .iter()
            .any(|file_name| dir.join(file_name).exists())
        }) {
            Self::start_inactive_services(compose_dir)?;
        }
        Self::get_vm(vm_path)
    }

    pub fn create(
        vm_path: PathBuf,
        work_dir: PathBuf,
        mut env_text: String,
    ) -> anyhow::Result<Vm, String> {
        let nginx_certs_dir = work_dir.join("config").join("nginx-certs");
        let tmp_nginx_certs_dir = vm_path.with_file_name("nginx-certs.tmp");

        if vm_path.exists() {
            if nginx_certs_dir.exists() {
                fs::rename(&nginx_certs_dir, &tmp_nginx_certs_dir).map_err(|e| {
                    format!(
                        "Error moving nginx cert directory {} to {}: {}",
                        nginx_certs_dir.display(),
                        tmp_nginx_certs_dir.display(),
                        e
                    )
                })?;
            }

            std::fs::remove_dir_all(&vm_path)
                .map_err(|e| format!("Error removing VM directory {}: {}", vm_path.display(), e))?;
        }

        if !vm_path.exists() {
            fs::create_dir_all(&vm_path)
                .map_err(|e| format!("Error creating directory {}: {}", vm_path.display(), e))?;
        }

        let env_path = vm_path.join(".env");
        let (uid, gid) = get_uid_gid();
        env_text.push_str(&format!("\nUID={uid}\nGID={gid}\n"));
        fs::write(&env_path, env_text)
            .map_err(|e| format!("Error writing file {}: {}", env_path.display(), e))?;

        for file in VM_FILES.files() {
            let relative_path = file.path();
            let target_path = vm_path.join(relative_path);
            fs::write(&target_path, file.contents())
                .map_err(|e| format!("Error copying file to {}: {}", target_path.display(), e))?;
        }

        if !work_dir.exists() {
            fs::create_dir_all(&work_dir)
                .map_err(|e| format!("Error creating directory {}: {}", work_dir.display(), e))?;
        }
        if tmp_nginx_certs_dir.exists() {
            fs::create_dir_all(nginx_certs_dir.parent().unwrap()).map_err(|e| {
                format!(
                    "Error creating nginx config directory for {}: {}",
                    nginx_certs_dir.display(),
                    e
                )
            })?;
            fs::rename(&tmp_nginx_certs_dir, &nginx_certs_dir).map_err(|e| {
                format!(
                    "Error restoring nginx cert directory {} to {}: {}",
                    tmp_nginx_certs_dir.display(),
                    nginx_certs_dir.display(),
                    e
                )
            })?;
        }

        Self::run_compose_command(&vm_path, &["up", "--build", "-d", "--wait"])?;
        Self::get_vm(&vm_path)
    }

    pub fn get_vm(vm_path: &Path) -> anyhow::Result<Vm, String> {
        if !vm_path.exists() {
            return Err(format!("VM path {} does not exist", vm_path.display()));
        }
        let port_output = Self::run_compose_command(vm_path, &["port", "vm", "22"])?;
        let port = port_output
            .split(':')
            .next_back()
            .ok_or("Failed to parse port")?;
        log::info!("VM SSH port: {port}");
        let vm_port = port.parse::<u16>().map_err(|e| e.to_string())?;
        Ok(Vm { ssh_port: vm_port })
    }

    pub fn destroy(vm_path: &Path) -> anyhow::Result<(), String> {
        log::info!("Removing local VM at {}", vm_path.display());
        if !vm_path.exists() {
            return Ok(());
        }
        let server_path = vm_path.join("server");
        if server_path.exists() {
            Self::run_compose_command(&server_path, &["down", "--rmi", "all"])?;
        }

        Self::run_compose_command(vm_path, &["down", "--rmi", "all"])?;
        std::fs::remove_dir_all(vm_path)
            .map_err(|e| format!("Error removing VM directory {}: {}", vm_path.display(), e))?;

        Ok(())
    }

    fn start_inactive_services(compose_dir: &Path) -> Result<(), String> {
        let configured = Self::run_compose_command(compose_dir, &["config", "--services"])?;
        let active = Self::run_compose_command(
            compose_dir,
            &[
                "ps",
                "--status",
                "running",
                "--status",
                "restarting",
                "--services",
            ],
        )?;
        let inactive: Vec<_> = configured
            .lines()
            .filter(|service| !active.lines().any(|running| running == *service))
            .collect();
        if inactive.is_empty() {
            return Ok(());
        }

        // Installation owns configuration updates. Reconnect only starts missing/stopped services.
        let mut args = vec!["up", "-d", "--no-recreate"];
        args.extend(inactive);
        Self::run_compose_command(compose_dir, &args)?;
        Ok(())
    }

    fn run_compose_command(vm_path: &Path, args: &[&str]) -> anyhow::Result<String, String> {
        let started = Instant::now();
        log::info!("Starting docker compose {args:?}");
        let mut command = Command::new("docker");
        command.arg("compose");
        if cfg!(debug_assertions) && args.contains(&"--build") {
            command.args(["--progress", "plain"]);
        }
        let output = command
            .args(args)
            .current_dir(vm_path)
            .output()
            .map_err(|e| format!("Failed to run docker compose: {e} at {vm_path:?}. {args:?}"))?;
        log::info!(
            "Finished docker compose {args:?} in {:?}, success={}",
            started.elapsed(),
            output.status.success()
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if cfg!(debug_assertions) && args.contains(&"--build") {
            // Build instructions expand SSH_PUBKEY. Keep only phase labels and completion timings.
            for line in stdout.lines().chain(stderr.lines()) {
                if let Some(progress) = compose_build_progress(line) {
                    log::info!("Docker build: {progress}");
                }
            }
        }

        if !output.status.success() {
            return Err(format!("docker compose {args:?} failed: {stderr}"));
        }
        Ok(stdout.trim().to_string())
    }
}

fn compose_build_progress(line: &str) -> Option<&str> {
    let (step, progress) = line.split_once(' ')?;
    let number = step.strip_prefix('#')?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    if progress.starts_with('[') {
        return line.find(']').map(|end| &line[..=end]);
    }
    if progress == "CACHED" || progress == "DONE" || progress.starts_with("DONE ") {
        return Some(line);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{Vm, compose_build_progress, has_vm_definition};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn build_progress_omits_expanded_keys_and_command_output() {
        assert_eq!(
            compose_build_progress(
                "#11 [7/12] RUN echo \"ssh-ed25519 synthetic-test-key\" > /root/.ssh/authorized_keys"
            ),
            Some("#11 [7/12]")
        );
        assert_eq!(
            compose_build_progress("#11 DONE 1.3s"),
            Some("#11 DONE 1.3s")
        );
        assert_eq!(compose_build_progress("#11 CACHED"), Some("#11 CACHED"));
        assert_eq!(
            compose_build_progress("#11 0.3 ssh-ed25519 synthetic-test-key"),
            None
        );
        assert_eq!(
            compose_build_progress("ssh-ed25519 synthetic-test-key"),
            None
        );
    }

    #[test]
    fn gateway_cert_staging_directory_is_not_an_installed_vm() {
        let unique_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let test_vm_path = std::env::temp_dir().join(format!(
            "argon-vm-definition-{}-{unique_id}",
            std::process::id()
        ));
        fs::create_dir_all(test_vm_path.join("app/config/nginx-certs")).unwrap();

        assert!(!has_vm_definition(&test_vm_path));

        fs::write(test_vm_path.join("docker-compose.yml"), "services: {}").unwrap();
        assert!(has_vm_definition(&test_vm_path));

        fs::remove_dir_all(test_vm_path).unwrap();
    }

    #[test]
    #[ignore = "Requires Docker and the alpine:3.17 image"]
    fn activation_preserves_running_containers_and_resumes_stopped_services() {
        let unique_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let project = format!("argon-vm-activation-{}-{unique_id}", std::process::id());
        let vm_path = std::env::temp_dir().join(&project);
        let work_dir = vm_path.join("app");
        let server_dir = work_dir.join("server");
        fs::create_dir_all(&server_dir).unwrap();
        for dir in [&vm_path, &server_dir] {
            fs::write(
                dir.join(".env"),
                format!("COMPOSE_PROJECT_NAME={project}\n"),
            )
            .unwrap();
        }
        fs::write(
            vm_path.join("docker-compose.yml"),
            "services:\n  vm:\n    image: alpine:3.17\n    command: sleep 600\n    ports: ['127.0.0.1:0:22']\n",
        )
        .unwrap();
        let server_compose = "services:\n  router:\n    image: alpine:3.17\n    command: sleep 600\n  worker:\n    image: alpine:3.17\n    command: sleep 600\n    profiles: [miners]\n";
        fs::write(server_dir.join("compose.yaml"), server_compose).unwrap();

        let result = std::panic::catch_unwind(|| {
            let vm = std::thread::scope(|scope| {
                let first = scope.spawn(|| Vm::activate(&vm_path, &work_dir));
                let second = scope.spawn(|| Vm::activate(&vm_path, &work_dir));
                let vm = first.join().unwrap().unwrap();
                assert_eq!(second.join().unwrap().unwrap().ssh_port, vm.ssh_port);
                vm
            });
            let vm_id = Vm::run_compose_command(&vm_path, &["ps", "--quiet", "vm"]).unwrap();
            let router_id =
                Vm::run_compose_command(&server_dir, &["ps", "--quiet", "router"]).unwrap();
            assert!(!vm_id.is_empty());
            assert!(!router_id.is_empty());
            assert!(
                Vm::run_compose_command(&server_dir, &["ps", "--all", "--quiet", "worker"])
                    .unwrap()
                    .is_empty()
            );

            // Reconnecting must not apply installer-owned configuration changes.
            fs::write(
                server_dir.join("compose.yaml"),
                server_compose.replace("sleep 600", "sleep 601"),
            )
            .unwrap();
            std::thread::scope(|scope| {
                let first = scope.spawn(|| Vm::activate(&vm_path, &work_dir));
                let second = scope.spawn(|| Vm::activate(&vm_path, &work_dir));
                assert_eq!(first.join().unwrap().unwrap().ssh_port, vm.ssh_port);
                assert_eq!(second.join().unwrap().unwrap().ssh_port, vm.ssh_port);
            });
            assert_eq!(
                Vm::run_compose_command(&server_dir, &["ps", "--quiet", "router"]).unwrap(),
                router_id
            );

            // A partial shutdown must resume the existing container and start a missing active service.
            Vm::run_compose_command(&server_dir, &["stop", "router"]).unwrap();
            fs::write(
                server_dir.join(".env"),
                format!("COMPOSE_PROJECT_NAME={project}\nCOMPOSE_PROFILES=miners\n"),
            )
            .unwrap();
            assert_eq!(
                Vm::activate(&vm_path, &work_dir).unwrap().ssh_port,
                vm.ssh_port
            );
            assert_eq!(
                Vm::run_compose_command(&server_dir, &["ps", "--quiet", "router"]).unwrap(),
                router_id
            );
            assert_eq!(
                Vm::run_compose_command(&vm_path, &["ps", "--quiet", "vm"]).unwrap(),
                vm_id
            );
            assert!(
                !Vm::run_compose_command(&server_dir, &["ps", "--quiet", "worker"])
                    .unwrap()
                    .is_empty()
            );
        });

        let cleanup = Vm::run_compose_command(&vm_path, &["down", "--remove-orphans", "--volumes"]);
        fs::remove_dir_all(&vm_path).unwrap();
        cleanup.unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
}
