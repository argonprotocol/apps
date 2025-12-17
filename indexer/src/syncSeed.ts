import { FinalizedBlockIndexer } from './FinalizedBlockIndexer.ts';
import { getClient } from '@argonprotocol/mainchain';
import { IndexerDb } from './IndexerDb.ts';
import Path from 'path';

const seeds = [
  { network: 'mainnet', rpc: 'wss://rpc.argon.network' },
  { network: 'testnet', rpc: 'wss://rpc.testnet.argonprotocol.org' },
];

for (const seed of seeds) {
  console.log(`Syncing seed for ${seed.network} from RPC: ${seed.rpc}`);
  const client = await getClient(seed.rpc);
  const db = new IndexerDb(Path.join(import.meta.dirname, `../seeds/${seed.network}.db`));
  const indexer = new FinalizedBlockIndexer(db);
  await indexer.start(client);
  await indexer.close();
  db.close();
  await client.disconnect();
}
