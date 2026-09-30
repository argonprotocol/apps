import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, createWriteStream, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';
import { BuildBlockMode, destroyWorker, setupWithServer } from '@acala-network/chopsticks';
import { getClient } from '@argonprotocol/mainchain';
import { u8aToHex } from '@polkadot/util';
import { AccountActivityIndexer } from '../../indexer/src/AccountActivityIndexer.ts';
import { IndexerDb } from '../../indexer/src/IndexerDb.ts';
import type { LocalMainnetManifest } from './manifest.ts';

// Produce the same pinned inputs used by capture and review. A published indexer
// seed only accelerates replay; no account database or private package is needed.
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    seed: { type: 'string' },
    archive: { type: 'string', default: 'wss://rpc.argon.network' },
    block: { type: 'string' },
  },
  strict: true,
});
if (!values.output) {
  throw new Error(
    'Usage: yarn local-mainnet:prepare --output <new-directory> [--seed <indexer.db.gz>] [--block <finalized-hash>]',
  );
}
const outputDirectory = Path.resolve(values.output);
mkdirSync(outputDirectory, { recursive: false });
const databasePath = Path.join(outputDirectory, 'mainnet-activity-v2.db');
const chopsticksDatabasePath = Path.join(outputDirectory, 'chopsticks.sqlite');
if (values.seed) {
  await pipeline(createReadStream(values.seed), createGunzip(), createWriteStream(databasePath, { flags: 'wx' }));
}

