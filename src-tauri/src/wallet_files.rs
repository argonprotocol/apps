use anyhow::{Result, ensure};
use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::utils::Utils;

#[tauri::command]
pub async fn read_wallet_file(app: AppHandle, filename: String) -> Result<Option<String>, String> {
    let path = wallet_file_path(&app, &filename).map_err(|error| error.to_string())?;
    read_account_file(&path).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_mnemonic_file(app: AppHandle) -> Result<Option<String>, String> {
    read_account_file(&Utils::get_absolute_config_instance_dir(&app).join("mnemonic"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn write_wallet_file(
    app: AppHandle,
    contents: String,
    create_new: bool,
    filename: String,
) -> Result<(), String> {
    let path = wallet_file_path(&app, &filename).map_err(|error| error.to_string())?;
    stage_file(&path, &contents, create_new).map_err(|error| error.to_string())?;
    commit_file(&path, create_new).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_wallet_file(app: AppHandle, filename: String) -> Result<(), String> {
    let path = wallet_file_path(&app, &filename).map_err(|error| error.to_string())?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    fs::File::open(path.parent().unwrap())
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn cleanup_mnemonic_files(app: AppHandle, mnemonic: String) -> Result<usize, String> {
    let mut config_dirs = vec![Utils::get_absolute_config_instance_dir(&app)];
    if let Some(suffix) = app.config().identifier.strip_prefix("com.argon.desktop") {
        // Operations used the same network/instance layout before the Desktop rename.
        let app_config_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?;
        if let Some(base_dir) = app_config_dir.parent() {
            config_dirs.push(base_dir.join(format!("com.argon.operations{suffix}")).join(
                Utils::get_relative_config_instance_dir(app.config().identifier.as_str()),
            ));
        }
    }

    remove_matching_mnemonic_files(&config_dirs, &mnemonic).map_err(|error| error.to_string())
}

fn wallet_file_path(app: &AppHandle, filename: &str) -> Result<PathBuf> {
    ensure!(
        Path::new(filename).file_name() == Some(OsStr::new(filename)) && !filename.contains('\\'),
        "Use a filename within the current profile, not a path"
    );
    Ok(Utils::get_absolute_config_instance_dir(app).join(filename))
}

fn read_account_file(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn stage_file(path: &Path, contents: &str, create_new: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Wallet directory is unavailable"))?;
    fs::create_dir_all(parent)?;
    let temporary_path = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
    if create_new && temporary_path.try_exists()? {
        ensure!(
            fs::symlink_metadata(&temporary_path)?.is_file(),
            "The pending wallet must be a regular file"
        );
        ensure!(
            fs::read_to_string(&temporary_path)? == contents,
            "A different pending wallet exists; it has been preserved"
        );
        // Reuse the validated copy; never remove the only saved wallet before publication.
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary_path)?
            .sync_all()?;
        return Ok(());
    }
    if !create_new {
        match fs::remove_file(&temporary_path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary_path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn commit_file(path: &Path, create_new: bool) -> Result<()> {
    let temporary_path = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
    #[cfg(unix)]
    let directory = fs::File::open(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("Wallet directory is unavailable"))?,
    )?;
    if create_new {
        fs::hard_link(&temporary_path, path)?;
        // Publish the final name durably before removing the pending copy.
        #[cfg(unix)]
        directory.sync_all()?;
        fs::remove_file(&temporary_path)?;
    } else {
        fs::rename(&temporary_path, path)?;
    }
    #[cfg(unix)]
    directory.sync_all()?;
    Ok(())
}

fn remove_matching_mnemonic_files(config_dirs: &[PathBuf], mnemonic: &str) -> Result<usize> {
    let mut removed = 0;
    for config_dir in config_dirs {
        let mut candidates = vec![config_dir.join("mnemonic")];
        let backup_dir = config_dir.join("mnemonic-backups");
        if backup_dir.try_exists()? {
            for entry in walkdir::WalkDir::new(&backup_dir).follow_root_links(false) {
                let entry = entry?;
                if entry.file_type().is_file() && entry.file_name() == "mnemonic" {
                    candidates.push(entry.into_path());
                }
            }
        }

        for path in candidates {
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !metadata.is_file() {
                continue;
            }

            let contents = fs::read_to_string(&path)?;
            if !contents.split_whitespace().eq(mnemonic.split_whitespace()) {
                continue;
            }

            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stages_wallet_contents_without_replacing_an_existing_wallet_until_commit() {
        let directory = unique_test_dir("wallet-file-creation");
        let path = directory.join("wallet.json");
        let temporary = directory.join("wallet.json.tmp");
        stage_file(&path, "first encrypted wallet", true).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&temporary).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(!path.exists());
        assert!(stage_file(&path, "another creation", true).is_err());
        assert_eq!(
            fs::read_to_string(&temporary).unwrap(),
            "first encrypted wallet"
        );
        // Replaying a validated pending write must preserve the only saved copy until publication.
        stage_file(&path, "first encrypted wallet", true).unwrap();
        assert!(!path.exists());
        commit_file(&path, true).unwrap();

        // A crash after the initial hard link can leave both names on the same inode.
        fs::hard_link(&path, &temporary).unwrap();
        stage_file(&path, "replacement", false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first encrypted wallet");
        assert!(commit_file(&path, true).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first encrypted wallet");
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "replacement");

        stage_file(&path, "updated encrypted wallet", false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first encrypted wallet");
        commit_file(&path, false).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "updated encrypted wallet"
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn removes_only_matching_mnemonic_files() {
        let test_dir = unique_test_dir("cleanup-matching-mnemonics");
        let desktop_dir = test_dir.join("desktop");
        let operations_dir = test_dir.join("operations");
        let backup_dir = desktop_dir.join("mnemonic-backups").join("before-import");
        fs::create_dir_all(&backup_dir).unwrap();
        fs::create_dir_all(&operations_dir).unwrap();

        let mnemonic = "test test test test test test test test test test test junk";
        let other_mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let wallet_path = desktop_dir.join("wallet.json");
        let wallet_contents = b"existing wallet contents";
        fs::write(&wallet_path, wallet_contents).unwrap();
        fs::write(desktop_dir.join("mnemonic"), mnemonic).unwrap();
        fs::write(operations_dir.join("mnemonic"), format!("  {mnemonic}\n")).unwrap();
        fs::write(backup_dir.join("mnemonic"), mnemonic).unwrap();
        fs::write(operations_dir.join("unrelated-file"), mnemonic).unwrap();
        let other_backup = operations_dir
            .join("mnemonic-backups")
            .join("other-account");
        fs::create_dir_all(&other_backup).unwrap();
        fs::write(other_backup.join("mnemonic"), other_mnemonic).unwrap();

        let config_dirs = [desktop_dir.clone(), operations_dir.clone()];

        assert_eq!(
            remove_matching_mnemonic_files(&config_dirs, mnemonic).unwrap(),
            3
        );
        assert!(!desktop_dir.join("mnemonic").exists());
        assert!(!operations_dir.join("mnemonic").exists());
        assert!(!backup_dir.join("mnemonic").exists());
        assert_eq!(
            fs::read_to_string(other_backup.join("mnemonic")).unwrap(),
            other_mnemonic
        );
        assert_eq!(
            fs::read_to_string(operations_dir.join("unrelated-file")).unwrap(),
            mnemonic
        );
        assert_eq!(fs::read(&wallet_path).unwrap(), wallet_contents);
        fs::remove_dir_all(&test_dir).unwrap();
    }

    #[test]
    fn preserves_non_utf8_mnemonic_file() {
        let test_dir = unique_test_dir("cleanup-unreadable-file");
        fs::create_dir_all(&test_dir).unwrap();
        let mnemonic = "test test test test test test test test test test test junk";
        let mnemonic_path = test_dir.join("mnemonic");
        fs::write(&mnemonic_path, [0xff]).unwrap();

        assert!(remove_matching_mnemonic_files(std::slice::from_ref(&test_dir), mnemonic).is_err());
        assert_eq!(fs::read(&mnemonic_path).unwrap(), [0xff]);

        fs::remove_dir_all(&test_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_mnemonic_symlinks() {
        let test_dir = unique_test_dir("cleanup-mnemonic-symlinks");
        let config_dir = test_dir.join("app");
        let outside_dir = test_dir.join("outside");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();
        let mnemonic = "test test test test test test test test test test test junk";
        fs::write(outside_dir.join("mnemonic"), mnemonic).unwrap();
        std::os::unix::fs::symlink(outside_dir.join("mnemonic"), config_dir.join("mnemonic"))
            .unwrap();
        std::os::unix::fs::symlink(&outside_dir, config_dir.join("mnemonic-backups")).unwrap();

        assert_eq!(
            remove_matching_mnemonic_files(std::slice::from_ref(&config_dir), mnemonic).unwrap(),
            0
        );
        assert_eq!(
            fs::read_to_string(outside_dir.join("mnemonic")).unwrap(),
            mnemonic
        );
        assert!(
            fs::symlink_metadata(config_dir.join("mnemonic"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_dir_all(&test_dir).unwrap();
    }

    fn unique_test_dir(name: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();

        std::env::temp_dir().join(format!(
            "argon-security-{name}-{}-{nanos}",
            std::process::id()
        ))
    }
}
