#!/usr/bin/env node

import { spawn } from 'child_process';
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
  updateDevEthereumRuntimeState,
} from '../e2e/devEthereum.ts';
import {
  startDevEthereumMintingAuthority,
  type IDevEthereumMintingAuthorityRuntime,
} from '../e2e/helpers/startDevEthereumMintingAuthority.ts';
import {
  getDevDockerComposeContext,
  type IDevUpstreamServerRuntime,
  readComposeContainerId,
  readComposePortWithRetry,
  startDevUpstreamServer,
  waitForDevUpstreamEthereumRelayReady,
} from '../e2e/scripts/devUpstreamServer.ts';
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

void main().catch(error => {
  console.error(`[tauri-dev] Failed to start: ${(error as Error).message}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const network = process.env.ARGON_NETWORK_NAME || 'testnet';
  const argonAppInstance = process.env.ARGON_APP_INSTANCE || '';
  console.log(`[tauri-dev] Starting Tauri dev for network="${network}" with instance="${argonAppInstance}"`);

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
  let devEthereumMintingAuthorityRuntime: IDevEthereumMintingAuthorityRuntime | undefined;
  let devEthereumMintingAuthorityPromise: Promise<void> | undefined;
  let devEthereumSetup: IDevEthereumSetup | undefined;
  let devDockerArchiveUrl: string | undefined;
  let devEthereumExecutionRpcUrl: string | undefined;
  let startedDevEthereum: IStartDevEthereumResult | undefined;
  let isShuttingDown = false;
  if (network === 'dev-docker') {
    const mintingAuthoritySetting = readNonEmpty(
      process.env.ARGON_DEV_ETHEREUM_MINTING_AUTHORITY,
    )?.toLowerCase();
    shouldStartDevEthereumMintingAuthority =
      !!devEthereumConfig && !['0', 'false', 'no', 'off'].includes(mintingAuthoritySetting ?? '');
    await ensureDevGatewayCerts({ appInstance: argonAppInstance, network });

    console.log('[tauri-dev] Resolving dev-docker compose ports');
    const composePorts = await resolveDevDockerComposePorts();
    startedDevEthereum = devEthereumConfig
      ? await (async () => {
          console.log(
            `[tauri-dev] Launching local dev Ethereum (preset=${devEthereumConfig.beaconPreset}, secondsPerSlot=${devEthereumConfig.secondsPerSlot})`,
          );
          return await startDevEthereum(devEthereumConfig);
        })()
      : undefined;
    if (composePorts) {
      devDockerArchiveUrl = `ws://127.0.0.1:${composePorts.archiveRpcPort}`;
      console.log(
        `[tauri-dev] Resolved compose ports archiveNode=${composePorts.archivePort} archiveRpc=${composePorts.archiveRpcPort} archiveP2p=${composePorts.archiveP2pPort} bitcoinP2p=${composePorts.bitcoinP2pPort} esplora=${composePorts.esploraPort}${composePorts.indexerPort ? ` indexer=${composePorts.indexerPort}` : ''} notary=${composePorts.notaryAliasContainerId}`,
      );
      Object.assign(tauriEnv, getDevDockerServerEnvVars(composePorts));
      if (startedDevEthereum && devEthereumConfig) {
        devEthereumSetup = createDevEthereumSetup(devDockerArchiveUrl, startedDevEthereum, devEthereumConfig);
        Object.assign(tauriEnv, devEthereumSetup.env);
      }
    } else {
      console.warn('[tauri-dev] Server env override unavailable, falling back to static server config');
    }

    const inheritedOverride = readNonEmpty(process.env.ARGON_NETWORK_CONFIG_OVERRIDE);
    const inheritedRuntimeOverride: RuntimeNetworkConfigOverride | undefined = inheritedOverride
      ? JSON.parse(inheritedOverride)
      : undefined;
    const ethereumExecutionRpcUrl = await resolveRuntimeEthereumExecutionRpcUrl(
      startedDevEthereum,
      inheritedRuntimeOverride,
    );
    devEthereumExecutionRpcUrl = ethereumExecutionRpcUrl;
    const ethereumUsdcTokenAddress = await resolveRuntimeEthereumUsdcTokenAddress(
      ethereumExecutionRpcUrl,
      startedDevEthereum,
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
  const configArg = process.platform === 'win32' ? `"${configJson.replace(/"/g, '\\"')}"` : configJson;
  const tauriArgs = ['tauri', 'dev', '--config', configArg];
  const isE2EAppRun = Boolean(readNonEmpty(tauriEnv.ARGON_DRIVER_WS));
  if (isE2EAppRun) {
    tauriArgs.push('--features', 'e2e-screenshots,e2e-insecure-gateway-certs');
    console.log('[tauri-dev] Enabling e2e features (ARGON_DRIVER_WS detected)');
  }

  let devEthereumRuntimeSetupPromise: Promise<void> | undefined;
  let devEthereumReadyPromise: Promise<void> | undefined;
  let devUpstreamPromise: Promise<void> | undefined;
  let devUpstreamRuntime: IDevUpstreamServerRuntime | undefined;
  if (devDockerArchiveUrl && (!isE2EAppRun || devEthereumConfig)) {
    devUpstreamPromise = startDevUpstreamServer({
      archiveUrl: devDockerArchiveUrl,
      devEthereum: startedDevEthereum,
      devEthereumConfig,
    })
      .then(runtime => {
        devUpstreamRuntime = runtime;
        console.log('[tauri-dev][upstream-ready] upstream server is ready');
      })
      .catch(error => {
        console.error(`[tauri-dev] Failed to start upstream server: ${(error as Error).message}`);
        throw error;
      });

    void devUpstreamPromise.catch(() => undefined);
  }

  if (devEthereumSetup) {
    devEthereumRuntimeSetupPromise = devEthereumSetup.start();
    devEthereumReadyPromise = devEthereumRuntimeSetupPromise
      .then(async () => {
        if (!devDockerArchiveUrl || !startedDevEthereum) {
          throw new Error('Dev Ethereum relay activation is missing archive or Ethereum setup details.');
        }
        if (isShuttingDown) {
          return;
        }

        await devUpstreamPromise;
        if (!devUpstreamRuntime) {
          throw new Error('Upstream server did not finish startup before Ethereum relay activation.');
        }
        if (isShuttingDown) {
          return;
        }

        await waitForDevUpstreamEthereumRelayReady({
          archiveUrl: devDockerArchiveUrl,
          botPort: devUpstreamRuntime.botPort,
        });
        if (isShuttingDown) {
          return;
        }

        console.log('[tauri-dev][ethereum-ready] upstream Ethereum relay is ready');

        await updateDevEthereumRuntimeState(startedDevEthereum.executionRpcUrl, {
          setupStatus: 'ready',
        });
      })
      .catch(error => {
        console.error(`[tauri-dev] Failed to finish local Ethereum setup: ${(error as Error).message}`);
        throw error;
      });

    void devEthereumReadyPromise.catch(() => undefined);
  }

  const child = spawn('yarn', tauriArgs, {
    env: tauriEnv,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });

  const killChildTree = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null) {
      return;
    }

    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child if the process group is already gone.
      }
    }

    child.kill(signal);
  };

  child.on('error', err => {
    console.error('[tauri-dev] Failed to start child process.', err);
    process.exit(1);
  });

  process.once('SIGINT', () => {
    isShuttingDown = true;
    killChildTree('SIGINT');
    setTimeout(() => {
      if (child.exitCode === null) {
        killChildTree('SIGKILL');
      }
    }, 5_000).unref();
  });

  process.once('SIGTERM', () => {
    isShuttingDown = true;
    killChildTree('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        killChildTree('SIGKILL');
      }
    }, 5_000).unref();
  });

  if (shouldStartDevEthereumMintingAuthority) {
    devEthereumMintingAuthorityPromise = (async () => {
      if (!devEthereumRuntimeSetupPromise || !devUpstreamPromise) {
        throw new Error('Dev Ethereum or upstream setup did not start before the minting authority.');
      }
      await Promise.all([devEthereumRuntimeSetupPromise, devUpstreamPromise]);
      if (!devUpstreamRuntime) {
        throw new Error('Upstream operator did not finish startup before the minting authority.');
      }
      if (isShuttingDown) {
        return;
      }

      console.log('[tauri-dev] Starting local Ethereum minting authority');
      devEthereumMintingAuthorityRuntime = await startDevEthereumMintingAuthority({
        archiveUrl: devDockerArchiveUrl!,
        executionRpcUrl: devEthereumExecutionRpcUrl,
        logPrefix: 'tauri-dev',
        operator: devUpstreamRuntime.operator,
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
      await devUpstreamPromise?.catch(() => undefined);
      await devEthereumMintingAuthorityPromise;
      await devEthereumMintingAuthorityRuntime?.shutdown().catch(() => undefined);
      await devUpstreamRuntime?.shutdown().catch(() => undefined);
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
  archiveRpcPort: string;
  archiveP2pPort: string;
  bitcoinP2pPort: string;
  esploraPort: string;
  indexerPort?: string;
  notaryAliasContainerId: string;
  notaryArchiveHost?: string;
}

async function resolveDevDockerComposePorts(): Promise<DevDockerComposePorts | null> {
  const context = getDevDockerComposeContext();
  let archivePort: string;
  let archiveRpcPort: string;
  let archiveP2pPort: string;
  let bitcoinP2pPort: string;
  let esploraPort: string;
  let indexerPort: string | undefined;
  let notaryAliasContainerId: string;
  let notaryArchiveHost: string | undefined;

  try {
    archivePort = (await readComposePortWithRetry({
      context,
      service: 'archive-node',
      port: 9944,
    }))!;
    archiveRpcPort = (await readComposePortWithRetry({
      context,
      service: 'archive-rpc',
      port: 9944,
    }))!;
    archiveP2pPort = (await readComposePortWithRetry({
      context,
      service: 'archive-node',
      port: 30334,
    }))!;
    bitcoinP2pPort = (await readComposePortWithRetry({
      context,
      service: 'bitcoin',
      port: 18444,
    }))!;
    esploraPort = (await readComposePortWithRetry({
      context,
      service: 'bitcoin-electrs',
      port: 3002,
    }))!;
    indexerPort = await readComposePortWithRetry({
      context,
      service: 'indexer',
      port: 3262,
      optional: true,
    });
    notaryAliasContainerId = readComposeContainerId({
      context,
      service: 'notary',
    });
    const notebookArchivePort = (await readComposePortWithRetry({
      context,
      service: 'minio',
      port: 9000,
    }))!;
    const notaryPort = (await readComposePortWithRetry({
      context,
      service: 'notary',
      port: 9925,
    }))!;
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
    archiveRpcPort,
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
    ARGON_ARCHIVE_NODE: `ws://host.docker.internal:${ports.archiveRpcPort}`,
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
): Promise<RuntimeNetworkConfigOverride | null> {
  const archiveRpcUrl = `ws://127.0.0.1:${ports.archiveRpcPort}`;
  let runtimeConfig: RuntimeChainConfig;
  try {
    console.log(`[tauri-dev] Loading runtime chain config from ${archiveRpcUrl}`);
    runtimeConfig = await loadRuntimeConfig(archiveRpcUrl);
  } catch (error) {
    console.warn(`[tauri-dev] Failed to load runtime chain config: ${(error as Error).message}`);
    return null;
  }

  const override: RuntimeNetworkConfigOverride = {
    ...runtimeConfig,
    archiveUrl: archiveRpcUrl,
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
    ...dynamicOverride,
    ...inheritedOverride,
    ethereumNetwork: {
      ...dynamicOverride.ethereumNetwork,
      ...inheritedOverride.ethereumNetwork,
    },
    baseNetwork: {
      ...dynamicOverride.baseNetwork,
      ...inheritedOverride.baseNetwork,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
