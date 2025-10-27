use anyhow::Result;
use rand::RngCore;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

static ENV_DOCKER: &str = include_str!("../../server/.env.dev-docker");
static ENV_LOCAL: &str = include_str!("../../server/.env.localnet");
static ENV_MAINNET: &str = include_str!("../../server/.env.mainnet");
static ENV_TESTNET: &str = include_str!("../../server/.env.testnet");

pub struct Utils;

impl Utils {
    pub fn get_instance_name() -> String {
        if let Ok(instance) = std::env::var("ARGON_APP_INSTANCE") {
            if let Some(name) = instance.split(':').next() {
                return name.to_string();
            }
        }

        // Default fallback
        "default".to_string()
    }

    pub fn is_experimental() -> bool {
        // baked into runtime via build.rs
        option_env!("ARGON_EXPERIMENTAL").map_or(false, |v| v == "true")
    }

    pub fn get_server_env_vars() -> Result<HashMap<String, String>, String> {
        let env_text = match Self::get_network_name().as_str() {
            "dev-docker" => ENV_DOCKER,
            "localnet" => ENV_LOCAL,
            "mainnet" => ENV_MAINNET,
            "testnet" => ENV_TESTNET,
            _ => return Err("Unknown network".to_string()),
        };
        let env_vars = dotenvy::from_read_iter(Cursor::new(env_text));

        let mut result = HashMap::new();
        for (key, value) in env_vars.flatten() {
            result.insert(key, value);
        }
        Ok(result)
    }

    pub fn get_network_name() -> String {
        std::env::var("ARGON_NETWORK_NAME").unwrap_or(
            if Self::is_experimental() {
                "testnet"
            } else {
                #[cfg(debug_assertions)]
                {
                    "testnet"
                }
                #[cfg(not(debug_assertions))]
                {
                    "mainnet"
                }
            }
            .to_string(),
        )
    }

    pub fn get_relative_config_instance_dir() -> PathBuf {
        let instance_name = Self::get_instance_name();
        let network_name = Self::get_network_name();
        PathBuf::from(network_name).join(instance_name)
    }

    pub fn get_absolute_config_instance_dir(app: &AppHandle) -> PathBuf {
        app.path()
            .resolve(
                Self::get_relative_config_instance_dir(),
                tauri::path::BaseDirectory::AppConfig,
            )
            .expect("Failed to resolve config instance directory")
    }

    pub fn get_embedded_path(app: &AppHandle, path: impl AsRef<Path>) -> anyhow::Result<PathBuf> {
        let local_base_path = app.path().resolve(
            PathBuf::from("..").join(path),
            tauri::path::BaseDirectory::Resource,
        )?;
        Ok(local_base_path)
    }

    #[allow(unused)]
    pub fn get_key_from_keychain() -> Result<String> {
        let key_entry = keyring::Entry::new("argon-apps", "db_key")?;
        let key = match key_entry.get_password() {
            Ok(k) => k,
            Err(_) => {
                let mut key = [0u8; 32]; // 256-bit key
                rand::rng().fill_bytes(&mut key);
                let new_key = hex::encode(key);

                key_entry.set_password(&new_key)?;
                new_key
            }
        };
        Ok(key)
    }
}
