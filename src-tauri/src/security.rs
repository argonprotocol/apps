use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use anyhow::Result;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bip32::{ExtendedKey, Prefix, XPrv};
use curve25519_dalek::edwards::CompressedEdwardsY;
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use secrecy::SecretString;
use sha2::{Digest, Sha256, Sha512};
use sp_core::crypto::AddressUri;
use sp_core::crypto::Ss58Codec;
use sp_core::{DeriveJunction, Pair, ed25519, sr25519};
use std::fs;
use std::path::PathBuf;
#[cfg(all(target_os = "macos", not(argon_signed_build)))]
use std::process::Command;
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
    pub operational_address: String,
    pub ethereum_address: String,
    pub ssh_public_key: String,
}

/// On-disk wallet file: public metadata + encrypted mnemonic.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletFile {
    encrypted_mnemonic: String,
    meta: Security,
}

struct X25519Keypair {
    secret_key: [u8; 32],
    public_key: [u8; 32],
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

        #[cfg(all(target_os = "macos", not(argon_signed_build)))]
        let use_local_dev_path = app_id.ends_with(".local");

        #[cfg(any(not(target_os = "macos"), argon_signed_build))]
        let use_local_dev_path = false;

        let hex_key = if use_local_dev_path {
            read_or_create_local_dev_wallet_key(&service, &account)?
        } else {
            let entry = keyring::Entry::new(&service, &account)?;
            match entry.get_password() {
                Ok(k) => k,
                Err(keyring::Error::NoEntry) => {
                    let new_key = generate_wallet_key_hex();
                    entry.set_password(&new_key)?;
                    new_key
                }
                Err(e) => return Err(e.into()),
            }
        };

