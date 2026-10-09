#!/usr/bin/env tsx

import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import { DEV_UPSTREAM_MASTER_MNEMONIC, stopDevUpstreamServer } from './devUpstreamServer.ts';
import { resolveDevUpstreamDir, stopDevUpstreamWorker } from './devUpstreamProcess.ts';

if (process.platform === 'win32') {
  throw new Error('The visible dev upstream handoff is not supported on Windows because it requires SIGUSR2.');
}

let appConfigDir: string;
if (process.platform === 'darwin') {
  appConfigDir = Path.join(Os.homedir(), 'Library', 'Application Support');
} else {
  appConfigDir = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
}
const visibleAppDir = Path.join(appConfigDir, 'com.argon.desktop.local', 'dev-docker', 'app2');

Fs.mkdirSync(visibleAppDir, { recursive: true });
Fs.writeFileSync(Path.join(visibleAppDir, 'mnemonic'), `${DEV_UPSTREAM_MASTER_MNEMONIC}\n`);

await stopDevUpstreamWorker(resolveDevUpstreamDir(), 'SIGUSR2');

// A healthy old gateway masks endpoint recovery after the visible app publishes its replacement.
await stopDevUpstreamServer();
