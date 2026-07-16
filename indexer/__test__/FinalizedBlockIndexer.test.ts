import { expect, it, vi } from 'vitest';
import type { ArgonClient } from '@argonprotocol/mainchain';
import { BlockWatch } from '@argonprotocol/apps-core';
import { FinalizedBlockIndexer } from '../src/FinalizedBlockIndexer.ts';
import type { LegacyIndexerDb } from '../src/LegacyIndexerDb.ts';

it('subscribes without waiting for the legacy backlog to finish', async () => {
  let releaseBacklog!: () => void;
  const backlog = new Promise<void>(resolve => {
    releaseBacklog = resolve;
  });
  const recordFinalizedBlock = vi.fn();
  const unsubscribeVaults = vi.fn();
  const unsubscribeHeads = vi.fn();
  const getBlockHash = vi.fn(async (blockNumber?: number) => {
    if (blockNumber === 1) await backlog;
    return { toHex: () => `0x0${blockNumber ?? 0}` };
  });
  const client = {
    query: {
      system: { events: { at: vi.fn(async () => []) } },
      vaults: {
        nextVaultId: vi.fn(async () => unsubscribeVaults),
        vaultIdByOperator: { entries: vi.fn(async () => []) },
      },
    },
    rpc: {
      chain: {
        getBlockHash,
        getFinalizedHead: vi.fn(async () => '0x01'),
        getHeader: vi.fn(async () => ({})),
        subscribeFinalizedHeads: vi.fn(async () => unsubscribeHeads),
      },
    },
  } as unknown as ArgonClient;
  const db = { latestSyncedBlock: 0, recordFinalizedBlock } as unknown as LegacyIndexerDb;
  const readHeader = vi.spyOn(BlockWatch, 'readHeader').mockReturnValue({ blockNumber: 1 } as any);
  const indexer = new FinalizedBlockIndexer(db);

  await indexer.start(client);

  expect(client.rpc.chain.subscribeFinalizedHeads).toHaveBeenCalledOnce();
  expect(recordFinalizedBlock).not.toHaveBeenCalled();

  releaseBacklog();
  await indexer.close();

  expect(recordFinalizedBlock).toHaveBeenCalledOnce();
  expect(unsubscribeVaults).toHaveBeenCalledOnce();
  expect(unsubscribeHeads).toHaveBeenCalledOnce();
  readHeader.mockRestore();
});
