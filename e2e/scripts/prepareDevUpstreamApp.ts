import Fs from 'node:fs/promises';
import Path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseEnv } from 'dotenv';
import * as tar from 'tar';
import { Keyring } from '@argonprotocol/mainchain';
import { type ArgonClient, NetworkConfig, toComposeProjectName } from '@argonprotocol/apps-core';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import type { AppVaultOperator } from '../actors/AppVaultOperator.ts';
import { BootstrapRecovery, BootstrapRecoveryContext } from 'src-vue/lib/BootstrapRecovery.ts';
import {
  DEV_UPSTREAM_MASTER_MNEMONIC,
  prepareDevUpstreamServer,
  stopDevUpstreamServer,
  waitForDevUpstreamEthereumRelayReady,
} from './devUpstreamServer.ts';
import { stopDevUpstreamWorker } from './devUpstreamProcess.ts';
import { readDevEthereumConfigFromEnv, type IStartDevEthereumResult } from '../devEthereum.ts';
import {
  startDevEthereumMintingAuthority,
  type IDevEthereumMintingAuthorityRuntime,
} from '../helpers/startDevEthereumMintingAuthority.ts';
import { chooseAvailablePort } from '../../scripts/utils.ts';
import type { DevOutput } from '../../dev/output.ts';

const execFileAsync = promisify(execFile);

