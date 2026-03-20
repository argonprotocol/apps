use crate::utils::Utils;
use anyhow::{Context, Result as AnyhowResult, anyhow};
use include_dir::{Dir, include_dir};
use sqlx::{
    error::BoxDynError,
    migrate::{Migration as SqlxMigration, MigrationSource, Migrator},
};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use tauri::AppHandle;
use tauri_plugin_sql::{Migration, MigrationKind};

static MIGRATIONS_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/migrations");
const APP_VERSION_FILENAME: &str = "app-version.txt";
const DATABASE_BACKUPS_DIR: &str = "database-backups";
const DATABASE_FILENAME: &str = "database.sqlite";
const INITIAL_TRACKED_APP_VERSION: &str = "1.3.2";

#[derive(Debug)]
struct MigrationList(Vec<Migration>);

impl MigrationSource<'static> for MigrationList {
    fn resolve(
        self,
    ) -> Pin<
        Box<
            dyn Future<Output = std::result::Result<Vec<SqlxMigration>, BoxDynError>>
                + Send
                + 'static,
        >,
    > {
        Box::pin(async move {
            let mut migrations = Vec::new();
            for migration in self.0 {
                if matches!(migration.kind, MigrationKind::Up) {
                    migrations.push(SqlxMigration::new(
                        migration.version,
                        migration.description.into(),
                        migration.kind.into(),
                        migration.sql.into(),
                        false,
                    ));
                }
            }
            Ok(migrations)
        })
    }
}

pub fn get_migrations() -> Vec<Migration> {
    let mut out: Vec<Migration> = MIGRATIONS_DIR
        .dirs()
        .filter_map(|dir| {
            let dir_name = dir.path().file_stem()?.to_str()?;
            let up_path = dir.path().join("up.sql");
            let file = dir.get_file(up_path)?;
            println!("Processing migration dir: {dir_name}",);
            let mut parts = dir_name.splitn(2, '-');
            let version = parts.next()?.parse::<i64>().ok()?;
            let description = parts.next()?;
            let sql = file.contents_utf8()?;

            Some(Migration {
                version,
                description,
                sql,
                kind: MigrationKind::Up,
            })
        })
        .collect();
    out.sort_by_key(|m| m.version);
    out
}

pub fn backup_current_instance_database(app: &AppHandle) -> AnyhowResult<bool> {
    let config_dir = Utils::get_absolute_config_instance_dir(app);
    let current_version = app.package_info().version.to_string();
    backup_database_if_needed(&config_dir, &current_version)
}

pub async fn run_db_migrations(absolute_db_path: PathBuf) -> Result<(), String> {
    let opts = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&absolute_db_path)
        .create_if_missing(true);

    let pool = sqlx::SqlitePool::connect_with(opts)
        .await
        .map_err(|e| format!("Failed to connect to database: {e}"))?;

    let migrations = MigrationList(get_migrations());
    let migrator = Migrator::new(migrations)
        .await
        .map_err(|e| format!("Failed to create migrator: {e}"))?;
    migrator
        .run(&pool)
        .await
        .map_err(|e| format!("Failed to run migrations: {e}"))?;

    pool.close().await;
    Ok(())
}

fn backup_database_if_needed(config_dir: &Path, current_version: &str) -> AnyhowResult<bool> {
    fs::create_dir_all(config_dir).with_context(|| {
        format!(
            "Failed to create config directory at {}",
            config_dir.display()
        )
    })?;

    let version_path = config_dir.join(APP_VERSION_FILENAME);
    let previous_version = read_previous_version(&version_path)?;
    let database_path = config_dir.join(DATABASE_FILENAME);

    if !database_path.exists() || previous_version.as_deref() == Some(current_version) {
        write_current_version(&version_path, current_version)?;
        return Ok(false);
    }

    let backup_version = previous_version
        .as_deref()
        .unwrap_or(INITIAL_TRACKED_APP_VERSION);
    let backup_dir = create_backup_dir(config_dir, backup_version)?;

    for source_path in [
        database_path.clone(),
        config_dir.join("database.sqlite-wal"),
        config_dir.join("database.sqlite-shm"),
        config_dir.join("database.sqlite-journal"),
    ] {
        if !source_path.exists() {
            continue;
        }

        let file_name = source_path
            .file_name()
            .ok_or_else(|| anyhow!("Missing file name for {}", source_path.display()))?;
        let destination_path = backup_dir.join(file_name);

        fs::copy(&source_path, &destination_path).with_context(|| {
            format!(
                "Failed to copy {} to {}",
                source_path.display(),
                destination_path.display()
            )
        })?;
    }

    write_current_version(&version_path, current_version)?;

    log::info!(
        "Backed up instance database before app upgrade from {} to {}. Backup = {}",
        backup_version,
        current_version,
        backup_dir.display()
    );
    Ok(true)
}