        let mut key = [0u8; 32];
        hex::decode_to_slice(hex_key.as_bytes(), &mut key).map_err(|e| {
            anyhow::anyhow!(
                "Keychain encryption key is not valid hex: {e}. Delete the keychain entry for this app and restart to regenerate."
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

    pub fn derive_x25519_public_key(app: &AppHandle, suri: &str) -> Result<Vec<u8>> {
        let (pair, seed) = Self::ed_derive(app, suri)?;
        let keypair = Self::x25519_keypair_from_ed_keypair(&pair, &seed)?;
        Ok(keypair.public_key.to_vec())
    }

    pub fn encrypt_x25519_message(
        app: &AppHandle,
        suri: &str,
        counterparty_public_key: &[u8],
        payload: &[u8],
    ) -> Result<Vec<u8>> {
        let (pair, seed) = Self::ed_derive(app, suri)?;
        Self::encrypt_x25519_message_from_keypair(&pair, &seed, counterparty_public_key, payload)
    }

    pub fn decrypt_x25519_message(
        app: &AppHandle,
        suri: &str,
        counterparty_public_key: &[u8],
        encrypted_message: &[u8],
    ) -> Result<Vec<u8>> {
        let (pair, seed) = Self::ed_derive(app, suri)?;
        Self::decrypt_x25519_message_from_keypair(
            &pair,
            &seed,
            counterparty_public_key,
            encrypted_message,
        )
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

    fn x25519_keypair_from_ed_keypair(
        pair: &ed25519::Pair,
        seed: &[u8; 32],
    ) -> Result<X25519Keypair> {
        let public = pair.public();
        Self::x25519_keypair_from_ed_bytes(seed, public.as_array_ref())
    }

    fn x25519_keypair_from_ed_bytes(
        seed: &[u8; 32],
        public_key: &[u8; 32],
    ) -> Result<X25519Keypair> {
        let secret_hash = Sha512::digest(seed);

        let mut secret_key = [0u8; 32];
        secret_key.copy_from_slice(&secret_hash[..32]);

        let public_key = CompressedEdwardsY::from_slice(public_key)
            .map_err(|e| anyhow::anyhow!("Failed to read Ed25519 public key bytes: {e}"))?
            .decompress()
            .ok_or_else(|| anyhow::anyhow!("Invalid Ed25519 public key"))?
            .to_montgomery()
            .to_bytes();

        Ok(X25519Keypair {
            secret_key,
            public_key,
        })
    }

    fn encrypt_x25519_message_from_keypair(
        pair: &ed25519::Pair,
        seed: &[u8; 32],
        counterparty_public_key: &[u8],
        payload: &[u8],
    ) -> Result<Vec<u8>> {
        let local_keypair = Self::x25519_keypair_from_ed_keypair(pair, seed)?;
        let counterparty_public_key = Self::decode_x25519_public_key(counterparty_public_key)?;
        let shared_secret =
            Self::derive_x25519_shared_secret(&local_keypair.secret_key, counterparty_public_key)?;
        let encryption_key = Self::derive_x25519_encryption_key(&shared_secret)?;

        let cipher = Aes256Gcm::new_from_slice(&encryption_key)?;
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, payload)
            .map_err(|e| anyhow::anyhow!("Encryption failed: {e}"))?;

        let mut encrypted = Vec::with_capacity(12 + ciphertext.len());
        encrypted.extend_from_slice(&nonce);
        encrypted.extend_from_slice(&ciphertext);

        Ok(encrypted)
    }

    fn decrypt_x25519_message_from_keypair(
        pair: &ed25519::Pair,
        seed: &[u8; 32],
        counterparty_public_key: &[u8],
        encrypted_message: &[u8],
    ) -> Result<Vec<u8>> {
        let local_keypair = Self::x25519_keypair_from_ed_keypair(pair, seed)?;
        let counterparty_public_key = Self::decode_x25519_public_key(counterparty_public_key)?;
        let shared_secret =
            Self::derive_x25519_shared_secret(&local_keypair.secret_key, counterparty_public_key)?;
        let encryption_key = Self::derive_x25519_encryption_key(&shared_secret)?;

        anyhow::ensure!(
            encrypted_message.len() >= 12 + 16,
            "Encrypted payload must be at least 28 bytes (12-byte nonce + 16-byte authentication tag + ciphertext)"
        );

        let (nonce, ciphertext) = encrypted_message.split_at(12);

        let cipher = Aes256Gcm::new_from_slice(&encryption_key)?;
        let plaintext = cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|e| anyhow::anyhow!("Decryption failed: {e}"))?;

        Ok(plaintext)
    }

    fn decode_x25519_public_key(public_key: &[u8]) -> Result<[u8; 32]> {
        anyhow::ensure!(
            public_key.len() == 32,
            "Counterparty public key must be 32 bytes, got {}",
            public_key.len()
        );

        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(public_key);
        Ok(bytes)
    }

    fn derive_x25519_shared_secret(
        secret_key: &[u8; 32],
        counterparty_public_key: [u8; 32],
    ) -> Result<[u8; 32]> {
        let shared_secret = MontgomeryPoint(counterparty_public_key)
            .mul_clamped(*secret_key)
            .to_bytes();

        anyhow::ensure!(
            shared_secret != [0u8; 32],
            "Counterparty public key produced an invalid shared secret"
        );

        Ok(shared_secret)
    }

    fn derive_x25519_encryption_key(shared_secret: &[u8; 32]) -> Result<[u8; 32]> {
        let hkdf = Hkdf::<Sha256>::new(Some(b"argon/x25519/aes256gcm/v1"), shared_secret);
        let mut key = [0u8; 32];
        hkdf.expand(b"message-encryption", &mut key)
            .map_err(|_| anyhow::anyhow!("Failed to derive an AES key from the shared secret"))?;
        Ok(key)
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
        let operational_account = Self::sr_derive_from_mnemonic(mnemonic, "//operational")?;
        let ethereum_address = Self::derive_ethereum_address(mnemonic)?;

        Ok(Self {
            mining_hold_address: mining_hold_account.0.public().to_ss58check(),
            mining_bot_address: mining_bot_account.0.public().to_ss58check(),
            vaulting_address: vaulting_account.0.public().to_ss58check(),
            investment_address: investment_account.0.public().to_ss58check(),
            operational_address: operational_account.0.public().to_ss58check(),
            ethereum_address,
            ssh_public_key: public_key.to_string(),
        })
    }

    pub fn create(app: &AppHandle) -> Result<Self> {
        let (_pair, phrase, _seed) = ed25519::Pair::generate_with_phrase(None);
        Self::save_with_mnemonic(app, &phrase)
    }

    fn derive_ethereum_address(mnemonic: &str) -> Result<String> {
        let seed = bip39::Mnemonic::from_str(mnemonic)?.to_seed("");
        let path = bip32::DerivationPath::from_str("m/44'/60'/0'/0/0")?;
        let hd_key: XPrv = bip32::XPrv::derive_from_path(seed, &path)?;
        let public_key = hd_key.private_key().verifying_key();
        let encoded = public_key.to_encoded_point(false);
        let public_key_bytes = encoded.as_bytes();
        let hash = sp_core::hashing::keccak_256(&public_key_bytes[1..]);
        Ok(Self::to_checksummed_ethereum_address(&hash[12..]))
    }

    fn to_checksummed_ethereum_address(address_bytes: &[u8]) -> String {
        let address_hex = hex::encode(address_bytes);
        let hash_hex = hex::encode(sp_core::hashing::keccak_256(address_hex.as_bytes()));
        let mut checksummed = String::with_capacity(42);
        checksummed.push_str("0x");

        for (address_char, hash_char) in address_hex.chars().zip(hash_hex.chars()) {
            if address_char.is_ascii_digit() {
                checksummed.push(address_char);
                continue;
            }

            let nibble = hash_char.to_digit(16).unwrap_or_default();
            if nibble >= 8 {
                checksummed.push(address_char.to_ascii_uppercase());
            } else {
                checksummed.push(address_char);
            }
        }

        checksummed
    }
}

#[cfg(all(target_os = "macos", not(argon_signed_build)))]
fn read_or_create_local_dev_wallet_key(service: &str, account: &str) -> Result<String> {
    let output = Command::new("security")
        .arg("find-generic-password")
        .arg("-a")
        .arg(account)
        .arg("-s")
        .arg(service)
        .arg("-w")
        .output()?;

    if output.status.success() {
        return Ok(String::from_utf8(output.stdout)?.trim().to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.contains("could not be found in the keychain") {
        anyhow::bail!("Failed to read local keychain entry: {}", stderr.trim());
    }

    let hex_key = generate_wallet_key_hex();
    let output = Command::new("security")
        .arg("add-generic-password")
        .arg("-U")
        .arg("-a")
        .arg(account)
        .arg("-s")
        .arg(service)
        .arg("-w")
        .arg(&hex_key)
        .arg("-A")
        .output()?;

    anyhow::ensure!(
        output.status.success(),
        "Failed to create local keychain entry: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );

    Ok(hex_key)
}

#[cfg(any(not(target_os = "macos"), argon_signed_build))]
fn read_or_create_local_dev_wallet_key(_service: &str, _account: &str) -> Result<String> {
    unreachable!("local dev keychain path should not be used in signed or non-mac builds");
}

fn generate_wallet_key_hex() -> String {
    let mut key = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut key);
    hex::encode(key)
}

#[cfg(test)]
mod tests {
    use super::Security;
    use sp_core::Pair;

    #[test]
    fn x25519_conversion_encrypts_between_derived_ed25519_keys() {
        let (_pair, mnemonic, _seed) = sp_core::ed25519::Pair::generate_with_phrase(None);

        let (alice_pair, alice_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//1")
            .expect("alice key should derive");
        let (bob_pair, bob_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//2")
            .expect("bob key should derive");

        let alice_public_key = Security::x25519_keypair_from_ed_keypair(&alice_pair, &alice_seed)
            .expect("alice x25519 conversion should work")
            .public_key;
        let bob_public_key = Security::x25519_keypair_from_ed_keypair(&bob_pair, &bob_seed)
            .expect("bob x25519 conversion should work")
            .public_key;
        let payload = vec![127, 0, 0, 1, 0x23, 0x84];

        let encrypted = Security::encrypt_x25519_message_from_keypair(
            &alice_pair,
            &alice_seed,
            &bob_public_key,
            &payload,
        )
        .expect("message should encrypt");

        let decrypted = Security::decrypt_x25519_message_from_keypair(
            &bob_pair,
            &bob_seed,
            &alice_public_key,
            &encrypted,
        )
        .expect("message should decrypt");

        assert_eq!(decrypted, payload);
    }

    #[test]
    fn x25519_encrypt_rejects_invalid_counterparty_key_length() {
        let (_pair, mnemonic, _seed) = sp_core::ed25519::Pair::generate_with_phrase(None);
        let (alice_pair, alice_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//1")
            .expect("alice key should derive");

        let invalid_counterparty_key = vec![0u8; 31];
        let payload = vec![1, 2, 3, 4];

        let result = Security::encrypt_x25519_message_from_keypair(
            &alice_pair,
            &alice_seed,
            &invalid_counterparty_key,
            &payload,
        );

        assert!(
            result.is_err(),
            "encryption should fail for invalid key length"
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Counterparty public key must be 32 bytes"),
            "error should mention the expected counterparty key length"
        );
    }

    #[test]
    fn x25519_decrypt_rejects_too_short_ciphertext() {
        let (_pair, mnemonic, _seed) = sp_core::ed25519::Pair::generate_with_phrase(None);

        let (alice_pair, alice_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//1")
            .expect("alice key should derive");
        let (bob_pair, bob_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//2")
            .expect("bob key should derive");

        let alice_public_key = Security::x25519_keypair_from_ed_keypair(&alice_pair, &alice_seed)
            .expect("alice x25519 conversion should work")
            .public_key;
        let too_short_ciphertext = vec![0u8; 27];

        let result = Security::decrypt_x25519_message_from_keypair(
            &bob_pair,
            &bob_seed,
            &alice_public_key,
            &too_short_ciphertext,
        );

        assert!(
            result.is_err(),
            "decryption should fail for ciphertext shorter than nonce plus tag"
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Encrypted payload must be at least 28 bytes"),
            "error should mention the minimum encrypted payload length"
        );
    }

    #[test]
    fn x25519_decrypt_fails_with_wrong_counterparty_key() {
        let (_pair, mnemonic, _seed) = sp_core::ed25519::Pair::generate_with_phrase(None);

        let (alice_pair, alice_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//1")
            .expect("alice key should derive");
        let (bob_pair, bob_seed) = Security::ed_derive_from_mnemonic(&mnemonic, "//chat//2")
            .expect("bob key should derive");
        let (charlie_pair, charlie_seed) =
            Security::ed_derive_from_mnemonic(&mnemonic, "//chat//3")
                .expect("charlie key should derive");

        let bob_public_key = Security::x25519_keypair_from_ed_keypair(&bob_pair, &bob_seed)
            .expect("bob x25519 conversion should work")
            .public_key;
        let charlie_public_key =
            Security::x25519_keypair_from_ed_keypair(&charlie_pair, &charlie_seed)
                .expect("charlie x25519 conversion should work")
                .public_key;
        let payload = vec![9, 8, 7, 6];

        let encrypted = Security::encrypt_x25519_message_from_keypair(
            &alice_pair,
            &alice_seed,
            &bob_public_key,
            &payload,
        )
        .expect("message should encrypt");

        let result = Security::decrypt_x25519_message_from_keypair(
            &bob_pair,
            &bob_seed,
            &charlie_public_key,
            &encrypted,
        );

        assert!(
            result.is_err(),
            "decryption should fail when using the wrong counterparty public key"
        );
    }
}
