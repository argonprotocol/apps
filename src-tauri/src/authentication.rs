use serde::Serialize;
use std::time::Duration;

pub use platform::{available_option, confirm};

const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemAuthenticationOption {
    #[cfg(target_os = "macos")]
    TouchId,
    #[cfg(target_os = "macos")]
    FaceId,
    #[cfg(target_os = "windows")]
    WindowsHello,
    #[cfg(target_os = "linux")]
    Fingerprint,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{CONFIRMATION_TIMEOUT, SystemAuthenticationOption};
    use block2::RcBlock;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LABiometryType, LAContext, LAPolicy};
    use std::sync::mpsc;

    pub async fn available_option() -> Result<Option<SystemAuthenticationOption>, String> {
        let context = unsafe { LAContext::new() };
        if unsafe {
            context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
        }
        .is_err()
        {
            return Ok(None);
        }

        let option = match unsafe { context.biometryType() } {
            LABiometryType::TouchID => Some(SystemAuthenticationOption::TouchId),
            LABiometryType::FaceID => Some(SystemAuthenticationOption::FaceId),
            _ => None,
        };
        Ok(option)
    }

    pub async fn confirm(reason: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let context = unsafe { LAContext::new() };
            unsafe { context.setLocalizedFallbackTitle(Some(&NSString::from_str(""))) };
            let (sender, receiver) = mpsc::sync_channel(1);
            let reply = RcBlock::new(move |success: objc2::runtime::Bool, error: *mut NSError| {
                let result = if success.as_bool() {
                    Ok(())
                } else if let Some(error) = unsafe { error.as_ref() } {
                    Err(error.localizedDescription().to_string())
                } else {
                    Err("System authentication was not confirmed.".to_string())
                };
                let _ = sender.try_send(result);
            });

            unsafe {
                context.evaluatePolicy_localizedReason_reply(
                    LAPolicy::DeviceOwnerAuthenticationWithBiometrics,
                    &NSString::from_str(&reason),
                    &reply,
                );
            }

            let result = receiver
                .recv_timeout(CONFIRMATION_TIMEOUT)
                .map_err(|_| "System authentication timed out.".to_string());
            unsafe { context.invalidate() };
            result?
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{CONFIRMATION_TIMEOUT, SystemAuthenticationOption};
    use windows::Security::Credentials::KeyCredentialManager;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::TpmBaseServices::{
        TBS_SUCCESS, TPM_DEVICE_INFO, TPM_VERSION_20, Tbsi_GetDeviceInfo,
    };
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows::core::factory;

    pub async fn available_option() -> Result<Option<SystemAuthenticationOption>, String> {
        let supports_credentials = KeyCredentialManager::IsSupportedAsync()
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;
        if !supports_credentials {
            return Ok(None);
        }

        // Key protection requires TPM 2.0 attestation, not software-only Hello credentials.
        let mut device_info = TPM_DEVICE_INFO {
            structVersion: TPM_VERSION_20,
            ..Default::default()
        };
        let result = unsafe {
            Tbsi_GetDeviceInfo(
                std::mem::size_of::<TPM_DEVICE_INFO>() as u32,
                std::ptr::from_mut(&mut device_info).cast(),
            )
        };
        if result != TBS_SUCCESS {
            return Ok(None);
        }
        if device_info.tpmVersion != TPM_VERSION_20 {
            return Ok(None);
        }

        Ok(Some(SystemAuthenticationOption::WindowsHello))
    }

    pub async fn confirm(reason: String, window_handle: isize) -> Result<(), String> {
        let verification = {
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|error| error.to_string())?;
            unsafe {
                interop.RequestVerificationForWindowAsync::<
                    windows_future::IAsyncOperation<UserConsentVerificationResult>,
                >(HWND(window_handle as *mut _), &reason.into())
            }
            .map_err(|error| error.to_string())?
        };

        let result = tokio::time::timeout(CONFIRMATION_TIMEOUT, verification.clone()).await;
        let result = match result {
            Ok(result) => result.map_err(|error| error.to_string())?,
            Err(_) => {
                let _ = verification.Cancel();
                return Err("System authentication timed out.".to_string());
            }
        };
        if result == UserConsentVerificationResult::Verified {
            return Ok(());
        }
        Err(format!(
            "System authentication was not confirmed: {result:?}"
        ))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{CONFIRMATION_TIMEOUT, SystemAuthenticationOption};
    use futures_util::StreamExt;
    use zbus::{Proxy, connection::Builder, zvariant::OwnedObjectPath};

    pub async fn available_option() -> Result<Option<SystemAuthenticationOption>, String> {
        let Ok(device) = fingerprint_device().await else {
            return Ok(None);
        };
        let fingers: Vec<String> = match device.call("ListEnrolledFingers", &("",)).await {
            Ok(fingers) => fingers,
            Err(_) => return Ok(None),
        };
        if fingers.is_empty() {
            return Ok(None);
        }
        Ok(Some(SystemAuthenticationOption::Fingerprint))
    }

    pub async fn confirm(_reason: String) -> Result<(), String> {
        let device = fingerprint_device()
            .await
            .map_err(|error| error.to_string())?;
        device
            .call::<_, _, ()>("Claim", &("",))
            .await
            .map_err(|error| error.to_string())?;

        let verification = async {
            let mut statuses = device
                .receive_signal("VerifyStatus")
                .await
                .map_err(|error| error.to_string())?;
            device
                .call::<_, _, ()>("VerifyStart", &("any",))
                .await
                .map_err(|error| error.to_string())?;
            while let Some(message) = statuses.next().await {
                let (status, done): (String, bool) = message
                    .body()
                    .deserialize()
                    .map_err(|error| error.to_string())?;
                if status == "verify-match" {
                    return Ok(());
                }
                if done {
                    return Err(format!(
                        "Fingerprint authentication was not confirmed: {status}"
                    ));
                }
            }
            Err("Fingerprint reader disconnected.".to_string())
        };
        let result = tokio::time::timeout(CONFIRMATION_TIMEOUT, verification).await;
        let _ = device.call::<_, _, ()>("VerifyStop", &()).await;
        let _ = device.call::<_, _, ()>("Release", &()).await;
        result.map_err(|_| "Fingerprint authentication timed out.".to_string())?
    }

    async fn fingerprint_device() -> zbus::Result<Proxy<'static>> {
        let connection = Builder::system()?
            .method_timeout(std::time::Duration::from_secs(5))
            .build()
            .await?;
        let manager = Proxy::new(
            &connection,
            "net.reactivated.Fprint",
            "/net/reactivated/Fprint/Manager",
            "net.reactivated.Fprint.Manager",
        )
        .await?;
        let path: OwnedObjectPath = manager.call("GetDefaultDevice", &()).await?;
        Proxy::new_owned(
            connection.clone(),
            "net.reactivated.Fprint",
            path,
            "net.reactivated.Fprint.Device",
        )
        .await
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::SystemAuthenticationOption;

    pub async fn available_option() -> Result<Option<SystemAuthenticationOption>, String> {
        Ok(None)
    }

    pub async fn confirm(_reason: String) -> Result<(), String> {
        Err("System authentication is not supported on this platform.".to_string())
    }
}
