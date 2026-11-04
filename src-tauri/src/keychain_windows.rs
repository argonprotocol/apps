use crate::encryption_key::{
    EncryptionKey, decode_key, decrypt, encrypt, validate_hardware_key_name,
};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use secrecy::ExposeSecret;
use secrecy::{SecretSlice, zeroize::Zeroize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::mpsc;
use std::time::Duration;
use windows::Security::Credentials::{
    KeyCredential, KeyCredentialAttestationStatus, KeyCredentialCreationOption,
    KeyCredentialManager, KeyCredentialStatus,
};
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::{DataReader, IBuffer};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::{HSTRING, RuntimeType};
use windows_future::{
    AsyncActionCompletedHandler, AsyncOperationCompletedHandler, IAsyncAction, IAsyncOperation,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtectedKey {
    version: u8,
    key_name: String,
    public_key: String,
    challenge: String,
    encrypted_key: String,
}

pub fn create(wrapping_key_prefix: &str, aes_key: &EncryptionKey, _reason: &str) -> Result<String> {
    let _apartment = WinRtApartment::initialize()?;
    let wrapping_key_name = format!(
        "{wrapping_key_prefix}{}",
        hex::encode(rand::random::<[u8; 16]>())
    );
    log::info!(
        "[SecurityAccess] event=hardware-authentication-requested platform=windows operation=create-credential"
    );
    let creation_result = wait_for_operation(KeyCredentialManager::RequestCreateAsync(
        &HSTRING::from(&wrapping_key_name),
        KeyCredentialCreationOption::FailIfExists,
    )?)?;
    ensure!(
        creation_result.Status()? == KeyCredentialStatus::Success,
        "Windows Hello key creation was not approved"
    );

    let wrap_result = (|| {
        let wrapping_credential = creation_result.Credential()?;
        require_tpm_attestation(&wrapping_credential)?;

        let wrapping_public_key = BASE64.encode(
            copy_buffer_bytes(&wrapping_credential.RetrievePublicKeyWithDefaultBlobType()?)?
                .expose_secret(),
        );
        let wrapping_challenge = rand::random::<[u8; 32]>();
        let wrapping_key =
            derive_wrapping_key_from_signature(&wrapping_credential, &wrapping_challenge)?;

        let encrypted_aes_key = encrypt(wrapping_key.expose_secret(), aes_key.expose_secret())?;

        Ok(serde_json::to_string(&ProtectedKey {
            version: 1,
            key_name: wrapping_key_name.clone(),
            public_key: wrapping_public_key,
            challenge: BASE64.encode(wrapping_challenge),
            encrypted_key: encrypted_aes_key,
        })?)
    })();

    if wrap_result.is_err() {
        let cleanup = KeyCredentialManager::DeleteAsync(&HSTRING::from(&wrapping_key_name))
            .map_err(anyhow::Error::from)
            .and_then(wait_for_action);
        if let Err(error) = cleanup {
            log::warn!("Unable to remove an unused Windows Hello key: {error}");
        }
    }
    wrap_result
}

pub fn read(
    wrapping_key_prefix: &str,
    wrapped_key_json: &str,
    _reason: &str,
) -> Result<EncryptionKey> {
    let record: ProtectedKey = serde_json::from_str(wrapped_key_json)?;
    ensure!(record.version == 1, "Unsupported hardware key version");
    validate_hardware_key_name(wrapping_key_prefix, &record.key_name)?;

    let _apartment = WinRtApartment::initialize()?;
    let open_result = wait_for_operation(KeyCredentialManager::OpenAsync(&HSTRING::from(
        &record.key_name,
    ))?)?;
    ensure!(
        open_result.Status()? == KeyCredentialStatus::Success,
        "The Windows Hello key is unavailable"
    );

    let wrapping_credential = open_result.Credential()?;
    let public_key = BASE64.encode(
        copy_buffer_bytes(&wrapping_credential.RetrievePublicKeyWithDefaultBlobType()?)?
            .expose_secret(),
    );
    ensure!(
        public_key == record.public_key,
        "The Windows Hello key has changed"
    );

    require_tpm_attestation(&wrapping_credential)?;

    let wrapping_challenge = BASE64.decode(record.challenge)?;
    ensure!(
        wrapping_challenge.len() == 32,
        "Invalid hardware wrapping challenge"
    );
    let wrapping_key =
        derive_wrapping_key_from_signature(&wrapping_credential, &wrapping_challenge)?;

    let aes_key_bytes = decrypt(wrapping_key.expose_secret(), &record.encrypted_key)?;
    decode_key(aes_key_bytes.expose_secret())
}

pub fn delete(wrapping_key_prefix: &str, wrapped_key_json: &str) -> Result<()> {
    let record: ProtectedKey = serde_json::from_str(wrapped_key_json)?;
    validate_hardware_key_name(wrapping_key_prefix, &record.key_name)?;

    let _apartment = WinRtApartment::initialize()?;
    wait_for_action(KeyCredentialManager::DeleteAsync(&HSTRING::from(
        &record.key_name,
    ))?)?;
    Ok(())
}

fn require_tpm_attestation(wrapping_credential: &KeyCredential) -> Result<()> {
    let attestation = wait_for_operation(wrapping_credential.GetAttestationAsync()?)?;
    ensure!(
        attestation.Status()? == KeyCredentialAttestationStatus::Success,
        "Windows could not attest that this credential is TPM-backed"
    );
    ensure!(
        attestation.AttestationBuffer()?.Length()? > 0
            && attestation.CertificateChainBuffer()?.Length()? > 0,
        "Windows returned incomplete TPM attestation"
    );
    Ok(())
}

fn derive_wrapping_key_from_signature(
    wrapping_credential: &KeyCredential,
    wrapping_challenge: &[u8],
) -> Result<EncryptionKey> {
    // Windows KeyCredential uses deterministic RSA/SHA-256/PKCS#1 signing, as used by KeePassXC.
    let wrapping_challenge = CryptographicBuffer::CreateFromByteArray(wrapping_challenge)?;
    log::info!(
        "[SecurityAccess] event=hardware-authentication-requested platform=windows operation=sign-challenge"
    );
    let sign_result =
        wait_for_operation(wrapping_credential.RequestSignAsync(&wrapping_challenge)?)?;
    ensure!(
        sign_result.Status()? == KeyCredentialStatus::Success,
        "Windows Hello key use was not approved"
    );

    let signature = copy_buffer_bytes(&sign_result.Result()?)?;
    let mut signature_hash = Sha256::digest(signature.expose_secret());
    let wrapping_key = decode_key(signature_hash.as_slice());
    signature_hash.as_mut_slice().zeroize();
    wrapping_key
}

fn copy_buffer_bytes(buffer: &IBuffer) -> Result<SecretSlice<u8>> {
    let mut bytes = vec![0; buffer.Length()? as usize];
    DataReader::FromBuffer(buffer)?.ReadBytes(&mut bytes)?;
    Ok(bytes.into())
}

fn wait_for_operation<T: RuntimeType + 'static>(operation: IAsyncOperation<T>) -> Result<T> {
    let (sender, receiver) = mpsc::sync_channel(1);
    operation.SetCompleted(&AsyncOperationCompletedHandler::new(move |_, _| {
        let _ = sender.try_send(());
        Ok(())
    }))?;
    if receiver.recv_timeout(Duration::from_secs(60)).is_err() {
        let _ = operation.Cancel();
        anyhow::bail!("Windows Hello operation timed out");
    }
    Ok(operation.GetResults()?)
}

fn wait_for_action(operation: IAsyncAction) -> Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    operation.SetCompleted(&AsyncActionCompletedHandler::new(move |_, _| {
        let _ = sender.try_send(());
        Ok(())
    }))?;
    if receiver.recv_timeout(Duration::from_secs(60)).is_err() {
        let _ = operation.Cancel();
        anyhow::bail!("Windows Hello key removal timed out");
    }
    Ok(operation.GetResults()?)
}

struct WinRtApartment;
impl WinRtApartment {
    fn initialize() -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}
impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}
