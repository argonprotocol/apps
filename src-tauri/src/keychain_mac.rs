use anyhow::{Result, ensure};
use core_foundation::base::{CFType, TCFType};
use objc2_foundation::NSString;
use objc2_local_authentication::LAContext;
use secrecy::{ExposeSecret, SecretSlice};
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
use security_framework::passwords::{
    PasswordOptions, delete_generic_password_options, set_generic_password_options,
};
use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
#[cfg(not(argon_signed_build))]
use std::process::Command;

use crate::encryption_key::{EncryptionKey, decode_key, validate_hardware_key_name};

const SERVICE: &str = "argon.hardware-unlock";

pub fn create(prefix: &str, key: &EncryptionKey, reason: &str) -> Result<String> {
    let name = format!("{prefix}{}", hex::encode(rand::random::<[u8; 16]>()));
    let access = SecAccessControl::create_with_protection(
        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
        kSecAccessControlBiometryCurrentSet,
    )?;
    let mut options = PasswordOptions::new_generic_password(SERVICE, &name);
    options.use_protected_keychain();
    options.set_access_control(access);
    set_generic_password_options(key.expose_secret(), options).map_err(|error| {
        // errSecMissingEntitlement is not exported by security-framework-sys.
        if error.code() == -34018 {
            return anyhow::anyhow!(
                "Touch ID is unavailable in this app build because its keychain signing permissions are missing. Use App Passcode instead."
            );
        }
        anyhow::Error::from(error)
    })?;

    // Verify the protected read before replacing any existing keychain record.
    let verification = read(prefix, &name, reason).and_then(|verified| {
        ensure!(
            verified.expose_secret() == key.expose_secret(),
            "The protected key could not be verified"
        );
        Ok(())
    });
    if let Err(error) = verification {
        let _ = delete(prefix, &name);
        return Err(error);
    }
    Ok(name)
}

pub fn read(prefix: &str, name: &str, reason: &str) -> Result<EncryptionKey> {
    validate_hardware_key_name(prefix, name)?;
    let authentication = unsafe { LAContext::new() };
    unsafe {
        authentication.setLocalizedReason(&NSString::from_str(reason));
        authentication.setLocalizedFallbackTitle(Some(&NSString::from_str("")));
        authentication.setTouchIDAuthenticationAllowableReuseDuration(0.0);
    }

    let result = (|| {
        // Retain for the Security Framework query; invalidate our context after the read.
        let context =
            unsafe { CFType::wrap_under_get_rule((&*authentication as *const LAContext).cast()) };
        log::info!(
            "[SecurityAccess] event=hardware-authentication-requested platform=macos operation=protected-read"
        );
        let results = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(SERVICE)
            .account(name)
            .ignore_legacy_keychains()
            .load_data(true)
            .local_authentication_context(Some(context))
            .search()?;
        let Some(SearchResult::Data(bytes)) = results.into_iter().next() else {
            anyhow::bail!("The biometric-protected keychain entry is unavailable");
        };
        let bytes: SecretSlice<u8> = bytes.into();
        decode_key(bytes.expose_secret())
    })();
    unsafe { authentication.invalidate() };
    log::info!(
        "[SecurityAccess] event=hardware-authentication-finished platform=macos success={}",
        result.is_ok()
    );
    result
}

pub fn delete(prefix: &str, name: &str) -> Result<()> {
    validate_hardware_key_name(prefix, name)?;
    let mut options = PasswordOptions::new_generic_password(SERVICE, name);
    options.use_protected_keychain();
    delete_generic_password_options(options)?;
    Ok(())
}

#[cfg(any(test, not(argon_signed_build)))]
pub(crate) fn uses_local_dev_keychain(app_id: &str) -> bool {
    cfg!(not(argon_signed_build)) && app_id.ends_with(".local")
}

#[cfg(not(argon_signed_build))]
pub(crate) fn read_local_dev_keychain_entry(
    service: &str,
    account: &str,
) -> Result<Option<String>> {
    let output = Command::new("security")
        .arg("find-generic-password")
        .arg("-a")
        .arg(account)
        .arg("-s")
        .arg(service)
        .arg("-w")
        .output()?;

    if output.status.success() {
        return Ok(Some(String::from_utf8(output.stdout)?.trim().to_string()));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found in the keychain") {
        return Ok(None);
    }

    anyhow::bail!(
        "Failed to read local keychain entry ({}): {}",
        output.status,
        stderr.trim()
    );
}

#[cfg(not(argon_signed_build))]
pub(crate) fn write_local_dev_keychain_entry(
    service: &str,
    account: &str,
    value: &str,
) -> Result<()> {
    let output = Command::new("security")
        .arg("add-generic-password")
        .arg("-U")
        .arg("-a")
        .arg(account)
        .arg("-s")
        .arg(service)
        .arg("-w")
        .arg(value)
        .output()?;

    anyhow::ensure!(
        output.status.success(),
        "Failed to create local keychain entry: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );

    Ok(())
}

#[cfg(not(argon_signed_build))]
pub(crate) fn delete_local_dev_keychain_entry(service: &str, account: &str) -> Result<()> {
    let output = Command::new("security")
        .args(["delete-generic-password", "-a", account, "-s", service])
        .output()?;
    ensure!(
        output.status.success(),
        "Failed to delete local keychain entry"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::uses_local_dev_keychain;

    #[test]
    fn local_dev_keychain_is_only_used_for_unsigned_macos_local_apps() {
        assert!(!uses_local_dev_keychain("com.argon.desktop"));
        assert!(!uses_local_dev_keychain("com.argon.desktop.local.test"));
        assert_eq!(
            uses_local_dev_keychain("com.argon.desktop.local"),
            cfg!(not(argon_signed_build))
        );
    }
}
