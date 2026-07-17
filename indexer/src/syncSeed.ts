import Fs from 'node:fs';
import Path from 'node:path';
import { getClient } from '@argonprotocol/mainchain';
import { IncompatibleAccountActivityDatabaseError, IndexerDb } from './IndexerDb.ts';
import { AccountActivityIndexer } from './AccountActivityIndexer.ts';

const seeds = [
  { network: 'mainnet', rpc: 'wss://rpc.argon.network', batchRpc: 'https://rpc.argon.network' },
  {
    network: 'testnet',
    rpc: 'wss://rpc.testnet.argonprotocol.org',
    batchRpc: 'https://rpc.testnet.argonprotocol.org',
  },
];
const requestedNetworks = new Set(process.argv.slice(2));
const seedDirectory = Path.join(import.meta.dirname, '../seeds');
const maxSyncMinutes = Number(process.env.SEED_SYNC_MAX_MINUTES ?? 0);
if (!Number.isFinite(maxSyncMinutes) || maxSyncMinutes < 0) {
  throw new Error(`Invalid SEED_SYNC_MAX_MINUTES: ${process.env.SEED_SYNC_MAX_MINUTES}`);
}

for (const seed of seeds.filter(seed => !requestedNetworks.size || requestedNetworks.has(seed.network))) {
  console.log(`Syncing indexer seed for ${seed.network} from RPC: ${seed.rpc}`);
  const client = await getClient(seed.rpc);
  const databasePath = Path.join(seedDirectory, `${seed.network}-activity-v2.db`);
  let db: IndexerDb;
  try {
    db = new IndexerDb(databasePath);
  } catch (error) {
    if (!(error instanceof IncompatibleAccountActivityDatabaseError)) throw error;

    console.warn(`Rebuilding incompatible ${seed.network} account activity seed: ${error.message}`);
    for (const suffix of ['', '-shm', '-wal']) Fs.rmSync(`${databasePath}${suffix}`, { force: true });
    db = new IndexerDb(databasePath);
  }
  const indexer = new AccountActivityIndexer(db, seed.batchRpc);

  try {
    const finalizedHash = await client.rpc.chain.getFinalizedHead();
    const finalizedHeader = await client.rpc.chain.getHeader(finalizedHash);
    const targetBlock = finalizedHeader.number.toNumber();
    const targetBlockHash = finalizedHash.toHex();

    await indexer.start(client);
    await indexer.close({
      drain: true,
      maxDurationMs: maxSyncMinutes ? maxSyncMinutes * 60_000 : undefined,
    });

    if (indexer.coverageGap) {
      throw new Error(`Unable to complete ${seed.network} seed: ${indexer.coverageGap.reason}`);
    }

    const checkpointBlock = db.latestSyncedBlock;
    const checkpointHash = (await client.rpc.chain.getBlockHash(checkpointBlock)).toHex();
    if (checkpointBlock === targetBlock && checkpointHash.toLowerCase() !== targetBlockHash.toLowerCase()) {
      throw new Error(
        `Invalid ${seed.network} seed: target block ${targetBlock} changed from ${targetBlockHash} to ${checkpointHash}`,
      );
    }
    Fs.writeFileSync(
      Path.join(seedDirectory, `.${seed.network}-seed-target.json`),
      `${JSON.stringify({
        blockNumber: checkpointBlock,
        blockHash: checkpointHash,
        targetBlockNumber: targetBlock,
        targetBlockHash,
      })}\n`,
    );

    if (checkpointBlock < targetBlock && !maxSyncMinutes) {
      throw new Error(`Incomplete ${seed.network} seed: indexed ${db.latestSyncedBlock}, expected ${targetBlock}`);
    }

    const result = checkpointBlock >= targetBlock ? 'Completed' : 'Checkpointed';
    console.log(`${result} ${seed.network} seed at block ${checkpointBlock} of ${targetBlock}`);
  } finally {
    db.close();
    await client.disconnect();
  }
}
