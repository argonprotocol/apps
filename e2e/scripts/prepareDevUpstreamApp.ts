#!/usr/bin/env tsx

import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { DEV_UPSTREAM_MASTER_MNEMONIC, resolveDevUpstreamRootDir } from './devUpstreamServer.ts';
import { stopDevUpstreamWorker } from './devUpstreamProcess.ts';

if (process.platform === 'win32') {
  throw new Error('The visible dev upstream handoff is not supported on Windows because it requires SIGUSR2.');
}

const upstreamRootDir = resolveDevUpstreamRootDir();
let appConfigDir: string;
if (process.platform === 'darwin') {
  appConfigDir = Path.join(Os.homedir(), 'Library', 'Application Support');
} else {
  appConfigDir = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
}
const appDir = Path.join(appConfigDir, 'com.argon.desktop.local', 'dev-docker', 'app2');

Fs.mkdirSync(appDir, { recursive: true });
Fs.writeFileSync(Path.join(appDir, 'mnemonic'), `${DEV_UPSTREAM_MASTER_MNEMONIC}\n`);

await stopDevUpstreamWorker(upstreamRootDir, 'SIGUSR2');
