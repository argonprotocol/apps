use std::env;

fn main() {
    println!("cargo:rerun-if-changed=migrations/");
    println!("cargo:rerun-if-changed=../resources/");
    println!("cargo:rerun-if-changed=../local-machine/");
    println!("cargo:rerun-if-env-changed=NODE_ENV");

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
    println!("Loading environment variables for mode: {}", mode);

    // 1. Load .env (loaded in all cases)
    dotenvy::dotenv().ok();
    // 2. Load .env.local (loaded in all cases, ignored by git)
    dotenvy::from_filename_override(".env.local").ok();

    // 3. Load .env.[mode] (only loaded in specified mode)
    dotenvy::from_filename_override(format!(".env.{}", mode)).ok();

    // 4. Load .env.[mode].local (only loaded in specified mode, ignored by git)
    dotenvy::from_filename_override(format!(".env.{}.local", mode)).ok();
    for (key, value) in env::vars() {
        if key.starts_with("RUST_LOG")
            || key == "CI"
            || key == "ARGON_APP_ENABLE_AUTOUPDATE"
            || key == "NODE_ENV"
        {
            println!("cargo:rustc-env={}={}", key, value);
            println!("set-env:  {}={}", key, value);
        }
    }

    tauri_build::build()
}
