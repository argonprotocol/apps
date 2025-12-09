import {
  type ArgonClient,
  getAuthorFromHeader,
  getFrameInfoFromHeader,
  getTickFromHeader,
  type Header,
} from '@argonprotocol/mainchain';
import { createDeferred } from './Deferred.js';
import type { MainchainClients } from './MainchainClients.js';
import { createTypedEventEmitter, SingleFileQueue } from './utils.js';

export interface IBlockHeaderInfo {
  isFinalized: boolean;
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  author: string;
  tick: number;
  frameId?: number;
  frameRewardTicksRemaining?: number;
  isNewFrame?: boolean;
}

export class BlockWatch {
  public get finalizedBlockHeader(): IBlockHeaderInfo {
    return this.latestHeaders.at(0)!;
  }

  public get bestBlockHeader(): IBlockHeaderInfo {
    return this.latestHeaders.at(-1)!;
  }

  public events = createTypedEventEmitter<{
    // Emitted when 1 or more new blocks are finalized. Newest block is last in array.
    finalized: (blocks: [...otherFinalized: IBlockHeaderInfo[], finalized: IBlockHeaderInfo]) => void;
    // Emitted when best blocks are updated (on new head). Newest block is last in array.
    'best-blocks': (blocks: [...newBestBlocks: IBlockHeaderInfo[], bestBlock: IBlockHeaderInfo]) => void;
  }>();
  // Tracks all best block headers seen since latest finalized block

  public latestHeaders: IBlockHeaderInfo[] = [];
  public finalizedHashes: { [blockNumber: number]: string } = {};
  public isLoaded = createDeferred(false);
  private processingQueue = new SingleFileQueue();

  private unsubscribe: (() => void) | undefined;
  private isPrunedClientSubscription: boolean = false;

  constructor(
    private clients: MainchainClients,
    private forcePrunedClientSubscriptions = false,
  ) {}

  public async start(): Promise<void> {
    if (this.isLoaded.isRunning || this.isLoaded.isResolved) {
      return this.isLoaded.promise;
    }
    console.time('[BlockWatch] start');
    let client = await this.clients.prunedClientPromise;
    if (this.forcePrunedClientSubscriptions) {
      if (!client) {
        throw new Error('No pruned client available for BlockWatch subscriptions');
      }
    }
    if (client) {
      this.isPrunedClientSubscription = true;
    }
    client ??= await this.clients.archiveClientPromise;

    this.isLoaded.setIsRunning(true);
    try {
      const finalizedHeader = await client.rpc.chain.getFinalizedHead().then(hash => client.rpc.chain.getHeader(hash));
      this.latestHeaders = [BlockWatch.readHeader(finalizedHeader)];
      const hasBlockData = createDeferred();
      const unsub1 = await client.rpc.chain.subscribeNewHeads(async header => {
        this.processingQueue.add(async () => {
          const gap = await this.fillNewHeadGap(this.finalizedBlockHeader, header);
          const newBlocks = gap.filter(x => !this.latestHeaders.some(y => y.blockHash === x.blockHash));
          this.latestHeaders = [this.finalizedBlockHeader, ...gap];
          hasBlockData.resolve();
          if (newBlocks.length) {
            this.events.emit('best-blocks', newBlocks as [...any, IBlockHeaderInfo]);
          }
        });
      });
      await hasBlockData.promise;

      const unsub2 = await client.rpc.chain.subscribeFinalizedHeads(async header => {
        // slight delay to allow newHeads to process first
        await new Promise(resolve => setTimeout(resolve, 100));
        this.processingQueue.add(async () => {
          await this.setFinalizedHeader(header);
        });
      });

      this.unsubscribe = () => {
        unsub1();
        unsub2();
      };

      if (!this.isPrunedClientSubscription) {
        const unsub = this.clients.events.on('on-pruned-client', async () => {
          console.log('[BlockWatch]: Switched to pruned client for subscriptions');
          this.stop();
          unsub();
          await this.start();
        });
      }
    } catch (err) {
      this.isLoaded.reject(err);
      throw err;
    }
    console.timeEnd('[BlockWatch] start');
    this.isLoaded.resolve();
    return this.isLoaded.promise;
  }

