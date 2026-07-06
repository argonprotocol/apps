use crate::utils::Utils;
use anyhow::Result;
use log::trace;
use russh::client::{AuthResult, Msg};
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey};
use russh::keys::*;
use russh::*;
use secrecy::{ExposeSecret, SecretString};
use sp_core::ed25519;
use std::borrow::Cow;
use std::fmt::Display;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::sync::Mutex;
use tokio::time::timeout;

type SSHClient = client::Handle<ClientHandler>;

#[derive(Clone)]
#[allow(clippy::upper_case_acronyms)]
pub struct SSH {
    client: Arc<Mutex<SSHClient>>,
    transfer_client: Arc<Mutex<Option<SSHClient>>>,
    pub config: SSHConfig,
}

#[derive(Clone)]
pub struct SSHConfig {
    addrs: (String, u16),
    username: String,
    private_key_openssh: SecretString,
    public_key_openssh: String,
}

impl SSHConfig {
    pub fn new(
        host: &str,
        port: u16,
        username: String,
        private_key_openssh: SecretString,
    ) -> Result<Self> {
        let addrs = (host.to_string(), port);
        let public_key_openssh =
            SSHConfig::get_pubkey_from_privkey(private_key_openssh.expose_secret())?;

        Ok(SSHConfig {
            addrs,
            username: username.to_string(),
            private_key_openssh,
            public_key_openssh,
        })
    }

    pub fn get_private_key(&self) -> Result<PrivateKey> {
        let private_key = decode_secret_key(self.private_key_openssh.expose_secret(), None)?;
        Ok(private_key)
    }

    pub fn host(&self) -> String {
        format!("{}:{}", self.addrs.0, self.addrs.1)
    }

    pub fn get_pubkey_from_privkey(private_key_openssh: &str) -> Result<String> {
        let private_key = decode_secret_key(private_key_openssh, None)?;
        let public_key = PublicKey::from(&private_key);
        let public_key_openssh = public_key.to_openssh()?;
        Ok(public_key_openssh)
    }
}

impl PartialEq for SSHConfig {
    fn eq(&self, other: &Self) -> bool {
        self.addrs == other.addrs
            && self.username == other.username
            && self.public_key_openssh == other.public_key_openssh
    }
}

impl SSH {
    pub async fn connect(config: &SSHConfig, timeout_duration: Duration) -> Result<Self> {
        let client = Self::connect_client(config, timeout_duration).await?;
        let ssh = SSH {
            client: Arc::new(Mutex::new(client)),
            transfer_client: Arc::new(Mutex::new(None)),
            config: config.clone(),
        };
        Ok(ssh)
    }

    async fn connect_client(config: &SSHConfig, timeout_duration: Duration) -> Result<SSHClient> {
        timeout(timeout_duration, Self::authenticate(config))
            .await
            .map_err(|_| anyhow::anyhow!("SSH connection timed out after {timeout_duration:?}"))?
    }

    async fn authenticate(ssh_config: &SSHConfig) -> Result<client::Handle<ClientHandler>> {
        let mut config = client::Config {
            inactivity_timeout: None,
            ..<_>::default()
        };
        config.preferred = Preferred {
            kex: Cow::Borrowed(&[
                kex::CURVE25519,              // "curve25519-sha256"
                kex::CURVE25519_PRE_RFC_8731, // "curve25519-sha256@libssh.org"
            ]),
            ..Preferred::DEFAULT
        };
        let config = Arc::new(config);
        let handler = ClientHandler {};

        let mut client = client::connect(config, ssh_config.addrs.clone(), handler).await?;
        let private_key = ssh_config.get_private_key()?;
        let private_key = Arc::new(private_key);
        // use publickey authentication, with or without certificate
        let auth_res = client
            .authenticate_publickey(
                &ssh_config.username,
                PrivateKeyWithHashAlg::new(private_key, None),
            )
            .await?;

        if let AuthResult::Failure {
            remaining_methods,
            partial_success,
        } = auth_res
        {
            anyhow::bail!(
                "Authentication (with publickey) failed for {}: {:?} (partial success: {})",
                ssh_config.username,
                remaining_methods,
                partial_success
            );
        }
        Ok(client)
    }

