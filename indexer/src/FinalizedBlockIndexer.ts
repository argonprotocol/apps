import { type IndexerDb, WalletTransferCurrency, WalletTransferSource } from './IndexerDb.js';
import Queue from 'p-queue';
import { AccountEventsFilter, BlockWatch, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import type { ArgonClient } from '@argonprotocol/mainchain';

export class FinalizedBlockIndexer {
  private vaultOwners = new Map<number, string>();
  private processingQueue = new Queue({ concurrency: 25 });
  private unsubscribes: (() => void)[] = [];
  private latestFinalizedHeader: IBlockHeaderInfo | null = null;
  private syncInProgress?: Promise<void>;

  constructor(private readonly db: IndexerDb) {}

  public async start(client: ArgonClient) {
    const unsub1 = await client.query.vaults.nextVaultId(async () => {
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
    await this.syncInProgress;
    const unsub2 = await client.rpc.chain.subscribeFinalizedHeads(header => {
      this.latestFinalizedHeader = BlockWatch.readHeader(header, true);
      // only queue if there's not already a task queued that will grab latest
      this.syncInProgress ??= this.syncLatestHeaders(client);
    });
    this.unsubscribes.push(unsub1, unsub2);
  }

  public async close() {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
    await this.syncInProgress;
    await this.processingQueue.onIdle();
  }

  private async syncLatestHeaders(client: ArgonClient) {
    const lastSynchedNumber = this.db.latestSyncedBlock + 1;
    const latestBlockNumber = this.latestFinalizedHeader!.blockNumber;
    const blockChunks: number[][] = [];
    let latestChunk: number[] = [];
    blockChunks.push(latestChunk);
    for (let i = lastSynchedNumber; i <= latestBlockNumber; i++) {
      latestChunk.push(i);
      if (latestChunk.length >= 25) {
        latestChunk = [];
        blockChunks.push(latestChunk);
      }
    }
    if (blockChunks.length === 0) {
      return;
    }
    for (const chunk of blockChunks) {
      console.log(`Syncing finalized blocks ${chunk[0]} to ${chunk.at(-1)}...`);
      const blockDatasPromise = chunk.map(async i => {
        const currentHash = await client.rpc.chain.getBlockHash(i);
        const events = await client.query.system.events.at(currentHash);
        const groupedEvents = AccountEventsFilter.groupEventsByExtrinsic(events);
        const blockData = { blockNumber: i, transfers: [], vaultCollects: [] } as Parameters<
          IndexerDb['recordFinalizedBlock']
        >[0];
        for (const { extrinsicEvents, extrinsicIndex } of groupedEvents) {
          for (const event of extrinsicEvents) {
            const transfer = AccountEventsFilter.isTransfer({
              extrinsicIndex,
              extrinsicEvents,
              client,
              event,
            });
            if (transfer) {
              blockData.transfers.push({
                currency: { argonot: WalletTransferCurrency.Argonot, argon: WalletTransferCurrency.Argon }[
                  transfer.currency
                ],
                source: {
                  transfer: WalletTransferSource.Transfer,
                  tokenGateway: WalletTransferSource.TokenGateway,
                  faucet: WalletTransferSource.Faucet,
                }[transfer.transferType],
                toAddress: transfer.to,
                fromAddress: transfer.from ?? null,
              });
            }
            if (client.events.vaults.VaultCollected.is(event)) {
              const [vaultId, _amount] = event.data;
              const owner = this.vaultOwners.get(vaultId.toNumber()) ?? 'unknown';
              blockData.vaultCollects.push({
                vaultAddress: owner,
              });
            }
          }
        }
        return blockData;
      });

      const blockDatas = await Promise.all(blockDatasPromise);
      for (const blockData of blockDatas) {
        this.db.recordFinalizedBlock(blockData);
      }
    }
    this.syncInProgress = undefined;
    console.log('Finished syncing finalized blocks to ', latestBlockNumber);
  }
}
