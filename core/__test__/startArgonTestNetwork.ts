import { execFileSync } from 'node:child_process';
import { promises as Fs } from 'node:fs';
import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import docker from 'docker-compose';
import { runOnTeardown } from '@argonprotocol/testing';
import { NetworkConfig, NetworkConfigSettings } from '../src/index.js';
import { getClient } from '@argonprotocol/mainchain';

type StartProfile = 'miners' | 'bob' | 'dave' | 'all' | 'price-oracle';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = Path.resolve(__dirname, '..', '..');
const COMPOSE_DIR = Path.resolve(__dirname, '..', '..', 'e2e/argon');
const COMPOSE_CONFIG = ['docker-compose.yml', 'indexer.docker-compose.yml'];

export function toComposeProjectName(uniqueTestName: string): string {
  return `argon-test-${uniqueTestName.replace('.test.ts', '').replace(/\W+/g, '-').toLowerCase()}`;
}

export interface StartArgonTestNetworkOptions {
  shouldLog?: boolean;
  profiles?: StartProfile[];
  registerTeardown?: boolean;
  composeProjectName?: string;
}

export interface StartedArgonTestNetwork {
  archiveUrl: string;
  notaryUrl: string;
  composeEnv: Record<string, string>;
  getPort: (
    service: 'miner-1' | 'miner-2' | 'bitcoin' | 'indexer' | 'bitcoin-electrs',
    internalPort: number,
  ) => Promise<number>;
  stop: () => Promise<void>;
}

async function fileExists(path: string): Promise<boolean> {
  return Fs.stat(path)
    .then(() => true)
    .catch(() => false);
}

async function ensureIndexerBundle(): Promise<void> {
  const indexerEntry = Path.resolve(REPO_ROOT, 'indexer/lib/index.js');
  const hasIndexerBundle = await fileExists(indexerEntry);

  if (hasIndexerBundle) return;

  console.info('[E2E] Building indexer bundle (missing indexer/lib/index.js)');
  execFileSync('yarn', ['workspace', '@argonprotocol/apps-indexer', 'run', 'build'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
}

async function ensureServerBundle(): Promise<void> {
  const packageJsonPath = Path.resolve(REPO_ROOT, 'package.json');
  const packageJsonRaw = await Fs.readFile(packageJsonPath, 'utf-8');
  const packageJson = JSON.parse(packageJsonRaw) as { version?: unknown };
  const version = typeof packageJson.version === 'string' ? packageJson.version : '';
  if (!version) {
    console.info('[E2E] Building server bundle (missing package version)');
    execFileSync('yarn', ['build:server'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    return;
  }

  const resourcesDir = Path.resolve(REPO_ROOT, 'resources');
  const serverTarName = `server-${version}.tar.gz`;
  const serverTarPath = Path.join(resourcesDir, serverTarName);
  const shasumPath = Path.join(resourcesDir, 'SHASUM256');
  const [hasServerTar, hasShasum] = await Promise.all([fileExists(serverTarPath), fileExists(shasumPath)]);

  if (hasServerTar && hasShasum) {
    const shasum = await Fs.readFile(shasumPath, 'utf-8').catch(() => '');
    if (shasum.includes(`  ${serverTarName}`)) {
      return;
    }
  }

  console.info(`[E2E] Building server bundle (missing resources/${serverTarName} or SHASUM256 entry)`);
  execFileSync('yarn', ['build:server'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
}

function ensureDockerComposeAssets(): void {
  console.info('[E2E] Ensuring argon docker compose assets are current');
  execFileSync('yarn', ['docker:argon:download'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
}

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
    COMPOSE_PROJECT_NAME: options.composeProjectName ?? toComposeProjectName(uniqueTestName),
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
  while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
    await new Promise(res => setTimeout(res, 100));
  }
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

  await client.disconnect();

  return {
    archiveUrl,
    composeEnv,
    notaryUrl: `ws://127.0.0.1:${notaryPortResult.data.port}`,
    stop,
    getPort(service, internalPort) {
      return docker
        .port(service, internalPort, { config: COMPOSE_CONFIG, cwd: COMPOSE_DIR, env: composeEnv })
        .then(res => res.data.port);
    },
  };
}