const client = await getClient(values.archive);
let database: IndexerDb | undefined;
let fork: Awaited<ReturnType<typeof setupWithServer>> | undefined;
let forkClient: Awaited<ReturnType<typeof getClient>> | undefined;
let indexer: AccountActivityIndexer | undefined;
let manifest: LocalMainnetManifest;
try {
  database = new IndexerDb(databasePath);
  const finalizedHash = await client.rpc.chain.getFinalizedHead();
  const finalizedHeader = await client.rpc.chain.getHeader(finalizedHash);
  const finalizedNumber = finalizedHeader.number.toNumber();
  const startingHeader = values.block ? await client.rpc.chain.getHeader(values.block) : finalizedHeader;
  const startingNumber = startingHeader.number.toNumber();
  const startingSpecVersion = (await client.rpc.state.getRuntimeVersion(startingHeader.hash)).specVersion.toNumber();
  const canonicalHash = await client.rpc.chain.getBlockHash(startingNumber);
  if (startingNumber > finalizedNumber || canonicalHash.toHex() !== startingHeader.hash.toHex()) {
    throw new Error('Requested preparation block is not on the canonical finalized chain');
  }
  if (database.latestSyncedBlock > startingNumber) {
    const message = `Indexer checkpoint ${database.latestSyncedBlock} is newer than pinned block ${startingNumber}; replaying from genesis.\n`;
    console.info(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
    // The downloaded seed is a cache. Preserve this run's copy and rebuild
    // rather than carry ownership projections from beyond the historical fork.
    database.close();
    renameSync(databasePath, Path.join(outputDirectory, 'newer-published-checkpoint.db'));
    database = new IndexerDb(databasePath);
  }
  let blockHash: string | undefined;
  let blockNumber: number | undefined;
  let runtimeSpecVersion: number | undefined;
  // ArgonInherents replays a no-op Bitcoin sync. Select a recent finalized
  // block that satisfies that precondition without rolling back the seed.
  for (let number = startingNumber; number >= Math.max(database.latestSyncedBlock, startingNumber - 100); number -= 1) {
    const hash = await client.rpc.chain.getBlockHash(number);
    const signedBlock = await client.rpc.chain.getBlock(hash);
    const sync = signedBlock.block.extrinsics.find(
      extrinsic => extrinsic.method.section === 'bitcoinUtxos' && extrinsic.method.method === 'sync',
    );
    if (!sync) continue;
    const bitcoinSync = sync.method.args[0].toJSON() as { funded?: unknown[]; spent?: unknown[] };
    if (bitcoinSync.funded?.length || bitcoinSync.spent?.length) continue;
    const candidateSpecVersion = (await client.rpc.state.getRuntimeVersion(hash)).specVersion.toNumber();
    if (candidateSpecVersion !== startingSpecVersion) continue;
    blockHash = hash.toHex();
    blockNumber = number;
    runtimeSpecVersion = candidateSpecVersion;
    break;
  }
  if (!blockHash || blockNumber === undefined || runtimeSpecVersion === undefined) {
    throw new Error('No recent finalized block with the current runtime and a no-op Bitcoin sync is available');
  }

  fork = await setupWithServer({
    endpoint: values.archive,
    block: blockHash,
    db: chopsticksDatabasePath,
    port: 0,
    host: '127.0.0.1',
    'build-block-mode': BuildBlockMode.Manual,
    'mock-signature-host': true,
    'save-blocks': true,
  });
  await fork.chain.head.wasm;
  if (fork.chain.head.hash !== blockHash || fork.chain.head.number !== blockNumber) {
    throw new Error('Prepared Chopsticks head differs from the selected finalized block');
  }
  if (database.latestSyncedBlock > 0) {
    // Check the seed's canonical checkpoint before advancing it on this fork.
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const checkpoint = inspection
        .prepare('SELECT blockHash FROM Blocks WHERE blockNumber = ?')
        .get(database.latestSyncedBlock);
      const canonicalHash = await client.rpc.chain.getBlockHash(database.latestSyncedBlock);
      if (!checkpoint || u8aToHex(checkpoint.blockHash as Uint8Array) !== canonicalHash.toHex()) {
        throw new Error('Published indexer seed checkpoint differs from the canonical finalized chain');
      }
    } finally {
      inspection.close();
    }
  }
  forkClient = await getClient(`ws://${fork.addr}`);
  const batchRpc = new URL(values.archive);
  batchRpc.protocol =
    batchRpc.protocol === 'wss:' ? 'https:' : batchRpc.protocol === 'ws:' ? 'http:' : batchRpc.protocol;
  indexer = new AccountActivityIndexer(database, batchRpc.toString());
  const target = await indexer.start(forkClient, { subscribe: false });
  if (target.blockNumber !== blockNumber || target.blockHash !== blockHash) {
    throw new Error('Indexer replay target differs from the pinned Chopsticks block');
  }
  await indexer.close({ drain: true, maxDurationMs: 285 * 60_000 });
  if (indexer.coverageGap || database.latestSyncedBlock !== blockNumber) {
    throw new Error(
      `Indexer did not reach the pinned block ${blockNumber}: ${indexer.coverageGap?.reason ?? database.latestSyncedBlock}`,
    );
  }
  manifest = {
    formatVersion: 1,
    network: 'mainnet',
    archive: {
      url: values.archive,
      blockNumber,
      blockHash,
      deployedSpecVersion: runtimeSpecVersion,
      chopsticksDatabasePath: Path.basename(chopsticksDatabasePath),
      sha256: '',
    },
    indexer: { databasePath: Path.basename(databasePath), blockNumber, blockHash, sha256: '' },
  };
} finally {
  await indexer?.close();
  database?.close();
  await forkClient?.disconnect();
  await fork?.close();
  await client.disconnect();
  await destroyWorker();
}

// Publish the manifest only after both databases have closed and checkpointed.
const inspection = new DatabaseSync(databasePath);
try {
  inspection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  if (inspection.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
    throw new Error('Prepared indexer database failed SQLite integrity verification');
  }
} finally {
  inspection.close();
}
for (const [path, input] of [
  [chopsticksDatabasePath, manifest.archive],
  [databasePath, manifest.indexer],
] as const) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  input.sha256 = hash.digest('hex');
}
writeFileSync(Path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.info(
  `Prepared local mainnet at finalized block ${manifest.archive.blockNumber} (${manifest.archive.blockHash})`,
);
