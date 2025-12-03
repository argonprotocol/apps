import type { ApiDecoration, ArgonClient } from '@argonprotocol/mainchain';
import { SingleFileQueue } from './utils.js';

interface StorageItem {
  key: string;
  handler: (api: ApiDecoration<'promise'>, blockHash: string) => Promise<void>;
}

export async function subscribeToFinalizedStorageChanges(
  client: ArgonClient,
  items: StorageItem[],
): Promise<{ unsubscribe: () => void }> {
  const lastHashesByKey: Record<string, string> = {};
  let prevFinalizedBlockNumber: number | null = null;
  const queue = new SingleFileQueue();

  const unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(async header => {
    const blockHash = header.hash.toHex();
    const blockNumber = header.number.toNumber();
    const result = queue.add(async () => {
      for (const { key, handler } of items) {
        const newStorageHash = (await client.rpc.state.getStorageHash(key, blockHash)).toHex();
        if (newStorageHash === lastHashesByKey[key]) continue;

        let changedBlockHash = blockHash;
        // find the block where this key was changed
        if (prevFinalizedBlockNumber !== null) {
          let checkBlockNumber = blockNumber - 1;
          while (checkBlockNumber >= prevFinalizedBlockNumber && checkBlockNumber >= 0) {
            const parentBlockHash = await client.rpc.chain.getBlockHash(checkBlockNumber);
            const hashAtBlock = (await client.rpc.state.getStorageHash(key, parentBlockHash)).toHex();
            if (hashAtBlock !== newStorageHash) {
              break;
            }
            changedBlockHash = parentBlockHash.toHex();
            checkBlockNumber--;
          }
        }
        lastHashesByKey[key] = newStorageHash;
        const clientAt = await client.at(changedBlockHash);

        void handler(clientAt, changedBlockHash).catch(e =>
          console.error(`[StorageSubscriber] Error subscribing to key in finalized`, e),
        );
      }
      prevFinalizedBlockNumber = blockNumber;
    });
    await result.promise;
  });

  return {
    unsubscribe,
  };
}
