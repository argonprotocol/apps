import type { ArgonClient, FrameSystemEventRecord } from '@argonprotocol/mainchain';
import { BlockWatch, getRange, groupEventsByExtrinsic, type IBlockHeaderInfo } from '@argonprotocol/apps-core';
import type { ApiDecoration } from '@polkadot/api/types';
import type { Bytes, Vec } from '@polkadot/types-codec';
import { hexToU8a } from '@polkadot/util';
import { AccountActivityDecoder, isGatewayOperationSourceEvent } from './AccountActivity.js';
import type { IAccountActivityBlock, IndexerDb } from './IndexerDb.js';
import { AccountActivityCoverageError } from './HistoricalEventSpecs.js';

export class AccountActivityIndexer {
  public coverageGap?: { fromBlock: number; toBlock: number; reason: string };

  private readonly decoder = new AccountActivityDecoder();
  private unsubscribe?: () => void;
  private latestFinalizedHeader: IBlockHeaderInfo | null = null;
  private syncInProgress?: Promise<void>;
  private isClosed = false;

  constructor(
    private readonly db: IndexerDb,
    private readonly batchRpcUrl?: string,
  ) {}

  public async start(client: ArgonClient, options: { subscribe?: boolean } = {}): Promise<IBlockHeaderInfo> {
    this.isClosed = false;
    const finalized = await client.rpc.chain.getFinalizedHead();
    const finalizedHeader = await client.rpc.chain.getHeader(finalized);
    const startingHeader = BlockWatch.readHeader(finalizedHeader, true);
    this.latestFinalizedHeader = startingHeader;
    this.queueSync(client);

    if (options.subscribe === false) return startingHeader;
    this.unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(header => {
      this.latestFinalizedHeader = BlockWatch.readHeader(header, true);
      if (this.coverageGap) this.coverageGap.toBlock = this.latestFinalizedHeader.blockNumber;
      this.queueSync(client);
    });
    return startingHeader;
  }

  public async close(options: { drain?: boolean; maxDurationMs?: number } = {}): Promise<void> {
    this.unsubscribe?.();
    if (!options.drain) this.isClosed = true;

    const stopTimer = options.maxDurationMs
      ? setTimeout(() => {
          this.isClosed = true;
        }, options.maxDurationMs)
      : undefined;
    try {
      // Transient failures replace syncInProgress with a retry. Keep draining
      // those retries until the target is reached or the bounded run expires.
      while (this.syncInProgress) {
        await this.syncInProgress;
      }
    } finally {
      if (stopTimer) clearTimeout(stopTimer);
      this.isClosed = true;
    }
  }

  private async syncLatestHeaders(client: ArgonClient): Promise<void> {
    let retryDelayMs = 0;

    try {
      const firstBlock = this.db.latestSyncedBlock + 1;
      const latestBlock = this.latestFinalizedHeader!.blockNumber;
      if (firstBlock > latestBlock) return;

      let nextBlock = firstBlock;
      // ApiPromise.at decorates an upgrade block with the runtime that emitted
      // that block's events, even though its resulting state has the new spec.
      let api = await client.at(await client.rpc.chain.getBlockHash(firstBlock));

      while (!this.isClosed && nextBlock <= latestBlock) {
        const chunkSize = this.batchRpcUrl ? 5_000 : 100;
        const chunkEnd = Math.min(nextBlock + chunkSize - 1, latestBlock);
        const { blocks, runtimeMetadata, runtimeUpgraded } = await this.decodeBlocks(client, api, nextBlock, chunkEnd);
        console.log(`Syncing account activity blocks ${nextBlock} to ${blocks.at(-1)!.blockNumber}...`);
        if (runtimeMetadata) {
          this.db.recordRuntimeMetadata({
            specVersion: blocks[0].specVersion,
            blockHash: blocks[0].blockHash,
            metadata: runtimeMetadata,
          });
        }
        this.db.recordBlocks(blocks);

        nextBlock = blocks.at(-1)!.blockNumber + 1;
        if (runtimeUpgraded && nextBlock <= latestBlock) {
          api = await client.at(await client.rpc.chain.getBlockHash(nextBlock));
        }
      }
    } catch (error) {
      if (error instanceof AccountActivityCoverageError) {
        // Coverage is contiguous: advancing the checkpoint here would make every
        // response after this block look trustworthy even though activity may be
        // missing. A process restart retries this block after decoder/spec updates.
        this.coverageGap = {
          fromBlock: this.db.latestSyncedBlock + 1,
          toBlock: this.latestFinalizedHeader!.blockNumber,
          reason: error.message,
        };
        console.error('Account activity coverage gap', this.coverageGap);
      } else {
        console.error('Error syncing account activity blocks', error);
        retryDelayMs = 1_000;
      }
    } finally {
      if (retryDelayMs) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      this.syncInProgress = undefined;
      if (!this.isClosed && !this.coverageGap && this.db.latestSyncedBlock < this.latestFinalizedHeader!.blockNumber) {
        this.queueSync(client);
      }
    }
  }

