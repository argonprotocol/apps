import Crypto from 'node:crypto';
import Fs from 'node:fs';
import Http from 'node:http';
import Os from 'node:os';
import Path from 'node:path';
import type { INetworkConfigOverride } from '@argonprotocol/apps-core';
import { acquireDevLock } from './lock.ts';

export interface DevProfile {
  network: string;
  instance: string;
  port?: string;
  join?: string;
}

export interface DevSessionState {
  controlUrl: string;
  token: string;
  pid: number;
  owner: string;
  ready: boolean;
  ethereumReady?: boolean;
  networkConfigOverride?: INetworkConfigOverride;
}

export function resolveDevProfile(
  values: Partial<Pick<DevProfile, 'instance' | 'join'>> & { profile?: string },
  env = process.env,
): DevProfile {
  const [configuredInstance, port, extraPort] = env.ARGON_APP_INSTANCE?.split(':') ?? [];
  if (extraPort !== undefined || (port !== undefined && (!/^\d+$/.test(port) || +port < 1 || +port > 65535))) {
    throw new Error('ARGON_APP_INSTANCE must be a profile name with an optional :port between 1 and 65535.');
  }
  const profile: DevProfile = {
    network: 'dev-docker',
    instance: values.profile ?? values.instance ?? (configuredInstance || 'default'),
  };
  const join = values.join ?? env.ARGON_DEV_JOIN ?? env.JOIN_COMPOSE_NETWORK?.replace(/^dev-docker-/, '');
  for (const [name, value] of Object.entries({ profile: profile.instance, join })) {
    if (value !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
      throw new Error(`Invalid ${name} "${value}". Use letters, numbers, hyphens, or underscores.`);
    }
  }
  profile.instance = normalizeDevInstance(profile.instance);
  if (port) profile.port = port;
  if (join !== undefined) profile.join = normalizeDevInstance(join);

  const session = readDevSession(profile);
  if (session) {
    if (profile.join && profile.join !== session.owner) {
      throw new Error(`Profile ${profile.instance} belongs to environment ${session.owner}, not ${profile.join}.`);
    }
    if (!profile.join && session.owner !== profile.instance) profile.join = session.owner;
  }
  return profile;
}

export function getDevPaths(options: Pick<DevProfile, 'network' | 'instance' | 'join'>) {
  let configRoot: string;
  if (process.platform === 'darwin') configRoot = Path.join(Os.homedir(), 'Library', 'Application Support');
  else if (process.platform === 'win32')
    configRoot = process.env.APPDATA || Path.join(Os.homedir(), 'AppData', 'Roaming');
  else configRoot = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  const configuredDir = process.env.ARGON_APP_INSTANCE_DIR;
  const configuredInstance = normalizeDevInstance(process.env.ARGON_APP_INSTANCE?.split(':')[0] || options.instance);
  const networkDir = configuredDir
    ? Path.dirname(configuredDir)
    : Path.join(configRoot, 'com.argon.desktop.local', options.network);
  const instanceDir =
    configuredDir && configuredInstance === options.instance ? configuredDir : Path.join(networkDir, options.instance);
  const ownerDir = options.join ? Path.join(networkDir, options.join) : instanceDir;
  return {
    instanceDir,
    ownerDir,
    networkDir,
    statePath: Path.join(instanceDir, 'dev-cli.json'),
    logPath: Path.join(instanceDir, 'dev-cli.log'),
    upstreamDir: Path.join(ownerDir, 'dev-upstream'),
  };
}

export function readDevSession(
  options: Pick<DevProfile, 'network' | 'instance' | 'join'>,
): DevSessionState | undefined {
  const { statePath } = getDevPaths(options);
  if (!Fs.existsSync(statePath)) return;
  return JSON.parse(Fs.readFileSync(statePath, 'utf8')) as DevSessionState;
}

export async function requestDevSession(state: DevSessionState, action: 'status' | 'stop') {
  const response = await fetch(`${state.controlUrl}/__argon_dev/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET',
    headers: { 'x-argon-dev-token': state.token },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Development launcher returned ${response.status}`);
  return (await response.json()) as DevSessionState;
}

export async function startDevControl(options: DevProfile) {
  const paths = getDevPaths(options);
  const state: DevSessionState = {
    controlUrl: '',
    token: Crypto.randomUUID(),
    pid: process.pid,
    owner: options.join ?? options.instance,
    ready: false,
  };
  const server = Http.createServer((request, response) => {
    if (request.headers['x-argon-dev-token'] !== state.token) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/__argon_dev/status' && request.method === 'GET') {
      response.end(JSON.stringify(state));
    } else if (request.url === '/__argon_dev/stop' && request.method === 'POST') {
      response.end('{}');
      process.kill(process.pid, 'SIGTERM');
    } else response.writeHead(404).end('{}');
  });
  const release = acquireDevLock(`${paths.statePath}.lock`, 'Launcher');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as import('node:net').AddressInfo;
    state.controlUrl = `http://127.0.0.1:${address.port}`;
    save();
  } catch (error) {
    server.closeAllConnections();
    server.close();
    release();
    throw error;
  }

  function save() {
    Fs.writeFileSync(paths.statePath, JSON.stringify(state), { mode: 0o600 });
  }

  let closed = false;
  return {
    state,
    save,
    close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      server.close();
      try {
        if (readDevSession(options)?.token === state.token) {
          state.ready = false;
          save();
        }
      } finally {
        release();
      }
    },
  };
}

function normalizeDevInstance(instance: string): string {
  return instance
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
