use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use anyhow::{Context, Result, anyhow, ensure};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use secrecy::zeroize::Zeroize;
use secrecy::{ExposeSecret, ExposeSecretMut, SecretBox, SecretSlice, SecretString};
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[cfg(target_os = "macos")]
use crate::keychain_mac as platform;
#[cfg(target_os = "windows")]
use crate::keychain_windows as platform;

// Usable AES bytes exist only for the duration of a native operation.
pub(crate) type EncryptionKey = SecretBox<[u8; 32]>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum KeyProtection {
    None,
    Passcode { kdf: serde_json::Value },
    System,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeychainAuthentication {
    access_id: Option<u64>,
    // User-facing action only; this text is also logged. Keep account details out.
    #[serde(default)]
    reason: String,
    wrapping_key: Option<[u8; 32]>,
}

impl Drop for KeychainAuthentication {
    fn drop(&mut self) {
        if let Some(key) = &mut self.wrapping_key {
            key.zeroize();
        }
    }
}

// The persisted key, not an unlocked key or a cached authentication session.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredEncryptionKey {
    version: u8,
    #[serde(rename = "protection")]
    material: StoredKeyMaterial,
}

impl StoredEncryptionKey {
    pub(crate) fn protect(
        scope: &str,
        key: &EncryptionKey,
        protection: KeyProtection,
        authentication: &KeychainAuthentication,
    ) -> Result<Self> {
        let reason = &authentication.reason;
        let method = match &protection {
            KeyProtection::None => "none",
            KeyProtection::Passcode { .. } => "passcode",
            KeyProtection::System => "system",
        };
        log::info!(
            "[SecurityAccess] event=native-key-protection-requested accessId={} method={method} reason={reason:?}",
            authentication.access_id.unwrap_or(0)
        );
        let material = match protection {
            KeyProtection::None => StoredKeyMaterial::Unprotected {
                key: hex::encode(key.expose_secret()),
            },
            KeyProtection::Passcode { kdf } => {
                let wrapping_key = authentication
                    .wrapping_key
                    .as_ref()
                    .ok_or_else(|| anyhow!("An app passcode is required"))?;
                let wrapped_key =
                    encrypt_with_context(wrapping_key, key.expose_secret(), scope.as_bytes())?;
                StoredKeyMaterial::PasscodeProtected { kdf, wrapped_key }
            }
            KeyProtection::System => {
                ensure!(
                    !authentication.reason.trim().is_empty(),
                    "An authentication reason is required"
                );
                let hardware_reference = platform::create(
                    &format!("{scope}/hardware-unlock/"),
                    key,
                    &authentication.reason,
                )?;
                StoredKeyMaterial::HardwareProtected { hardware_reference }
            }
        };
        log::info!(
            "[SecurityAccess] event=native-key-protection-created accessId={} reason={reason:?}",
            authentication.access_id.unwrap_or(0)
        );
        Ok(Self {
            version: 1,
            material,
        })
    }

    pub(crate) fn unlock(
        &self,
        scope: &str,
        authentication: &KeychainAuthentication,
    ) -> Result<EncryptionKey> {
        let access_id = authentication.access_id.unwrap_or(0);
        let reason = &authentication.reason;
        let method = match &self.material {
            StoredKeyMaterial::Unprotected { .. } => "none",
            StoredKeyMaterial::PasscodeProtected { .. } => "passcode",
            StoredKeyMaterial::HardwareProtected { .. } => "system",
        };
        let started = Instant::now();
        log::info!(
            "[SecurityAccess] event=native-key-requested accessId={access_id} method={method} reason={reason:?}"
        );
        let result = (|| match &self.material {
            StoredKeyMaterial::Unprotected { key } => decode_stored_key(key),
            StoredKeyMaterial::PasscodeProtected { wrapped_key, .. } => {
                let wrapping_key = authentication
                    .wrapping_key
                    .as_ref()
                    .ok_or_else(|| anyhow!("An app passcode is required"))?;
                let bytes = decrypt_with_context(wrapping_key, wrapped_key, scope.as_bytes())
                    .context("Incorrect app passcode. Please try again.")?;
                decode_key(bytes.expose_secret())
            }
            StoredKeyMaterial::HardwareProtected { hardware_reference } => {
                ensure!(
                    !authentication.reason.trim().is_empty(),
                    "An authentication reason is required"
                );
                platform::read(
                    &format!("{scope}/hardware-unlock/"),
                    hardware_reference,
                    &authentication.reason,
                )
            }
        })();
        let event = if result.is_ok() {
            "native-key-acquired"
        } else {
            "native-key-failed"
        };
        log::info!(
            "[SecurityAccess] event={event} accessId={access_id} method={method} reason={reason:?} elapsedMs={}",
            started.elapsed().as_millis()
        );
        result
    }

