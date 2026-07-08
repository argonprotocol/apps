import { execFileSync } from 'node:child_process';
import Fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { parseEnv } from 'node:util';
import {
  MainchainClients,
  minimumVaultDelegateBalance,
  NetworkConfig,
  type IEthereumGatewayRelayStatus,
} from '@argonprotocol/apps-core';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import type { IDevEthereumConfig, IStartDevEthereumResult } from '../devEthereum.ts';
import { AppVaultOperator } from '../actors/AppVaultOperator.ts';
import { ensureDevGatewayCerts } from '../../scripts/devGatewayCerts.ts';
import { MemoryWalletKeys } from 'src-vue/lib/MemoryWalletKeys.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultUpstreamRootDir = path.resolve(__dirname, '..', 'dev-upstream');

export const DEV_UPSTREAM_MASTER_MNEMONIC = 'test test test test test test test test test test test junk';
export const DEV_UPSTREAM_SUBSTRATE_SURI = '//DevUpstreamOperator';

export const DEV_DOCKER_COMPOSE_FILES = [
  'docker-compose.yml',
  'miners.docker-compose.yml',
  'upstream-server.docker-compose.yml',
  'indexer.docker-compose.yml',
  'chainspec.docker-compose.yml',
] as const;

const DEFAULT_COMPOSE_PROFILES = ['all'] as const;
const UPSTREAM_COMPOSE_PROFILES = ['all', 'upstream'] as const;

export interface DevDockerComposeContext {
  composeDir: string;
  composeEnv: NodeJS.ProcessEnv;
  composeProjectName?: string;
  profiles: readonly string[];
}

export interface IDevUpstreamServerRuntime {
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
  devEthereum?: IStartDevEthereumResult;
  devEthereumConfig?: Pick<IDevEthereumConfig, 'finalityBlocks' | 'finalityMillis'>;
}): Promise<IDevUpstreamServerRuntime> {
  const upstreamRootDir = resolveDevUpstreamRootDir();
  const context = getDevUpstreamComposeContext();
  const walletKeys = await createDevUpstreamWalletKeys();
  const configDir = path.join(upstreamRootDir, 'config');
  const dataDir = path.join(upstreamRootDir, 'data');
  const envStatePath = path.join(configDir, '.env.state');
  const miningBotWalletPath = path.join(configDir, 'walletMiningBot.json');
  const vaultDelegateWalletPath = path.join(configDir, 'walletVaultDelegate.json');

  await Fs.mkdir(configDir, { recursive: true });
  await Fs.mkdir(dataDir, { recursive: true });

  const [miningBotKeypair, vaultDelegateKeypair, sessionMiniSecret] = await Promise.all([
    walletKeys.getMiningBotKeypair(),
    walletKeys.getVaultDelegateKeypair(),
    walletKeys.getMiningSessionMiniSecret(),
  ]);

  await Promise.all([
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
          executionRpcUrl: args.devEthereum.serverExecutionRpcUrl,
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
    `SESSION_MINI_SECRET=${sessionMiniSecret}`,
    `ETHEREUM_BEACON_API_URL=${args.devEthereum?.serverBeaconApiUrl?.trim() || existingState.ETHEREUM_BEACON_API_URL || ''}`,
    `ETHEREUM_EXECUTION_RPC_URL=${args.devEthereum?.serverExecutionRpcUrl?.trim() || existingState.ETHEREUM_EXECUTION_RPC_URL || ''}`,
    `ETHEREUM_FINALITY_MILLIS=${args.devEthereumConfig?.finalityMillis?.toString() || existingState.ETHEREUM_FINALITY_MILLIS || ''}`,
    `ARGON_NETWORK_CONFIG_OVERRIDE=${argonNetworkConfigOverride || existingState.ARGON_NETWORK_CONFIG_OVERRIDE || ''}`,
  ];

  await Fs.writeFile(envStatePath, envLines.join('\n') + '\n');
  await ensureDevGatewayCerts();

  execFileSync('docker', [...getComposeArgs(context), 'build', 'upstream-router', 'upstream-bot', 'upstream-nginx'], {
    cwd: context.composeDir,
    encoding: 'utf8',
    env: context.composeEnv,
  });

  execFileSync(
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

  const clients = new MainchainClients(args.archiveUrl, () => false);
  const actor = await AppVaultOperator.load({
    clients,
    walletKeys,
  });
  let isShutdown = false;
  let operationsUpgradePoller: { shutdown(): Promise<void> } | undefined;
  const shutdown = async () => {
    if (isShutdown) {
      return;
    }
    isShutdown = true;
    await operationsUpgradePoller?.shutdown().catch(() => undefined);
    await actor.dispose().catch(() => undefined);
    await clients.disconnect().catch(() => undefined);
  };

  try {
    const client = await clients.get(false);
    await actor.bootstrapUpstreamOperator({
      client,
      vaultName: 'NetworkVault',
    });

    const { botPort, gatewayPort, routerPort } = await readDevUpstreamServerPorts(context);
    operationsUpgradePoller = actor.startOperationsUpgradePoller({
      client,
      routerHost: `http://127.0.0.1:${routerPort}`,
    });

    return {
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
      if (!matchedPort) {
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

function getComposeArgs(context: DevDockerComposeContext): string[] {
  return [
    'compose',
    ...context.profiles.flatMap(profile => ['--profile', profile]),
    ...(context.composeProjectName ? ['--project-name', context.composeProjectName] : []),
    ...DEV_DOCKER_COMPOSE_FILES.flatMap(file => ['-f', file]),
  ];
}

export async function createDevUpstreamWalletKeys(): Promise<MemoryWalletKeys> {
  return new MemoryWalletKeys({
    substrateSuri: DEV_UPSTREAM_SUBSTRATE_SURI,
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

function resolveDevUpstreamRootDir(): string {
  const configuredRootDir = process.env.ARGON_DEV_UPSTREAM_ROOT_DIR?.trim() || defaultUpstreamRootDir;
  return path.resolve(configuredRootDir);
}
