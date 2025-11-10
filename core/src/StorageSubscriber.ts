import type { ApiDecoration, ArgonClient } from '@argonprotocol/mainchain';

interface StorageItem {
  key: string;
  handler: (api: ApiDecoration<'promise'>) => Promise<void>;
}

export async function subscribeToFinalizedStorageChanges(
  client: ArgonClient,
  items: StorageItem[],
): Promise<{ unsubscribe: () => void }> {
  const lastHashesByKey: Record<string, string> = {};

  const unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(async header => {
    let clientAt: ApiDecoration<'promise'> | undefined;

    for (const { key, handler } of items) {
      const currentHash = (await client.rpc.state.getStorageHash(key, header.hash)).toHex();
      if (currentHash === lastHashesByKey[key]) continue;
      lastHashesByKey[key] = currentHash;
      clientAt ??= await client.at(header.hash);

      void handler(clientAt).catch(e => console.error(`[StorageSubscriber] Error subscribing to key in finalized`, e));
    }
  });

  return {
    unsubscribe,
  };
}
