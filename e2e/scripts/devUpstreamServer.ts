import { execFile, execFileSync } from 'node:child_process';
import Fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { parseEnv, promisify } from 'node:util';
import {
  BidAmountFormulaType,
  createArgonClient,
  type IEthereumGatewayRelayStatus,
  type INetworkConfigOverride,
  JsonExt,
  MainchainClients,
  MICROGONS_PER_ARGON,
  MICRONOTS_PER_ARGONOT,
  minimumVaultDelegateBalance,
  NetworkConfig,
  SeatGoalType,
} from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import type { IDevEthereumConfig, IStartDevEthereumResult } from '../devEthereum.ts';
import { AppVaultOperator } from '../actors/AppVaultOperator.ts';
import { ensureDevGatewayCerts } from '../../scripts/devGatewayCerts.ts';
import type { IConfig } from 'src-vue/interfaces/IConfig.ts';
import { BootstrapRecovery } from 'src-vue/lib/BootstrapRecovery.ts';
import { Config } from 'src-vue/lib/Config.ts';
import { MemoryWalletKeys } from 'src-vue/lib/MemoryWalletKeys.ts';
import { DEV_DOCKER_COMPOSE_FILES, type DevDockerComposeContext, getComposeArgs } from './devUpstreamCompose.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultUpstreamRootDir = path.resolve(__dirname, '..', 'dev-upstream');
const execFileAsync = promisify(execFile);

export const DEV_UPSTREAM_MASTER_MNEMONIC = 'test test test test test test test test test test test junk';

export { DEV_DOCKER_COMPOSE_FILES } from './devUpstreamCompose.ts';
export type { DevDockerComposeContext } from './devUpstreamCompose.ts';

const DEFAULT_COMPOSE_PROFILES = ['all'] as const;
const UPSTREAM_COMPOSE_PROFILES = ['all', 'upstream'] as const;

export interface IDevUpstreamServerRuntime {
  operator: AppVaultOperator;
  botPort: string;
  gatewayPort: string;
  routerPort: string;
  shutdown(): Promise<void>;
}

export function getDevDockerComposeContext(
  args: {
    envOverrides?: Record<string, string | undefined>;
    profiles?: readonly string[];
  } = {},
): DevDockerComposeContext {
  const composeDir = path.resolve(__dirname, '..', 'argon');
  const dotenvPath = path.join(composeDir, '.env');
  const dotenvEnv = loadDotEnv({ path: dotenvPath, quiet: true }).parsed ?? {};
  const composeProjectName =
    process.env.JOIN_COMPOSE_NETWORK?.trim() || dotenvEnv.COMPOSE_PROJECT_NAME?.trim() || undefined;
  const composeEnv: NodeJS.ProcessEnv = { ...dotenvEnv, ...process.env, ...args.envOverrides };

  delete composeEnv.COMPOSE_PROJECT_NAME;
  if (composeProjectName) {
    composeEnv.COMPOSE_PROJECT_NAME = composeProjectName;
  }

  return {
    composeDir,
    composeEnv,
    composeProjectName,
    profiles: args.profiles ?? DEFAULT_COMPOSE_PROFILES,
  };
}

export function getDevUpstreamComposeContext(): DevDockerComposeContext {
  return getDevDockerComposeContext({
    envOverrides: {
      ARGON_DEV_UPSTREAM_ROOT_DIR: resolveDevUpstreamRootDir(),
    },
    profiles: UPSTREAM_COMPOSE_PROFILES,
  });
}

export async function readDevUpstreamServerPorts(
  context = getDevUpstreamComposeContext(),
): Promise<{ botPort: string; gatewayPort: string; routerPort: string }> {
  const timeoutMs = 30_000;
  let botPort: string | undefined;
  let gatewayPort: string | undefined;
  let routerPort: string | undefined;

  try {
    [botPort, gatewayPort, routerPort] = await Promise.all([
      readComposePortWithRetry({ context, service: 'upstream-bot', port: 8080, timeoutMs }),
      readComposePortWithRetry({ context, service: 'upstream-nginx', port: 443, timeoutMs }),
      readComposePortWithRetry({ context, service: 'upstream-router', port: 8080, timeoutMs }),
    ]);
  } catch (error) {
    throw new Error(
      `Upstream services are not running. Keep 'yarn dev:docker' open and wait for '[tauri-dev][upstream-ready]', or restart 'yarn dev:docker' to retry upstream startup. Root error: ${(error as Error).message}`,
    );
  }

  return {
    botPort: botPort!,
    gatewayPort: gatewayPort!,
    routerPort: routerPort!,
  };
}