    async fn reconnect_client(client: &mut SSHClient, config: &SSHConfig) -> Result<()> {
        *client = Self::authenticate(config).await?;
        Ok(())
    }

    async fn get_or_connect_client<'a>(
        client: &'a mut Option<SSHClient>,
        config: &SSHConfig,
        timeout_duration: Duration,
    ) -> Result<&'a mut SSHClient> {
        let needs_connect = match client {
            Some(client) => client.is_closed(),
            None => true,
        };

        if needs_connect {
            *client = Some(Self::connect_client(config, timeout_duration).await?);
        }

        Ok(client
            .as_mut()
            .expect("SSH transfer client should exist after connect"))
    }

    async fn open_channel_on_client(
        client: &mut SSHClient,
        config: &SSHConfig,
    ) -> Result<Channel<Msg>> {
        if let Ok(channel) = client.channel_open_session().await {
            return Ok(channel);
        }

        Self::reconnect_client(client, config).await?;
        Ok(client.channel_open_session().await?)
    }

    async fn run_command_on_client(
        client: &mut SSHClient,
        config: &SSHConfig,
        command: String,
    ) -> Result<(String, u32)> {
        let final_command = command.to_string().replace('\'', "'\\''");
        trace!("Executing ssh command: {final_command}");
        let shell_command = format!("bash -c '{final_command}'");
        let mut channel = Self::open_channel_on_client(client, config).await?;
        channel.exec(true, shell_command).await?;
        channel.eof().await?;

        let mut code = None;
        let mut output = String::new();

        loop {
            // There's an event available on the session channel
            let Some(msg) = channel.wait().await else {
                break;
            };
            match msg {
                // Collect stdout data
                russh::ChannelMsg::Data { ref data } => {
                    output.push_str(&String::from_utf8_lossy(data));
                }
                russh::ChannelMsg::ExtendedData { ref data, ext } => {
                    if ext == 1 {
                        // 1 is stderr
                        output.push_str(&String::from_utf8_lossy(data));
                    }
                }
                // The command has returned an exit code
                russh::ChannelMsg::ExitStatus { exit_status } => {
                    code = Some(exit_status);
                }
                _ => {}
            }
        }
        let _ = channel.close().await;
        let code = code.ok_or_else(|| anyhow::anyhow!("SSHCommandMissingExitStatus"))?;

        Ok((output, code))
    }

    pub async fn run_command(&self, command: impl Display) -> Result<(String, u32)> {
        let mut client = self.client.lock().await;
        Self::run_command_on_client(&mut client, &self.config, command.to_string()).await
    }

    pub async fn upload_file(&self, contents: &[u8], remote_path: &str) -> Result<()> {
        let contents = contents.to_vec();
        let remote_path = remote_path.to_string();
        let transfer_client = self.transfer_client.clone();
        let config = self.config.clone();
        let timeout_duration = Duration::from_secs(10);
        tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            tauri::async_runtime::block_on(async move {
                let mut client = transfer_client.lock().await;
                let client =
                    Self::get_or_connect_client(&mut client, &config, timeout_duration).await?;
                Self::upload_file_on_client(client, &config, &contents, &remote_path).await
            })
        })
        .await
        .map_err(|e| anyhow::anyhow!("SSH worker thread failed: {e}"))?
    }

    async fn upload_file_on_client(
        client: &mut SSHClient,
        config: &SSHConfig,
        contents: &[u8],
        remote_path: &str,
    ) -> Result<()> {
        let escaped_remote = shell_escape_remote_path(remote_path);
        let mut channel = Self::open_channel_on_client(client, config).await?;
        let scp_command = format!("cat > {escaped_remote}");
        channel.exec(true, scp_command).await?;

        // Write the contents of the setup script
        channel.data(contents).await?;
        channel.eof().await?;

        // Wait for the copy to complete
        while channel.wait().await.is_some() {}

        Ok(())
    }

    pub async fn upload_embedded_file(
        &self,
        app: &AppHandle,
        file_name: &str,
        remote_path: &str,
        event_progress_key: String,
    ) -> Result<()> {
        let app = app.clone();
        let file_name = file_name.to_string();
        let remote_path = remote_path.to_string();
        let transfer_client = self.transfer_client.clone();
        let config = self.config.clone();
        let timeout_duration = Duration::from_secs(10);
        tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            tauri::async_runtime::block_on(async move {
                let mut client = transfer_client.lock().await;
                let client =
                    Self::get_or_connect_client(&mut client, &config, timeout_duration).await?;
                Self::upload_embedded_file_on_client(
                    client,
                    &config,
                    &app,
                    &file_name,
                    &remote_path,
                    &event_progress_key,
                )
                .await
            })
        })
        .await
        .map_err(|e| anyhow::anyhow!("SSH worker thread failed: {e}"))?
    }

    async fn upload_embedded_file_on_client(
        client: &mut SSHClient,
        config: &SSHConfig,
        app: &AppHandle,
        file_name: &str,
        remote_path: &str,
        event_progress_key: &str,
    ) -> Result<()> {
        let path = Utils::get_embedded_path(app, file_name)?;
        let file = File::open(&path).await?;

        let escaped_remote = shell_escape_remote_path(remote_path);
        // ensure old file is removed
        let _ =
            Self::run_command_on_client(client, config, format!("rm -f {escaped_remote}")).await;

        let mut channel = Self::open_channel_on_client(client, config).await?;
        channel
            .exec(true, format!("cat > {escaped_remote}"))
            .await?;
        let mut writer = channel.make_writer();

        let file_size = file.metadata().await?.len();
        let mut reader = BufReader::new(file);
        let mut buffer = [0u8; 64 * 1024];
        let mut total = 0u64;
        let mut last_percent = -1;

        loop {
            let n = reader.read(&mut buffer).await?;
            if n == 0 {
                break;
            }

            writer.write_all(&buffer[..n]).await?;
            total += n as u64;

            if file_size > 0 {
                let percent = ((total.saturating_mul(100)) / file_size) as i32;
                if percent != last_percent {
                    last_percent = percent;
                    trace!("Uploading {file_name}: {percent}%");
                    app.emit(event_progress_key, percent)?;
                }
            }
        }

        writer.shutdown().await?;
        channel.eof().await?;
        while channel.wait().await.is_some() {}

        if last_percent < 100 {
            app.emit(event_progress_key, 100)?;
        }
        Ok(())
    }

    pub async fn download_remote_file(
        &self,
        app: &AppHandle,
        remote_path: &str,
        local_download_path: &str,
        event_progress_key: String,
    ) -> Result<()> {
        let app = app.clone();
        let remote_path = remote_path.to_string();
        let local_download_path = local_download_path.to_string();
        let transfer_client = self.transfer_client.clone();
        let config = self.config.clone();
        let timeout_duration = Duration::from_secs(10);
        tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            tauri::async_runtime::block_on(async move {
                let mut client = transfer_client.lock().await;
                let client =
                    Self::get_or_connect_client(&mut client, &config, timeout_duration).await?;
                Self::download_remote_file_on_client(
                    client,
                    &config,
                    &app,
                    &remote_path,
                    &local_download_path,
                    &event_progress_key,
                )
                .await
            })
        })
        .await
        .map_err(|e| anyhow::anyhow!("SSH worker thread failed: {e}"))?
    }

    async fn download_remote_file_on_client(
        client: &mut SSHClient,
        config: &SSHConfig,
        app: &AppHandle,
        remote_path: &str,
        local_download_path: &str,
        event_progress_key: &str,
    ) -> Result<()> {
        let escaped_remote = shell_escape_remote_path(remote_path);

        // Best-effort: get remote file size for progress (may fail; then size=0)
        let mut remote_size: u64 = 0;
        if let Ok((out, _code)) =
            Self::run_command_on_client(client, config, format!("stat -c %s {escaped_remote}"))
                .await
        {
            if let Ok(sz) = out.trim().parse::<u64>() {
                remote_size = sz;
            }
        }

        // Ensure local directory exists and create/truncate the file
        if let Some(parent) = std::path::Path::new(local_download_path).parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let file = File::create(local_download_path).await?;
        let mut writer = BufWriter::new(file);

        // Open a channel and stream the remote file via `cat`
        let mut channel = Self::open_channel_on_client(client, config).await?;
        channel.exec(true, format!("cat {escaped_remote}")).await?;
        {
            let mut reader = channel.make_reader();

            // Stream copy with progress
            let mut buf = [0u8; 64 * 1024]; // 64KB buffer
            let mut total: u64 = 0;
            let mut last_percent: i32 = -1;
            loop {
                let n = reader.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                writer.write_all(&buf[..n]).await?;
                total += n as u64;

                if remote_size > 0 {
                    let percent = ((total.saturating_mul(100)) / remote_size) as i32;
                    if percent != last_percent {
                        last_percent = percent;
                        app.emit(event_progress_key, percent)?;
                    }
                }
            }
            writer.flush().await?;
        }
        channel.eof().await?;
        while channel.wait().await.is_some() {}

        // If size was unknown, emit 100% at the end so the UI completes
        app.emit(event_progress_key, 100)?;
        Ok(())
    }

    async fn disconnect_client(client: &mut SSHClient, host: &str) {
        if client.is_closed() {
            return;
        }

        log::info!("Closing existing SSH connection to {host}");
        let _ = client
            .disconnect(Disconnect::ByApplication, "", "English")
            .await
            .map_err(|e| {
                let msg = e.to_string();
                let is_benign = matches!(e, russh::Error::SendError)
                    || msg.contains("Channel send error")
                    || msg.contains("send error")
                    || msg.contains("connection closed");

                if !is_benign {
                    log::error!("Error closing existing SSH connection: {e:#}");
                }
            });
    }

    pub async fn close(&self) {
        let host = self.config.host();

        if let Ok(mut handle) = self.client.try_lock() {
            Self::disconnect_client(&mut handle, &host).await;
        }

        if let Ok(mut handle) = self.transfer_client.try_lock() {
            if let Some(client) = handle.as_mut() {
                Self::disconnect_client(client, &host).await;
            }
            *handle = None;
        }
    }

    pub fn format_as_openssh(key: ed25519::Pair) -> Result<(String, String)> {
        // Generate a new key pair using Ed25519
        let bytes = key.seed();
        let keypair = Ed25519Keypair::from(Ed25519PrivateKey::from_bytes(&bytes));
        let private_key = PrivateKey::from(keypair);

        // Derive the public key from the private key
        let public_key = PublicKey::from(&private_key);

        // Convert to OpenSSH format
        let public_key_openssh = public_key.to_openssh()?;

        // Convert private key to OpenSSH format
        let private_key_openssh = private_key.to_openssh(LineEnding::LF)?.to_string();

        Ok((private_key_openssh, public_key_openssh))
    }
}

fn shell_escape_remote_path(remote_path: &str) -> String {
    let escape = |value: &str| value.replace('\'', "'\\''");

    if let Some(stripped) = remote_path.strip_prefix('~') {
        if stripped.is_empty() {
            return "~".to_string();
        }

        if let Some((user, rest)) = stripped.split_once('/') {
            let prefix = format!("~{user}/");
            return if rest.is_empty() {
                prefix.trim_end_matches('/').to_string()
            } else {
                format!("{prefix}'{}'", escape(rest))
            };
        }
    }

    format!("'{}'", escape(remote_path))
}

struct ClientHandler {}

// Explicitly implement Send for ClientHandler
unsafe impl Send for ClientHandler {}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}
