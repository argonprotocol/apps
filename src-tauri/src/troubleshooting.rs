use crate::utils::Utils;
use reqwest::Url;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Command;
use tauri::AppHandle;
use time::OffsetDateTime;

pub fn collect_os_profile(app: &AppHandle) -> Result<String, String> {
    let config_instance_dir = Utils::get_absolute_config_instance_dir(app);
    let temp_dir = std::env::temp_dir();

    let profile = json!({
        "collectedAtUnixSeconds": OffsetDateTime::now_utc().unix_timestamp(),
        "app": {
            "identifier": app.config().identifier.clone(),
            "version": app.package_info().version.to_string(),
        },
        "system": collect_system_profile(),
        "storage": {
            "configInstanceDir": collect_path_status(&config_instance_dir),
            "tempDir": collect_path_status(&temp_dir),
        },
        "networkEnvironment": collect_network_environment(),
        "windowsSecurity": collect_windows_security_profile(),
        "windowsNetwork": collect_windows_network_profile(),
    });

    serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())
}

fn collect_path_status(path: &Path) -> Value {
    let metadata = fs::metadata(path);
    let exists = metadata.is_ok();
    let is_directory = metadata.as_ref().is_ok_and(|x| x.is_dir());
    let metadata_error = metadata.err().map(|e| e.to_string());
    let available_space_bytes = fs2::available_space(path).ok();
    let write_check_error = if is_directory {
        test_directory_write(path).err()
    } else if exists {
        Some("Path is not a directory".to_string())
    } else {
        Some("Path does not exist".to_string())
    };

    json!({
        "exists": exists,
        "isDirectory": is_directory,
        "availableSpaceBytes": available_space_bytes,
        "writable": write_check_error.is_none(),
        "metadataError": metadata_error,
        "writeCheckError": write_check_error,
    })
}

fn test_directory_write(path: &Path) -> Result<(), String> {
    let test_file = path.join(format!(
        ".argon-troubleshooting-write-check-{}-{}",
        std::process::id(),
        OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));

    fs::write(&test_file, []).map_err(|e| e.to_string())?;
    fs::remove_file(&test_file).map_err(|e| e.to_string())?;
    Ok(())
}

fn collect_system_profile() -> Value {
    json!({
        "platform": std::env::consts::OS,
        "family": std::env::consts::FAMILY,
        "arch": std::env::consts::ARCH,
        "version": collect_system_version(),
    })
}

#[cfg(target_os = "macos")]
fn collect_system_version() -> Value {
    json!({
        "productName": run_command_text("sw_vers", &["-productName"]).ok(),
        "productVersion": run_command_text("sw_vers", &["-productVersion"]).ok(),
        "buildVersion": run_command_text("sw_vers", &["-buildVersion"]).ok(),
    })
}

#[cfg(target_os = "windows")]
fn collect_system_version() -> Value {
    Value::Null
}

#[cfg(all(unix, not(target_os = "macos")))]
fn collect_system_version() -> Value {
    json!({
        "kernelRelease": run_command_text("uname", &["-r"]).ok(),
    })
}

fn collect_network_environment() -> Value {
    json!({
        "proxyVars": {
            "http_proxy": summarize_proxy_env_var("HTTP_PROXY"),
            "https_proxy": summarize_proxy_env_var("HTTPS_PROXY"),
            "all_proxy": summarize_proxy_env_var("ALL_PROXY"),
            "no_proxy": summarize_present_env_var("NO_PROXY"),
        },
        "certificateVars": {
            "ssl_cert_file": summarize_present_env_var("SSL_CERT_FILE"),
            "ssl_cert_dir": summarize_present_env_var("SSL_CERT_DIR"),
            "curl_ca_bundle": summarize_present_env_var("CURL_CA_BUNDLE"),
            "requests_ca_bundle": summarize_present_env_var("REQUESTS_CA_BUNDLE"),
        },
    })
}

fn summarize_proxy_env_var(key: &str) -> Value {
    let Ok(raw) = std::env::var(key) else {
        return Value::String("absent".to_string());
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Value::String("absent".to_string());
    }

    if let Ok(url) = Url::parse(raw) {
        let value = if !url.username().is_empty() || url.password().is_some() {
            "configured_with_credentials"
        } else {
            "configured"
        };
        return Value::String(value.to_string());
    }

    Value::String("configured_unparsed".to_string())
}

