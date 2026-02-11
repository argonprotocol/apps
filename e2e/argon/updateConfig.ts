import { configDotenv } from 'dotenv';
import Path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { getClient } from '@argonprotocol/mainchain';
import { NetworkConfig, type INetworkConfig } from '@argonprotocol/apps-core';

const __dirname = Path.dirname(new URL(import.meta.url).pathname);

const res = configDotenv({ path: Path.join(__dirname, '.env') });
const dotenvEnv = res.parsed ?? {};
const networkName = process.env.ARGON_CHAIN?.trim() || dotenvEnv.ARGON_CHAIN?.trim() || 'dev-docker';
const composeProjectName = process.env.COMPOSE_PROJECT_NAME?.trim() || dotenvEnv.COMPOSE_PROJECT_NAME?.trim();
const composeEnv = {
  ...dotenvEnv,
  ...process.env,
  ARGON_CHAIN: networkName,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readComposePortOnce(service: string, port: number): string {
  const composeArgs = [
    'compose',
    ...(composeProjectName ? ['--project-name', composeProjectName] : []),
    '-f',
    'docker-compose.yml',
    '-f',
    'indexer.docker-compose.yml',
    'port',
    service,
    String(port),
  ];

  const output = execFileSync('docker', composeArgs, {
    cwd: __dirname,
    encoding: 'utf-8',
    env: composeEnv,
  })
    .trim()
    .split(':')
    .pop()
    ?.trim();

  if (!output) {
    throw new Error(`Unable to resolve docker compose port for ${service}:${port}`);
  }
  return output;
}

async function readComposePortWithRetry(
  service: string,
  port: number,
  options: { optional?: boolean; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return readComposePortOnce(service, port);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }

  if (options.optional) {
    console.warn(`Skipping ${service}:${port} port lookup after ${timeoutMs}ms: ${lastError}`);
    return undefined;
  }

  throw new Error(`Unable to resolve docker compose port for ${service}:${port} after ${timeoutMs}ms: ${lastError}`);
}

async function loadRuntimeConfig(archiveUrl: string): Promise<Awaited<ReturnType<typeof NetworkConfig.loadConfigs>>> {
  const client = await getClient(archiveUrl);
  try {
    while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return await NetworkConfig.loadConfigs(client);
  } finally {
    await client.disconnect();
  }
}

const archivePort = await readComposePortWithRetry('archive-node', 9944);
if (!archivePort) {
  throw new Error('Archive node port lookup returned empty result');
}
const archiveUrl = `ws://127.0.0.1:${archivePort}`;
const runtimeConfig = await loadRuntimeConfig(archiveUrl);
const esploraPort = await readComposePortWithRetry('bitcoin-electrs', 3002);
if (!esploraPort) {
  throw new Error('Esplora port lookup returned empty result');
}
const indexerPort = await readComposePortWithRetry('indexer', 3262, { optional: true });

const configPath = Path.join(__dirname, '../../core/network.config.json');
const networkJson = readFileSync(configPath, 'utf-8');
const networkConfig = JSON.parse(networkJson) as Record<string, INetworkConfig>;
const configEntry = networkConfig[networkName];
if (!configEntry) {
  throw new Error(`Network '${networkName}' not found in network.config.json`);
}
Object.assign(configEntry, runtimeConfig);
configEntry.archiveUrl = archiveUrl;
configEntry.esploraHost = `http://localhost:${esploraPort}`;
if (indexerPort) {
  configEntry.indexerHost = `http://localhost:${indexerPort}`;
}
if (networkName === 'dev-docker') {
  configEntry.bitcoinBlockMillis = runtimeConfig.tickMillis * 10;
}
writeFileSync(configPath, JSON.stringify(networkConfig, null, 2) + '\n', 'utf-8');

if (networkName === 'dev-docker') {
  // this is because it needs to be on the same network right now to sync properly. we could fix this by
  // modifying the bitcoin-regtest.conf to use an `addnode` with a host-accessible docker port
  console.log('------------ NOTE!!! USING DEV-DOCKER CONFIG ------------');
  console.log('Bitcoin can only sync right now if you set:');
  console.log(' ARGON_APP_INSTANCE=e2e ARGON_NETWORK_NAME=dev-docker');
  console.log('---------------------------------------------------------');
}
