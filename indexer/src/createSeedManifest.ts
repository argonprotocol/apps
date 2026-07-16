import Fs from 'node:fs';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compressSeeds } from './seedArtifacts.ts';

const seedDirectory = Path.join(import.meta.dirname, '../seeds');
const networks = ['mainnet', 'testnet'] as const;
const manifest = {
  formatVersion: 1,
  seeds: {} as Record<
    (typeof networks)[number],
    {
      file: string;
      sizeBytes: number;
      databaseSizeBytes: number;
      blockNumber: number;
      blockHash: string;
      definitionVersion: number;
      schemaVersion: number;
      blockCount: number;
      accountBlockCount: number;
      caughtUp: boolean;
      targetBlockNumber: number;
      targetBlockHash: string;
    }
  >,
};

for (const network of networks) {
  const databaseFile = `${network}-activity-v2.db`;
  const compressedFile = `${databaseFile}.gz`;
  const databasePath = Path.join(seedDirectory, databaseFile);
  const walPath = `${databasePath}-wal`;
  if (!Fs.existsSync(databasePath)) throw new Error(`Missing ${databasePath}`);

  const writableDatabase = new DatabaseSync(databasePath, { open: true });
  try {
    const checkpoint = writableDatabase.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    if (checkpoint.busy) throw new Error(`${databaseFile} WAL checkpoint is busy`);
  } finally {
    writableDatabase.close();
  }
  if (Fs.existsSync(walPath) && Fs.statSync(walPath).size > 0) {
    throw new Error(`${databaseFile} has an uncheckpointed WAL after TRUNCATE checkpoint`);
  }

  const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (quickCheck.quick_check !== 'ok')
      throw new Error(`${databaseFile} failed SQLite quick_check: ${quickCheck.quick_check}`);

    const sync = database
      .prepare(`SELECT blockNumber, definitionVersion FROM SyncState WHERE id = 'accountActivity'`)
      .get() as { blockNumber: number; definitionVersion: number } | undefined;
    if (!sync) throw new Error(`${databaseFile} has no account activity checkpoint`);

    const targetPath = Path.join(seedDirectory, `.${network}-seed-target.json`);
    if (!Fs.existsSync(targetPath)) throw new Error(`Missing seed checkpoint state for ${network}`);
    const seedState = JSON.parse(Fs.readFileSync(targetPath, 'utf8')) as {
      blockNumber: number;
      blockHash: string;
      targetBlockNumber?: number;
      targetBlockHash?: string;
    };
    if (sync.blockNumber !== seedState.blockNumber) {
      throw new Error(
        `${databaseFile} checkpoint ${sync.blockNumber} does not match captured seed checkpoint ${seedState.blockNumber}`,
      );
    }
    const targetBlockNumber = seedState.targetBlockNumber ?? seedState.blockNumber;
    const targetBlockHash = seedState.targetBlockHash ?? seedState.blockHash;
    if (
      seedState.blockNumber === targetBlockNumber &&
      seedState.blockHash.toLowerCase() !== targetBlockHash.toLowerCase()
    ) {
      throw new Error(`${databaseFile} caught-up checkpoint does not match its captured finalized target hash`);
    }

    const schema = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM SchemaVersion').get() as {
      version: number;
    };
    const blocks = database
      .prepare('SELECT COUNT(*) AS count, MIN(blockNumber) AS first, MAX(blockNumber) AS last FROM Blocks')
      .get() as { count: number; first: number; last: number };
    if (blocks.first !== 1 || blocks.last !== sync.blockNumber || blocks.count !== sync.blockNumber) {
      throw new Error(
        `${databaseFile} block coverage is not contiguous: count ${blocks.count}, range ${blocks.first}-${blocks.last}, checkpoint ${sync.blockNumber}`,
      );
    }

    const checkpointBlock = database
      .prepare('SELECT blockHash FROM Blocks WHERE blockNumber = ?')
      .get(sync.blockNumber) as { blockHash: Uint8Array } | undefined;
    const checkpointHash = checkpointBlock ? `0x${Buffer.from(checkpointBlock.blockHash).toString('hex')}` : undefined;
    if (checkpointHash?.toLowerCase() !== seedState.blockHash.toLowerCase()) {
      throw new Error(
        `${databaseFile} checkpoint hash ${checkpointHash ?? 'missing'} does not match captured seed hash ${seedState.blockHash}`,
      );
    }

    const accountBlocks = database.prepare('SELECT COUNT(*) AS count FROM AccountBlocks').get() as { count: number };
    manifest.seeds[network] = {
      file: compressedFile,
      sizeBytes: 0,
      databaseSizeBytes: Fs.statSync(databasePath).size,
      blockNumber: sync.blockNumber,
      blockHash: checkpointHash,
      definitionVersion: sync.definitionVersion,
      schemaVersion: schema.version,
      blockCount: blocks.count,
      accountBlockCount: accountBlocks.count,
      caughtUp: seedState.blockNumber === targetBlockNumber,
      targetBlockNumber,
      targetBlockHash,
    };
  } finally {
    database.close();
  }
}

await compressSeeds(seedDirectory);
for (const network of networks) {
  const seed = manifest.seeds[network];
  seed.sizeBytes = Fs.statSync(Path.join(seedDirectory, seed.file)).size;
}
Fs.writeFileSync(Path.join(seedDirectory, 'seed-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const network of networks) {
  const seed = manifest.seeds[network];
  console.log(`${network}: block ${seed.blockNumber}, ${seed.accountBlockCount} account rows`);
}
