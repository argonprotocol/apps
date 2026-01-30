use crate::ssh::SSH;
use crate::ssh::SSHConfig;
use anyhow::Result;
use lazy_static::lazy_static;
use secrecy::SecretString;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::Mutex;

lazy_static! {
    static ref CONNECTIONS_BY_ADDRESS: Mutex<HashMap<String, SSH>> = Mutex::new(HashMap::new());
}

pub async fn close_connection(address: &str) -> Result<()> {
    let address = address.to_string();
    if let Some(ssh) = CONNECTIONS_BY_ADDRESS.lock().await.remove(&address) {
        ssh.close().await
    }

    Ok(())
}

pub async fn get_connection(address: &str) -> Result<Option<SSH>> {
    let address = address.to_string();
    Ok(CONNECTIONS_BY_ADDRESS.lock().await.get(&address).cloned())
}

pub async fn open_connection(
    address: &str,
    host: &str,
    port: u16,
    username: String,
    private_key_openssh: SecretString,
) -> Result<SSH> {
    let address = address.to_string();
    let ssh_config = SSHConfig::new(host, port, username, private_key_openssh)?;

    let timeout_duration = Duration::from_secs(10);
    if let Some(existing) = CONNECTIONS_BY_ADDRESS.lock().await.get_mut(&address) {
        if existing.config != ssh_config {
            log::info!("Closing connection to SSH: {:#}", existing.config.host());
            existing.close().await;

            log::info!(
                "Recreating SSH connection to {} with {:?} timeout",
                ssh_config.host(),
                timeout_duration
            );
            *existing = SSH::connect(&ssh_config, timeout_duration).await?;
        }
        return Ok(existing.clone());
    }

    log::info!(
        "Creating new SSH connection to {} with {:?} timeout",
        ssh_config.host(),
        timeout_duration
    );
    let ssh = SSH::connect(&ssh_config, timeout_duration).await?;
    CONNECTIONS_BY_ADDRESS
        .lock()
        .await
        .insert(address.clone(), ssh.clone());
    Ok(ssh)
}
