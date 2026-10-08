import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSessionDiagnostics } from '../../e2e/AppSessionDiagnostics.ts';

describe.skipIf(process.platform === 'win32')('AppSessionDiagnostics process capture', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(Path.join(tmpdir(), 'argon-session-diagnostics-'));
    const binDirectory = Path.join(directory, 'bin');
    mkdirSync(binDirectory);
    const dockerPath = Path.join(binDirectory, 'docker');
    writeFileSync(
      dockerPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.DIAGNOSTIC_PROBE_CAPTURE, JSON.stringify(process.argv.slice(2)));
if (process.env.COMPOSE_PROJECT_NAME !== 'synthetic-owned-network') process.exit(1);
console.log('indexer | Syncing account activity blocks 30 to 455');
console.log('indexer | Error syncing account activity blocks: synthetic archive timeout');
`,
    );
    chmodSync(dockerPath, 0o700);

    vi.stubEnv('PATH', `${binDirectory}${Path.delimiter}${process.env.PATH}`);
    vi.stubEnv('CI_TEMP_DIR', directory);
    vi.stubEnv('COMPOSE_PROJECT_NAME', 'unrelated-network');
    vi.spyOn(AppSessionDiagnostics, 'getInstanceDirectory').mockReturnValue(Path.join(directory, 'app'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('preserves owned-network indexer diagnostics before the app directory exists', async () => {
    const diagnostics = new AppSessionDiagnostics({
      appConfigId: 'synthetic.app',
      networkName: 'dev-docker',
      instanceName: 'synthetic-recovery',
    });
    const capturePath = Path.join(directory, 'command.json');

    await diagnostics.printFailure('account-history-recovery', new Error('Synthetic incomplete history'), {
      composeEnv: {
        ...process.env,
        COMPOSE_PROJECT_NAME: 'synthetic-owned-network',
        DIAGNOSTIC_PROBE_CAPTURE: capturePath,
      },
    });

    const artifactPath = Path.join(directory, 'e2e-network-synthetic-recovery.log');
    expect(readFileSync(artifactPath, 'utf8')).toContain(
      'Error syncing account activity blocks: synthetic archive timeout',
    );
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(capturePath, 'utf8'))).toEqual([
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'upstream-server.docker-compose.yml',
      '-f',
      'indexer.docker-compose.yml',
      'logs',
      '--no-color',
      '--timestamps',
      '--tail',
      '1000',
      'indexer',
    ]);
    expect(existsSync(Path.join(directory, 'app'))).toBe(false);
  });

  it('does not collect Docker logs from an ambient network without an owned test network', async () => {
    const capturePath = Path.join(directory, 'command.json');
    vi.stubEnv('DIAGNOSTIC_PROBE_CAPTURE', capturePath);
    const diagnostics = new AppSessionDiagnostics({
      appConfigId: 'synthetic.app',
      networkName: 'dev-docker',
      instanceName: 'synthetic-recovery',
    });

    await diagnostics.printFailure('account-history-recovery', new Error('Synthetic incomplete history'));

    expect(existsSync(capturePath)).toBe(false);
    expect(existsSync(Path.join(directory, 'e2e-network-synthetic-recovery.log'))).toBe(false);
  });
});
