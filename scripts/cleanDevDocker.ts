#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = Path.dirname(fileURLToPath(import.meta.url));
const repoRoot = Path.resolve(scriptDir, '..');
const appIds = ['com.argon.operations.local', 'com.argon.capital.local'];

const networkName = readNonEmptyEnv('ARGON_NETWORK_NAME') ?? 'dev-docker';
const rawInstance = readNonEmptyEnv('ARGON_APP_INSTANCE') ?? 'e2e';
const instanceName = rawInstance.split(':')[0] || 'e2e';
const composeProjectName =
  readNonEmptyEnv('COMPOSE_PROJECT_NAME') ??
  `${networkName}-${instanceName}`.toLowerCase().replace(/[^a-z0-9]/g, '-');

console.info(
  `[clean:dev:docker] Resetting project="${composeProjectName}" network="${networkName}" instance="${instanceName}"`,
);

bringDownArgonComposeProject();
bringDownLocalMachineComposeProjects();

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

function runDockerComposeDown(cwd: string, extraArgs: string[] = [], options: { clearComposeProjectName?: boolean } = {}): void {
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
    execFileSync(
      'docker',
      ['compose', 'down', '--volumes', '--remove-orphans', '--timeout=0', ...extraArgs],
      {
        cwd,
        env: commandEnv,
        stdio: 'inherit',
      },
    );
  } catch (error) {
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
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn(
      `[clean:dev:docker] argon compose down failed for ${composeProjectName}: ${(error as Error).message}`,
    );
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
      console.warn(
        `[clean:dev:docker] Failed to remove directory ${instanceDir}: ${(error as Error).message}`,
      );
    }
  }
}
