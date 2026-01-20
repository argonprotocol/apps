import Path from 'path';
import docker from 'docker-compose';
import { runOnTeardown } from '@argonprotocol/testing';
import { NetworkConfig, NetworkConfigSettings } from '../src/index.js';
import { getClient } from '@argonprotocol/mainchain';

export async function startArgonTestNetwork(
  uniqueTestName: string,
  options?: {
    shouldLog?: boolean;
    dockerEnv?: Record<string, string>;
    profiles: ('miners' | 'bob' | 'dave' | 'all' | 'price-oracle')[];
  },
): Promise<{
  archiveUrl: string;
  notaryUrl: string;
  getPort: (service: 'miner-1' | 'miner-2' | 'bitcoin', internalPort: number) => Promise<number>;
}> {
  NetworkConfig.setNetwork('dev-docker');
  const config = [Path.join(Path.dirname(require.resolve('@argonprotocol/testing')), 'docker-compose.yml')];
  const env = {
    VERSION: 'dev',
    ARGON_CHAIN: 'dev-docker',
    RPC_PORT: '0',
    BITCOIN_BLOCK_SECS: '20',
    PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
    COMPOSE_PROJECT_NAME: `argon-test-${uniqueTestName.replace('.test.ts', '').replace(/\W+/g, '-').toLowerCase()}`,
    ...(options?.dockerEnv ?? {}),
  };
  async function cleanup() {
    await Promise.all([
      docker.downAll({
        log: options?.shouldLog ?? false,
        commandOptions: [`--volumes`, '--timeout=0'],
        composeOptions: options?.profiles ? options.profiles.map(p => `--profile=${p}`) : [],
        config,
        env,
      }),
      docker.downAll({
        log: options?.shouldLog ?? false,
        commandOptions: [`--volumes`, '--timeout=0'],
        composeOptions: options?.profiles ? options.profiles.map(p => `--profile=${p}`) : [],
        config: 'indexer.docker-compose.yml',
        cwd: Path.resolve(__dirname, '..', '..', 'e2e/argon'),
        env,
      }),
    ]);
  }
  runOnTeardown(cleanup);
  await cleanup();
  await docker.upAll({
    log: options?.shouldLog ?? false,
    commandOptions: [`--force-recreate`, `--remove-orphans`, '--pull=always'],
    composeOptions: options?.profiles ? options.profiles.map(p => `--profile=${p}`) : [],
    config,
    env,
  });
  await docker.upAll({
    log: options?.shouldLog ?? false,
    commandOptions: [],
    env,
    config: 'indexer.docker-compose.yml',
    cwd: Path.resolve(__dirname, '..', '..', 'e2e/argon'),
  });
  const portResult = await docker.port('archive-node', '9944', { config, env });
  const notaryPortResult = await docker.port('notary', '9925', { config, env });
  const port = portResult.data.port;
  const archiveUrl = `ws://localhost:${port}`;
  const client = await getClient(archiveUrl);
  while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
    await new Promise(res => setTimeout(res, 100));
  }
  const miningConfig = await NetworkConfig.loadConfigs(client);
  console.log('Loaded mining config:', miningConfig);
  Object.assign(NetworkConfigSettings['dev-docker'], {
    ...miningConfig,
    archiveUrl,
    bitcoinBlockMillis: miningConfig.tickMillis * 10,
  });

  await client.disconnect();

  return {
    archiveUrl,
    notaryUrl: `ws://localhost:${notaryPortResult.data.port}`,
    getPort(service, internalPort) {
      return docker.port(service, internalPort, { config, env }).then(res => res.data.port);
    },
  };
}