    pub(crate) fn protection(&self) -> KeyProtection {
        match &self.material {
            StoredKeyMaterial::Unprotected { .. } => KeyProtection::None,
            StoredKeyMaterial::PasscodeProtected { kdf, .. } => {
                KeyProtection::Passcode { kdf: kdf.clone() }
            }
            StoredKeyMaterial::HardwareProtected { .. } => KeyProtection::System,
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        // Released wallets store this same AES key as 64 hex characters in the same keychain slot.
        if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(Self {
                version: 1,
                material: StoredKeyMaterial::Unprotected {
                    key: value.to_owned(),
                },
            });
        }
        let record: Self = serde_json::from_str(value).map_err(|_| {
            anyhow!("The saved encryption key is unreadable; it has not been replaced")
        })?;
        ensure!(
            record.version == 1,
            "Unsupported encryption key version; update the app"
        );
        Ok(record)
    }

    pub(crate) fn to_keychain_value(&self) -> Result<SecretString> {
        match &self.material {
            StoredKeyMaterial::Unprotected { key } => Ok(SecretString::from(key.clone())),
            _ => Ok(SecretString::from(serde_json::to_string(self)?)),
        }
    }

    pub(crate) fn remove_hardware_key(&self, scope: &str) {
        if let StoredKeyMaterial::HardwareProtected { hardware_reference } = &self.material
            && let Err(error) =
                platform::delete(&format!("{scope}/hardware-unlock/"), hardware_reference)
        {
            log::warn!("Unable to remove an unused hardware key: {error}");
        }
    }

    pub(crate) fn remove_unsaved_hardware_key(
        &self,
        scope: &str,
        saved: Result<Option<SecretString>>,
    ) {
        let Ok(saved) = saved else { return };
        let Ok(value) = self.to_keychain_value() else {
            return;
        };
        if saved
            .as_ref()
            .is_some_and(|saved| saved.expose_secret() == value.expose_secret())
        {
            return;
        }
        self.remove_hardware_key(scope);
    }
}

// Private representations retain the existing keychain format.
#[derive(Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
enum StoredKeyMaterial {
    #[serde(rename = "none")]
    Unprotected { key: String },
    #[serde(rename = "passcode")]
    PasscodeProtected {
        kdf: serde_json::Value,
        #[serde(rename = "ciphertext")]
        wrapped_key: String,
    },
    #[serde(rename = "system")]
    HardwareProtected {
        #[serde(rename = "entry")]
        hardware_reference: String,
    },
}

impl Drop for StoredKeyMaterial {
    fn drop(&mut self) {
        if let Self::Unprotected { key } = self {
            key.zeroize();
        }
    }
}

pub(crate) fn decode_stored_key(value: &str) -> Result<EncryptionKey> {
    let mut key = EncryptionKey::new(Box::new([0; 32]));
    hex::decode_to_slice(value.as_bytes(), key.expose_secret_mut())
        .map_err(|error| anyhow::anyhow!("Invalid stored 32-byte encryption key: {error}"))?;
    Ok(key)
}

// Preserve the wallet format: base64(12-byte nonce || ciphertext || authentication tag).
pub(crate) fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<String> {
    encrypt_with_context(key, plaintext, b"")
}

