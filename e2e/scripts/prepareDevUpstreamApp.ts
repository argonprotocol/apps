#!/usr/bin/env tsx

import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { DEV_UPSTREAM_MASTER_MNEMONIC } from './devUpstreamServer.ts';

const appDir = Path.join(
  Os.homedir(),
  'Library',
  'Application Support',
  'com.argon.desktop.local',
  'dev-docker',
  'app2',
);

Fs.mkdirSync(appDir, { recursive: true });
Fs.writeFileSync(Path.join(appDir, 'mnemonic'), `${DEV_UPSTREAM_MASTER_MNEMONIC}\n`);