  public stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.isLoaded = createDeferred(false);
  }

  public isSafeForPrunedClient(blockNumber: number): boolean {
    if (!this.isPrunedClientSubscription) {
      return false;
    }
    const finalizedNumber = this.finalizedBlockHeader.blockNumber;
    // TODO: we could add 256 blocks if we obtain the first block synced by the pruned client
    return blockNumber >= finalizedNumber;
  }

  /**
   * Gets an appropriate client for this header. The local node will be pruned to 256 finalized blocks.
   * @param headerOrNumber
   */
  public getRpcClient(headerOrNumber: Header | number): Promise<ArgonClient> {
    const headerNumber = typeof headerOrNumber === 'number' ? headerOrNumber : headerOrNumber.number.toNumber();

    if (this.isPrunedClientSubscription) {
      if (this.isSafeForPrunedClient(headerNumber)) {
        return this.clients.prunedClientPromise!;
      }
    }
    return this.clients.archiveClientPromise;
  }

  public async getFinalizedHash(blockNumber: number): Promise<string> {
    const finalizedHash = this.finalizedHashes[blockNumber];
    if (finalizedHash) {
      return finalizedHash;
    }
    const client = await this.getRpcClient(blockNumber);
    return await client.rpc.chain.getBlockHash(blockNumber).then(x => x.toHex());
  }

  public async getHeader(blockNumber: number): Promise<IBlockHeaderInfo> {
    const best = this.latestHeaders.find(x => x.blockNumber === blockNumber);
    if (best) {
      return best;
    }
    const client = await this.getRpcClient(blockNumber);
    const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
    const header = await client.rpc.chain.getHeader(blockHash);
    return BlockWatch.readHeader(header);
  }

  public async getParentHeader(header: IBlockHeaderInfo): Promise<IBlockHeaderInfo> {
    const parentNumber = header.blockNumber - 1;
    const client = await this.getRpcClient(parentNumber);
    const parentHeader = await client.rpc.chain.getHeader(header.parentHash);
    return BlockWatch.readHeader(parentHeader);
  }

  private async setFinalizedHeader(header: Header): Promise<void> {
    const finalizedHash = header.hash.toHex();
    const finalizedNumber = header.number.toNumber();
    // If finalized is ahead of what we know, or not in our history at all
    if (
      finalizedNumber > this.bestBlockHeader.blockNumber ||
      !this.latestHeaders.some(x => x.blockHash === finalizedHash)
    ) {
      if (finalizedNumber > this.bestBlockHeader.blockNumber) {
        console.warn('[BlockWatch]: Finalized header is ahead of known best, filling gap', {
          finalizedNumber,
          bestKnown: this.bestBlockHeader.blockNumber,
        });
      } else {
        console.warn('[BlockWatch]: Finalized header not found in known best blocks, filling gap', {
          finalizedNumber,
          latestHeaders: this.latestHeaders,
        });
      }
      const client = await this.getRpcClient(finalizedNumber);
      const bestHeader = await client.rpc.chain.getHeader();
      // presume our old finalized is still valid, fill in the gap to the new best
      const bestTail = await this.fillNewHeadGap(this.finalizedBlockHeader, bestHeader);
      // New canonical window: [latest finalized ... best]
      this.latestHeaders = [this.finalizedBlockHeader, ...bestTail];

      // Emit best-blocks for the new chain past finalized
      if (bestTail.length > 0) {
        this.events.emit('best-blocks', bestTail as [...any, IBlockHeaderInfo]);
      }
    }

    const finalized: IBlockHeaderInfo[] = [];
    let toDeleteCount = 0;
    for (let i = 0; i < this.latestHeaders.length; i++) {
      const h = this.latestHeaders[i];
      if (h.blockNumber <= finalizedNumber) {
        this.finalizedHashes[h.blockNumber] = h.blockHash;
        if (h.blockNumber < finalizedNumber) {
          toDeleteCount++;
        }
        h.isFinalized = true;
        finalized.push(h);
      }
      if (h.blockHash === finalizedHash) {
        break;
      }
    }
    if (finalized.length > 0) {
      this.events.emit('finalized', finalized as [...any, IBlockHeaderInfo]);
    }

    if (toDeleteCount > 0) {
      this.latestHeaders.splice(0, toDeleteCount);
    }
  }

  private async fillNewHeadGap(
    finalizedHeader: IBlockHeaderInfo,
    newHeader: Header | IBlockHeaderInfo,
  ): Promise<IBlockHeaderInfo[]> {
    const headers: IBlockHeaderInfo[] = [];
    let walkBack: IBlockHeaderInfo = 'blockHash' in newHeader ? newHeader : BlockWatch.readHeader(newHeader);
    while (walkBack.blockNumber > finalizedHeader.blockNumber) {
      headers.push(walkBack);
      walkBack = await this.getParentHeader(walkBack);
    }
    return headers.reverse();
  }

  public static readHeader(header: Header, isFinalized = false): IBlockHeaderInfo {
    const frameInfo = getFrameInfoFromHeader(header);
    return {
      isFinalized,
      blockNumber: header.number.toNumber(),
      blockHash: header.hash.toHex(),
      parentHash: header.parentHash.toHex(),
      tick: getTickFromHeader(header)!,
      author: getAuthorFromHeader(header)!,
      frameId: frameInfo?.frameId,
      frameRewardTicksRemaining: frameInfo?.frameRewardTicksRemaining,
      isNewFrame: frameInfo?.isNewFrame,
    };
  }
}
