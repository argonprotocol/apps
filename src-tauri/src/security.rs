use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
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

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub mining_hold_address: String,
    pub mining_bot_address: String,
    pub vaulting_address: String,
    pub investment_address: String,
    pub ssh_public_key: String,
}

/// On-disk wallet file: public metadata + encrypted mnemonic.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletFile {
    encrypted_mnemonic: String,
    meta: Security,
}

impl Security {
    pub fn expose_private_key_openssh(app: &AppHandle) -> anyhow::Result<SecretString> {
        let mnemonic = Self::expose_mnemonic(app)?;
        let (private_key, _public_key) = Self::derive_ssh_key(&mnemonic)?;
        Ok(SecretString::new(private_key))
    }

    fn wallet_path(app: &AppHandle) -> PathBuf {
        Utils::get_absolute_config_instance_dir(app).join("wallet.json")
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

    /// Get the encryption key from the OS keychain.
    /// Today this is automatic (no user prompt). In the future,
    /// this can be swapped to require biometric/password auth.
    fn encryption_key(app: &AppHandle) -> Result<[u8; 32]> {
        let app_id = &app.config().identifier;
        let service = format!("{app_id}.mnemonic");
        let account = Utils::get_relative_config_instance_dir(app_id)
            .to_string_lossy()
            .to_string();
        let entry = keyring::Entry::new(&service, &account)?;

        let hex_key = match entry.get_password() {
            Ok(k) => k,
            Err(keyring::Error::NoEntry) => {
                let mut key = [0u8; 32];
                rand::RngCore::fill_bytes(&mut rand::rng(), &mut key);
                let new_key = hex::encode(key);
                entry.set_password(&new_key)?;
                new_key
            }
            Err(e) => return Err(e.into()),
        };
        anyhow::ensure!(
            hex_key.len() == 64,
            "Keychain encryption key is invalid (expected 64 hex chars, got {}). \
             Delete the keychain entry for this app and restart to regenerate.",
            hex_key.len()
        );
        let mut key = [0u8; 32];
        hex::decode_to_slice(&hex_key, &mut key).map_err(|e| {
            anyhow::anyhow!(
                "Keychain encryption key is not valid hex: {e}. \
                 Delete the keychain entry for this app and restart to regenerate."
            )
        })?;
        Ok(key)
    }

    fn encrypt_mnemonic(key: &[u8; 32], plaintext: &str) -> Result<String> {
        let cipher = Aes256Gcm::new_from_slice(key)?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|e| anyhow::anyhow!("Encryption failed: {e}"))?;
        // Format: 12-byte nonce || ciphertext, base64 encoded
        let mut combined = Vec::with_capacity(12 + ciphertext.len());
        combined.extend_from_slice(&nonce);
        combined.extend_from_slice(&ciphertext);
        Ok(BASE64.encode(combined))
    }

    fn decrypt_mnemonic(key: &[u8; 32], encoded: &str) -> Result<String> {
        let data = BASE64.decode(encoded)?;
        anyhow::ensure!(data.len() > 12, "Encrypted mnemonic is too short");
        let cipher = Aes256Gcm::new_from_slice(key)?;
        let nonce = Nonce::from_slice(&data[..12]);
        let plaintext = cipher
            .decrypt(nonce, &data[12..])
            .map_err(|e| anyhow::anyhow!("Decryption failed: {e}"))?;
        Ok(String::from_utf8(plaintext)?)
    }

    pub fn expose_mnemonic(app: &AppHandle) -> Result<String> {
        let raw = fs::read_to_string(Self::wallet_path(app))?;
        let wallet: WalletFile = serde_json::from_str(&raw)?;
        let key = Self::encryption_key(app)?;
        Self::decrypt_mnemonic(&key, &wallet.encrypted_mnemonic)
    }

    /// Migrate legacy plaintext mnemonic file to the new wallet.json format.
    fn migrate_legacy_mnemonic(app: &AppHandle) -> Result<()> {
        let legacy_path = Utils::get_absolute_config_instance_dir(app).join("mnemonic");
        if !legacy_path.exists() || Self::wallet_path(app).exists() {
            return Ok(());
        }
        let raw = fs::read_to_string(&legacy_path)?;
        let mnemonic = raw.trim();
        let word_count = mnemonic.split_whitespace().count();
        if word_count != 12 && word_count != 24 {
            return Ok(());
        }
        log::info!("Migrating plaintext mnemonic to encrypted wallet.json");
        Self::write_wallet_file(app, mnemonic)?;
        let _ = fs::remove_file(&legacy_path);
        Ok(())
    }

    fn write_wallet_file(app: &AppHandle, mnemonic: &str) -> Result<Security> {
        let (_, ssh_public_key) = Self::derive_ssh_key(mnemonic)?;
        let security = Self::create_with_addresses(mnemonic, &ssh_public_key)?;

        let key = Self::encryption_key(app)?;
        let wallet = WalletFile {
            encrypted_mnemonic: Self::encrypt_mnemonic(&key, mnemonic)?,
            meta: security.clone(),
        };

        let config_dir = Utils::get_absolute_config_instance_dir(app);
        fs::create_dir_all(&config_dir)?;
        let wallet_path = Self::wallet_path(app);
        let tmp_path = wallet_path.with_extension("json.tmp");
        fs::write(&tmp_path, serde_json::to_string_pretty(&wallet)?)?;
        fs::rename(&tmp_path, &wallet_path)?;

        Ok(security)
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

        Self::migrate_legacy_mnemonic(app)?;

        let wallet_path = Self::wallet_path(app);
        if wallet_path.exists() {
            let raw = fs::read_to_string(&wallet_path)?;
            let wallet: WalletFile = serde_json::from_str(&raw)?;
            Ok(wallet.meta)
        } else {
            Security::create(app)
        }
    }

    pub fn save_with_mnemonic(app: &AppHandle, mnemonic: &str) -> Result<Self> {
        // Remove legacy file if it exists
        let legacy_path = Utils::get_absolute_config_instance_dir(app).join("mnemonic");
        if legacy_path.exists() {
            let _ = fs::remove_file(&legacy_path);
        }

        Self::write_wallet_file(app, mnemonic)
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