fn summarize_present_env_var(key: &str) -> Value {
    let present = std::env::var(key)
        .ok()
        .is_some_and(|value| !value.trim().is_empty());

    Value::String(if present { "configured" } else { "absent" }.to_string())
}

#[cfg(target_os = "windows")]
fn collect_windows_security_profile() -> Value {
    json!({
        "os": result_or_error(run_powershell_json(
            "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime",
        )),
        "firewallProfiles": result_or_error(run_powershell_json(
            "Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction,AllowInboundRules,NotifyOnListen",
        )),
        "antivirusProducts": result_or_error(run_powershell_json(
            "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct | Select-Object displayName,productState,timestamp",
        )),
        "defenderStatus": result_or_error(run_powershell_json(
            "Get-MpComputerStatus | Select-Object AMRunningMode,AMServiceEnabled,AntispywareEnabled,AntivirusEnabled,BehaviorMonitorEnabled,DefenderSignaturesOutOfDate,IoavProtectionEnabled,IsTamperProtected,NISEnabled,OnAccessProtectionEnabled,QuickScanAge,RealTimeProtectionEnabled,AntivirusSignatureVersion,AntivirusSignatureLastUpdated",
        )),
        "defenderPreferences": result_or_error(run_powershell_json(
            "Get-MpPreference | Select-Object EnableControlledFolderAccess,DisableRealtimeMonitoring",
        )),
    })
}

#[cfg(not(target_os = "windows"))]
fn collect_windows_security_profile() -> Value {
    Value::Null
}

#[cfg(target_os = "windows")]
fn collect_windows_network_profile() -> Value {
    json!({
        "connectionProfiles": result_or_error(run_powershell_json(
            "Get-NetConnectionProfile | Select-Object NetworkCategory,IPv4Connectivity,IPv6Connectivity",
        )),
        "internetSettingsProxy": result_or_error(
            run_powershell_json(
                "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL,AutoDetect",
            )
            .map(summarize_windows_proxy_settings)
        ),
        "winHttpProxy": result_or_error(run_powershell_text(
            "netsh winhttp show proxy",
        ).map(summarize_winhttp_proxy)),
    })
}

#[cfg(not(target_os = "windows"))]
fn collect_windows_network_profile() -> Value {
    Value::Null
}

#[cfg(target_os = "windows")]
fn result_or_error(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => value,
        Err(error) => json!({ "error": error }),
    }
}

#[cfg(target_os = "windows")]
fn run_powershell_json(script: &str) -> Result<Value, String> {
    let command = format!("{script} | ConvertTo-Json -Depth 6 -Compress");
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .output()
        .map_err(|e| format!("Failed to launch PowerShell: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "PowerShell exited with {}{}",
            output.status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(Value::Null);
    }

    serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse PowerShell JSON: {e}"))
}

#[cfg(target_os = "windows")]
fn run_powershell_text(script: &str) -> Result<Value, String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to launch PowerShell: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "PowerShell exited with {}{}",
            output.status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }

    Ok(json!({
        "text": String::from_utf8_lossy(&output.stdout).trim(),
    }))
}

#[cfg(target_os = "windows")]
fn summarize_windows_proxy_settings(value: Value) -> Value {
    let object = match value {
        Value::Object(object) => object,
        other => return other,
    };

    json!({
        "proxyEnabled": object.get("ProxyEnable").and_then(Value::as_i64).is_some_and(|x| x != 0),
        "autoDetect": object.get("AutoDetect").and_then(Value::as_i64).is_some_and(|x| x != 0),
        "proxyConfigured": object
            .get("ProxyServer")
            .and_then(Value::as_str)
            .is_some_and(|x| !x.trim().is_empty()),
        "autoConfigConfigured": object
            .get("AutoConfigURL")
            .and_then(Value::as_str)
            .is_some_and(|x| !x.trim().is_empty()),
    })
}

#[cfg(target_os = "windows")]
fn summarize_winhttp_proxy(value: Value) -> Value {
    let Some(text) = value.get("text").and_then(Value::as_str) else {
        return value;
    };

    let normalized = text.to_ascii_lowercase();
    json!({
        "configured": !normalized.contains("direct access"),
        "hasBypassList": normalized.contains("bypass list"),
    })
}

fn run_command_text(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to launch {command}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!(
            "{command} exited with {}{}",
            output.status,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
