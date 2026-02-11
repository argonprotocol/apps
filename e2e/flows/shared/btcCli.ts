import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARGON_DOCKER_DIR = path.resolve(__dirname, '../../argon');

function readNonEmptyEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}

function getComposeProjectName(): string {
  const explicitProjectName = readNonEmptyEnv('COMPOSE_PROJECT_NAME');
  if (explicitProjectName) {
    return explicitProjectName;
  }

  const networkName = readNonEmptyEnv('ARGON_NETWORK_NAME') ?? 'dev-docker';
  const rawInstance = readNonEmptyEnv('ARGON_APP_INSTANCE') ?? 'e2e';
  const instanceName = rawInstance.split(':')[0] || 'e2e';
  return `${networkName}-${instanceName}`.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

export function runBtcCli(args: string[]): string {
  const composeProjectName = getComposeProjectName();
  const result = spawnSync('docker', ['compose', '--profile', 'tooling', 'run', '--rm', 'btc-cli', ...args], {
    cwd: ARGON_DOCKER_DIR,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: composeProjectName,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'unknown error';
    throw new Error(`btc-cli failed (${args.join(' ')}): ${stderr}`);
  }

  return result.stdout.trim();
}

export function generateBlocks(count: number, minerAddress?: string): string[] {
  const address = minerAddress?.trim() || runBtcCli(['getnewaddress']);
  const raw = runBtcCli(['generatetoaddress', String(count), address]);

  try {
    const parsed = JSON.parse(raw) as string[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // no-op; fall back to a line-based parse below
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}
