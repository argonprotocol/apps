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

#[derive(Clone)]
#[allow(clippy::upper_case_acronyms)]
pub struct SSH {
    client: Arc<Mutex<client::Handle<ClientHandler>>>,
    pub config: SSHConfig,
}

#[derive(Clone)]
pub struct SSHConfig {
    addrs: (String, u16),
    username: String,
    private_key_openssh: SecretString,
}

impl SSHConfig {
    pub fn new(
        host: &str,
        port: u16,
        username: String,
        private_key_openssh: SecretString,
    ) -> Result<Self> {
        let addrs = (host.to_string(), port);

        Ok(SSHConfig {
            addrs,
            username: username.to_string(),
            private_key_openssh,
        })
    }

    pub fn get_private_key(&self) -> Result<PrivateKey> {
        let private_key = decode_secret_key(self.private_key_openssh.expose_secret(), None)?;
        Ok(private_key)
    }

    pub fn host(&self) -> String {
        format!("{}:{}", self.addrs.0, self.addrs.1)
    }
}

impl PartialEq for SSHConfig {
    fn eq(&self, other: &Self) -> bool {
        self.addrs == other.addrs
            && self.username == other.username
            && self.private_key_openssh.expose_secret() == other.private_key_openssh.expose_secret()
    }
}

impl SSH {
    pub async fn connect(config: &SSHConfig, timeout_duration: Duration) -> Result<Self> {
        let client = timeout(timeout_duration, Self::authenticate(config))
            .await
            .map_err(|_| {
                anyhow::anyhow!("SSH connection timed out after {:?}", timeout_duration)
            })??;
        let ssh = SSH {
            client: Arc::new(Mutex::new(client)),
            config: config.clone(),
        };
        Ok(ssh)
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

    pub async fn reconnect(&self) -> Result<()> {
        let client = Self::authenticate(&self.config).await?;
        *self.client.lock().await = client;
        Ok(())
    }

    async fn open_channel(&self) -> Result<Channel<Msg>> {
        if let Ok(channel) = self.client.lock().await.channel_open_session().await {
            return Ok(channel);
        }

        self.reconnect().await?;
        Ok(self.client.lock().await.channel_open_session().await?)
    }

    pub async fn run_command(&self, command: impl Display) -> Result<(String, u32)> {
        let final_command = command.to_string().replace('\'', "'\\''");
        trace!("Executing ssh command: {}", final_command);
        let shell_command = format!("bash -c '{}'", final_command);
        let mut channel = self.open_channel().await?;
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

    pub async fn upload_file(&self, contents: &[u8], remote_path: &str) -> Result<()> {
        // First, create the script in the remote server's home directory
        let mut channel = self.open_channel().await?;
        let scp_command = format!("cat > {}", remote_path);
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
        let path = Utils::get_embedded_path(app, file_name)?;
        let file = File::open(&path).await?;

        // ensure old file is removed
        let _ = self.run_command(format!("rm -f {}", remote_path)).await;

        let mut channel = self.open_channel().await?;
        channel.exec(true, format!("cat > {}", remote_path)).await?;
        let mut writer = channel.make_writer();

        let file_size = file.metadata().await?.len();
        let mut reader = BufReader::new(file);
        let mut buffer = [0u8; 64 * 1024]; // 60KB buffer
        let mut total = 0;

        let mut last_percent = -1;
        loop {
            let n = reader.read(&mut buffer).await?;
            if n == 0 {
                break;
            }
            writer.write_all(&buffer[..n]).await?;
            total += n as u64;
            let percent = (total * 100 / file_size) as i32;
            if percent != last_percent {
                last_percent = percent;
                trace!("Uploading {}: {}%", file_name, percent);
                app.emit(&event_progress_key, percent)?;
            }
        }

        app.emit(&event_progress_key, 100)?;
        writer.shutdown().await?;
        channel.eof().await?;
        while channel.wait().await.is_some() {}

        Ok(())
    }

    pub async fn download_remote_file(
        &self,
        app: &AppHandle,
        remote_path: &str,
        local_download_path: &str,
        event_progress_key: String,
    ) -> Result<()> {
        // Escape the remote path safely for single-quoted shell
        let escaped_remote = format!("'{}'", remote_path.replace('\'', "'\\''"));

        // Best-effort: get remote file size for progress (may fail; then size=0)
        let mut remote_size: u64 = 0;
        if let Ok((out, _code)) = self
            .run_command(format!("stat -c %s {}", escaped_remote))
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
        let mut channel = self.open_channel().await?;
        channel
            .exec(true, format!("cat {}", escaped_remote))
            .await?;
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
                        app.emit(&event_progress_key, percent)?;
                    }
                }
            }
            writer.flush().await?;
        }
        channel.eof().await?;
        while channel.wait().await.is_some() {}

        // If size was unknown, emit 100% at the end so the UI completes
        app.emit(&event_progress_key, 100)?;
        Ok(())
    }

    pub async fn close(&self) {
        if let Ok(handle) = self.client.try_lock() {
            if handle.is_closed() {
                return;
            }

            log::info!("Closing existing SSH connection to {}", self.config.host());
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "English")
                .await
                .map_err(|e| {
                    let msg = e.to_string();
                    let is_benign = matches!(e,
                        russh::Error::SendError
                    ) || msg.contains("Channel send error")   // covers variant/name differences
                        || msg.contains("send error")
                        || msg.contains("connection closed");

                    if !is_benign {
                        log::error!("Error closing existing SSH connection: {:#}", e);
                    }
                });
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