pub(crate) fn decrypt(key: &[u8; 32], ciphertext: &str) -> Result<SecretSlice<u8>> {
    decrypt_with_context(key, ciphertext, b"")
}

pub(crate) fn encrypt_with_context(
    key: &[u8; 32],
    plaintext: &[u8],
    context: &[u8],
) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key)?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: context,
            },
        )
        .map_err(|_| anyhow!("Secret encryption failed"))?;
    let mut data = nonce.to_vec();
    data.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(data))
}

pub(crate) fn decrypt_with_context(
    key: &[u8; 32],
    ciphertext: &str,
    context: &[u8],
) -> Result<SecretSlice<u8>> {
    let data = BASE64.decode(ciphertext)?;
    ensure!(data.len() >= 28, "Encrypted secret is too short");
    let plaintext = Aes256Gcm::new_from_slice(key)?
        .decrypt(
            Nonce::from_slice(&data[..12]),
            Payload {
                msg: &data[12..],
                aad: context,
            },
        )
        .map_err(|_| anyhow!("Authentication could not decrypt this secret"))?;
    Ok(plaintext.into())
}

pub(crate) fn decode_key(bytes: &[u8]) -> Result<EncryptionKey> {
    ensure!(
        bytes.len() == 32,
        "The encryption key must contain 32 bytes"
    );
    Ok(EncryptionKey::init_with_mut(|key| {
        key.copy_from_slice(bytes)
    }))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn validate_hardware_key_name(prefix: &str, name: &str) -> Result<()> {
    let suffix = name
        .strip_prefix(prefix)
        .ok_or_else(|| anyhow::anyhow!("The hardware key belongs to another network or profile"))?;
    ensure!(
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid hardware key identifier"
    );
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    pub fn create(_prefix: &str, _key: &EncryptionKey, _reason: &str) -> Result<String> {
        anyhow::bail!("Hardware-backed key access is unavailable on this platform")
    }
    pub fn read(_prefix: &str, _entry: &str, _reason: &str) -> Result<EncryptionKey> {
        anyhow::bail!("Hardware-backed key access is unavailable on this platform")
    }
    pub fn delete(_prefix: &str, _entry: &str) -> Result<()> {
        anyhow::bail!("Hardware-backed key access is unavailable on this platform")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_the_existing_keychain_record_formats() {
        let raw_key = "37".repeat(32);
        let unprotected = StoredEncryptionKey::parse(&raw_key).unwrap();
        assert_eq!(
            unprotected.to_keychain_value().unwrap().expose_secret(),
            &raw_key
        );

        // Node/OpenSSL fixture: key 0x08 * 32, nonce 0x00 * 12, scoped AAD, plaintext 0x37 * 32.
        let passcode_record = r#"{"version":1,"protection":{"method":"passcode","kdf":{"algorithm":"scrypt"},"ciphertext":"AAAAAAAAAAAAAAAAKIXdXpE5nmYNA7GiVnFtP6djMu5KLWi7HJhmM1fFHuLfSTLSp/Bsg1Id8XdGBeK0"}}"#;
        let passcode_key = StoredEncryptionKey::parse(passcode_record).unwrap();
        let key = passcode_key
            .unlock(
                "com.argon.desktop/testnet/synthetic",
                &KeychainAuthentication {
                    reason: String::new(),
                    access_id: None,
                    wrapping_key: Some([8; 32]),
                },
            )
            .unwrap();
        assert_eq!(key.expose_secret(), &[0x37; 32]);

        let hardware_record = r#"{"version":1,"protection":{"method":"system","entry":"synthetic-hardware-reference"}}"#;
        for saved in [passcode_record, hardware_record] {
            let stored_key = StoredEncryptionKey::parse(saved).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(
                    stored_key.to_keychain_value().unwrap().expose_secret()
                )
                .unwrap(),
                serde_json::from_str::<serde_json::Value>(saved).unwrap(),
            );
        }
    }

    #[test]
    fn protects_the_existing_key_without_changing_wallet_ciphertext() {
        let scope = "com.argon.desktop/testnet/synthetic";
        let original = StoredEncryptionKey::parse(&"37".repeat(32)).unwrap();
        let authentication = KeychainAuthentication {
            reason: String::new(),
            access_id: None,
            wrapping_key: None,
        };
        let key = original.unlock(scope, &authentication).unwrap();
        // Independent Node/OpenSSL AES-256-GCM fixture: key 0x37 * 32, nonce 0x00 * 12.
        let ciphertext = "AAAAAAAAAAAAAAAAjzT6LNDOY1NowbhfE0hViD0Jv3cMF72ZCmYU4mdnVXWt4UkLOY0F";
        assert_eq!(
            decrypt(key.expose_secret(), ciphertext)
                .unwrap()
                .expose_secret(),
            b"synthetic wallet secret"
        );

        let passcode_authentication = KeychainAuthentication {
            reason: String::new(),
            access_id: None,
            wrapping_key: Some([8; 32]),
        };
        let protection = KeyProtection::Passcode {
            kdf: serde_json::json!({"algorithm": "scrypt"}),
        };
        let protected =
            StoredEncryptionKey::protect(scope, &key, protection.clone(), &passcode_authentication)
                .unwrap();
        assert!(protected.unlock(scope, &authentication).is_err());
        assert_eq!(
            protected
                .unlock(
                    scope,
                    &KeychainAuthentication {
                        reason: String::new(),
                        access_id: None,
                        wrapping_key: Some([9; 32])
                    }
                )
                .err()
                .unwrap()
                .to_string(),
            "Incorrect app passcode. Please try again."
        );
        assert!(
            protected
                .unlock(
                    "com.argon.desktop/mainnet/synthetic",
                    &passcode_authentication
                )
                .is_err()
        );
        assert!(
            protected
                .unlock(
                    "com.argon.desktop/testnet/another-profile",
                    &passcode_authentication
                )
                .is_err()
        );

        let persisted = serde_json::to_string(&protected).unwrap();
        assert!(!persisted.contains(&"37".repeat(32)));
        let restarted = StoredEncryptionKey::parse(&persisted).unwrap();
        let reopened = restarted.unlock(scope, &passcode_authentication).unwrap();
        assert_eq!(
            decrypt(reopened.expose_secret(), ciphertext)
                .unwrap()
                .expose_secret(),
            b"synthetic wallet secret"
        );
        let public_info = serde_json::to_value(restarted.protection()).unwrap();
        assert!(public_info.get("key").is_none());
        assert!(public_info.get("ciphertext").is_none());

        let changed_authentication = KeychainAuthentication {
            reason: String::new(),
            access_id: None,
            wrapping_key: Some([9; 32]),
        };
        let changed =
            StoredEncryptionKey::protect(scope, &reopened, protection, &changed_authentication)
                .unwrap();
        assert!(changed.unlock(scope, &passcode_authentication).is_err());
        let changed_key = changed.unlock(scope, &changed_authentication).unwrap();
        assert_eq!(
            decrypt(changed_key.expose_secret(), ciphertext)
                .unwrap()
                .expose_secret(),
            b"synthetic wallet secret"
        );

        let mut tampered: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&changed).unwrap()).unwrap();
        tampered["protection"]["ciphertext"] =
            serde_json::json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==");
        assert!(
            StoredEncryptionKey::parse(&tampered.to_string())
                .unwrap()
                .unlock(scope, &changed_authentication)
                .is_err()
        );
    }

    #[test]
    fn unreadable_or_unsupported_entries_are_not_treated_as_an_empty_keychain() {
        assert!(StoredEncryptionKey::parse("not an encryption key").is_err());
        assert!(
            StoredEncryptionKey::parse(
                r#"{"version":2,"protection":{"method":"none","key":"00"}}"#
            )
            .is_err()
        );
    }
}
