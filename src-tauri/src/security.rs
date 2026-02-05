use anyhow::Result;
use bip32::{ExtendedKey, Prefix, XPrv};
use secrecy::SecretString;
use sp_core::crypto::AddressUri;
use sp_core::crypto::Ss58Codec;
use sp_core::{DeriveJunction, Pair, ed25519, sr25519};
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::AppHandle;

use crate::{ssh::SSH, utils::Utils};

#[derive(serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub mining_hold_address: String,
    pub mining_bot_address: String,
    pub vaulting_address: String,
    pub investment_address: String,
    pub ssh_public_key: String,
}

impl Security {
    pub fn expose_private_key_openssh(app: &AppHandle) -> anyhow::Result<SecretString> {
        let mnemonic = Self::expose_mnemonic(app)?;
        let (private_key, _public_key) = Self::derive_ssh_key(&mnemonic)?;
        Ok(SecretString::new(private_key))
    }

    fn mnemonic_path(app: &AppHandle) -> PathBuf {
        let absolute_config_dir = Utils::get_absolute_config_instance_dir(app);
        absolute_config_dir.join("mnemonic")
    }

    pub fn derive_bitcoin_extended_key(
        app: &AppHandle,
        hd_path: &str,
        version: u32,
    ) -> Result<ExtendedKey> {
        let master_mnemonic = Self::expose_mnemonic(app)?;
        let seed = bip39::Mnemonic::from_str(&master_mnemonic)?.to_seed("");
        let path = bip32::DerivationPath::from_str(hd_path)?;
        let hd_key: XPrv = bip32::XPrv::derive_from_path(seed, &path)?;

        let prefix = Prefix::try_from(version)?;

        let extended_key = hd_key.to_extended_key(prefix);
        Ok(extended_key)
    }

    pub fn expose_mnemonic(app: &AppHandle) -> Result<String> {
        let mnemonic_file_path = Self::mnemonic_path(app);
        let master_mnemonic = fs::read_to_string(&mnemonic_file_path)?;
        Ok(master_mnemonic)
    }

    pub fn sr_derive(app: &AppHandle, suri: &str) -> Result<(sr25519::Pair, [u8; 32])> {
        let mnemonic = Self::expose_mnemonic(app)?;
        Self::sr_derive_from_mnemonic(&mnemonic, suri)
    }

    fn sr_derive_from_mnemonic(mnemonic: &str, suri: &str) -> Result<(sr25519::Pair, [u8; 32])> {
        let (pair, seed) = sr25519::Pair::from_phrase(mnemonic, None)?;
        let suri = AddressUri::parse(suri)?;
        let ssh_derive = suri.paths.iter().map(DeriveJunction::from);
        let (derived_pair, seed) = pair.derive(ssh_derive, Some(seed))?;
        Ok((
            derived_pair,
            seed.expect("provided the root seed, so derived seed is always present"),
        ))
    }

    pub fn ed_derive(app: &AppHandle, suri: &str) -> Result<(ed25519::Pair, [u8; 32])> {
        let mnemonic = Self::expose_mnemonic(app)?;
        Self::ed_derive_from_mnemonic(&mnemonic, suri)
    }

    fn ed_derive_from_mnemonic(mnemonic: &str, suri: &str) -> Result<(ed25519::Pair, [u8; 32])> {
        let (pair, seed) = ed25519::Pair::from_phrase(mnemonic, None)?;
        let suri = AddressUri::parse(suri)?;
        let ssh_derive = suri.paths.iter().map(DeriveJunction::from);
        let (pair, seed) = pair.derive(ssh_derive, Some(seed))?;
        Ok((
            pair,
            seed.expect("provided the root seed, so derived seed is always present"),
        ))
    }

    fn derive_ssh_key(mnemonic: &str) -> anyhow::Result<(String, String)> {
        let (ssh_key, _seed) = Self::ed_derive_from_mnemonic(mnemonic, "//ssh-ed25519//1")?;
        let (private_key, public_key) = SSH::format_as_openssh(ssh_key)?;
        Ok((private_key, public_key))
    }

    pub fn load(app: &AppHandle) -> Result<Self> {
        let private_key_path = Utils::get_absolute_config_instance_dir(app).join("serverkey.pem");
        if private_key_path.exists() {
            let _ = fs::remove_file(&private_key_path);
        }

        if Self::mnemonic_path(app).exists() {
            let mnemonic = Self::expose_mnemonic(app)?;
            let (_, ssh_public_key) = Self::derive_ssh_key(&mnemonic)?;
            Self::create_with_addresses(&mnemonic, &ssh_public_key)
        } else {
            Security::create(app)
        }
    }

    pub fn save_with_mnemonic(app: &AppHandle, mnemonic: &str) -> Result<Self> {
        let (_, public_key) = Self::derive_ssh_key(mnemonic)?;
        let config_dir = Utils::get_absolute_config_instance_dir(app);
        fs::create_dir_all(&config_dir)?;

        // Save mnemonics
        fs::write(config_dir.join("mnemonic"), mnemonic)?;

        Self::create_with_addresses(mnemonic, &public_key)
    }

    fn create_with_addresses(mnemonic: &str, public_key: &str) -> Result<Self> {
        let mining_hold_account = Self::sr_derive_from_mnemonic(mnemonic, "//holding")?; // If we had a do-over, it would be called mining
        let mining_bot_account = Self::sr_derive_from_mnemonic(mnemonic, "//mining")?; // If we had a do-over, it would be called miningBot
        let vaulting_account = Self::sr_derive_from_mnemonic(mnemonic, "//vaulting")?;
        let investment_account = Self::sr_derive_from_mnemonic(mnemonic, "//investment")?;

        Ok(Self {
            mining_hold_address: mining_hold_account.0.public().to_ss58check(),
            mining_bot_address: mining_bot_account.0.public().to_ss58check(),
            vaulting_address: vaulting_account.0.public().to_ss58check(),
            investment_address: investment_account.0.public().to_ss58check(),
            ssh_public_key: public_key.to_string(),
        })
    }

    pub fn create(app: &AppHandle) -> Result<Self> {
        let (_pair, phrase, _seed) = ed25519::Pair::generate_with_phrase(None);
        Self::save_with_mnemonic(app, &phrase)
    }
}