export async function prepareDevUpstreamApp(args: {
  instance: string;
  visibleAppDir: string;
  devUpstreamDir: string;
  actor: AppVaultOperator;
  client: ArgonClient;
  runtimeEnv: NodeJS.ProcessEnv;
  output: DevOutput;
  devEthereum?: IStartDevEthereumResult;
}): Promise<void> {
  const { instance, visibleAppDir, devUpstreamDir, actor, client, runtimeEnv, output, devEthereum } = args;
  const { walletKeys } = actor;
  const networkEnv = ['ARGON_ARCHIVE_NODE', 'ARGON_BOOTNODES', 'BITCOIN_ADDNODE', 'NOTEBOOK_ARCHIVE_HOSTS'] as const;
  for (const key of networkEnv) {
    if (!runtimeEnv[key]) throw new Error(`The replacement server requires ${key} from the local network.`);
  }
  const repoDir = Path.resolve(import.meta.dirname, '../..');
  const vmDir = Path.join(visibleAppDir, 'virtual-machine');
  const appDir = Path.join(vmDir, 'app');
  const serverDir = Path.join(appDir, 'server');
  const logsDir = Path.join(appDir, 'logs');
  const mnemonic = (await Fs.readFile(Path.join(visibleAppDir, 'mnemonic'), 'utf8')).trim();
  if (mnemonic !== DEV_UPSTREAM_MASTER_MNEMONIC) {
    throw new Error('The upstream app must use the development upstream identity. Select a fresh instance.');
  }
  const hasVm = await Fs.stat(Path.join(vmDir, '.env')).then(
    () => true,
    () => false,
  );
  const hasDatabase = await Fs.stat(Path.join(visibleAppDir, 'database.sqlite')).then(
    () => true,
    () => false,
  );
  if (hasDatabase && !hasVm) {
    throw new Error(
      'This app already has a server history. Select a fresh --instance NAME --join OWNER for the handoff.',
    );
  }

  await stopDevUpstreamWorker(devUpstreamDir, 'SIGUSR2');
  await stopDevUpstreamServer();
  output.progress('Preparing the replacement local server');
  await Fs.mkdir(serverDir, { recursive: true });
  await Fs.mkdir(logsDir, { recursive: true });
  await Fs.cp(Path.join(repoDir, 'local-machine'), vmDir, { recursive: true });
  const upstreamConfig = Path.join(devUpstreamDir, 'config');
  try {
    await Fs.cp(upstreamConfig, Path.join(appDir, 'config'), { recursive: true, force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await prepareDevUpstreamServer({
    devUpstreamDir: appDir,
    walletKeys,
    client,
    devEthereum,
    devEthereumConfig: readDevEthereumConfigFromEnv(),
  });
  output.progress('Preparing a usable upstream account');
  await actor.bootstrapUpstreamOperator({ client, operatorName: 'Testing' });
  await Fs.cp(Path.join(repoDir, 'config/nginx-certs'), Path.join(appDir, 'config/nginx-certs'), { recursive: true });
  const envState = parseEnv(await Fs.readFile(Path.join(appDir, 'config/.env.state'), 'utf8'));
  await Fs.writeFile(
    Path.join(appDir, 'config/.env.security'),
    `SESSION_MINI_SECRET=${envState.SESSION_MINI_SECRET}\n`,
    { mode: 0o600 },
  );
  await Fs.writeFile(Path.join(appDir, 'account'), walletKeys.miningBotAddress);

  const shasum = await Fs.readFile(Path.join(repoDir, 'resources/SHASUM256'), 'utf8');
  const archive = shasum.trim().split(/\s+/)[1];
  await tar.extract({ file: Path.join(repoDir, 'resources', archive), cwd: serverDir });
  await Fs.writeFile(Path.join(serverDir, 'SHASUM256'), shasum);

  const vmEnv = await Fs.readFile(Path.join(vmDir, '.env'), 'utf8').then(
    parseEnv,
    () => ({}) as Record<string, string>,
  );
  const serverEnv = await Fs.readFile(Path.join(serverDir, '.env'), 'utf8').then(
    parseEnv,
    () => ({}) as Record<string, string>,
  );
  const sshPort = Number(vmEnv.SSH_PORT) || (await chooseAvailablePort(2222, '0.0.0.0'));
  const gatewayPort = Number(serverEnv.GATEWAY_PORT) || (await chooseAvailablePort(44301, '0.0.0.0'));
  const bitcoinPort = Number(serverEnv.BITCOIN_P2P_PORT) || (await chooseAvailablePort(18445, '0.0.0.0'));
  const argonPort = Number(serverEnv.ARGON_P2P_PORT) || (await chooseAvailablePort(30337, '0.0.0.0'));
  const project = toComposeProjectName(instance, 'dev-docker');
  const publicKey = new Keyring({ type: 'ed25519' }).addFromUri(`${mnemonic}//ssh-ed25519//1`).publicKey;
  const sshPublicKey = `ssh-ed25519 ${Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), publicKey]).toString('base64')}`;
  await Fs.writeFile(
    Path.join(vmDir, '.env'),
    [
      `COMPOSE_PROJECT_NAME=${project}`,
      `SSH_PORT=${sshPort}`,
      `SSH_PUBKEY=${sshPublicKey}`,
      `UID=${process.getuid?.() ?? 1000}`,
      `GID=${process.getgid?.() ?? 1000}`,
      '',
    ].join('\n'),
  );

  if (runtimeEnv.ARGON_CHAIN_SPEC_PATH) {
    const spec = await Fs.readFile(runtimeEnv.ARGON_CHAIN_SPEC_PATH);
    const dataDir = Path.join(appDir, 'data/argon');
    await Fs.mkdir(dataDir, { recursive: true });
    const installed = await Fs.readFile(Path.join(dataDir, 'chainspec.raw.json')).catch(() => undefined);
    if (installed && !installed.equals(spec)) throw new Error('The local server uses a different chain specification.');
    await Fs.writeFile(Path.join(dataDir, 'chainspec.raw.json'), spec);
  }
  const deploymentEnv = await Fs.readFile(Path.join(serverDir, '.env.dev-docker'), 'utf8');
  await Fs.writeFile(
    Path.join(serverDir, '.env'),
    [
      deploymentEnv.replace(/^ROOT=.*$/m, `ROOT=${JSON.stringify(appDir)}`),
      `COMPOSE_PROJECT_NAME=${project}`,
      `GATEWAY_PORT=${gatewayPort}`,
      `BITCOIN_P2P_PORT=${bitcoinPort}`,
      `ARGON_P2P_PORT=${argonPort}`,
      `UID=${process.getuid?.() ?? 1000}`,
      `GID=${process.getgid?.() ?? 1000}`,
      ...networkEnv.map(key => `${key}=${JSON.stringify(runtimeEnv[key] ?? '')}`),
      ...(runtimeEnv.ARGON_CHAIN_SPEC_PATH ? ['ARGON_NODE_CHAIN=/data/chainspec.raw.json'] : []),
      '',
    ].join('\n'),
  );
  const composeEnv: NodeJS.ProcessEnv = { ...process.env, ARGON_CHAIN: 'dev-docker' };
  delete composeEnv.COMPOSE_PROJECT_NAME;
  delete composeEnv.JOIN_COMPOSE_NETWORK;
  await output.run('docker', ['compose', 'up', '-d', '--build', '--wait'], { cwd: vmDir, env: composeEnv });
  await output.run('docker', ['network', 'inspect', `${project}-net`], { env: composeEnv }).catch(async () => {
    await output.run('docker', ['network', 'create', `${project}-net`], { env: composeEnv });
  });
  if (runtimeEnv.NOTARY_ALIAS_CONTAINER_ID) {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '--format',
      '{{json .NetworkSettings.Networks}}',
      runtimeEnv.NOTARY_ALIAS_CONTAINER_ID,
    ]);
    if (!JSON.parse(stdout)[`${project}-net`]) {
      await output.run('docker', [
        'network',
        'connect',
        '--alias',
        'notary.localhost',
        `${project}-net`,
        runtimeEnv.NOTARY_ALIAS_CONTAINER_ID,
      ]);
    }
  }

  for (const name of await Fs.readdir(logsDir)) {
    if (/^step-.*\.(Finished|Failed|Started)$/.test(name)) await Fs.rm(Path.join(logsDir, name));
  }
  output.progress('Installing the replacement server');
  await output.run(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '--user',
      'argon',
      'vm',
      'bash',
      '-c',
      'nohup bash -c \'while [ "$PPID" -ne 1 ]; do sleep 0.1; done; export IS_DOCKER_HOST_PROXY=true; exec /app/server/scripts/installer.sh\' > /app/logs/installer.log 2>&1 < /dev/null &',
    ],
    { cwd: vmDir, env: composeEnv },
  );
  const stages = ['FileUpload', 'UbuntuCheck', 'DockerInstall', 'BitcoinInstall', 'ArgonInstall', 'MiningLaunch'];
  let reportedStage = '';
  await waitFor(
    15 * 60_000,
    `local server installation; logs: ${Path.join(logsDir, 'installer.log')}`,
    async () => {
      const files = await Fs.readdir(logsDir);
      const failed = files.find(file => /^step-.*\.Failed$/.test(file));
      if (failed) throw new Error(`Server ${failed}: ${await Fs.readFile(Path.join(logsDir, failed), 'utf8')}`);
      const active = stages.find(stage => !files.includes(`step-${stage}.Finished`));
      if (!active) return true;
      if (active !== reportedStage) {
        output.progress(`Server setup: ${active}`);
        reportedStage = active;
      }
    },
    { retryErrors: false },
  );
  const { stdout } = await execFileAsync('docker', ['compose', 'port', 'bot', '8080'], {
    cwd: serverDir,
    env: composeEnv,
  });
  const botPort = Number(stdout.trim().split(':').at(-1));
  const recovery = new BootstrapRecovery(walletKeys);
  const bootstrapEndpointSecret = await walletKeys.getOwnServerBootstrapEndpointSecret();
  await recovery.publishRecovery({
    client,
    transactionTracker: actor.transactionTracker,
    context: BootstrapRecoveryContext.OwnServer,
    bootstrapEndpointSecret,
    bootstrapEndpointIndex: 0,
    ssh: { user: 'argon', port: sshPort },
  });
  await recovery.publishEndpoint({
    client,
    transactionTracker: actor.transactionTracker,
    bootstrapEndpointSecret,
    host: '127.0.0.1',
    port: gatewayPort,
  });
  output.progress('Replacement server ready and published');
  if (devEthereum) {
    const archiveUrl = NetworkConfig.get().archiveUrl;
    let mintingAuthority: IDevEthereumMintingAuthorityRuntime | undefined;
    try {
      const setting = process.env.ARGON_DEV_ETHEREUM_MINTING_AUTHORITY?.trim().toLowerCase();
      if (!['0', 'false', 'no', 'off'].includes(setting ?? '')) {
        output.progress('Preparing Ethereum minting authority');
        mintingAuthority = await startDevEthereumMintingAuthority({
          archiveUrl,
          client,
          executionRpcUrl: devEthereum.executionRpcUrl,
          operator: actor,
          virtualEnv: { appInstance: instance, network: 'dev-docker', serverEnvVars: runtimeEnv },
        });
      }
      await waitForDevUpstreamEthereumRelayReady({
        archiveUrl,
        botPort: String(botPort),
      });
    } finally {
      await mintingAuthority?.shutdown();
    }
  }
}