fn read_previous_version(version_path: &Path) -> AnyhowResult<Option<String>> {
    if !version_path.exists() {
        return Ok(None);
    }

    let version = fs::read_to_string(version_path)
        .with_context(|| format!("Failed to read {}", version_path.display()))?;
    let version = version.trim();

    if version.is_empty() {
        return Ok(None);
    }

    Ok(Some(version.to_string()))
}

fn write_current_version(version_path: &Path, current_version: &str) -> AnyhowResult<()> {
    fs::write(version_path, current_version)
        .with_context(|| format!("Failed to write {}", version_path.display()))
}

fn create_backup_dir(config_dir: &Path, previous_version: &str) -> AnyhowResult<PathBuf> {
    let backups_dir = config_dir.join(DATABASE_BACKUPS_DIR);
    fs::create_dir_all(&backups_dir)
        .with_context(|| format!("Failed to create {}", backups_dir.display()))?;

    let backup_dir_name = previous_version.replace(['/', '\\'], "_");
    if backup_dir_name.is_empty() || matches!(backup_dir_name.as_str(), "." | "..") {
        return Err(anyhow!("Invalid previous version: {previous_version}"));
    }

    let backup_dir = backups_dir.join(backup_dir_name);
    fs::create_dir_all(&backup_dir)
        .with_context(|| format!("Failed to create {}", backup_dir.display()))?;
    Ok(backup_dir)
}

#[cfg(test)]
mod tests {
    use super::{INITIAL_TRACKED_APP_VERSION, backup_database_if_needed};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn backs_up_existing_database_when_version_changes() {
        let temp_dir = create_temp_dir("version-change");
        let database_path = temp_dir.join("database.sqlite");
        let version_path = temp_dir.join("app-version.txt");

        fs::write(&database_path, b"db-contents").unwrap();
        fs::write(temp_dir.join("database.sqlite-wal"), b"wal-contents").unwrap();
        fs::write(&version_path, "1.0.0").unwrap();

        let backed_up = backup_database_if_needed(&temp_dir, "1.1.0").unwrap();

        assert!(backed_up);

        let backup_entries = read_backup_entries(&temp_dir);
        assert_eq!(backup_entries.len(), 1);
        let backup_dir = &backup_entries[0];
        assert_eq!(backup_dir.file_name().unwrap().to_string_lossy(), "1.0.0");

        assert_eq!(
            fs::read(backup_dir.join("database.sqlite")).unwrap(),
            b"db-contents"
        );
        assert_eq!(
            fs::read(backup_dir.join("database.sqlite-wal")).unwrap(),
            b"wal-contents"
        );
        assert!(!backup_dir.join("app-version.txt").exists());

        fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    fn backs_up_existing_database_without_recorded_version() {
        let temp_dir = create_temp_dir("missing-version");
        let database_path = temp_dir.join("database.sqlite");

        fs::write(&database_path, b"db-contents").unwrap();

        let backed_up = backup_database_if_needed(&temp_dir, "1.3.3").unwrap();

        assert!(backed_up);
        let backup_entries = read_backup_entries(&temp_dir);
        assert_eq!(backup_entries.len(), 1);
        assert_eq!(
            backup_entries[0].file_name().unwrap().to_string_lossy(),
            INITIAL_TRACKED_APP_VERSION
        );

        fs::remove_dir_all(temp_dir).unwrap();
    }

    #[test]
    fn skips_backup_when_version_is_unchanged() {
        let temp_dir = create_temp_dir("same-version");
        let database_path = temp_dir.join("database.sqlite");
        let version_path = temp_dir.join("app-version.txt");

        fs::write(&database_path, b"db-contents").unwrap();
        fs::write(&version_path, "1.1.0").unwrap();

        let backed_up = backup_database_if_needed(&temp_dir, "1.1.0").unwrap();

        assert!(!backed_up);
        assert!(!temp_dir.join("database-backups").exists());

        fs::remove_dir_all(temp_dir).unwrap();
    }

    fn read_backup_entries(temp_dir: &Path) -> Vec<PathBuf> {
        let mut entries = fs::read_dir(temp_dir.join("database-backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    }

    fn create_temp_dir(test_name: &str) -> PathBuf {
        let unique_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir()
            .join(format!("argon-db-backup-{test_name}-{}-{unique_id}", std::process::id()));
        fs::create_dir_all(&temp_dir).unwrap();
        temp_dir
    }
}
