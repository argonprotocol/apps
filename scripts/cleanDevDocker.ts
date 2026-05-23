#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripNetworkPrefix, toComposeProjectName } from '../core/src/utils.ts';

const scriptDir = Path.dirname(fileURLToPath(import.meta.url));
const repoRoot = Path.resolve(scriptDir, '..');
const appIds = ['com.argon.operations.local', 'com.argon.treasury.local'];
const kurtosisEthereumEnclavePrefix = 'argon-eth-';

const networkName = readNonEmptyEnv('ARGON_NETWORK_NAME') ?? 'dev-docker';
const rawInstance = readNonEmptyEnv('ARGON_APP_INSTANCE') ?? 'e2e';
const rawInstanceName = rawInstance.split(':')[0] || 'e2e';
const instanceName = stripNetworkPrefix(rawInstanceName, networkName) || 'e2e';
const composeProjectName = readNonEmptyEnv('COMPOSE_PROJECT_NAME') ?? toComposeProjectName(instanceName, networkName);

console.info(
  `[clean:dev:docker] Resetting project="${composeProjectName}" network="${networkName}" instance="${instanceName}"`,
);

bringDownArgonComposeProject();
removeConflictingComposeNetwork(composeProjectName);
bringDownLocalMachineComposeProjects();
removeDevEthereumRelayers();
removeDevEthereumEnclaves();

console.info('[clean:dev:docker] Completed');

function readNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getAppConfigBaseDir(): string {
  if (process.platform === 'darwin') {
    return Path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || Path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || Path.join(os.homedir(), '.config');
}

function runDockerComposeDown(
  cwd: string,
  extraArgs: string[] = [],
  options: { clearComposeProjectName?: boolean } = {},
): void {
  if (!existsSync(cwd)) return;

  const composeYaml = Path.join(cwd, 'docker-compose.yml');
  const composeAltYaml = Path.join(cwd, 'docker-compose.yaml');
  if (!existsSync(composeYaml) && !existsSync(composeAltYaml)) return;

  const commandEnv: NodeJS.ProcessEnv = { ...process.env };
  if (options.clearComposeProjectName) {
    // Local VM/server compose projects keep their own COMPOSE_PROJECT_NAME in their .env files.
    // Do not override them with the outer test-network project name.
    delete commandEnv.COMPOSE_PROJECT_NAME;
  }

  try {
    execFileSync('docker', ['compose', 'down', '--volumes', '--remove-orphans', '--timeout=0', ...extraArgs], {
      cwd,
      env: commandEnv,
      encoding: 'utf8',
    });
  } catch (error) {
    if (isMissingDockerNetworkError(error)) {
      return;
    }
    console.warn(`[clean:dev:docker] docker compose down failed in ${cwd}: ${(error as Error).message}`);
  }
}

function bringDownArgonComposeProject(): void {
  const composeArgs = [
    'compose',
    '--project-name',
    composeProjectName,
    '--env-file=.env',
    '-f',
    'docker-compose.yml',
    '-f',
    'miners.docker-compose.yml',
    '-f',
    'indexer.docker-compose.yml',
    '-f',
    'chainspec.docker-compose.yml',
    'down',
    '--volumes',
    '--remove-orphans',
    '--timeout=0',
  ];

  try {
    execFileSync('docker', composeArgs, {
      cwd: Path.join(repoRoot, 'e2e', 'argon'),
      env: process.env,
      encoding: 'utf8',
    });
  } catch (error) {
    if (isMissingDockerNetworkError(error)) {
      return;
    }
    console.warn(`[clean:dev:docker] argon compose down failed for ${composeProjectName}: ${(error as Error).message}`);
  }
}

function removeConflictingComposeNetwork(composeProjectName: string): void {
  const networkName = `${composeProjectName}-net`;
  let networkInfoJson: string;

  try {
    networkInfoJson = execFileSync('docker', ['network', 'inspect', networkName], { encoding: 'utf8' });
  } catch (_error) {
    return;
  }

  try {
    const networks = JSON.parse(networkInfoJson) as Array<{
      Labels?: Record<string, string>;
      Containers?: Record<string, unknown>;
    }>;
    const network = networks[0];
    if (!network) return;

    const composeNetworkLabel = network.Labels?.['com.docker.compose.network'];
    if (composeNetworkLabel === 'default') {
      return;
    }

    if (network.Containers && Object.keys(network.Containers).length > 0) {
      console.warn(
        `[clean:dev:docker] ${networkName} exists with unexpected label "${composeNetworkLabel}" and is in use; skipping removal`,
      );
      return;
    }

    console.warn(
      `[clean:dev:docker] Removing stale network "${networkName}" with unexpected compose label "${composeNetworkLabel}"`,
    );
    execFileSync('docker', ['network', 'rm', networkName], {
      stdio: 'inherit',
    });
  } catch (_error) {
    console.warn(`[clean:dev:docker] Unable to inspect network "${networkName}" before start; continuing`);
  }
}

function bringDownLocalMachineComposeProjects(): void {
  const appConfigBaseDir = getAppConfigBaseDir();

  for (const appId of appIds) {
    const instanceDir = Path.join(appConfigBaseDir, appId, networkName, instanceName);
    const vmDir = Path.join(instanceDir, 'virtual-machine');
    runDockerComposeDown(vmDir, [], { clearComposeProjectName: true });

    const vmServerDir = Path.join(vmDir, 'app', 'server');
    runDockerComposeDown(vmServerDir, [], { clearComposeProjectName: true });

    try {
      if (existsSync(instanceDir)) {
        rmSync(instanceDir, { recursive: true, force: true });
        console.info(`[clean:dev:docker] Removed directory ${instanceDir}`);
      }
    } catch (error) {
      console.warn(`[clean:dev:docker] Failed to remove directory ${instanceDir}: ${(error as Error).message}`);
    }
  }
}

function removeDevEthereumEnclaves(): void {
  let output: string;
  try {
    output = execFileSync('kurtosis', ['enclave', 'ls'], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    });
  } catch (error) {
    console.warn(`[clean:dev:docker] Unable to list Kurtosis enclaves: ${(error as Error).message}`);
    return;
  }

  const enclaveNames = Array.from(
    new Set(output.match(new RegExp(`\\b${kurtosisEthereumEnclavePrefix}[a-z0-9]+\\b`, 'g')) ?? []),
  );
  if (!enclaveNames.length) return;

  for (const enclaveName of enclaveNames) {
    try {
      console.info(`[clean:dev:docker] Removing Kurtosis enclave ${enclaveName}`);
      execFileSync('kurtosis', ['enclave', 'rm', '-f', enclaveName], {
        cwd: repoRoot,
        env: process.env,
        encoding: 'utf8',
      });
    } catch (error) {
      console.warn(`[clean:dev:docker] Failed to remove Kurtosis enclave ${enclaveName}: ${(error as Error).message}`);
    }
  }
}

