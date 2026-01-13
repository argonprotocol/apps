#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Recreate __filename / __dirname in ESM
// @ts-ignore
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const network = (process.env.ARGON_NETWORK_NAME || "testnet");
const argonAppInstance = process.env.ARGON_APP_INSTANCE || "";
const app = process.env.ARGON_APP || "operations";
console.log(`[tauri-dev] Starting Tauri dev for app="${app}" on network="${network}" with instance="${argonAppInstance}"`);

let tauriPort: string | undefined;

if (argonAppInstance.includes(":")) {
  const parts = argonAppInstance.split(":");
  tauriPort = parts[parts.length - 1];
}

// Default port if nothing parsed
if (!tauriPort) {
  if (app.startsWith("i")) {
    tauriPort = '1430';
  } else {
    tauriPort = '1420';
  }
}

const configFileName = `tauri.${app}.local.${network.replace('dev-docker', 'docknet')}.conf.json`;
const configFilePath = path.resolve(__dirname, configFileName);

// Load base config from file (if present)
let baseConfig: any = {};
try {
  const raw = fs.readFileSync(configFilePath, "utf8");
  baseConfig = JSON.parse(raw);
  console.log(`[tauri-dev] Using config file: ${configFileName}`);
} catch (err: any) {
  console.warn(
    `[tauri-dev] Could not read ${configFileName} (${err.message}). ` +
    `Falling back to empty config override.`
  );
}

// Inject / override build.devUrl
const devUrl = `http://localhost:${tauriPort}`;

if (!baseConfig.build) baseConfig.build = {};
baseConfig.build.devUrl = devUrl;

// Stringify final config
const configJson = JSON.stringify(baseConfig);
console.log(baseConfig);

// Spawn `yarn tauri dev` with the merged config
const child = spawn(
  "yarn",
  ["tauri", "dev", "--config", configJson],
  {
    stdio: "inherit",
    shell: false, // <- important: no shell, no brace expansion
  }
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
