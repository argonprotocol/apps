import { GlobalMiningStats as CoreGlobalMiningStats, type Mining, type Currency } from '@argonprotocol/apps-core';
import { FinancialCacheTypes, type FinancialCacheTable } from './db/FinancialCacheTable.ts';

const MINING_FRAME_DEFINITION_VERSION = 2;

export class GlobalMiningStats extends CoreGlobalMiningStats {
  private restorePromise?: Promise<void>;

  constructor(
    mining: Mining,
    currency: Currency,
    private readonly cache: Promise<FinancialCacheTable>,
  ) {
    super(mining, currency);
  }

  protected override async loadFrameEstimates(): Promise<void> {
    if (this.restorePromise) return this.restorePromise;

    this.restorePromise = (async () => {
      const client = await this.mining.prunedClientOrArchivePromise;
      const cache = await this.cache;
      const stored = await cache.get(FinancialCacheTypes.GlobalMiningStats, client.genesisHash.toHex());
      if (!stored || stored.definitionVersion !== MINING_FRAME_DEFINITION_VERSION) return;

      const anchor = stored.frames.at(-1);
      if (anchor) {
        const blockHash = await client.rpc.chain.getBlockHash(anchor.blockNumber);
        if (blockHash.toHex() !== anchor.blockHash) return;
      }
      for (const frame of stored.frames) this.frameEstimates.set(frame.frameId, frame);
    })().catch(error => {
      this.restorePromise = undefined;
      console.warn('[GlobalMiningStats] Unable to restore cached frame statistics', error);
    });
    return this.restorePromise;
  }

  protected override async saveFrameEstimates(): Promise<boolean> {
    const frames = [...this.frameEstimates.values()].sort((a, b) => a.frameId - b.frameId);
    if (!frames.length) return true;

    try {
      const client = await this.mining.prunedClientOrArchivePromise;
      const cache = await this.cache;
      await cache.upsert(FinancialCacheTypes.GlobalMiningStats, client.genesisHash.toHex(), {
        definitionVersion: MINING_FRAME_DEFINITION_VERSION,
        frames,
      });
      return true;
    } catch (error) {
      console.warn('[GlobalMiningStats] Unable to save cached frame statistics; retaining loaded history', error);
      return false;
    }
  }
}
