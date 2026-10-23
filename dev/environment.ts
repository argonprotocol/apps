import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Fs from 'node:fs';
import Path from 'node:path';
import type { INetworkConfigOverride } from '@argonprotocol/apps-core';
import type { IDevEthereumRuntimeState } from '../e2e/devEthereum.ts';
import type { DevOutput } from './output.ts';
import { getDevPaths, type DevProfile } from './session.ts';

export interface DevEnvironment {
  chainSpec?: string;
  chainSpecHash?: string;
  upstreamApp?: string;
  ethereumContainers?: string[];
  ethereumNetwork?: INetworkConfigOverride['ethereumNetwork'];
}

export function readDevEnvironment(options: DevProfile): DevEnvironment | undefined {
  const file = Path.join(getDevPaths(options).ownerDir, 'dev-environment.json');
  if (!Fs.existsSync(file)) return;
  return JSON.parse(Fs.readFileSync(file, 'utf8')) as DevEnvironment;
}

export function selectDevEnvironment(
  options: DevProfile & { chainSpec?: string; detachUpstreamApp?: boolean },
): DevEnvironment {
  const current = readDevEnvironment(options);
  const chainSpec = options.chainSpec ?? current?.chainSpec;
  const environment = { ...current };
  if (chainSpec) {
    const hash = createHash('sha256').update(Fs.readFileSync(chainSpec)).digest('hex');
    if (current && (current.chainSpec !== chainSpec || current.chainSpecHash !== hash)) {
      throw new Error(
        'The owning environment uses a different chain specification. Use a fresh instance or reset it explicitly.',
      );
    }
    environment.chainSpec = chainSpec;
    environment.chainSpecHash = hash;
  }
  if (options.detachUpstreamApp) environment.upstreamApp = options.instance;
  return environment;
}

export function saveDevEnvironment(options: DevProfile, environment: DevEnvironment): void {
  const { ownerDir } = getDevPaths(options);
  Fs.mkdirSync(ownerDir, { recursive: true });
  const file = Path.join(ownerDir, 'dev-environment.json');
  const temporaryPath = `${file}.${process.pid}.tmp`;
  Fs.writeFileSync(temporaryPath, JSON.stringify(environment), { mode: 0o600 });
  Fs.renameSync(temporaryPath, file);
}

export function readOwnedEthereumStates(options: DevProfile): IDevEthereumRuntimeState[] {
  const directory = Path.join(getDevPaths(options).ownerDir, 'dev-ethereum');
  if (!Fs.existsSync(directory)) return [];
  const states = Fs.readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(Fs.readFileSync(Path.join(directory, file), 'utf8')) as IDevEthereumRuntimeState);
  return [...new Map(states.map(state => [state.enclaveName, state])).values()];
}

export function recordEthereumContainers(options: DevProfile, environment: DevEnvironment): void {
  const states = readOwnedEthereumStates(options);
  if (!states.length) return;
  const enclaves = execFileSync('kurtosis', ['enclave', 'ls', '--full-uuids'], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim().split(/\s+/));
  const containers = new Set(environment.ethereumContainers ?? []);
  for (const state of states) {
    const enclaveId = enclaves.find(([, name]) => name === state.enclaveName)?.[0];
    if (!enclaveId) continue;
    const port = new URL(state.executionRpcUrl).port;
    const execution = execFileSync('docker', ['ps', '-aq', '--filter', `publish=${port}`], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!execution.length) continue;
    if (execution.length !== 1)
      throw new Error('The selected Ethereum RPC must resolve to one owned Docker container.');
    const labels = JSON.parse(
      execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', execution[0]], { encoding: 'utf8' }),
    ) as Record<string, string>;
    if (labels['com.kurtosistech.enclave-id'] !== enclaveId) {
      throw new Error('The saved Ethereum RPC port belongs to another enclave. Refusing to change its containers.');
    }
    const ids = execFileSync('docker', ['ps', '-q', '--filter', `label=com.kurtosistech.enclave-id=${enclaveId}`], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/);
    for (const id of ids) if (id) containers.add(id);
  }
  environment.ethereumContainers = [...containers];
  saveDevEnvironment(options, environment);
}

export async function resumeOwnedEthereum(environment: DevEnvironment, output: DevOutput): Promise<void> {
  if (environment.ethereumContainers?.length) {
    output.progress('Resuming the owning Ethereum services');
    await output.run('docker', ['start', ...environment.ethereumContainers]);
  }
}

export async function configureDevEnvironment(profile: DevProfile, chainSpec?: string) {
  const { network, instance, join } = profile;
  if (network !== 'dev-docker') throw new Error('This command requires the local dev-docker network.');
  if (chainSpec !== undefined) {
    if (!chainSpec.trim() || /[\0\r\n]/.test(chainSpec)) throw new Error('--chain-spec must name a valid file path.');
    chainSpec = Path.resolve(chainSpec);
  }

  const paths = getDevPaths(profile);
  const { toComposeProjectName } = await import('@argonprotocol/apps-core');
  const composeProjectName = toComposeProjectName(join ?? instance, network);
  Object.assign(process.env, {
    ARGON_NETWORK_NAME: network,
    ARGON_APP_INSTANCE: profile.port ? `${instance}:${profile.port}` : instance,
    COMPOSE_PROJECT_NAME: composeProjectName,
    JOIN_COMPOSE_NETWORK: composeProjectName,
    ARGON_DEV_UPSTREAM_DIR: paths.upstreamDir,
    ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR: Path.join(paths.ownerDir, 'dev-ethereum'),
  });
  const environment = readDevEnvironment(profile);
  const configuredSpec = chainSpec ?? environment?.chainSpec;
  if (configuredSpec) {
    process.env.ARGON_CHAIN_SPEC_PATH = configuredSpec;
    process.env.ARGON_CHAIN = '/chainspec.raw.json';
  }
  const { getDevDockerComposeContext } = await import('../e2e/scripts/devUpstreamServer.ts');
  const { getComposeArgs } = await import('../e2e/scripts/devUpstreamCompose.ts');
  const context = getDevDockerComposeContext();
  return { paths, environment, context, composeArgs: getComposeArgs(context) };
}
