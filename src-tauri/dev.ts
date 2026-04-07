#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { config as loadDotEnv } from 'dotenv';
import { NetworkConfig, type INetworkConfig } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

// @ts-ignore
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPOSE_FILES = ['docker-compose.yml', 'indexer.docker-compose.yml'];

void main().catch(error => {
  console.error(`[tauri-dev] Failed to start: ${(error as Error).message}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const network = process.env.ARGON_NETWORK_NAME || 'testnet';
  const argonAppInstance = process.env.ARGON_APP_INSTANCE || '';
  const app = process.env.ARGON_APP || 'operations';
  console.log(
    `[tauri-dev] Starting Tauri dev for app="${app}" on network="${network}" with instance="${argonAppInstance}"`,
  );

  const tauriPort = getTauriPort(argonAppInstance, app);
  const configFileName = `tauri.${app}.local.${network.replace('dev-docker', 'docknet')}.conf.json`;
  const configFilePath = path.resolve(__dirname, configFileName);
  const baseConfig = loadBaseConfig(configFileName, configFilePath);
  baseConfig.build ??= {};
  baseConfig.build.devUrl = `http://localhost:${tauriPort}`;
  const configJson = JSON.stringify(baseConfig);

  const tauriEnv: NodeJS.ProcessEnv = { ...process.env };
  if (network === 'dev-docker') {
    const inheritedOverride = readNonEmpty(process.env.ARGON_NETWORK_CONFIG_OVERRIDE);
    if (inheritedOverride) {
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = inheritedOverride;
      console.log('[tauri-dev] Using preconfigured network override from parent environment');
    } else {
      const override = await resolveDevDockerNetworkConfigOverride();
      if (override) {
        tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(override);
        console.log(
          `[tauri-dev] Runtime override archive=${override.archiveUrl} esplora=${override.esploraHost}${override.indexerHost ? ` indexer=${override.indexerHost}` : ''}`,
        );
      } else {
        delete tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
        console.warn('[tauri-dev] Runtime override unavailable, falling back to static network config');
      }
    }
  }

  console.log(baseConfig);
  const tauriArgs = ['tauri', 'dev', '--config', configJson];
  if (readNonEmpty(tauriEnv.ARGON_DRIVER_WS)) {
    tauriArgs.push('--features', 'e2e-screenshots');
    console.log('[tauri-dev] Enabling e2e screenshot feature (ARGON_DRIVER_WS detected)');
  }

  const child = spawn('yarn', tauriArgs, {
    env: tauriEnv,
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', code => {
    process.exit(code ?? 0);
  });
}

function getTauriPort(argonAppInstance: string, app: string): string {
  if (argonAppInstance.includes(':')) {
    const parts = argonAppInstance.split(':');
    const port = parts[parts.length - 1];
    if (port) return port;
  }
  return app.startsWith('treasury') ? '1430' : '1420';
}

function loadBaseConfig(configFileName: string, configFilePath: string): any {
  try {
    const raw = fs.readFileSync(configFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    console.log(`[tauri-dev] Using config file: ${configFileName}`);
    return parsed;
  } catch (err: any) {
    console.warn(
      `[tauri-dev] Could not read ${configFileName} (${err.message}). Falling back to empty config override.`,
    );
    return {};
  }
}

type RuntimeChainConfig = Awaited<ReturnType<typeof NetworkConfig.loadConfigs>>;
type RuntimeNetworkConfigOverride = Partial<INetworkConfig>;

async function resolveDevDockerNetworkConfigOverride(): Promise<RuntimeNetworkConfigOverride | null> {
  const composeDir = path.resolve(__dirname, '..', 'e2e', 'argon');
  const dotenvPath = path.join(composeDir, '.env');
  const dotenvEnv = loadDotEnv({ path: dotenvPath }).parsed ?? {};
  const composeEnv: NodeJS.ProcessEnv = { ...dotenvEnv, ...process.env };
  const composeProjectName =
    readNonEmpty(process.env.COMPOSE_PROJECT_NAME) ?? readNonEmpty(dotenvEnv.COMPOSE_PROJECT_NAME);

  let archivePort: string;
  let esploraPort: string;
  let indexerPort: string | undefined;

  try {
    archivePort = await readComposePortWithRetry(composeDir, composeEnv, composeProjectName, 'archive-node', 9944);
    esploraPort = await readComposePortWithRetry(composeDir, composeEnv, composeProjectName, 'bitcoin-electrs', 3002);
    indexerPort = await readComposePortWithRetry(composeDir, composeEnv, composeProjectName, 'indexer', 3262, {
      optional: true,
    });
  } catch (error) {
    console.warn(`[tauri-dev] Failed to resolve compose ports: ${(error as Error).message}`);
    return null;
  }

  const archiveUrl = `ws://127.0.0.1:${archivePort}`;
  let runtimeConfig: RuntimeChainConfig;
  try {
    runtimeConfig = await loadRuntimeConfig(archiveUrl);
  } catch (error) {
    console.warn(`[tauri-dev] Failed to load runtime chain config: ${(error as Error).message}`);
    return null;
  }

  const override: RuntimeNetworkConfigOverride = {
    ...runtimeConfig,
    archiveUrl,
    bitcoinBlockMillis: runtimeConfig.tickMillis * 10,
    esploraHost: `http://localhost:${esploraPort}`,
  };
  if (indexerPort) {
    override.indexerHost = `http://localhost:${indexerPort}`;
  }
  return override;
}

async function readComposePortWithRetry(
  composeDir: string,
  composeEnv: NodeJS.ProcessEnv,
  composeProjectName: string | undefined,
  service: string,
  port: number,
  options: { optional?: boolean; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return readComposePort(composeDir, composeEnv, composeProjectName, service, port);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }

  if (options.optional) {
    console.warn(`[tauri-dev] Skipping ${service}:${port} after ${timeoutMs}ms: ${String(lastError)}`);
    return undefined;
  }
  throw new Error(
    `Unable to resolve docker compose port for ${service}:${port} after ${timeoutMs}ms: ${String(lastError)}`,
  );
}

function readComposePort(
  composeDir: string,
  composeEnv: NodeJS.ProcessEnv,
  composeProjectName: string | undefined,
  service: string,
  port: number,
): string {
  const args = [
    'compose',
    ...(composeProjectName ? ['--project-name', composeProjectName] : []),
    ...COMPOSE_FILES.flatMap(file => ['-f', file]),
    'port',
    service,
    String(port),
  ];

  const output = execFileSync('docker', args, {
    cwd: composeDir,
    encoding: 'utf-8',
    env: composeEnv,
  }).trim();

  const endpoint = output
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .at(-1);
  if (!endpoint) {
    throw new Error(`No docker compose port output for ${service}:${port}`);
  }
  const matchedPort = endpoint.match(/:(\d+)\s*$/)?.[1];
  if (!matchedPort) {
    throw new Error(`Could not parse mapped port from "${endpoint}" for ${service}:${port}`);
  }
  return matchedPort;
}

async function loadRuntimeConfig(archiveUrl: string): Promise<RuntimeChainConfig> {
  const client = await getClient(archiveUrl);
  try {
    while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
      await sleep(100);
    }
    return await NetworkConfig.loadConfigs(client);
  } finally {
    await client.disconnect();
  }
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
