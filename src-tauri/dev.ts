#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { config as loadDotEnv } from 'dotenv';
import { type INetworkConfigOverride, NetworkConfig } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { ensureDevGatewayCerts } from '../scripts/devGatewayCerts.ts';
import {
  createDevEthereumSetup,
  type IDevEthereumSetup,
  type IStartDevEthereumResult,
  readDevEthereumConfigFromEnv,
  readDevEthereumRuntimeState,
  resolveDevEthereumRpcUrl,
  startDevEthereum,
} from '../e2e/devEthereum.ts';
import {
  startDevEthereumMintingAuthority,
  type IDevEthereumMintingAuthorityRuntime,
} from '../e2e/helpers/startDevEthereumMintingAuthority.ts';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

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
  console.log(
    `[tauri-dev] Starting Tauri dev for network="${network}" with instance="${argonAppInstance}"`,
  );

  const tauriPort = getTauriPort(argonAppInstance);
  const configFileName = `tauri.desktop.local.${network.replace('dev-docker', 'docknet')}.conf.json`;
  const configFilePath = path.resolve(__dirname, configFileName);
  const baseConfig = loadBaseConfig(configFileName, configFilePath);
  baseConfig.build ??= {};
  baseConfig.build.devUrl = `http://localhost:${tauriPort}`;
  const configJson = JSON.stringify(baseConfig);

  const tauriEnv: NodeJS.ProcessEnv = { ...process.env };
  const devEthereumConfig = readDevEthereumConfigFromEnv();
  let shouldStartDevEthereumMintingAuthority = false;
  let devEthereumRuntime: { shutdown(): Promise<void> } | undefined;
  let devEthereumMintingAuthorityRuntime: IDevEthereumMintingAuthorityRuntime | undefined;
  let devEthereumMintingAuthorityPromise: Promise<void> | undefined;
  let devEthereumSetup: IDevEthereumSetup | undefined;
  let devDockerArchiveUrl: string | undefined;
  let devEthereumExecutionRpcUrl: string | undefined;
  let isShuttingDown = false;
  if (network === 'dev-docker') {
    shouldStartDevEthereumMintingAuthority = ['1', 'true', 'yes', 'on'].includes(
      readNonEmpty(process.env.ARGON_DEV_ETHEREUM_MINTING_AUTHORITY)?.toLowerCase() ?? '',
    );
    shouldStartDevEthereumMintingAuthority = false;
    await ensureDevGatewayCerts({ appInstance: argonAppInstance, network });

    console.log('[tauri-dev] Resolving dev-docker compose ports');
    const composePorts = await resolveDevDockerComposePorts();
    const devEthereum = devEthereumConfig
      ? await (async () => {
          console.log(
            `[tauri-dev] Launching local dev Ethereum (preset=${devEthereumConfig.beaconPreset}, secondsPerSlot=${devEthereumConfig.secondsPerSlot})`,
          );
          return await startDevEthereum(devEthereumConfig);
        })()
      : undefined;
    if (composePorts) {
      devDockerArchiveUrl = `ws://127.0.0.1:${composePorts.archivePort}`;
      console.log(
        `[tauri-dev] Resolved compose ports archive=${composePorts.archivePort} archiveP2p=${composePorts.archiveP2pPort} bitcoinP2p=${composePorts.bitcoinP2pPort} esplora=${composePorts.esploraPort}${composePorts.indexerPort ? ` indexer=${composePorts.indexerPort}` : ''} notary=${composePorts.notaryAliasContainerId}`,
      );
      Object.assign(tauriEnv, getDevDockerServerEnvVars(composePorts));
      if (devEthereum && devEthereumConfig) {
        devEthereumSetup = createDevEthereumSetup(devDockerArchiveUrl, devEthereum, devEthereumConfig);
        Object.assign(tauriEnv, devEthereumSetup.env);
      }
    } else {
      console.warn('[tauri-dev] Server env override unavailable, falling back to static server config');
    }

    const inheritedOverride = readNonEmpty(process.env.ARGON_NETWORK_CONFIG_OVERRIDE);
    const inheritedRuntimeOverride: RuntimeNetworkConfigOverride | undefined = inheritedOverride
      ? JSON.parse(inheritedOverride)
      : undefined;
    const ethereumExecutionRpcUrl = await resolveRuntimeEthereumExecutionRpcUrl(devEthereum, inheritedRuntimeOverride);
    devEthereumExecutionRpcUrl = ethereumExecutionRpcUrl;
    const ethereumUsdcTokenAddress = await resolveRuntimeEthereumUsdcTokenAddress(
      ethereumExecutionRpcUrl,
      devEthereum,
      inheritedRuntimeOverride,
    );
    const runtimeOverride = composePorts
      ? await resolveDevDockerNetworkConfigOverride(composePorts, ethereumExecutionRpcUrl, ethereumUsdcTokenAddress)
      : null;
    const resolvedOverride = inheritedRuntimeOverride
      ? mergeNetworkConfigOverrides(inheritedRuntimeOverride, runtimeOverride)
      : runtimeOverride;

    if (resolvedOverride) {
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(resolvedOverride);
      console.log(
        `[tauri-dev] Runtime override archive=${resolvedOverride.archiveUrl} esplora=${resolvedOverride.esploraHost}${resolvedOverride.indexerHost ? ` indexer=${resolvedOverride.indexerHost}` : ''}${resolvedOverride.ethereumNetwork?.executionRpcUrl ? ` ethereumExecution=${resolvedOverride.ethereumNetwork.executionRpcUrl}` : ''}${resolvedOverride.ethereumNetwork?.usdcTokenAddress ? ` usdc=${resolvedOverride.ethereumNetwork.usdcTokenAddress}` : ''}`,
      );
    } else {
      delete tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
      console.warn('[tauri-dev] Runtime override unavailable, falling back to static network config');
    }
  }

  console.log(baseConfig);
  const configArg =
    process.platform === 'win32' ? `"${configJson.replace(/"/g, '\\"')}"` : configJson;
  const tauriArgs = ['tauri', 'dev', '--config', configArg];
  const isE2EAppRun = Boolean(readNonEmpty(tauriEnv.ARGON_DRIVER_WS));
  if (isE2EAppRun) {
    tauriArgs.push('--features', 'e2e-screenshots,e2e-insecure-gateway-certs');
    console.log('[tauri-dev] Enabling e2e features (ARGON_DRIVER_WS detected)');
  }

  let devEthereumSetupPromise: Promise<void> | undefined;
  if (devEthereumSetup) {
    devEthereumSetupPromise = devEthereumSetup
      .start()
      .then(runtime => {
        devEthereumRuntime = runtime;
        console.log('[tauri-dev][ethereum-ready] local Ethereum relayer is ready');
      })
      .catch(error => {
        console.error(`[tauri-dev] Failed to finish local Ethereum setup: ${(error as Error).message}`);
        throw error;
      });

    void devEthereumSetupPromise.catch(() => undefined);
  }

  const child = spawn('yarn', tauriArgs, {
    env: tauriEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('error', err => {
    console.error('[tauri-dev] Failed to start child process.', err);
    process.exit(1);
  });

  if (shouldStartDevEthereumMintingAuthority) {
    devEthereumMintingAuthorityPromise = (async () => {
      if (devEthereumSetupPromise) {
        await devEthereumSetupPromise;
      }
      if (isShuttingDown) {
        return;
      }

      console.log('[tauri-dev] Starting local Ethereum minting authority');
      devEthereumMintingAuthorityRuntime = await startDevEthereumMintingAuthority({
        archiveUrl: devDockerArchiveUrl!,
        executionRpcUrl: devEthereumExecutionRpcUrl,
        logPrefix: 'tauri-dev',
        virtualEnv: {
          appInstance: argonAppInstance,
          network,
          serverEnvVars: tauriEnv,
        },
      });
      console.log('[tauri-dev][ethereum-ready] local Ethereum minting authority is ready');

      if (isShuttingDown) {
        await devEthereumMintingAuthorityRuntime.shutdown().catch(() => undefined);
        devEthereumMintingAuthorityRuntime = undefined;
      }
    })().catch(error => {
      console.error(`[tauri-dev] Failed to start local Ethereum minting authority: ${(error as Error).message}`);
    });
  }

  child.on('exit', code => {
    isShuttingDown = true;
    const shutdownPromise = (async () => {
      await devEthereumMintingAuthorityPromise;
      await devEthereumMintingAuthorityRuntime?.shutdown().catch(() => undefined);
      await devEthereumRuntime?.shutdown().catch(() => undefined);
    })();
    void shutdownPromise.finally(() => {
      process.exit(code ?? 0);
    });
  });
}

function getTauriPort(argonAppInstance: string): string {
  if (argonAppInstance.includes(':')) {
    const parts = argonAppInstance.split(':');
    const port = parts[parts.length - 1];
    if (port) return port;
  }
  return '1420';
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
type RuntimeNetworkConfigOverride = INetworkConfigOverride;

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
    archivePort = (await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'archive-node', 9944))!;
    archiveP2pPort = (await readComposePortWithRetry(
      composeDir,
      composeEnv,
      joinComposeNetwork,
      'archive-node',
      30334,
    ))!;
    bitcoinP2pPort = (await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'bitcoin', 18444))!;
    esploraPort = (await readComposePortWithRetry(
      composeDir,
      composeEnv,
      joinComposeNetwork,
      'bitcoin-electrs',
      3002,
    ))!;
    indexerPort = await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'indexer', 3262, {
      optional: true,
    });
    notaryAliasContainerId = readComposeContainerId(composeDir, composeEnv, joinComposeNetwork, 'notary');
    const notebookArchivePort = (await readComposePortWithRetry(
      composeDir,
      composeEnv,
      joinComposeNetwork,
      'minio',
      9000,
    ))!;
    const notaryPort = (await readComposePortWithRetry(composeDir, composeEnv, joinComposeNetwork, 'notary', 9925))!;
    // then after resolving ports:
    console.log(
      `[tauri-dev] Resolving notary archive host via ws://127.0.0.1:${notaryPort} with MinIO port ${notebookArchivePort}`,
    );
    notaryArchiveHost = await resolveNotaryArchiveHost(notaryPort, notebookArchivePort);
    console.log(
      `[tauri-dev] Resolved notary archive host${notaryArchiveHost ? ` ${notaryArchiveHost}` : ' unavailable'}`,
    );
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
  ethereumExecutionRpcUrl?: string,
  usdcTokenAddress?: string,
  relayerUrl?: string,
): Promise<RuntimeNetworkConfigOverride | null> {
  const archiveUrl = `ws://127.0.0.1:${ports.archivePort}`;
  let runtimeConfig: RuntimeChainConfig;
  try {
    console.log(`[tauri-dev] Loading runtime chain config from ${archiveUrl}`);
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
    baseNetwork: {
      rpcUrl: '',
    },
  };
  if (ethereumExecutionRpcUrl) {
    override.ethereumNetwork = {
      executionRpcUrl: ethereumExecutionRpcUrl,
      ...(usdcTokenAddress ? { usdcTokenAddress } : {}),
    };
  }
  if (ports.indexerPort) {
    override.indexerHost = `http://localhost:${ports.indexerPort}`;
  }
  return override;
}