function removeDevEthereumRelayers(): void {
  const processes = listProcesses();
  if (!processes.length) return;

  const matchingPids = new Set<number>();
  for (const entry of processes) {
    if (isDevEthereumRelayerProcess(entry.command)) {
      matchingPids.add(entry.pid);
      collectDescendantPids(entry.pid, processes, matchingPids);
    }
  }

  if (!matchingPids.size) return;

  console.info(`[clean:dev:docker] Stopping ${matchingPids.size} local Ethereum relayer process(es)`);
  signalProcesses(matchingPids, 'SIGTERM');
  sleepSync(500);
  signalProcesses(matchingPids, 'SIGKILL');
}

function listProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  if (process.platform === 'win32') return [];

  let output: string;
  try {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
    });
  } catch (error) {
    console.warn(`[clean:dev:docker] Unable to inspect local processes: ${(error as Error).message}`);
    return [];
  }

  return output
    .split('\n')
    .map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return;
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3],
      };
    })
    .filter((entry): entry is { pid: number; ppid: number; command: string } => Boolean(entry));
}

function isDevEthereumRelayerProcess(command: string): boolean {
  const normalizedRepoRoot = repoRoot.split('\\').join('/');
  const normalizedCommand = command.split('\\').join('/');

  return (
    (normalizedCommand.includes(`${normalizedRepoRoot}/.yarn/releases/`) &&
      normalizedCommand.includes('workspace @argonprotocol/apps-bot run start:relayer')) ||
    (normalizedCommand.includes(`${normalizedRepoRoot}/node_modules/tsx/`) &&
      normalizedCommand.includes('src/relayer.ts'))
  );
}

function collectDescendantPids(
  pid: number,
  processes: Array<{ pid: number; ppid: number; command: string }>,
  targetPids: Set<number>,
): void {
  for (const processEntry of processes) {
    if (processEntry.ppid !== pid || targetPids.has(processEntry.pid)) continue;
    targetPids.add(processEntry.pid);
    collectDescendantPids(processEntry.pid, processes, targetPids);
  }
}

function signalProcesses(pids: Set<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (_error) {
      // Already exited.
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isMissingDockerNetworkError(error: unknown): boolean {
  const message = readExecErrorOutput(error).toLowerCase();
  return message.includes('network ') && message.includes(' not found');
}

function readExecErrorOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr =
    'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr
      : 'stderr' in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8')
        : '';
  const stdout =
    'stdout' in error && typeof error.stdout === 'string'
      ? error.stdout
      : 'stdout' in error && Buffer.isBuffer(error.stdout)
        ? error.stdout.toString('utf8')
        : '';

  return [error.message, stderr, stdout].filter(Boolean).join('\n');
}