  private queueSync(client: ArgonClient): void {
    if (this.isClosed || this.coverageGap || this.syncInProgress) return;

    // Assign the pending promise before syncLatestHeaders can take its synchronous
    // no-work path. Otherwise a genesis startup leaves the resolved promise set
    // and later finalized-head notifications cannot start the first real sync.
    this.syncInProgress = Promise.resolve().then(() => this.syncLatestHeaders(client));
  }

  private async decodeBlocks(
    client: ArgonClient,
    api: ApiDecoration<'promise'>,
    firstBlock: number,
    lastBlock: number,
  ): Promise<{ blocks: IAccountActivityBlock[]; runtimeMetadata?: Uint8Array; runtimeUpgraded: boolean }> {
    const blockNumbers = getRange(firstBlock, lastBlock + 1);
    // Proxy and batch context comes from emitted events. Replay never needs the
    // signed block or its extrinsic call bodies.
    const eventsKey = client.query.system.events.key();
    let blockHashes: string[];

    if (this.batchRpcUrl) {
      // Preserve the prior 2,000-call concurrency envelope with smaller batches.
      blockHashes = await this.batchRpc<string>(
        blockNumbers.map(blockNumber => ({ method: 'chain_getBlockHash', params: [blockNumber] })),
        40,
      );
    } else {
      const blockHashCodecs = await Promise.all(
        blockNumbers.map(blockNumber => client.rpc.chain.getBlockHash(blockNumber)),
      );
      blockHashes = blockHashCodecs.map(blockHash => blockHash.toHex());
    }

    const specVersion = api.runtimeVersion.specVersion.toNumber();
    const runtimeUpgradeIndex = await this.findRuntimeUpgradeIndex(client, blockHashes, specVersion);

    // The upgrade block's state reports the new spec, but its events were emitted
    // by the previous runtime. Switch registries on the following block.
    const blockCount = runtimeUpgradeIndex === -1 ? blockNumbers.length : runtimeUpgradeIndex + 1;
    const decodedBlockHashes = blockHashes.slice(0, blockCount);
    let rawEventsByBlock: (string | null)[];
    if (this.batchRpcUrl) {
      // Event payloads are larger, so keep the prior 1,000-call envelope lower.
      rawEventsByBlock = await this.batchRpc<string | null>(
        decodedBlockHashes.map(blockHash => ({ method: 'state_getStorage', params: [eventsKey, blockHash] })),
        20,
      );
    } else {
      const rawEventCodecs = await Promise.all(
        decodedBlockHashes.map(blockHash => client.rpc.state.getStorage<Bytes>(eventsKey, blockHash)),
      );
      rawEventsByBlock = rawEventCodecs.map(rawEvents => rawEvents?.toHex() ?? null);
    }

    const eventsByBlock = rawEventsByBlock.map(rawEvents => {
      return api.registry.createType<Vec<FrameSystemEventRecord>>('Vec<FrameSystemEventRecord>', rawEvents ?? '0x00');
    });
    const runtimeMetadata = this.db.hasRuntimeMetadata(specVersion)
      ? undefined
      : (await client.getBlockRegistry(hexToU8a(decodedBlockHashes[0]))).metadata.toU8a();
    const sourceAccountsByBlock = await Promise.all(
      eventsByBlock.map(async (events, index) => {
        if (!events.some(({ event }) => isGatewayOperationSourceEvent(event))) return;

        const signedBlock = await client.rpc.chain.getBlock(blockHashes[index]);
        return signedBlock.block.extrinsics.map(extrinsic =>
          extrinsic.isSigned ? extrinsic.signer.toString() : undefined,
        );
      }),
    );
    const blocks = blockNumbers.slice(0, blockCount).map((blockNumber, index) => {
      const eventGroups = groupEventsByExtrinsic(eventsByBlock[index]).map(group => {
        if (group.extrinsicIndex === undefined) return group;

        const sourceAccount = sourceAccountsByBlock[index]?.[group.extrinsicIndex];
        return sourceAccount ? { ...group, sourceAccount } : group;
      });
      const activity = this.decoder.decode({
        eventGroups,
        specVersion,
      });
      return {
        blockNumber,
        blockHash: hexToU8a(blockHashes[index]),
        specVersion,
        systemEvents: hexToU8a(rawEventsByBlock[index] ?? '0x00'),
        accounts: activity.accounts,
        vaults: activity.vaults,
        vaultOwners: activity.vaultOwners,
        bitcoinLocks: activity.bitcoinLocks,
        bitcoinLockOwners: activity.bitcoinLockOwners,
        mintingAuthorities: activity.mintingAuthorities,
        mintingAuthorityOwners: activity.mintingAuthorityOwners,
      };
    });

    return { blocks, runtimeMetadata, runtimeUpgraded: runtimeUpgradeIndex !== -1 };
  }

