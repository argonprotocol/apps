import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { compressSeeds, extractSeed, extractSeeds } from '../src/seedArtifacts.ts';

describe('seed artifacts', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) Fs.rmSync(directory, { force: true, recursive: true });
  });

  it('round trips both seed databases through gzip artifacts', async () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'indexer-seeds-'));
    directories.push(directory);
    const expected = {
      mainnet: Buffer.from('mainnet seed\n'.repeat(100)),
      testnet: Buffer.from('testnet seed\n'.repeat(100)),
    };
    for (const [network, contents] of Object.entries(expected)) {
      Fs.writeFileSync(Path.join(directory, `${network}-activity-v2.db`), contents);
    }

    await compressSeeds(directory);
    for (const network of Object.keys(expected)) Fs.rmSync(Path.join(directory, `${network}-activity-v2.db`));
    await extractSeeds(directory);

    for (const [network, contents] of Object.entries(expected)) {
      expect(Fs.readFileSync(Path.join(directory, `${network}-activity-v2.db`))).toEqual(contents);
      expect(Fs.existsSync(Path.join(directory, `${network}-activity-v2.db.tmp`))).toBe(false);
    }
  });

  it('keeps an existing database when extraction fails', async () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'indexer-seeds-'));
    directories.push(directory);
    const compressedPath = Path.join(directory, 'seed.db.gz');
    const databasePath = Path.join(directory, 'seed.db');
    Fs.writeFileSync(compressedPath, 'not gzip data');
    Fs.writeFileSync(databasePath, 'existing database');

    await expect(extractSeed(compressedPath, databasePath)).rejects.toThrow();

    expect(Fs.readFileSync(databasePath, 'utf8')).toBe('existing database');
    expect(Fs.existsSync(`${databasePath}.tmp`)).toBe(false);
  });

  it('replaces an existing database after successful extraction', async () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'indexer-seeds-'));
    directories.push(directory);
    const compressedPath = Path.join(directory, 'seed.db.gz');
    const databasePath = Path.join(directory, 'seed.db');
    Fs.writeFileSync(compressedPath, gzipSync('updated database'));
    Fs.writeFileSync(databasePath, 'existing database');

    await extractSeed(compressedPath, databasePath);

    expect(Fs.readFileSync(databasePath, 'utf8')).toBe('updated database');
    expect(Fs.existsSync(`${databasePath}.tmp`)).toBe(false);
  });
});
