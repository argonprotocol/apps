import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildLocalServices } from '../../dev/commands/start.ts';
import { DevOutput } from '../../dev/output.ts';

it.skipIf(process.platform === 'win32').each([false, true])(
  'overlaps independent builds and drains child processes before returning (server fails: %s)',
  async failServer => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-builds-'));
    const binDir = Path.join(directory, 'bin');
    Fs.mkdirSync(binDir);
    const builder = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.BUILD_TEST_DIRECTORY;
const args = process.argv.slice(2);
let job = 'cli';
if (args.includes('build:server')) job = 'server';
else if (args.includes('@argonprotocol/apps-indexer')) job = 'indexer';
const file = name => path.join(directory, name);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  fs.appendFileSync(file('events'), job + ':start\\n');
  fs.writeFileSync(file(job + '.started'), '');
  if (job !== 'cli') {
    const peer = job === 'server' ? 'indexer' : 'server';
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(file(peer + '.started'))) {
      if (Date.now() >= deadline) throw new Error('Independent build did not start');
      await wait(10);
    }
  }
  await wait(job === 'cli' ? 150 : 20);
  if (job === 'server' && process.env.BUILD_TEST_FAIL_SERVER === '1') process.exit(1);
  fs.writeFileSync(file(job + '.done'), '');
  fs.appendFileSync(file('events'), job + ':done\\n');
})().catch(error => { console.error(error); process.exit(1); });
`;
    for (const command of ['yarn', 'docker']) {
      Fs.writeFileSync(Path.join(binDir, command), builder, { mode: 0o755 });
    }
    vi.stubEnv('PATH', `${binDir}${Path.delimiter}${process.env.PATH}`);
    vi.stubEnv('BUILD_TEST_DIRECTORY', directory);
    vi.stubEnv('BUILD_TEST_FAIL_SERVER', failServer ? '1' : '0');
    const output = new DevOutput(Path.join(directory, 'startup.log'));

    try {
      const builds = buildLocalServices(output, {
        context: { composeDir: directory, composeEnv: { ...process.env }, profiles: ['all'] },
        composeArgs: ['compose'],
      });
      if (failServer) await expect(builds).rejects.toThrow('build:server failed');
      else await builds;

      const events = Fs.readFileSync(Path.join(directory, 'events'), 'utf8').trim().split('\n');
      expect(events.slice(0, 2).sort()).toEqual(['indexer:start', 'server:start']);
      expect(events.indexOf('cli:start')).toBeGreaterThan(events.indexOf('indexer:done'));
      expect(Fs.existsSync(Path.join(directory, 'cli.done'))).toBe(true);
      expect(Fs.existsSync(Path.join(directory, 'server.done'))).toBe(!failServer);
    } finally {
      output.close();
      vi.unstubAllEnvs();
      Fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
