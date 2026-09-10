use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=migrations/");
    println!("cargo:rerun-if-changed=../resources/");
    println!("cargo:rerun-if-changed=../local-machine/");
    println!("cargo:rerun-if-env-changed=NODE_ENV");
    println!("cargo:rerun-if-env-changed=APPLE_SIGNING_IDENTITY");
    println!("cargo:rustc-check-cfg=cfg(argon_signed_build)");

    // Check if NODE_ENV is set (highest priority)
    let mode = if let Ok(node_env) = std::env::var("NODE_ENV") {
        node_env
    } else {
        // If NODE_ENV is not set, determine the mode based on debug assertions
        #[cfg(debug_assertions)]
        {
            "development".to_string()
        }
        #[cfg(not(debug_assertions))]
        {
            "production".to_string()
        }
    };
    println!("Loading environment variables for mode: {mode}");

    // 1. Load .env (loaded in all cases)
    dotenvy::dotenv().ok();
    // 2. Load .env.local (loaded in all cases, ignored by git)
    dotenvy::from_filename_override(".env.local").ok();

    // 3. Load .env.[mode] (only loaded in specified mode)
    dotenvy::from_filename_override(format!(".env.{mode}")).ok();

    // 4. Load .env.[mode].local (only loaded in specified mode, ignored by git)
    dotenvy::from_filename_override(format!(".env.{mode}.local")).ok();
    for (key, value) in env::vars() {
        if key.starts_with("RUST_LOG")
            || key == "CI"
            || key == "ARGON_APP_ENABLE_AUTOUPDATE"
            || key == "NODE_ENV"
        {
            println!("cargo:rustc-env={key}={value}");
            println!("set-env:  {key}={value}");
        }
    }

    if env::var("APPLE_SIGNING_IDENTITY")
        .is_ok_and(|value| !value.trim().is_empty() && value.trim() != "-")
    {
        println!("cargo:rustc-cfg=argon_signed_build");
    }

    tauri_build::build();
    link_development_resources();
}

fn link_development_resources() {
    if env::var("PROFILE").as_deref() != Ok("debug") {
        return;
    }

    let build_profile_dir =
        PathBuf::from(env::var_os("OUT_DIR").expect("Cargo did not provide OUT_DIR"))
            .ancestors()
            .nth(3)
            .expect("Cargo OUT_DIR did not contain a profile directory")
            .to_path_buf();
    let staged_resources = build_profile_dir.join("_up_").join("resources");
    if !staged_resources.exists() {
        return;
    }

    let target_dir = env::var_os("CARGO_TARGET_DIR")
        .or_else(|| env::var_os("CARGO_BUILD_TARGET_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("target")
        });
    let runtime_resources = target_dir.join("debug").join("_up_").join("resources");
    if staged_resources == runtime_resources {
        return;
    }
    if std::fs::read_link(&runtime_resources).is_ok_and(|target| target == staged_resources) {
        return;
    }

    match std::fs::symlink_metadata(&runtime_resources) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            std::fs::remove_dir_all(&runtime_resources)
                .expect("Unable to replace the development resource directory");
        }
        Ok(_) => std::fs::remove_file(&runtime_resources)
            .expect("Unable to replace the development resource link"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("Unable to inspect the development resource path: {error}"),
    }
    std::fs::create_dir_all(runtime_resources.parent().unwrap())
        .expect("Unable to create the development resource directory");

    #[cfg(unix)]
    std::os::unix::fs::symlink(&staged_resources, &runtime_resources)
        .expect("Unable to link the development resources");

    #[cfg(windows)]
    if let Err(error) = std::os::windows::fs::symlink_dir(&staged_resources, &runtime_resources) {
        println!("cargo:warning=Unable to link the development resources: {error}");
    }
}
