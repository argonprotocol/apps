#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { config as loadDotEnv } from 'dotenv';
import { NetworkConfig, type INetworkConfig } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { ensureDevGatewayCerts } from '../scripts/devGatewayCerts.ts';
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
    await ensureDevGatewayCerts({ app, appInstance: argonAppInstance, network });

    const composePorts = await resolveDevDockerComposePorts();
    if (composePorts) {
      Object.assign(tauriEnv, getDevDockerServerEnvVars(composePorts));
    } else {
      console.warn('[tauri-dev] Server env override unavailable, falling back to static server config');
    }

    const inheritedOverride = readNonEmpty(process.env.ARGON_NETWORK_CONFIG_OVERRIDE);
    if (inheritedOverride) {
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = inheritedOverride;
      console.log('[tauri-dev] Using preconfigured network override from parent environment');
    } else {
      const override = composePorts ? await resolveDevDockerNetworkConfigOverride(composePorts) : null;
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
    tauriArgs.push('--features', 'e2e-screenshots,e2e-insecure-gateway-certs');
    console.log('[tauri-dev] Enabling e2e features (ARGON_DRIVER_WS detected)');
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

interface DevDockerComposePorts {
  archivePort: string;
  archiveP2pPort: string;
  bitcoinP2pPort: string;
  esploraPort: string;
  indexerPort?: string;
  notaryAliasContainerId: string;
  notaryArchiveHost?: string;
}

async function resolveDevDockerComposePorts(): Promise<DevDockerComposePorts | null> {
  const composeDir = path.resolve(__dirname, '..', 'e2e', 'argon');
  const dotenvPath = path.join(composeDir, '.env');
  const dotenvEnv = loadDotEnv({ path: dotenvPath }).parsed ?? {};
  const joinComposeNetwork =
    readNonEmpty(process.env.JOIN_COMPOSE_NETWORK) ?? readNonEmpty(dotenvEnv.COMPOSE_PROJECT_NAME);
  const composeEnv: NodeJS.ProcessEnv = { ...dotenvEnv, ...process.env };
  delete composeEnv.COMPOSE_PROJECT_NAME;
  if (joinComposeNetwork) {
    composeEnv.COMPOSE_PROJECT_NAME = joinComposeNetwork;
  }

  let archivePort: string;
  let archiveP2pPort: string;
  let bitcoinP2pPort: string;
  let esploraPort: string;
  let indexerPort: string | undefined;
  let notaryAliasContainerId: string;
  let notaryArchiveHost: string | undefined;

  try {
    archivePort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'archive-node', 9944);
    archiveP2pPort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'archive-node', 30334);
    bitcoinP2pPort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'bitcoin', 18444);
    esploraPort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'bitcoin-electrs', 3002);
    indexerPort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'indexer', 3262, {
      optional: true,
    });
    notaryAliasContainerId = readComposeContainerId(composeDir, composeEnv, joinComposeNetwork, 'notary');
    const notebookArchivePort = await readComposePortWithRetry(
      composeDir,
      composeEnv,
      joinComposeNetwork,
      'minio',
      9000,
    );
    const notaryPort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'notary', 9925);
    // then after resolving ports:
    notaryArchiveHost = await resolveNotaryArchiveHost(notaryPort, notebookArchivePort);
  } catch (error) {
    console.warn(`[tauri-dev] Failed to resolve compose ports: ${(error as Error).message}`);
    return null;
  }

  return {
    archivePort,
    archiveP2pPort,
    bitcoinP2pPort,
    esploraPort,
    indexerPort,
    notaryAliasContainerId,
    notaryArchiveHost,
  };
}

function getDevDockerServerEnvVars(ports: DevDockerComposePorts): NodeJS.ProcessEnv {
  return {
    ARGON_ARCHIVE_NODE: `ws://host.docker.internal:${ports.archivePort}`,
    ARGON_BOOTNODES: `--bootnodes=/dns/host.docker.internal/tcp/${ports.archiveP2pPort}/p2p/12D3KooWMdmKGEuFPVvwSd92jCQJgX9aFCp45E8vV2X284HQjwnn`,
    BITCOIN_ADDNODE: `host.docker.internal:${ports.bitcoinP2pPort}`,
    NOTEBOOK_ARCHIVE_HOSTS: ports.notaryArchiveHost,
    NOTARY_ALIAS_CONTAINER_ID: ports.notaryAliasContainerId,
  };
}

async function resolveNotaryArchiveHost(notaryPort: string, minioPort: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${notaryPort}`);
    const timeout = setTimeout(() => {
      ws.close();
      resolve(undefined);
    }, 5_000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_getArchiveBaseUrl', params: [] }));
    });
    ws.addEventListener('message', ({ data }) => {
      clearTimeout(timeout);
      ws.close();
      try {
        const url = new URL(JSON.parse(String(data)).result);
        resolve(`http://host.docker.internal:${minioPort}${url.pathname}`);
      } catch {
        resolve(undefined);
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function resolveDevDockerNetworkConfigOverride(
  ports: DevDockerComposePorts,
): Promise<RuntimeNetworkConfigOverride | null> {
  const archiveUrl = `ws://127.0.0.1:${ports.archivePort}`;
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
    esploraHost: `http://localhost:${ports.esploraPort}`,
  };
  if (ports.indexerPort) {
    override.indexerHost = `http://localhost:${ports.indexerPort}`;
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

function readComposeContainerId(
  composeDir: string,
  composeEnv: NodeJS.ProcessEnv,
  composeProjectName: string | undefined,
  service: string,
): string {
  const args = [
    'compose',
    ...(composeProjectName ? ['--project-name', composeProjectName] : []),
    ...COMPOSE_FILES.flatMap(file => ['-f', file]),
    'ps',
    '-q',
    service,
  ];

  const containerId = execFileSync('docker', args, {
    cwd: composeDir,
    encoding: 'utf-8',
    env: composeEnv,
  }).trim();
  if (!containerId) {
    throw new Error(`No docker compose container id found for ${service}`);
  }
  return containerId;
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