  private async findRuntimeUpgradeIndex(
    client: ArgonClient,
    blockHashes: string[],
    specVersion: number,
  ): Promise<number> {
    const readSpecVersion = async (index: number): Promise<number> => {
      const runtimeVersion = await client.rpc.state.getRuntimeVersion(blockHashes[index]);
      return runtimeVersion.specVersion.toNumber();
    };

    if ((await readSpecVersion(blockHashes.length - 1)) === specVersion) return -1;

    let matchingIndex = -1;
    let mismatchingIndex = blockHashes.length - 1;
    while (mismatchingIndex - matchingIndex > 1) {
      const index = Math.floor((matchingIndex + mismatchingIndex) / 2);
      if ((await readSpecVersion(index)) === specVersion) {
        matchingIndex = index;
      } else {
        mismatchingIndex = index;
      }
    }
    return mismatchingIndex;
  }

  private async batchRpc<T>(requests: { method: string; params: unknown[] }[], concurrency = 1): Promise<T[]> {
    const batchRpcUrl = this.batchRpcUrl;
    if (!batchRpcUrl) throw new Error('Batch RPC URL is not configured');

    // The public archive endpoints accept JSON-RPC batches of 50. Preserve request order because
    // JSON-RPC responses may arrive reordered and each result must stay paired with its block.
    const batchSize = 50;
    const batches: { method: string; params: unknown[] }[][] = [];
    for (let start = 0; start < requests.length; start += batchSize) {
      batches.push(requests.slice(start, start + batchSize));
    }

    const results: T[][] = new Array(batches.length);
    for (let start = 0; start < batches.length; start += concurrency) {
      await Promise.all(
        batches.slice(start, start + concurrency).map(async (batch, offset) => {
          const batchIndex = start + offset;
          const response = await fetch(batchRpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch.map(({ method, params }, id) => ({ jsonrpc: '2.0', id, method, params }))),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) {
            throw new Error(`Batch RPC failed with ${response.status} ${response.statusText}`);
          }

          const records = (await response.json()) as { id: number; result?: T; error?: { message?: string } }[];
          if (!Array.isArray(records) || records.length !== batch.length) {
            throw new Error(`Batch RPC returned ${Array.isArray(records) ? records.length : 'invalid'} responses`);
          }

          const byId = new Map(records.map(record => [record.id, record]));
          results[batchIndex] = batch.map((_, id) => {
            const record = byId.get(id);
            if (!record || record.error || !('result' in record)) {
              throw new Error(
                `Batch RPC request ${batchIndex * batchSize + id} failed: ${record?.error?.message ?? 'missing response'}`,
              );
            }
            return record.result as T;
          });
        }),
      );
    }
    return results.flat();
  }
}
