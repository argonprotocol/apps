import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getClient } from '@argonprotocol/mainchain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLocalMainnetManifest, type LocalMainnetManifest } from '../local-mainnet/manifest.ts';

vi.mock('@argonprotocol/mainchain', async importOriginal => ({
  ...(await importOriginal<typeof import('@argonprotocol/mainchain')>()),
  getClient: vi.fn(),
}));

const directories: string[] = [];
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('local mainnet baseline transfer', () => {
  it('selects the published app and finalized mainnet state', async () => {
    const directory = mkdtempSync(Path.join(tmpdir(), 'qualification-inputs-'));
    directories.push(directory);
    const blockHash = `0x${'ab'.repeat(32)}`;
    const disconnect = vi.fn();
    vi.mocked(getClient).mockResolvedValue({
      rpc: {
        chain: { getFinalizedHead: async () => ({ toHex: () => blockHash }) },
        state: { getRuntimeVersion: async () => ({ specVersion: { toNumber: () => 159 } }) },
      },
      disconnect,
    } as unknown as Awaited<ReturnType<typeof getClient>>);
    const environmentPath = Path.join(directory, 'environment');
    vi.stubEnv('GITHUB_ENV', environmentPath);
    process.argv = [process.execPath, 'qualificationInputs.ts', '--output', Path.join(directory, 'run')];

    await import('../local-mainnet/qualificationInputs.ts');

    const releasedVersion = JSON.parse(readFileSync('release-channels/desktop-stable.json', 'utf8')).version;
    const environment = readFileSync(environmentPath, 'utf8');
    expect(environment).toContain(`PREVIOUS_APPS_REF=v${releasedVersion}\n`);
    expect(environment).toContain(`QUALIFICATION_BLOCK_HASH=${blockHash}\n`);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('resolves copied baseline databases relative to their manifest, not the preparation runner', () => {
    const source = mkdtempSync(Path.join(tmpdir(), 'qualification-baseline-source-'));
    const destination = mkdtempSync(Path.join(tmpdir(), 'qualification-baseline-copy-'));
    directories.push(source, destination);
    for (const name of ['chopsticks.sqlite', 'mainnet-activity-v2.db']) {
      const database = new DatabaseSync(Path.join(source, name));
      database.exec('CREATE TABLE Checkpoint (blockNumber INTEGER); INSERT INTO Checkpoint VALUES (100)');
      database.close();
    }
    const manifest: LocalMainnetManifest = {
      formatVersion: 1,
      network: 'mainnet',
      archive: {
        url: 'wss://rpc.argon.network',
        blockNumber: 100,
        blockHash: `0x${'12'.repeat(32)}`,
        deployedSpecVersion: 158,
        chopsticksDatabasePath: 'chopsticks.sqlite',
        sha256: createHash('sha256')
          .update(readFileSync(Path.join(source, 'chopsticks.sqlite')))
          .digest('hex'),
      },
      indexer: {
        blockNumber: 100,
        blockHash: `0x${'12'.repeat(32)}`,
        databasePath: 'mainnet-activity-v2.db',
        sha256: createHash('sha256')
          .update(readFileSync(Path.join(source, 'mainnet-activity-v2.db')))
          .digest('hex'),
      },
    };
    writeFileSync(Path.join(source, 'manifest.json'), JSON.stringify(manifest));
    cpSync(source, destination, { recursive: true });
    rmSync(source, { recursive: true });

    const restored = loadLocalMainnetManifest(Path.join(destination, 'manifest.json'));
    expect(restored.archive.chopsticksDatabasePath).toBe(realpathSync(Path.join(destination, 'chopsticks.sqlite')));
    expect(restored.indexer.databasePath).toBe(realpathSync(Path.join(destination, 'mainnet-activity-v2.db')));
    const database = new DatabaseSync(restored.indexer.databasePath, { readOnly: true });
    expect(database.prepare('SELECT blockNumber FROM Checkpoint').get()?.blockNumber).toBe(100);
    database.close();

    const verifyPath = fileURLToPath(new URL('../local-mainnet/qualificationInputs.ts', import.meta.url));
    const verified = spawnSync(
      process.execPath,
      ['--import', 'tsx', verifyPath, '--verify-baseline', Path.join(destination, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect(verified.status, verified.stderr).toBe(0);
    writeFileSync(restored.indexer.databasePath, 'damaged baseline');
    const corrupted = spawnSync(
      process.execPath,
      ['--import', 'tsx', verifyPath, '--verify-baseline', Path.join(destination, 'manifest.json')],
      { encoding: 'utf8' },
    );
    expect(corrupted.status).toBe(1);
    expect(corrupted.stderr).toContain('Baseline database checksum mismatch');
  });

  it('retains a failed phase duration and preserves its nonzero process status', () => {
    const directory = mkdtempSync(Path.join(tmpdir(), 'qualification-timing-'));
    directories.push(directory);
    const phasePath = fileURLToPath(new URL('../local-mainnet/runQualificationPhase.sh', import.meta.url));
    const summaryPath = Path.join(directory, 'summary.md');
    const result = spawnSync('bash', [phasePath, 'capture', 'bash', '-c', 'exit 7'], {
      encoding: 'utf8',
      env: { ...process.env, CI_TEMP_DIR: directory, GITHUB_STEP_SUMMARY: summaryPath },
    });
    expect(result.status, result.stderr).toBe(7);
    expect(readFileSync(Path.join(directory, 'phase-timings.tsv'), 'utf8')).toMatch(/^capture\t\d+\t7\n$/);
    expect(readFileSync(summaryPath, 'utf8')).toContain('(exit 7)');
  });
});
