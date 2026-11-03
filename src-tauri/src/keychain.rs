use anyhow::{Result, anyhow, ensure};
use secrecy::{ExposeSecret, SecretString, zeroize::Zeroize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[cfg(target_os = "linux")]
use crate::encryption_key::decode_stored_key;
use crate::encryption_key::{EncryptionKey, StoredEncryptionKey};
use crate::encryption_key::{KeyProtection, KeychainAuthentication};
use crate::encryption_key::{decrypt, encrypt};
use crate::utils::Utils;

// Serializes native operations, including prompts. It holds no keys or unlock state.
#[derive(Default)]
pub struct KeychainLock {
    operation: Arc<Mutex<()>>,
}

#[tauri::command]
pub async fn keychain_info(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
) -> Result<Option<KeyProtection>, String> {
    with_encryption_key_entry(app, keychain_lock, |entry| {
        Ok(entry
            .read_encryption_key()?
            .map(|stored_key| stored_key.protection()))
    })
    .await
}

#[tauri::command]
pub async fn keychain_create(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    protection: KeyProtection,
    authentication: KeychainAuthentication,
    mut key: [u8; 32],
    replace_existing: Option<bool>,
) -> Result<(), String> {
    let encryption_key = EncryptionKey::new(Box::new(key));
    key.zeroize();
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let replace_existing = replace_existing.unwrap_or(false);
        let current = match entry.read_encryption_key() {
            Ok(current) => current,
            Err(_) if replace_existing => None,
            Err(error) => return Err(error),
        };
        if !replace_existing {
            ensure!(
                current.is_none(),
                "This profile already has an encryption key"
            );
        }

        #[cfg(target_os = "linux")]
        if let Some(current) = &current
            && matches!(current.protection(), KeyProtection::None)
        {
            let current_key = current.unlock(&entry.scope(), &authentication)?;
            entry.retire_previous_linux_key(current, &current_key)?;
        }

        let stored_key = StoredEncryptionKey::protect(
            &entry.scope(),
            &encryption_key,
            protection,
            &authentication,
        )?;
        let write_result = entry.write_encryption_key(&stored_key);
        if write_result.is_err() {
            stored_key.remove_unsaved_hardware_key(&entry.scope(), entry.read());
        }
        if let Some(current) = write_result? {
            current.remove_hardware_key(&entry.scope());
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn keychain_write(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    value: String,
) -> Result<(), String> {
    let value = SecretString::from(value);
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let stored_key = StoredEncryptionKey::parse(value.expose_secret())?;
        if let Some(current) = entry.write_encryption_key(&stored_key)? {
            current.remove_hardware_key(&entry.scope());
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn keychain_encrypt(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    plaintext: String,
    authentication: KeychainAuthentication,
) -> Result<String, String> {
    let plaintext = SecretString::from(plaintext);
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let stored_key = entry.require_encryption_key()?;
        let key = stored_key.unlock(&entry.scope(), &authentication)?;

        encrypt(key.expose_secret(), plaintext.expose_secret().as_bytes())
    })
    .await
}

#[tauri::command]
pub async fn keychain_decrypt(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    ciphertexts: Vec<String>,
    authentication: KeychainAuthentication,
    required_count: Option<usize>,
) -> Result<Vec<Option<String>>, String> {
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let stored_key = entry.require_encryption_key()?;
        let key = stored_key.unlock(&entry.scope(), &authentication)?;

        let plaintexts = decrypt_ciphertexts(&key, &ciphertexts, required_count)?;

        Ok(plaintexts
            .iter()
            .map(|plaintext| {
                plaintext
                    .as_ref()
                    .map(|plaintext| plaintext.expose_secret().to_owned())
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn keychain_authenticate(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    authentication: KeychainAuthentication,
) -> Result<(), String> {
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let stored_key = entry.require_encryption_key()?;
        let _key = stored_key.unlock(&entry.scope(), &authentication)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn keychain_set_protection(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    protection: KeyProtection,
    authentication: KeychainAuthentication,
    new_authentication: KeychainAuthentication,
) -> Result<(), String> {
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let current = entry.require_encryption_key()?;
        let key = current.unlock(&entry.scope(), &authentication)?;
        #[cfg(target_os = "linux")]
        entry.retire_previous_linux_key(&current, &key)?;

        let replacement =
            StoredEncryptionKey::protect(&entry.scope(), &key, protection, &new_authentication)?;
        let write_result = entry.write_encryption_key(&replacement);
        if write_result.is_err() {
            replacement.remove_unsaved_hardware_key(&entry.scope(), entry.read());
        }
        if let Some(current) = write_result? {
            current.remove_hardware_key(&entry.scope());
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn keychain_delete(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    authentication: KeychainAuthentication,
) -> Result<(), String> {
    with_encryption_key_entry(app, keychain_lock, move |entry| {
        let Some(current) = entry.read_encryption_key()? else {
            return Ok(());
        };

        let _key = current.unlock(&entry.scope(), &authentication)?;
        #[cfg(target_os = "linux")]
        entry.retire_previous_linux_key(&current, &_key)?;
        entry.delete()?;
        current.remove_hardware_key(&entry.scope());
        Ok(())
    })
    .await
}

fn decrypt_ciphertexts(
    key: &EncryptionKey,
    ciphertexts: &[String],
    required_count: Option<usize>,
) -> Result<Vec<Option<SecretString>>> {
    let required_count = required_count.unwrap_or(ciphertexts.len());
    ensure!(
        required_count <= ciphertexts.len(),
        "Required secret count exceeds the encrypted batch"
    );
    let mut plaintexts = Vec::with_capacity(ciphertexts.len());
    for (index, ciphertext) in ciphertexts.iter().enumerate() {
        let plaintext = (|| -> Result<SecretString> {
            let bytes = decrypt(key.expose_secret(), ciphertext)?;
            Ok(SecretString::from(
                std::str::from_utf8(bytes.expose_secret())?.to_owned(),
            ))
        })();
        match plaintext {
            Ok(plaintext) => plaintexts.push(Some(plaintext)),
            Err(error) if index < required_count => return Err(error),
            Err(_) => plaintexts.push(None),
        }
    }
    Ok(plaintexts)
}

// Capture the network/profile before leaving the command. No caller can select an OS service/account.
async fn with_encryption_key_entry<T: Send + 'static>(
    app: AppHandle,
    keychain_lock: State<'_, KeychainLock>,
    operation: impl FnOnce(&KeychainEntry) -> Result<T> + Send + 'static,
) -> Result<T, String> {
    let entry = KeychainEntry::encryption_key(&app);
    let lock = Arc::clone(&keychain_lock.operation);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| anyhow::anyhow!("Keychain access is unavailable"))?;
        operation(&entry)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

struct KeychainEntry {
    app_id: String,
    service: String,
    account: String,
}

impl KeychainEntry {
    fn encryption_key(app: &AppHandle) -> Self {
        let app_id = app.config().identifier.clone();
        let profile = Utils::get_relative_config_instance_dir(&app_id)
            .to_string_lossy()
            .into_owned();
        Self {
            service: format!("{app_id}.mnemonic"),
            app_id,
            account: profile,
        }
    }

    fn read_encryption_key(&self) -> Result<Option<StoredEncryptionKey>> {
        if let Some(value) = self.read()? {
            return StoredEncryptionKey::parse(value.expose_secret()).map(Some);
        }

        #[cfg(target_os = "linux")]
        {
            let previous = self.previous_linux_entry()?;
            let value = match previous.get_password() {
                Ok(value) => SecretString::from(value),
                Err(keyring::Error::NoEntry) => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            // The previous kernel store contains only the released raw AES-key format.
            decode_stored_key(value.expose_secret())?;
            let stored_key = StoredEncryptionKey::parse(value.expose_secret())?;
            if let Err(error) = self.write(value.expose_secret()) {
                log::warn!(
                    "Could not persist the previous Linux encryption key; using it for this session: {error}"
                );
            }
            Ok(Some(stored_key))
        }

        #[cfg(not(target_os = "linux"))]
        Ok(None)
    }

    fn require_encryption_key(&self) -> Result<StoredEncryptionKey> {
        self.read_encryption_key()?
            .ok_or_else(|| anyhow!("The keychain encryption key is unavailable"))
    }

    fn write_encryption_key(
        &self,
        stored_key: &StoredEncryptionKey,
    ) -> Result<Option<StoredEncryptionKey>> {
        let value = stored_key.to_keychain_value()?;
        let current = self
            .read()?
            .and_then(|current| StoredEncryptionKey::parse(current.expose_secret()).ok());
        if let Some(current) = &current
            && current.to_keychain_value()?.expose_secret() == value.expose_secret()
        {
            return Ok(None);
        }
        if let Err(error) = self.write(value.expose_secret()) {
            let saved = self.read()?;
            if saved
                .as_ref()
                .is_none_or(|saved| saved.expose_secret() != value.expose_secret())
            {
                return Err(error);
            }
        }
        Ok(current)
    }

    #[cfg(target_os = "linux")]
    fn retire_previous_linux_key(
        &self,
        current: &StoredEncryptionKey,
        key: &EncryptionKey,
    ) -> Result<()> {
        let previous = self.previous_linux_entry()?;
        let value = match previous.get_password() {
            Ok(value) => SecretString::from(value),
            Err(keyring::Error::NoEntry) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let previous_key = decode_stored_key(value.expose_secret())?;
        if previous_key.expose_secret() != key.expose_secret() {
            return Ok(());
        }
        // Preserve a durable current entry before retiring an unprotected copy of this same key.
        self.write_encryption_key(current)?;
        previous.delete_credential()?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn previous_linux_entry(&self) -> Result<keyring::Entry> {
        let credential = keyring::keyutils::KeyutilsCredential::new_with_target(
            None,
            &self.service,
            &self.account,
        )?;
        Ok(keyring::Entry::new_with_credential(Box::new(credential)))
    }

    fn scope(&self) -> String {
        format!("{}/{}", self.app_id, self.account)
    }

    fn read(&self) -> Result<Option<SecretString>> {
        #[cfg(all(target_os = "macos", not(argon_signed_build)))]
        if crate::keychain_mac::uses_local_dev_keychain(&self.app_id) {
            return crate::keychain_mac::read_local_dev_keychain_entry(
                &self.service,
                &self.account,
            )
            .map(|value| value.map(SecretString::from));
        }
        match keyring::Entry::new(&self.service, &self.account)?.get_password() {
            Ok(value) => Ok(Some(SecretString::from(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn write(&self, value: &str) -> Result<()> {
        #[cfg(all(target_os = "macos", not(argon_signed_build)))]
        if crate::keychain_mac::uses_local_dev_keychain(&self.app_id) {
            return crate::keychain_mac::write_local_dev_keychain_entry(
                &self.service,
                &self.account,
                value,
            );
        }
        keyring::Entry::new(&self.service, &self.account)?.set_password(value)?;
        Ok(())
    }

    fn delete(&self) -> Result<()> {
        #[cfg(all(target_os = "macos", not(argon_signed_build)))]
        if crate::keychain_mac::uses_local_dev_keychain(&self.app_id) {
            return crate::keychain_mac::delete_local_dev_keychain_entry(
                &self.service,
                &self.account,
            );
        }
        keyring::Entry::new(&self.service, &self.account)?.delete_credential()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
    use std::any::Any;
    use std::collections::HashMap;
    use std::sync::OnceLock;

    #[test]
    fn preserves_required_secrets_and_isolates_unreadable_optional_secrets() {
        let key = crate::encryption_key::decode_stored_key(&"37".repeat(32)).unwrap();
        let other_key = crate::encryption_key::decode_stored_key(&"38".repeat(32)).unwrap();
        let required = encrypt(key.expose_secret(), b"synthetic required secret").unwrap();
        let unavailable =
            encrypt(other_key.expose_secret(), b"synthetic unavailable secret").unwrap();
        let healthy = encrypt(key.expose_secret(), b"synthetic healthy secret").unwrap();
        let ciphertexts = vec![required, unavailable, healthy];

        assert!(decrypt_ciphertexts(&key, &ciphertexts, None).is_err());
        let plaintexts = decrypt_ciphertexts(&key, &ciphertexts, Some(1)).unwrap();
        assert_eq!(
            plaintexts[0].as_ref().unwrap().expose_secret(),
            "synthetic required secret"
        );
        assert!(plaintexts[1].is_none());
        assert_eq!(
            plaintexts[2].as_ref().unwrap().expose_secret(),
            "synthetic healthy secret"
        );
        assert!(decrypt_ciphertexts(&key, &ciphertexts[1..], Some(1)).is_err());
        assert!(decrypt_ciphertexts(&key, &ciphertexts, Some(4)).is_err());
    }

    #[test]
    fn stored_entries_and_deletes_use_both_service_and_account() {
        install_test_store();
        let entries = [
            KeychainEntry {
                app_id: "com.argon.keychain-tests".into(),
                service: "com.argon.keychain-tests.mnemonic".into(),
                account: "testnet/profile-one".into(),
            },
            KeychainEntry {
                app_id: "com.argon.keychain-tests".into(),
                service: "com.argon.keychain-tests.mnemonic".into(),
                account: "testnet/profile-two".into(),
            },
            KeychainEntry {
                app_id: "com.argon.keychain-tests".into(),
                service: "com.argon.keychain-tests.mnemonic".into(),
                account: "mainnet/profile-one".into(),
            },
            KeychainEntry {
                app_id: "com.argon.keychain-tests".into(),
                service: "com.argon.keychain-tests.secrets".into(),
                account: "testnet/profile-one/account-security".into(),
            },
        ];
        for (index, entry) in entries.iter().enumerate() {
            entry.write(&format!("synthetic-{index}")).unwrap();
        }
        for (index, entry) in entries.iter().enumerate() {
            assert_eq!(
                entry.read().unwrap().unwrap().expose_secret(),
                &format!("synthetic-{index}")
            );
        }
        entries[0].delete().unwrap();
        assert!(entries[0].read().unwrap().is_none());
        for (index, entry) in entries.iter().enumerate().skip(1) {
            assert_eq!(
                entry.read().unwrap().unwrap().expose_secret(),
                &format!("synthetic-{index}")
            );
        }
    }

    #[test]
    fn failed_key_writes_distinguish_rejected_committed_and_unconfirmed_results() {
        install_test_store();
        let entry = KeychainEntry {
            app_id: "com.argon.keychain-tests".into(),
            service: "com.argon.keychain-tests.mnemonic".into(),
            account: "testnet/write-failures".into(),
        };
        let original = "37".repeat(32);
        let replacement = StoredEncryptionKey::parse(&"42".repeat(32)).unwrap();
        let credential = keyring::Entry::new(&entry.service, &entry.account).unwrap();
        let storage = credential
            .get_credential()
            .downcast_ref::<TestCredential>()
            .unwrap();

        for failure in [
            WriteFailure::BeforeWrite,
            WriteFailure::AfterWrite,
            WriteFailure::UnreadableAfterWrite,
        ] {
            entry.write(&original).unwrap();
            storage.0.lock().unwrap().failure = failure;
            let result = entry.write_encryption_key(&replacement);
            if matches!(failure, WriteFailure::AfterWrite) {
                let replaced = result.unwrap().unwrap().to_keychain_value().unwrap();
                assert_eq!(replaced.expose_secret(), &original);
            } else {
                assert!(result.is_err());
            }

            let saved = entry
                .read_encryption_key()
                .unwrap()
                .unwrap()
                .to_keychain_value()
                .unwrap();
            if matches!(failure, WriteFailure::BeforeWrite) {
                assert_eq!(saved.expose_secret(), &original);
            } else {
                assert_eq!(saved.expose_secret(), &"42".repeat(32));
            }
        }
        storage.0.lock().unwrap().failure = WriteFailure::BeforeWrite;
        assert!(entry.write_encryption_key(&replacement).unwrap().is_none());
        assert_eq!(
            entry.read().unwrap().unwrap().expose_secret(),
            &"42".repeat(32)
        );
        storage.0.lock().unwrap().failure = WriteFailure::None;
    }

    #[test]
    fn unreadable_saved_keys_are_errors_not_missing_entries() {
        install_test_store();
        let entry = KeychainEntry {
            app_id: "com.argon.keychain-tests".into(),
            service: "com.argon.keychain-tests.mnemonic".into(),
            account: "testnet/unreadable".into(),
        };
        entry.write("damaged-synthetic-key").unwrap();
        assert!(entry.read_encryption_key().is_err());
        assert!(entry.require_encryption_key().is_err());
        assert_eq!(
            entry.read().unwrap().unwrap().expose_secret(),
            "damaged-synthetic-key"
        );
    }

    // Replace only the OS credential store. Production entry lookup, parsing and persistence run unchanged.
    fn install_test_store() {
        static INSTALLED: OnceLock<()> = OnceLock::new();
        INSTALLED.get_or_init(|| {
            keyring::set_default_credential_builder(Box::new(TestStore::default()));
        });
    }

    type TestSlots = HashMap<(String, String), Arc<Mutex<TestSlot>>>;

    #[derive(Default)]
    struct TestStore(Mutex<TestSlots>);

    impl CredentialBuilderApi for TestStore {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            account: &str,
        ) -> keyring::Result<Box<Credential>> {
            let mut slots = self.0.lock().unwrap();
            let slot = slots.entry((service.into(), account.into())).or_default();
            Ok(Box::new(TestCredential(Arc::clone(slot))))
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    #[derive(Default)]
    struct TestSlot {
        secret: Option<Vec<u8>>,
        failure: WriteFailure,
        read_error: bool,
    }

    #[derive(Clone, Copy, Default)]
    enum WriteFailure {
        #[default]
        None,
        BeforeWrite,
        AfterWrite,
        UnreadableAfterWrite,
    }

    struct TestCredential(Arc<Mutex<TestSlot>>);

    impl CredentialApi for TestCredential {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            let mut slot = self.0.lock().unwrap();
            let failure = std::mem::take(&mut slot.failure);
            if !matches!(failure, WriteFailure::BeforeWrite) {
                slot.secret = Some(secret.to_vec());
            }
            slot.read_error = matches!(failure, WriteFailure::UnreadableAfterWrite);
            if matches!(failure, WriteFailure::None) {
                Ok(())
            } else {
                Err(keyring::Error::Invalid(
                    "synthetic write".into(),
                    "failed".into(),
                ))
            }
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            let mut slot = self.0.lock().unwrap();
            if std::mem::take(&mut slot.read_error) {
                return Err(keyring::Error::Invalid(
                    "synthetic readback".into(),
                    "failed".into(),
                ));
            }
            slot.secret.clone().ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            self.0
                .lock()
                .unwrap()
                .secret
                .take()
                .ok_or(keyring::Error::NoEntry)?;
            Ok(())
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }
}
