use crate::security::Security;
use crate::ssh;
use crate::ssh_pool;
use secrecy::{ExposeSecret, SecretString};
use sp_core::Pair;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

pub struct SshAccessState {
    pub access: Mutex<Option<SshAccessSession>>,
}

#[derive(Clone)]
pub struct SshAccessSession {
    private_key: SecretString,
    public_key: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAccessStatus {
    active: bool,
    public_key: Option<String>,
    private_key: Option<String>,
}

fn now_epoch() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[tauri::command]
pub async fn ssh_access_status(
    state: State<'_, SshAccessState>,
) -> Result<SshAccessStatus, String> {
    let guard = state.access.lock().await;
    if let Some(access) = guard.as_ref() {
        Ok(SshAccessStatus {
            active: true,
            public_key: Some(access.public_key.clone()),
            private_key: Some(access.private_key.expose_secret().to_string()),
        })
    } else {
        Ok(SshAccessStatus {
            active: false,
            public_key: None,
            private_key: None,
        })
    }
}

#[tauri::command]
pub async fn ssh_access_activate(
    app: AppHandle,
    state: State<'_, SshAccessState>,
    address: &str,
    host: &str,
    port: u16,
    username: String,
) -> Result<SshAccessStatus, String> {
    if state.access.lock().await.is_some() {
        let _ = clear_ssh_access(&app, &state, address, host, port, &username).await;
    }

    let private_key = Security::expose_private_key_openssh(&app).map_err(|e| e.to_string())?;
    let ssh = ssh_pool::open_connection(address, host, port, username, private_key)
        .await
        .map_err(|e| e.to_string())?;

    let (pair, _phrase, _seed) = sp_core::ed25519::Pair::generate_with_phrase(None);
    let (private_key_openssh, public_key_openssh) =
        ssh::SSH::format_as_openssh(pair).map_err(|e| e.to_string())?;
    let now = now_epoch();
    let comment = format!("argon-app-ssh:{}", now);
    let public_key_with_comment = format!("{} {}", public_key_openssh.trim(), comment);
    let public_key_material = public_key_openssh.trim().to_string();

    let add_cmd = format!(
        "grep -q '{key}' ~/.ssh/authorized_keys || echo '{line}' >> ~/.ssh/authorized_keys",
        key = public_key_material,
        line = public_key_with_comment
    );
    ssh.run_command(add_cmd).await.map_err(|e| e.to_string())?;

    *state.access.lock().await = Some(SshAccessSession {
        private_key: SecretString::new(private_key_openssh.clone()),
        public_key: public_key_openssh.clone(),
    });

    Ok(SshAccessStatus {
        active: true,
        public_key: Some(public_key_openssh),
        private_key: Some(private_key_openssh),
    })
}

#[tauri::command]
pub async fn ssh_access_deactivate(
    app: AppHandle,
    state: State<'_, SshAccessState>,
    address: &str,
    host: &str,
    port: u16,
    username: String,
) -> Result<SshAccessStatus, String> {
    let _ = clear_ssh_access(&app, &state, address, host, port, &username).await;
    Ok(SshAccessStatus {
        active: false,
        public_key: None,
        private_key: None,
    })
}

async fn clear_ssh_access(
    app: &AppHandle,
    state: &SshAccessState,
    address: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Result<(), String> {
    let access = state.access.lock().await.take();
    if let Some(access) = access {
        let private_key = Security::expose_private_key_openssh(app).map_err(|e| e.to_string())?;
        let ssh = ssh_pool::open_connection(address, host, port, username.to_string(), private_key)
            .await
            .map_err(|e| e.to_string())?;

        let remove_cmd = format!(
            "if [ -f ~/.ssh/authorized_keys ]; then grep -v '{key}' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys; fi",
            key = access.public_key.trim()
        );
        ssh.run_command(remove_cmd)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