async function resolveRuntimeEthereumExecutionRpcUrl(
  devEthereum?: IStartDevEthereumResult,
  inheritedOverride?: RuntimeNetworkConfigOverride,
): Promise<string | undefined> {
  const inheritedExecutionRpcUrl = readNonEmpty(inheritedOverride?.ethereumNetwork?.executionRpcUrl);
  if (inheritedExecutionRpcUrl) {
    return inheritedExecutionRpcUrl;
  }

  const launchedExecutionRpcUrl = readNonEmpty(devEthereum?.executionRpcUrl);
  if (launchedExecutionRpcUrl) {
    return launchedExecutionRpcUrl;
  }

  try {
    return await resolveDevEthereumRpcUrl({ logPrefix: 'tauri-dev' });
  } catch (error) {
    console.warn(`[tauri-dev] Ethereum execution RPC unavailable: ${(error as Error).message}`);
    return undefined;
  }
}

async function resolveRuntimeEthereumUsdcTokenAddress(
  executionRpcUrl: string | undefined,
  devEthereum?: IStartDevEthereumResult,
  inheritedOverride?: RuntimeNetworkConfigOverride,
): Promise<string | undefined> {
  const inheritedUsdcTokenAddress = readNonEmpty(inheritedOverride?.ethereumNetwork?.usdcTokenAddress);
  if (inheritedUsdcTokenAddress) {
    return inheritedUsdcTokenAddress;
  }

  const launchedUsdcTokenAddress = readNonEmpty(devEthereum?.usdcTokenAddress);
  if (launchedUsdcTokenAddress) {
    return launchedUsdcTokenAddress;
  }

  try {
    const runtimeState = await readDevEthereumRuntimeState(executionRpcUrl);
    return readNonEmpty(runtimeState?.usdcTokenAddress);
  } catch (error) {
    console.warn(`[tauri-dev] Dev Ethereum USDC address unavailable: ${(error as Error).message}`);
    return undefined;
  }
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

function mergeNetworkConfigOverrides(
  inheritedOverride: RuntimeNetworkConfigOverride,
  dynamicOverride: RuntimeNetworkConfigOverride | null,
): RuntimeNetworkConfigOverride {
  if (!dynamicOverride) {
    return inheritedOverride;
  }

  return {
    ...inheritedOverride,
    ...dynamicOverride,
    ethereumNetwork: {
      ...inheritedOverride.ethereumNetwork,
      ...dynamicOverride.ethereumNetwork,
    },
    baseNetwork: {
      ...inheritedOverride.baseNetwork,
      ...dynamicOverride.baseNetwork,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
