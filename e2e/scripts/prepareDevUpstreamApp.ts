#!/usr/bin/env tsx

import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { DEV_UPSTREAM_MASTER_MNEMONIC, resolveDevUpstreamRootDir } from './devUpstreamServer.ts';

const actorPidPath = Path.join(resolveDevUpstreamRootDir(), 'config', 'operator-actor.pid');
let appConfigDir: string;
if (process.platform === 'darwin') {
  appConfigDir = Path.join(Os.homedir(), 'Library', 'Application Support');
} else if (process.platform === 'win32') {
  appConfigDir = process.env.APPDATA || Path.join(Os.homedir(), 'AppData', 'Roaming');
} else {
  appConfigDir = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
}
const appDir = Path.join(appConfigDir, 'com.argon.desktop.local', 'dev-docker', 'app2');

Fs.mkdirSync(appDir, { recursive: true });
Fs.writeFileSync(Path.join(appDir, 'mnemonic'), `${DEV_UPSTREAM_MASTER_MNEMONIC}\n`);

let actorPid: number;
try {
  actorPid = Number.parseInt(Fs.readFileSync(actorPidPath, 'utf8').trim(), 10);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error("Keep 'yarn dev:docker' running and wait for '[tauri-dev][upstream-ready]' before continuing.");
  }
  throw error;
}
if (!Number.isSafeInteger(actorPid) || actorPid <= 0) {
  throw new Error(`Invalid embedded upstream operator PID in ${actorPidPath}.`);
}

try {
  process.kill(actorPid, 'SIGUSR2');
} catch (error) {
  throw new Error(`The embedded upstream operator is not running. Restart 'yarn dev:docker' and try again.`, {
    cause: error,
  });
}

await waitFor(10_000, 'embedded upstream operator detachment', () => !Fs.existsSync(actorPidPath), {
  pollMs: 50,
  retryErrors: false,
  timeoutMessage: 'The embedded upstream operator did not detach before the visible app started.',
});
