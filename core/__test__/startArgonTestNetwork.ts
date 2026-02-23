import { execFileSync } from 'node:child_process';
import { promises as Fs } from 'node:fs';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import docker from 'docker-compose';
import { runOnTeardown } from '@argonprotocol/testing';
import { NetworkConfig, NetworkConfigSettings } from '../src/NetworkConfig.js';
import { stripNetworkPrefix, toComposeProjectName } from '../src/utils.js';
import { type ArgonClient, getClient } from '@argonprotocol/mainchain';

type StartProfile = 'miners' | 'bob' | 'dave' | 'all' | 'price-oracle';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = Path.resolve(__dirname, '..', '..');
const COMPOSE_DIR = Path.resolve(__dirname, '..', '..', 'e2e/argon');
const COMPOSE_CONFIG = ['docker-compose.yml', 'indexer.docker-compose.yml'];

export interface StartArgonTestNetworkOptions {
  shouldLog?: boolean;
  profiles?: StartProfile[];
  registerTeardown?: boolean;
  composeProjectName?: string;
  chainStartTimeoutMs?: number;
  chainStartPollMs?: number;
}

export interface ResolvedTestSessionIdentity {
  composeNetwork: string;
  sessionName: string;
  composeProjectName: string;
  appInstanceName: string;
  appInstancePort: string;
}

export interface TestSessionIdentityOptions {
  networkName?: string;
  rawAppInstance?: string;
  fallbackSessionName?: string;
  processEnv?: NodeJS.ProcessEnv;
}

export function resolveTestSessionIdentity(options: TestSessionIdentityOptions = {}): ResolvedTestSessionIdentity {
  const env = options.processEnv ?? process.env;
  const networkName = options.networkName?.trim() || env.ARGON_NETWORK_NAME?.trim() || 'dev-docker';
  const normalizedNetworkName = networkName.trim() || 'dev-docker';
  const [appInstanceName, appInstancePort = ''] = (options.rawAppInstance ?? env.ARGON_APP_INSTANCE ?? '')
    .trim()
    .split(':');
  const normalizedInstance = stripNetworkPrefix(appInstanceName || '', normalizedNetworkName);
  const sessionName = normalizedInstance || options.fallbackSessionName?.trim() || 'e2e';
  const composeProjectName = toComposeProjectName(sessionName, normalizedNetworkName);
  return {
    composeNetwork: normalizedNetworkName,
    sessionName,
    composeProjectName,
    appInstanceName: normalizedInstance,
    appInstancePort,
  };
}

export interface ResolvedTestSessionCommandEnv {
  composeNetwork: string;
  sessionName: string;
  composeProjectName: string;
  appInstance: string;
  appEnv: NodeJS.ProcessEnv;
}

export interface TestSessionCommandEnvOptions extends TestSessionIdentityOptions {
  appPort: number;
  baseEnv?: NodeJS.ProcessEnv;
}

export function resolveTestSessionCommandEnv(options: TestSessionCommandEnvOptions): ResolvedTestSessionCommandEnv {
  const baseEnv = options.baseEnv ?? process.env;
  const identity = resolveTestSessionIdentity({
    networkName: options.networkName,
    rawAppInstance: options.rawAppInstance,
    fallbackSessionName: options.fallbackSessionName,
    processEnv: baseEnv,
  });
  const appInstance = `${identity.sessionName}:${options.appPort}`;
  const appEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ARGON_NETWORK_NAME: identity.composeNetwork,
    ARGON_APP_INSTANCE: appInstance,
    COMPOSE_PROJECT_NAME: identity.composeProjectName,
  };
  return {
    composeNetwork: identity.composeNetwork,
    sessionName: identity.sessionName,
    composeProjectName: identity.composeProjectName,
    appInstance,
    appEnv,
  };
}

export interface StartedArgonTestNetwork {
  archiveUrl: string;
  notaryUrl: string;
  networkConfigOverride: {
    archiveUrl: string;
    bitcoinBlockMillis: number;
    esploraHost: string;
    indexerHost?: string;
  };
  composeEnv: Record<string, string>;
  getPort: (
    service: 'miner-1' | 'miner-2' | 'bitcoin' | 'indexer' | 'bitcoin-electrs',
    internalPort: number,
  ) => Promise<number>;
  stop: () => Promise<void>;
}

const DEFAULT_CHAIN_START_TIMEOUT_MS = 120_000;
const DEFAULT_CHAIN_START_POLL_MS = 500;

