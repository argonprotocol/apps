import type { ArgonClient } from '@argonprotocol/mainchain';
import { BlockWatch, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import type { LegacyIndexerDb } from './LegacyIndexerDb.js';
import { decodeWalletTransfer, groupEventsByExtrinsic } from './WalletTransferEvents.js';

export class FinalizedBlockIndexer {
  private readonly vaultOwners = new Map<number, string>();
  private readonly unsubscribes: (() => void)[] = [];
  private latestFinalizedHeader: IBlockHeaderInfo | null = null;
  private syncInProgress?: Promise<void>;
  private isClosed = false;

  constructor(private readonly db: LegacyIndexerDb) {}

  public async start(client: ArgonClient): Promise<void> {
    this.isClosed = false;
    const unsubscribeVaults = await client.query.vaults.nextVaultId(async () => {
      const operators = await client.query.vaults.vaultIdByOperator.entries();
      for (const [key, vaultId] of operators) {
        const operator = key.args[0].toString();
        this.vaultOwners.set(vaultId.unwrap().toNumber(), operator);
      }
    });
    const finalized = await client.rpc.chain.getFinalizedHead();
    const finalizedHeader = await client.rpc.chain.getHeader(finalized);
    this.latestFinalizedHeader = BlockWatch.readHeader(finalizedHeader, true);
    this.syncInProgress = this.syncLatestHeaders(client);

    const unsubscribeFinalized = await client.rpc.chain.subscribeFinalizedHeads(header => {
      this.latestFinalizedHeader = BlockWatch.readHeader(header, true);
      this.syncInProgress ??= this.syncLatestHeaders(client);
    });
    this.unsubscribes.push(unsubscribeVaults, unsubscribeFinalized);
  }

  public async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.isClosed = true;
    await this.syncInProgress;
  }

  private async syncLatestHeaders(client: ArgonClient): Promise<void> {
    let shouldContinue = false;

    try {
      const firstBlock = this.db.latestSyncedBlock + 1;
      const latestBlock = this.latestFinalizedHeader!.blockNumber;

      for (let chunkStart = firstBlock; !this.isClosed && chunkStart <= latestBlock; chunkStart += 100) {
        const chunkEnd = Math.min(chunkStart + 99, latestBlock);
        console.log(`Syncing finalized blocks ${chunkStart} to ${chunkEnd}...`);
        const blocks = await Promise.all(
          Array.from({ length: chunkEnd - chunkStart + 1 }, (_, offset) =>
            this.decodeBlock(client, chunkStart + offset),
          ),
        );
        for (const block of blocks) this.db.recordFinalizedBlock(block);
      }
      shouldContinue = this.db.latestSyncedBlock < this.latestFinalizedHeader!.blockNumber;
    } catch (error) {
      console.error('Error syncing blocks', error);
    } finally {
      await new Promise(setImmediate);
      this.syncInProgress = undefined;
      if (!this.isClosed && shouldContinue) this.syncInProgress = this.syncLatestHeaders(client);
    }
  }

  private async decodeBlock(
    client: ArgonClient,
    blockNumber: number,
  ): Promise<Parameters<LegacyIndexerDb['recordFinalizedBlock']>[0]> {
    const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
    const events = await client.query.system.events.at(blockHash);
    const block = {
      blockNumber,
      transfers: [],
      vaultCollects: [],
    } as Parameters<LegacyIndexerDb['recordFinalizedBlock']>[0];

    for (const { extrinsicEvents, extrinsicIndex } of groupEventsByExtrinsic(events)) {
      for (const event of extrinsicEvents) {
        const transfer = decodeWalletTransfer({
          extrinsicIndex,
          extrinsicEvents,
          client,
          event,
        });
        if (transfer) block.transfers.push(transfer);

        if (client.events.vaults.VaultCollected.is(event)) {
          const [vaultId] = event.data;
          block.vaultCollects.push({
            vaultAddress: this.vaultOwners.get(vaultId.toNumber()) ?? 'unknown',
          });
        }
      }
    }

    return block;
  }
}
