use bip32::{ExtendedKey, Prefix, XPrv};
use russh::keys::PrivateKey;
use russh::keys::ssh_encoding::LineEnding;
use sp_core::crypto::AddressUri;
use sp_core::crypto::Ss58Codec;
use sp_core::{DeriveJunction, Pair, ed25519, sr25519};
use std::fs;
#[cfg(not(target_os = "windows"))]
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::AppHandle;

use crate::ssh::SSHConfig;
use crate::{ssh::SSH, utils::Utils};

#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub vaulting_address: String,
    pub mining_address: String,
    pub ssh_public_key: String,
}

impl Security {
    pub fn get_ssh_private_key_path(app: &AppHandle) -> PathBuf {
        let absolute_config_dir = Utils::get_absolute_config_instance_dir(app);
        absolute_config_dir.join("serverkey.pem")
    }

    pub fn expose_private_key_openssh(app: &AppHandle) -> anyhow::Result<String> {
        let private_key = Self::expose_ssh_private_key(app)?;
        let private_key = private_key.to_openssh(LineEnding::LF)?;
        Ok(private_key.to_string())
    }

    pub fn expose_ssh_private_key(app: &AppHandle) -> anyhow::Result<PrivateKey> {
        let private_key_path = Self::get_ssh_private_key_path(app);
        let private_key = SSHConfig::read_private_key(&private_key_path)?;
        Ok(private_key)
    }

    fn mnemonic_path(app: &AppHandle) -> PathBuf {
        let absolute_config_dir = Utils::get_absolute_config_instance_dir(app);
        absolute_config_dir.join("mnemonic")
    }

    pub fn derive_bitcoin_extended_key(
        app: &AppHandle,
        hd_path: &str,
        version: u32,
    ) -> Result<ExtendedKey, Box<dyn std::error::Error>> {
        let master_mnemonic = Self::expose_mnemonic(app)?;
        let seed = bip39::Mnemonic::from_str(&master_mnemonic)
            .map_err(|e| e.to_string())?
            .to_seed("");
        let path = bip32::DerivationPath::from_str(hd_path).map_err(|e| e.to_string())?;
        let hd_key: XPrv =
            bip32::XPrv::derive_from_path(seed, &path).map_err(|e| e.to_string())?;

        let prefix = Prefix::try_from(version).map_err(|e| e.to_string())?;

        let extended_key = hd_key.to_extended_key(prefix);
        Ok(extended_key)
    }

    pub fn expose_mnemonic(app: &AppHandle) -> Result<String, Box<dyn std::error::Error>> {
        let mnemonic_file_path = Self::mnemonic_path(app);
        let master_mnemonic = fs::read_to_string(&mnemonic_file_path)?;
        Ok(master_mnemonic)
    }

    pub fn sr_derive(
        app: &AppHandle,
        suri: &str,
    ) -> Result<(sr25519::Pair, [u8; 32]), Box<dyn std::error::Error>> {
        let mnemonic = Self::expose_mnemonic(app)?;
        Self::sr_derive_from_mnemonic(&mnemonic, suri)
    }

    fn sr_derive_from_mnemonic(
        mnemonic: &str,
        suri: &str,
    ) -> Result<(sr25519::Pair, [u8; 32]), Box<dyn std::error::Error>> {
        let (pair, seed) = sr25519::Pair::from_phrase(mnemonic, None)?;
        let suri = AddressUri::parse(suri)?;
        let ssh_derive = suri.paths.iter().map(DeriveJunction::from);
        let (derived_pair, seed) = pair.derive(ssh_derive, Some(seed))?;
        Ok((
            derived_pair,
            seed.expect("provided the root seed, so derived seed is always present"),
        ))
    }

    pub fn ed_derive(
        app: &AppHandle,
        suri: &str,
    ) -> Result<(ed25519::Pair, [u8; 32]), Box<dyn std::error::Error>> {
        let mnemonic = Self::expose_mnemonic(app)?;
        Self::ed_derive_from_mnemonic(&mnemonic, suri)
    }

    fn ed_derive_from_mnemonic(
        mnemonic: &str,
        suri: &str,
    ) -> Result<(ed25519::Pair, [u8; 32]), Box<dyn std::error::Error>> {
        let (pair, seed) = ed25519::Pair::from_phrase(mnemonic, None)?;
        let suri = AddressUri::parse(suri)?;
        let ssh_derive = suri.paths.iter().map(DeriveJunction::from);
        let (pair, seed) = pair.derive(ssh_derive, Some(seed))?;
        Ok((
            pair,
            seed.expect("provided the root seed, so derived seed is always present"),
        ))
    }

    fn derive_ssh_key(mnemonic: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
        let (ssh_key, _seed) = Self::ed_derive_from_mnemonic(mnemonic, "//ssh-ed25519//1")?;
        let (private_key, public_key) = SSH::format_as_openssh(ssh_key)?;
        Ok((private_key, public_key))
    }

    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let private_key_path = Self::get_ssh_private_key_path(app);

        if Self::mnemonic_path(app).exists() && private_key_path.exists() {
            // Load SSH keys
            let ssh_public_key = SSHConfig::get_pubkey_from_privkey_file(&private_key_path)?;
            let mnemonic = Self::expose_mnemonic(app)?;

            Ok(Self {
                vaulting_address: Self::sr_derive_from_mnemonic(&mnemonic, "//vaulting")?
                    .0
                    .public()
                    .to_ss58check(),
                mining_address: Self::sr_derive_from_mnemonic(&mnemonic, "//mining")?
                    .0
                    .public()
                    .to_ss58check(),
                ssh_public_key,
            })
        } else {
            Security::create(app)
        }
    }

    pub fn save_with_mnemonic(
        app: &AppHandle,
        mnemonic: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (private_key, public_key) = Self::derive_ssh_key(mnemonic)?;
        let config_dir = Utils::get_absolute_config_instance_dir(app);
        let ssh_private_key_path = Self::get_ssh_private_key_path(app);
        fs::create_dir_all(&config_dir)?;
        fs::write(&ssh_private_key_path, private_key)?;
        // Set private key permissions to 600
        #[cfg(not(target_os = "windows"))]
        {
            let mut perms = fs::metadata(&ssh_private_key_path)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&ssh_private_key_path, perms)?;
        }

        // Save mnemonics
        fs::write(config_dir.join("mnemonic"), mnemonic)?;

        let mining_account = Self::sr_derive_from_mnemonic(mnemonic, "//mining")?;
        let vaulting_account = Self::sr_derive_from_mnemonic(mnemonic, "//vaulting")?;

        Ok(Self {
            vaulting_address: vaulting_account.0.public().to_ss58check(),
            mining_address: mining_account.0.public().to_ss58check(),
            ssh_public_key: public_key,
        })
    }

    pub fn create(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let (_pair, phrase, _seed) = ed25519::Pair::generate_with_phrase(None);
        Self::save_with_mnemonic(app, &phrase)
    }
}