export async function startArgonTestNetwork(
  uniqueTestName: string,
  options: StartArgonTestNetworkOptions = {},
): Promise<StartedArgonTestNetwork> {
  await ensureIndexerBundle();
  await ensureServerBundle();
  ensureDockerComposeAssets();

  NetworkConfig.setNetwork('dev-docker');

  const composeOptions = options.profiles?.map(p => `--profile=${p}`) ?? [];
  const composeEnv: Record<string, string> = {
    ...process.env,
    RPC_PORT: '0',
    COMPOSE_PROJECT_NAME:
      options.composeProjectName ??
      toComposeProjectName(uniqueTestName, process.env.ARGON_NETWORK_NAME ?? 'dev-docker'),
    PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`,
  };

  async function stop(): Promise<void> {
    await docker.downAll({
      log: options.shouldLog ?? false,
      commandOptions: ['--volumes', '--timeout=0'],
      composeOptions,
      config: COMPOSE_CONFIG,
      cwd: COMPOSE_DIR,
      env: composeEnv,
    });
  }

  if (options.registerTeardown ?? true) {
    runOnTeardown(stop);
  }
  await stop();

  await docker.upAll({
    log: options.shouldLog ?? false,
    commandOptions: ['--force-recreate', '--remove-orphans', '--pull=missing'],
    composeOptions,
    config: COMPOSE_CONFIG,
    cwd: COMPOSE_DIR,
    env: composeEnv,
  });

  const portResult = await docker.port('archive-node', '9944', {
    config: COMPOSE_CONFIG,
    cwd: COMPOSE_DIR,
    env: composeEnv,
  });
  const esploraPortResult = await docker.port('bitcoin-electrs', '3002', {
    config: COMPOSE_CONFIG,
    cwd: COMPOSE_DIR,
    env: composeEnv,
  });
  const indexerPortResult = await docker
    .port('indexer', '3262', {
      config: COMPOSE_CONFIG,
      cwd: COMPOSE_DIR,
      env: composeEnv,
    })
    .catch(() => null);
  const notaryPortResult = await docker.port('notary', '9925', {
    config: COMPOSE_CONFIG,
    cwd: COMPOSE_DIR,
    env: composeEnv,
  });
  const port = portResult.data.port;
  const archiveUrl = `ws://127.0.0.1:${port}`;
  const client = await getClient(archiveUrl);
  await waitForFirstMainchainBlock(client, archiveUrl, {
    timeoutMs: Number.isFinite(options.chainStartTimeoutMs ?? NaN)
      ? Number(options.chainStartTimeoutMs)
      : DEFAULT_CHAIN_START_TIMEOUT_MS,
    pollMs: Number.isFinite(options.chainStartPollMs ?? NaN)
      ? Number(options.chainStartPollMs)
      : DEFAULT_CHAIN_START_POLL_MS,
    composeProjectName:
      options.composeProjectName ??
      toComposeProjectName(uniqueTestName, process.env.ARGON_NETWORK_NAME ?? 'dev-docker'),
  });

  try {
    const miningConfig = await NetworkConfig.loadConfigs(client);
    console.log('Loaded mining config:', miningConfig);
    const updatedConfig: Record<string, unknown> = {
      ...miningConfig,
      archiveUrl,
      bitcoinBlockMillis: miningConfig.tickMillis * 10,
      esploraHost: `http://localhost:${esploraPortResult.data.port}`,
    };
    if (indexerPortResult?.data?.port) {
      updatedConfig.indexerHost = `http://localhost:${indexerPortResult.data.port}`;
    }
    Object.assign(NetworkConfigSettings['dev-docker'], updatedConfig);

    return {
      archiveUrl,
      networkConfigOverride: {
        archiveUrl,
        bitcoinBlockMillis: updatedConfig.bitcoinBlockMillis as number,
        esploraHost: updatedConfig.esploraHost as string,
        ...(updatedConfig.indexerHost ? { indexerHost: updatedConfig.indexerHost as string } : {}),
      },
      composeEnv,
      notaryUrl: `ws://127.0.0.1:${notaryPortResult.data.port}`,
      stop,
      getPort(service, internalPort) {
        return docker
          .port(service, internalPort, { config: COMPOSE_CONFIG, cwd: COMPOSE_DIR, env: composeEnv })
          .then(res => res.data.port);
      },
    };
  } finally {
    await client.disconnect();
  }
}

async function waitForFirstMainchainBlock(
  client: ArgonClient,
  archiveUrl: string,
  options: {
    timeoutMs: number;
    pollMs: number;
    composeProjectName: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let lastLogAt = Date.now();
  const timeoutMs = Math.max(
    1,
    Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_CHAIN_START_TIMEOUT_MS,
  );
  const pollMs = Math.max(10, Number.isFinite(options.pollMs) ? options.pollMs : DEFAULT_CHAIN_START_POLL_MS);

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const header = await client.rpc.chain.getHeader();
      const blockNumber = header.number.toNumber();
      if (blockNumber > 0) return;
    } catch (_error) {
      // Wait for chain websocket to become usable.
    }
    if (Date.now() - lastLogAt >= 10_000) {
      console.info(
        `[E2E] Waiting for first chain block from archive node at ${archiveUrl} (compose=${options.composeProjectName})`,
      );
      lastLogAt = Date.now();
    }
    await new Promise(res => setTimeout(res, pollMs));
  }

  throw new Error(
    `[E2E] archive node at ${archiveUrl} never produced block >0 within ${timeoutMs}ms (compose=${options.composeProjectName})`,
  );
}

async function fileExists(path: string): Promise<boolean> {
  return Fs.stat(path)
    .then(() => true)
    .catch(() => false);
}

function runYarn(...args: string[]): void {
  execFileSync('yarn', args, {
    cwd: REPO_ROOT,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  });
}

async function ensureIndexerBundle(): Promise<void> {
  const indexerEntry = Path.resolve(REPO_ROOT, 'indexer/lib/index.js');
  const hasIndexerBundle = await fileExists(indexerEntry);

  if (hasIndexerBundle) return;

  console.info('[E2E] Building indexer bundle (missing indexer/lib/index.js)');
  runYarn('workspace', '@argonprotocol/apps-indexer', 'run', 'build');
}

async function ensureServerBundle(): Promise<void> {
  console.info('[E2E] Building server bundle (ensuring latest for test network)');
  runYarn('build:server');
}

function ensureDockerComposeAssets(): void {
  console.info('[E2E] Ensuring argon docker compose assets are current');
  runYarn('docker:argon:download');
}
