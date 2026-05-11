#!/usr/bin/env node

import { execFileSync, spawn } from 'child_process';
import { config as loadDotEnv } from 'dotenv';
import { NetworkConfig, type INetworkConfigOverride } from '@argonprotocol/apps-core';
import {
  checkForExtrinsicSuccess,
  dispatchErrorToString,
  getClient,
  getEthereumBeaconSyncBootstrapTx,
  getEthereumBeaconSyncState,
  getNextEthereumBeaconSyncTxs,
  Keyring,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { TestEthereum } from '@argonprotocol/testing';
import { ensureDevGatewayCerts } from '../scripts/devGatewayCerts.ts';
import { DEV_ETHEREUM_ADMIN_ACCOUNT } from '../e2e/devEthereumAdmin.ts';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

// @ts-ignore
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPOSE_FILES = ['docker-compose.yml', 'indexer.docker-compose.yml'];
const DEV_ETHEREUM_BEACON_PRESET = readDevEthereumBeaconPreset();
const DEV_ETHEREUM_SECONDS_PER_SLOT = readPositiveIntEnv('ARGON_DEV_ETHEREUM_SECONDS_PER_SLOT') ?? 1;
const DEV_ETHEREUM_FINALITY_SLOTS = DEV_ETHEREUM_BEACON_PRESET === 'minimal' ? 16 : 64;
const DEFAULT_ETHEREUM_FINALITY_MILLIS =
  DEV_ETHEREUM_SECONDS_PER_SLOT * DEV_ETHEREUM_FINALITY_SLOTS * 1_000;
const DEV_ETHEREUM_RELAYER_POLL_MS = Math.max(1_000, Math.floor(DEFAULT_ETHEREUM_FINALITY_MILLIS / 32));

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
  let devEthereumRelayer: { shutdown(): Promise<void> } | undefined;
  if (network === 'dev-docker') {
    await ensureDevGatewayCerts({ app, appInstance: argonAppInstance, network });

    const composePorts = await resolveDevDockerComposePorts();
    const devEthereum = shouldStartDevEthereum() ? await startDevEthereum() : undefined;
    if (composePorts) {
      Object.assign(tauriEnv, getDevDockerServerEnvVars(composePorts));
      if (devEthereum) {
        console.log(`[tauri-dev] Ethereum execution RPC (app): ${devEthereum.executionRpcUrl}`);
        console.log(`[tauri-dev] Ethereum beacon API (app): ${devEthereum.beaconApiUrl}`);
        console.log(`[tauri-dev] Add this beacon URL in server config: ${devEthereum.serverBeaconApiUrl}`);
        const archiveUrl = `ws://127.0.0.1:${composePorts.archivePort}`;
        await ensureDevEthereumBeaconBootstrap(archiveUrl, devEthereum.beaconApiUrl);
        await ensureDevEthereumChainConfig(archiveUrl, devEthereum);
        devEthereumRelayer = await startDevEthereumRelayer(archiveUrl, devEthereum.beaconApiUrl);
        Object.assign(tauriEnv, {
          ETHEREUM_BEACON_API_URL: devEthereum.serverBeaconApiUrl,
          ETHEREUM_EXECUTION_RPC_URL: devEthereum.serverExecutionRpcUrl,
          ETHEREUM_FINALITY_MILLIS: String(DEFAULT_ETHEREUM_FINALITY_MILLIS),
        });
      }
    } else {
      console.warn('[tauri-dev] Server env override unavailable, falling back to static server config');
    }

    const inheritedOverride = readNonEmpty(process.env.ARGON_NETWORK_CONFIG_OVERRIDE);
    const runtimeOverride = composePorts ? await resolveDevDockerNetworkConfigOverride(composePorts, devEthereum) : null;
    const resolvedOverride = inheritedOverride
      ? mergeNetworkConfigOverrides(JSON.parse(inheritedOverride), runtimeOverride)
      : runtimeOverride;

    if (resolvedOverride) {
      tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE = JSON.stringify(resolvedOverride);
      console.log(
        `[tauri-dev] Runtime override archive=${resolvedOverride.archiveUrl} esplora=${resolvedOverride.esploraHost}${resolvedOverride.indexerHost ? ` indexer=${resolvedOverride.indexerHost}` : ''}${resolvedOverride.ethereumNetwork?.executionRpcUrl ? ` ethereumExecution=${resolvedOverride.ethereumNetwork.executionRpcUrl}` : ''}`,
      );
    } else {
      delete tauriEnv.ARGON_NETWORK_CONFIG_OVERRIDE;
      console.warn('[tauri-dev] Runtime override unavailable, falling back to static network config');
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
    const shutdownPromise = devEthereumRelayer?.shutdown() ?? Promise.resolve();
    void shutdownPromise.finally(() => {
      process.exit(code ?? 0);
    });
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
type RuntimeNetworkConfigOverride = INetworkConfigOverride;

interface IStartDevEthereumResult {
  enclaveName: string;
  executionRpcUrl: string;
  beaconApiUrl: string;
  chainId: string;
  gatewayAddress: string;
  argonTokenAddress: string;
  argonotTokenAddress: string;
  serverExecutionRpcUrl: string;
  serverBeaconApiUrl: string;
}

type DevEthereumBeaconPreset = 'mainnet' | 'minimal';

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

async function startDevEthereum(): Promise<IStartDevEthereumResult> {
  if (!TestEthereum.isInstalled()) {
    throw new Error(
      'Kurtosis is required to launch the local Ethereum devnet. Install Kurtosis first, or rerun with ARGON_DEV_ETHEREUM=0 to disable Ethereum.',
    );
  }

  const ethereum = new TestEthereum();
  const endpoints = await ethereum.launch({
    consensusClient: 'lighthouse',
    preset: DEV_ETHEREUM_BEACON_PRESET,
    secondsPerSlot: DEV_ETHEREUM_SECONDS_PER_SLOT,
    prefundedAccounts: {
      [DEV_ETHEREUM_ADMIN_ACCOUNT.address]: {
        balance: DEV_ETHEREUM_ADMIN_ACCOUNT.balance,
      },
    },
  });
  const fixture = await ethereum.deployMintingGatewayFixture({
    deployerPrivateKey: DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey,
  });

  return {
    enclaveName: ethereum.enclaveName,
    ...endpoints,
    ...fixture,
    serverExecutionRpcUrl: rewriteUrlHost(endpoints.executionRpcUrl, 'host.docker.internal'),
    serverBeaconApiUrl: rewriteUrlHost(endpoints.beaconApiUrl, 'host.docker.internal'),
  };
}

async function ensureDevEthereumBeaconBootstrap(archiveUrl: string, beaconApiUrl: string): Promise<void> {
  const client = await getClient(archiveUrl);

  try {
    const state = await getEthereumBeaconSyncState(client);
    if (state.isBootstrapped) {
      console.log('[tauri-dev] Ethereum verifier already bootstrapped');
      return;
    }

    const startedAt = Date.now();
    let hasLoggedWaiting = false;
    let tx;

    while (true) {
      try {
        tx = await getEthereumBeaconSyncBootstrapTx(client, beaconApiUrl);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isBootstrap404 = message.includes('/eth/v1/beacon/light_client/bootstrap/') && message.includes('404');

        if (!isBootstrap404) {
          throw error;
        }
        if (Date.now() - startedAt >= 60_000) {
          throw new Error(
            `Ethereum beacon light-client bootstrap endpoint did not become ready within 60s. Last error: ${message}`,
          );
        }
        if (!hasLoggedWaiting) {
          hasLoggedWaiting = true;
          console.log('[tauri-dev] Waiting for Ethereum light-client bootstrap endpoint...');
        }
        await sleep(1_000);
      }
    }

    const sudoKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
    const result = await new TxSubmitter(client, client.tx.sudo.sudo(tx), sudoKeypair).submit();
    await result.waitForInFirstBlock;

    const sudoResultEvent = result.events.find(event => client.events.sudo.Sudid.is(event));
    if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
      throw new Error('Bootstrap transaction did not emit sudo.Sudid.');
    }
    if (sudoResultEvent.data.sudoResult.isErr) {
      throw new Error(
        `Bootstrap failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr as any)}`,
      );
    }

    console.log(`[tauri-dev] Bootstrapped ethereum verifier from ${beaconApiUrl}`);
  } finally {
    await client.disconnect();
  }
}

async function startDevEthereumRelayer(
  archiveUrl: string,
  beaconApiUrl: string,
): Promise<{ shutdown(): Promise<void> }> {
  const client = await getClient(archiveUrl);
  const syncKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
  let shouldStop = false;
  let stopSleep: (() => void) | undefined;
  let hasLoggedWaitingForFinalityUpdate = false;

  const loopPromise = (async () => {
    while (!shouldStop) {
      try {
        const txs = await getNextEthereumBeaconSyncTxs(client, beaconApiUrl);
        hasLoggedWaitingForFinalityUpdate = false;
        for (const tx of txs) {
          if (shouldStop) break;

          const result = await new TxSubmitter(client, tx, syncKeypair).submit({
            useLatestNonce: true,
          });
          await result.waitForInFirstBlock;
          await checkForExtrinsicSuccess(result.events, client);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isLightClientFinalityUpdateNotReady(message)) {
          if (!hasLoggedWaitingForFinalityUpdate) {
            hasLoggedWaitingForFinalityUpdate = true;
            console.log('[tauri-dev] Waiting for Ethereum light-client finality updates...');
          }
        } else {
          console.error('[tauri-dev] Error syncing Ethereum beacon state', error);
        }
      }

      if (!shouldStop) {
        await waitForNextPoll(DEV_ETHEREUM_RELAYER_POLL_MS, stop => {
          stopSleep = stop;
        });
        stopSleep = undefined;
      }
    }
  })();

  console.log(`[tauri-dev] Started local Ethereum relayer with //Alice (poll=${DEV_ETHEREUM_RELAYER_POLL_MS}ms)`);

  return {
    async shutdown(): Promise<void> {
      shouldStop = true;
      stopSleep?.();
      await loopPromise;
      await client.disconnect();
    },
  };
}

async function ensureDevEthereumChainConfig(
  archiveUrl: string,
  devEthereum: Pick<IStartDevEthereumResult, 'gatewayAddress' | 'argonTokenAddress' | 'argonotTokenAddress'>,
): Promise<void> {
  const client = await getClient(archiveUrl);

  try {
    const currentConfig = await client.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (currentConfig.isSome && currentConfig.unwrap().isEthereum) {
      const ethereumConfig = currentConfig.unwrap().asEthereum;
      const isMatch =
        ethereumConfig.gateway.toHex().toLowerCase() === devEthereum.gatewayAddress.toLowerCase() &&
        ethereumConfig.argonToken.toHex().toLowerCase() === devEthereum.argonTokenAddress.toLowerCase() &&
        ethereumConfig.argonotToken.toHex().toLowerCase() === devEthereum.argonotTokenAddress.toLowerCase();

      if (isMatch) {
        console.log('[tauri-dev] Ethereum chain config already matches local gateway fixture');
        return;
      }
    }

    const sudoKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
    const result = await new TxSubmitter(
      client,
      client.tx.sudo.sudo(
        client.tx.crosschainTransfer.setChainConfig({
          Ethereum: {
            gateway: devEthereum.gatewayAddress,
            argonToken: devEthereum.argonTokenAddress,
            argonotToken: devEthereum.argonotTokenAddress,
            previousGateway: null,
            previousReleaseExpiration: null,
          },
        }),
      ),
      sudoKeypair,
    ).submit();
    await result.waitForInFirstBlock;

    const sudoResultEvent = result.events.find(event => client.events.sudo.Sudid.is(event));
    if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
      throw new Error('Ethereum chain-config transaction did not emit sudo.Sudid.');
    }
    if (sudoResultEvent.data.sudoResult.isErr) {
      throw new Error(
        `Ethereum chain-config setup failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr as any)}`,
      );
    }

    console.log('[tauri-dev] Configured local Ethereum gateway on Argon');
  } finally {
    await client.disconnect();
  }
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
  devEthereum?: IStartDevEthereumResult,
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
    ethereumNetwork: {
      executionRpcUrl: devEthereum?.executionRpcUrl ?? '',
    },
    baseNetwork: {
      rpcUrl: '',
    },
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

function rewriteUrlHost(url: string, host: string): string {
  const parsed = new URL(url);
  if (['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname)) {
    parsed.hostname = host;
  }
  return parsed.toString();
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

function shouldStartDevEthereum(): boolean {
  const value = readNonEmpty(process.env.ARGON_DEV_ETHEREUM)?.toLowerCase();
  if (!value) {
    return true;
  }

  return !['0', 'false', 'no', 'off'].includes(value);
}

function readDevEthereumBeaconPreset(): DevEthereumBeaconPreset {
  const value = readNonEmpty(process.env.ARGON_DEV_ETHEREUM_PRESET)?.toLowerCase();
  if (!value) {
    return 'minimal';
  }
  if (value === 'mainnet' || value === 'minimal') {
    return value;
  }

  throw new Error(`Unsupported ARGON_DEV_ETHEREUM_PRESET value: ${value}`);
}

function readPositiveIntEnv(name: string): number | undefined {
  const value = readNonEmpty(process.env[name]);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForNextPoll(ms: number, onStopReady: (stop: () => void) => void): Promise<void> {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    onStopReady(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function isLightClientFinalityUpdateNotReady(message: string): boolean {
  return message.includes('/eth/v1/beacon/light_client/finality_update') && message.includes('404');
}
