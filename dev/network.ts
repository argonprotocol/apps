import { createArgonClient, type INetworkConfigOverride, NetworkConfig } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { type IStartDevEthereumResult, readDevEthereumRuntimeState } from '../e2e/devEthereum.ts';
import {
  getDevDockerComposeContext,
  readComposeContainerId,
  readComposePortWithRetry,
} from '../e2e/scripts/devUpstreamServer.ts';

type RuntimeChainConfig = Awaited<ReturnType<typeof NetworkConfig.loadConfigs>>;

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

export async function resolveDevDockerComposePorts(): Promise<DevDockerComposePorts | null> {
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

export function getDevDockerServerEnvVars(
  ports: DevDockerComposePorts,
  isSharedComposeNetwork: boolean,
): NodeJS.ProcessEnv {
  return {
    ARGON_ARCHIVE_NODE: `ws://host.docker.internal:${ports.archiveRpcPort}`,
    ARGON_BOOTNODES: isSharedComposeNetwork
      ? '--bootnodes=/dns/archive-node/tcp/30334/p2p/12D3KooWMdmKGEuFPVvwSd92jCQJgX9aFCp45E8vV2X284HQjwnn'
      : `--bootnodes=/dns/host.docker.internal/tcp/${ports.archiveP2pPort}/p2p/12D3KooWMdmKGEuFPVvwSd92jCQJgX9aFCp45E8vV2X284HQjwnn`,
    BITCOIN_ADDNODE: `host.docker.internal:${ports.bitcoinP2pPort}`,
    NOTEBOOK_ARCHIVE_HOSTS: ports.notaryArchiveHost,
    NOTARY_ALIAS_CONTAINER_ID: ports.notaryAliasContainerId,
  };
}

export async function resolveNotaryArchiveHost(notaryPort: string, minioPort: string): Promise<string | undefined> {
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

export async function resolveDevDockerNetworkConfigOverride(
  ports: DevDockerComposePorts,
  ethereumExecutionRpcUrl?: string,
  usdcTokenAddress?: string,
): Promise<INetworkConfigOverride | null> {
  const archiveRpcUrl = `ws://127.0.0.1:${ports.archiveRpcPort}`;
  let runtimeConfig: RuntimeChainConfig;
  try {
    console.log(`[tauri-dev] Loading runtime chain config from ${archiveRpcUrl}`);
    runtimeConfig = await loadRuntimeConfig(archiveRpcUrl);
  } catch (error) {
    console.warn(`[tauri-dev] Failed to load runtime chain config: ${(error as Error).message}`);
    return null;
  }

  const override: INetworkConfigOverride = {
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
      executionRpcUrls: [ethereumExecutionRpcUrl],
      ...(usdcTokenAddress ? { usdcTokenAddress } : {}),
    };
  }
  if (ports.indexerPort) {
    override.indexerHost = `http://localhost:${ports.indexerPort}`;
  }
  return override;
}

export async function resolveRuntimeEthereumExecutionRpcUrl(
  devEthereum?: IStartDevEthereumResult,
  inheritedOverride?: INetworkConfigOverride,
): Promise<string | undefined> {
  const launchedExecutionRpcUrl = readNonEmpty(devEthereum?.executionRpcUrl);
  if (launchedExecutionRpcUrl) return launchedExecutionRpcUrl;

  return readNonEmpty(inheritedOverride?.ethereumNetwork?.executionRpcUrls?.[0]);
}

export async function resolveRuntimeEthereumUsdcTokenAddress(
  executionRpcUrl: string | undefined,
  devEthereum?: IStartDevEthereumResult,
  inheritedOverride?: INetworkConfigOverride,
): Promise<string | undefined> {
  const launchedUsdcTokenAddress = readNonEmpty(devEthereum?.usdcTokenAddress);
  if (launchedUsdcTokenAddress) return launchedUsdcTokenAddress;

  const inheritedUsdcTokenAddress = readNonEmpty(inheritedOverride?.ethereumNetwork?.usdcTokenAddress);
  if (inheritedUsdcTokenAddress) return inheritedUsdcTokenAddress;

  try {
    if (!executionRpcUrl) return;
    const runtimeState = await readDevEthereumRuntimeState(executionRpcUrl);
    return readNonEmpty(runtimeState?.usdcTokenAddress);
  } catch (error) {
    console.warn(`[tauri-dev] Dev Ethereum USDC address unavailable: ${(error as Error).message}`);
    return undefined;
  }
}

export async function loadRuntimeConfig(archiveUrl: string): Promise<RuntimeChainConfig> {
  const client = createArgonClient(await getClient(archiveUrl));
  try {
    const deadline = Date.now() + 60_000;
    while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
      if (Date.now() > deadline) throw new Error('Local chain did not produce its first block within 60 seconds.');
      await sleep(100);
    }
    return await NetworkConfig.loadConfigs(client);
  } finally {
    await client.disconnect();
  }
}

export function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function mergeNetworkConfigOverrides(
  inheritedOverride: INetworkConfigOverride,
  dynamicOverride: INetworkConfigOverride | null,
): INetworkConfigOverride {
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

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
