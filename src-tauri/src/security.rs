use russh::keys::PrivateKey;
use russh::keys::ssh_encoding::LineEnding;
use sp_core::crypto::AddressUri;
use sp_core::{DeriveJunction, Pair, ed25519};
use std::fs;
#[cfg(not(target_os = "windows"))]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use tauri::AppHandle;

use crate::ssh::SSHConfig;
use crate::{ssh::SSH, utils::Utils};

#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub master_mnemonic: String,
    pub ssh_public_key: String,
}

impl Security {
    pub fn get_private_key_path(app: &AppHandle) -> PathBuf {
        let absolute_config_dir = Utils::get_absolute_config_instance_dir(app);
        absolute_config_dir.join("serverkey.pem")
    }

    pub fn expose_private_key_openssh(app: &AppHandle) -> anyhow::Result<String> {
        let private_key = Self::expose_private_key(app)?;
        let private_key = private_key.to_openssh(LineEnding::LF)?;
        Ok(private_key.to_string())
    }

    pub fn expose_private_key(app: &AppHandle) -> anyhow::Result<PrivateKey> {
        let private_key_path = Self::get_private_key_path(app);
        let private_key = SSHConfig::read_private_key(&private_key_path)?;
        Ok(private_key)
    }

    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let absolute_config_dir = Utils::get_absolute_config_instance_dir(app);
        let mnemonic_file_path = absolute_config_dir.join("mnemonic");
        let private_key_path = Self::get_private_key_path(app);

        if mnemonic_file_path.exists() && private_key_path.exists() {
            // Load mnemonics
            let master_mnemonic = fs::read_to_string(&mnemonic_file_path)?;

            // Load SSH keys
            let ssh_public_key = SSHConfig::get_pubkey_from_privkey_file(&private_key_path)?;

            Ok(Self {
                ssh_public_key,
                master_mnemonic,
            })
        } else {
            Security::create(app)
        }
    }

    fn derive_ssh_key_from_mnemonic(
        mnemonic: &str,
    ) -> Result<(String, String), Box<dyn std::error::Error>> {
        let (pair, _seed) = ed25519::Pair::from_phrase(mnemonic, None)?;
        let suri = AddressUri::parse("//ssh-ed25519//1")?;
        let ssh_derive = suri.paths.iter().map(DeriveJunction::from);
        let (ssh_key, _seed) = pair.derive(ssh_derive, None)?;
        let (private_key, public_key) = SSH::format_as_openssh(ssh_key)?;
        Ok((private_key, public_key))
    }

    pub fn save_with_mnemonic(
        app: &AppHandle,
        mnemonic: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (private_key, public_key) = Self::derive_ssh_key_from_mnemonic(mnemonic)?;
        let config_dir = Utils::get_absolute_config_instance_dir(app);
        let ssh_private_key_path = Self::get_private_key_path(app);
        fs::create_dir_all(&config_dir)?;
        fs::write(&ssh_private_key_path, private_key)?;
        // Set private key permissions to 600
        #[cfg(not(target_os = "windows"))]
        {
            let mut perms = fs::metadata(&ssh_private_key_path)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&ssh_private_key_path, perms)?;
        }

        let master_mnemonic = mnemonic.to_string();
        // Save mnemonics
        fs::write(config_dir.join("mnemonic"), &master_mnemonic)?;

        Ok(Self {
            master_mnemonic,
            ssh_public_key: public_key,
        })
    }

    pub fn create(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let (_pair, phrase, _seed) = ed25519::Pair::generate_with_phrase(None);
        Self::save_with_mnemonic(app, &phrase)
    }
}