export async function startDevUpstreamServer(args: {
  archiveUrl: string;
  networkConfigOverride?: INetworkConfigOverride;
  devEthereum?: Pick<IStartDevEthereumResult, 'serverBeaconApiUrl' | 'serverExecutionRpcUrl' | 'usdcTokenAddress'>;
  devEthereumConfig?: Pick<IDevEthereumConfig, 'finalityBlocks' | 'finalityMillis'>;
}): Promise<IDevUpstreamServerRuntime> {
  const upstreamRootDir = resolveDevUpstreamRootDir();
  const context = getDevUpstreamComposeContext();
  const walletKeys = await createDevUpstreamWalletKeys();
  const configDir = path.join(upstreamRootDir, 'config');
  const dataDir = path.join(upstreamRootDir, 'data');
  const envStatePath = path.join(configDir, '.env.state');
  const biddingRulesPath = path.join(configDir, 'biddingRules.json');
  const miningBotWalletPath = path.join(configDir, 'walletMiningBot.json');
  const vaultDelegateWalletPath = path.join(configDir, 'walletVaultDelegate.json');

  await Fs.mkdir(configDir, { recursive: true });
  await Fs.mkdir(dataDir, { recursive: true });

  const [miningBotKeypair, vaultDelegateKeypair, sessionMiniSecret, restoreKey, bootstrapEndpointSecret] =
    await Promise.all([
      walletKeys.getMiningBotKeypair(),
      walletKeys.getVaultDelegateKeypair(),
      walletKeys.getMiningSessionMiniSecret(),
      walletKeys.getRouterRestoreSealingKey(),
      walletKeys.getOwnServerBootstrapEndpointSecret(),
    ]);
  const biddingRules = {
    ...(Config.getDefault('biddingRules') as IConfig['biddingRules']),
    seatGoalType: SeatGoalType.Max,
    seatGoalCount: 4,
    maximumBidFormulaType: BidAmountFormulaType.Custom,
    maximumBidCustom: 280_000n,
  };

  await Promise.all([
    Fs.writeFile(biddingRulesPath, JsonExt.stringify(biddingRules, 2) + '\n'),
    Fs.writeFile(miningBotWalletPath, JSON.stringify(miningBotKeypair.toJson(''), null, 2) + '\n'),
    Fs.writeFile(vaultDelegateWalletPath, JSON.stringify(vaultDelegateKeypair.toJson(''), null, 2) + '\n'),
  ]);

  let existingState: Record<string, string | undefined> = {};
  try {
    existingState = parseEnv(await Fs.readFile(envStatePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const argonNetworkConfigOverride = args.devEthereum
    ? JSON.stringify({
        ethereumNetwork: {
          executionRpcUrls: [args.devEthereum.serverExecutionRpcUrl],
          finalityBlocks: args.devEthereumConfig?.finalityBlocks,
          usdcTokenAddress: args.devEthereum.usdcTokenAddress,
        },
      })
    : undefined;
  const envLines = [
    '# Generated during upstream server startup.',
    `MINING_FUNDING_ACCOUNT_ID=${miningBotKeypair.address}`,
    `VAULT_OPERATOR_ADDRESS=${walletKeys.vaultingAddress}`,
    `OPERATOR_ACCOUNT_ID=${walletKeys.operationalAddress}`,
    `ROUTER_RESTORE_KEY=${restoreKey}`,
    `ROUTER_BOOTSTRAP_ENDPOINT_SECRET=${bootstrapEndpointSecret}`,
    `SESSION_MINI_SECRET=${sessionMiniSecret}`,
    `ETHEREUM_BEACON_API_URL=${args.devEthereum?.serverBeaconApiUrl?.trim() || existingState.ETHEREUM_BEACON_API_URL || ''}`,
    `ETHEREUM_EXECUTION_RPC_URL=${args.devEthereum?.serverExecutionRpcUrl?.trim() || existingState.ETHEREUM_EXECUTION_RPC_URL || ''}`,
    `ETHEREUM_FINALITY_MILLIS=${args.devEthereumConfig?.finalityMillis?.toString() || existingState.ETHEREUM_FINALITY_MILLIS || ''}`,
    `ARGON_NETWORK_CONFIG_OVERRIDE=${argonNetworkConfigOverride || existingState.ARGON_NETWORK_CONFIG_OVERRIDE || ''}`,
  ];

  await Fs.writeFile(envStatePath, envLines.join('\n') + '\n');
  await ensureDevGatewayCerts();

  const miningCapital = {
    microgons: 100_000_000n * BigInt(MICROGONS_PER_ARGON),
    micronots: 100_000_000n * BigInt(MICRONOTS_PER_ARGONOT),
  };
  const fundingClient = createArgonClient(await getClient(args.archiveUrl));
  try {
    const existingTreasuryMicronots = (await fundingClient.query.ownership.account(walletKeys.defaultArgonAddress))
      .free;

    await sudoFundWallet({
      client: fundingClient,
      address: miningBotKeypair.address,
      microgons: miningCapital.microgons,
      micronots: miningCapital.micronots,
    });
    await sudoFundWallet({
      client: fundingClient,
      address: walletKeys.defaultArgonAddress,
      microgons: 10n * BigInt(MICROGONS_PER_ARGON),
      micronots: existingTreasuryMicronots,
    });
  } finally {
    await fundingClient.disconnect();
  }

  let clients: MainchainClients | undefined;
  let actor: AppVaultOperator | undefined;
  try {
    await execFileAsync(
      'docker',
      [...getComposeArgs(context), 'build', 'upstream-router', 'upstream-bot', 'upstream-nginx'],
      {
        cwd: context.composeDir,
        encoding: 'utf8',
        env: context.composeEnv,
      },
    );

    await execFileAsync(
      'docker',
      [
        ...getComposeArgs(context),
        'up',
        '-d',
        '--wait',
        'upstream-miner',
        'upstream-router',
        'upstream-bot',
        'upstream-nginx',
      ],
      {
        cwd: context.composeDir,
        encoding: 'utf8',
        env: context.composeEnv,
      },
    );

    NetworkConfig.setNetwork('dev-docker');

    const archiveClient = await getClient(args.archiveUrl);
    clients = new MainchainClients(args.archiveUrl, () => false, archiveClient);
    actor = await AppVaultOperator.load({
      clients,
      walletKeys,
      networkConfigOverride: args.networkConfigOverride,
    });
  } catch (error) {
    await actor?.dispose().catch(() => undefined);
    await clients?.disconnect().catch(() => undefined);
    throw error;
  }

  const bootstrapRecovery = new BootstrapRecovery(walletKeys);
  const vaultAlertAbortController = new AbortController();
  let isShutdown = false;
  let shutdownPromise: Promise<void> | undefined;
  let operationsUpgradePoller: { shutdown(): Promise<void> } | undefined;
  let vaultAlertPoller: Promise<void> | undefined;
  let endpointMonitor: NodeJS.Timeout | undefined;
  let isEndpointRefreshRunning = false;
  let publishedGatewayPort: string | undefined;
  const detachOperator = async () => {
    const upgradePoller = operationsUpgradePoller;
    const alertPoller = vaultAlertPoller;
    operationsUpgradePoller = undefined;
    vaultAlertPoller = undefined;

    vaultAlertAbortController.abort();
    try {
      await Promise.all([upgradePoller?.shutdown(), alertPoller]);
    } finally {
      actor.myVault.unsubscribe();
    }
  };
  const shutdown = (): Promise<void> => {
    if (isShutdown) return Promise.resolve();
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      clearInterval(endpointMonitor);
      await detachOperator().catch(() => undefined);
      await actor.dispose().catch(() => undefined);
      await clients.disconnect().catch(() => undefined);
      isShutdown = true;
    })().finally(() => {
      shutdownPromise = undefined;
    });

    return shutdownPromise;
  };

  try {
    const client = await clients.get(false);
    const { botPort, gatewayPort, routerPort } = await readDevUpstreamServerPorts(context);
    await bootstrapRecovery.publishEndpoint({
      client,
      transactionTracker: actor.transactionTracker,
      bootstrapEndpointSecret,
      host: '127.0.0.1',
      port: Number(gatewayPort),
    });
    publishedGatewayPort = gatewayPort;

    endpointMonitor = setInterval(() => {
      if (isEndpointRefreshRunning) return;
      isEndpointRefreshRunning = true;

      void readComposePortWithRetry({
        context,
        service: 'upstream-nginx',
        port: 443,
        optional: true,
        timeoutMs: 1_500,
      })
        .then(async currentGatewayPort => {
          if (!currentGatewayPort || currentGatewayPort === publishedGatewayPort) return;

          await bootstrapRecovery.publishEndpoint({
            client,
            transactionTracker: actor.transactionTracker,
            bootstrapEndpointSecret,
            host: '127.0.0.1',
            port: Number(currentGatewayPort),
          });
          publishedGatewayPort = currentGatewayPort;
          console.log(`[dev-upstream] Published updated gateway port ${currentGatewayPort}`);
        })
        .catch(error => {
          console.warn(`[dev-upstream] Unable to publish updated gateway: ${(error as Error).message}`);
        })
        .finally(() => {
          isEndpointRefreshRunning = false;
        });
    }, 2_000);
    endpointMonitor.unref();

    await actor.bootstrapUpstreamOperator({
      client,
      operatorName: 'Testing',
    });

    operationsUpgradePoller = actor.startOperationsUpgradePoller({
      client,
      routerHost: `http://127.0.0.1:${routerPort}`,
    });
    vaultAlertPoller = actor.pollVaultAlerts({ signal: vaultAlertAbortController.signal });
    void vaultAlertPoller.catch(error => {
      console.warn('[dev-upstream] Vault alert poller stopped.', error);
    });

    return {
      operator: actor,
      botPort,
      gatewayPort,
      routerPort,
      shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

export async function readComposePortWithRetry(args: {
  context?: DevDockerComposeContext;
  service: string;
  port: number;
  optional?: boolean;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const context = args.context ?? getDevDockerComposeContext();
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let lastError = 'no docker output received';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const output = execFileSync('docker', [...getComposeArgs(context), 'port', args.service, String(args.port)], {
        cwd: context.composeDir,
        encoding: 'utf-8',
        env: context.composeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const endpoint = output
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean)
        .at(-1);

      if (!endpoint) {
        throw new Error(`No docker compose port output for ${args.service}:${args.port}`);
      }

      const matchedPort = endpoint.match(/:(\d+)\s*$/)?.[1];
      if (!matchedPort || matchedPort === '0') {
        throw new Error(`Could not parse mapped port from "${endpoint}" for ${args.service}:${args.port}`);
      }

      return matchedPort;
    } catch (error) {
      const execError = error as Error & { stderr?: Buffer | string };
      const stderr = execError.stderr?.toString().trim();
      lastError = stderr || execError.message;
      await delay(1_000);
    }
  }

  if (args.optional) {
    return undefined;
  }

  throw new Error(
    `Unable to resolve docker compose port for ${args.service}:${args.port} after ${timeoutMs}ms: ${lastError}`,
  );
}

export function readComposeContainerId(args: { context?: DevDockerComposeContext; service: string }): string {
  const context = args.context ?? getDevDockerComposeContext();
  const containerId = execFileSync('docker', [...getComposeArgs(context), 'ps', '-q', args.service], {
    cwd: context.composeDir,
    encoding: 'utf-8',
    env: context.composeEnv,
  }).trim();

  if (!containerId) {
    throw new Error(`No docker compose container id found for ${args.service}`);
  }

  return containerId;
}

export async function createDevUpstreamWalletKeys(): Promise<MemoryWalletKeys> {
  return new MemoryWalletKeys({
    substrateSuri: DEV_UPSTREAM_MASTER_MNEMONIC,
    masterMnemonic: DEV_UPSTREAM_MASTER_MNEMONIC,
  });
}

export async function waitForDevUpstreamEthereumRelayReady(args: {
  archiveUrl: string;
  botPort: string;
}): Promise<void> {
  const walletKeys = await createDevUpstreamWalletKeys();
  const delegateAddress = (await walletKeys.getVaultDelegateKeypair()).address;
  const startedAt = Date.now();
  const timeoutMs = 120_000;
  let didFundDelegate = false;
  let lastReason = 'upstream Ethereum relay is not ready yet';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${args.botPort}/ethereum-relay-status`);
      if (!response.ok) {
        lastReason = `upstream bot returned ${response.status}`;
        await delay(1_000);
        continue;
      }

      const status = (await response.json()) as IEthereumGatewayRelayStatus;
      if (status.isReady) {
        return;
      }

      lastReason = status.reason ?? 'upstream Ethereum relay is still initializing';
      if (status.reasonCode === 'delegateInsufficientFunds' && !didFundDelegate) {
        didFundDelegate = true;
        await sudoFundWallet({
          address: delegateAddress,
          archiveUrl: args.archiveUrl,
          microgons: minimumVaultDelegateBalance * 2n,
          micronots: 0n,
        });
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }

    await delay(1_000);
  }

  throw new Error(`Upstream Ethereum relay did not become ready within ${timeoutMs}ms: ${lastReason}`);
}

export function resolveDevUpstreamRootDir(): string {
  const configuredRootDir = process.env.ARGON_DEV_UPSTREAM_ROOT_DIR?.trim() || defaultUpstreamRootDir;
  return path.resolve(configuredRootDir);
}
