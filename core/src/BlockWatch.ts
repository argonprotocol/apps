import {
  type ApiDecoration,
  type ArgonClient,
  type FrameSystemEventRecord,
  getAuthorFromHeader,
  getFrameInfoFromHeader,
  getOfflineRegistry,
  type SignedBlock,
  getTickFromHeader,
  type Header,
} from '@argonprotocol/mainchain';
import { createDeferred } from './Deferred.js';
import type { MainchainClients } from './MainchainClients.js';
import { createTypedEventEmitter } from './utils.js';
import { SingleFileQueue } from './SingleFileQueue.js';

export interface IBlockHeaderInfo {
  isFinalized: boolean;
  blockNumber: number;
  blockHash: string;
  blockTime: number;
  parentHash: string;
  author: string;
  tick: number;
  frameId?: number;
  frameRewardTicksRemaining?: number;
  isNewFrame?: boolean;
}

type ISubscriptionSource = 'archive' | 'pruned';

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
  private apiByBlockHash = new Map<string, Promise<ApiDecoration<'promise'>>>();
  private eventsByBlockHash = new Map<string, Promise<FrameSystemEventRecord[]>>();

  public subscriptionClient!: ArgonClient;

  private unsubscribe: (() => void) | undefined;
  private activeSource: ISubscriptionSource = 'archive';
  private subscriptionGeneration: number = 0;
  private clientEventUnsubscribes: (() => void)[] = [];
  private finalizedAheadRecoveryFailures: number = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRestart: { reason: string; source: ISubscriptionSource } | undefined;
  private isRestarting: boolean = false;

  constructor(
    public clients: MainchainClients,
    private forcePrunedClientSubscriptions = false,
  ) {
    this.clientEventUnsubscribes = [
      this.clients.events.on('degraded', (_error, clientType) => {
        if (!this.isLoaded.isSettled || this.isRestarting) {
          return;
        }
        if (clientType !== this.activeSource) {
          return;
        }

        this.scheduleRestart(this.getRecoverySource(), `Detected ${clientType} client degradation`);
      }),

      this.clients.events.on('working', (_path, clientType) => {
        if (clientType !== 'pruned' || this.forcePrunedClientSubscriptions || this.activeSource !== 'archive') {
          return;
        }
        if (this.getPreferredSubscriptionSource() !== 'pruned') {
          return;
        }
        this.scheduleRestart('pruned', 'Pruned client recovered');
      }),

      this.clients.events.on('on-pruned-client', () => {
        if (this.forcePrunedClientSubscriptions || this.activeSource === 'pruned') {
          return;
        }
        this.scheduleRestart('pruned', 'Switched to pruned client');
      }),
    ];
  }

  public async start(source = this.getPreferredSubscriptionSource()): Promise<void> {
    if (this.isLoaded.isRunning || this.isLoaded.isSettled) {
      return this.isLoaded.promise;
    }
    this.isLoaded.setIsRunning(true);

    try {
      this.processingQueue.clear();
      this.latestHeaders.length = 1;
      this.finalizedAheadRecoveryFailures = 0;
      console.time('[BlockWatch] start');
      const generation = ++this.subscriptionGeneration;
      try {
        await this.startSubscription(source, generation);
      } catch (error) {
        if (source !== 'pruned' || this.forcePrunedClientSubscriptions) {
          throw error;
        }

        console.warn('[BlockWatch]: Failed to start with pruned client, falling back to archive', { error });
        this.processingQueue.clear();
        this.latestHeaders.length = 1;
        this.finalizedAheadRecoveryFailures = 0;
        await this.startSubscription('archive', ++this.subscriptionGeneration);
      }
    } catch (err) {
      this.isLoaded.reject(err);
      throw err;
    }
    console.timeEnd('[BlockWatch] start');
    this.isLoaded.resolve();
    return this.isLoaded.promise;
  }

  private async startSubscription(source: ISubscriptionSource, generation: number): Promise<void> {
    let unsub1: (() => void) | undefined;
    let unsub2: (() => void) | undefined;

    try {
      const { client, source: activeSource } = await this.getSubscriptionClient(source);
      this.activeSource = activeSource;
      this.subscriptionClient = client;
      const finalizedHeader = await client.rpc.chain.getFinalizedHead().then(hash => client.rpc.chain.getHeader(hash));
      const finalizedBlock = BlockWatch.readHeader(finalizedHeader);
      this.latestHeaders = [finalizedBlock];
      const bestHeader = await client.rpc.chain.getHeader();
      const bestTail = await this.fillNewHeadGap(finalizedBlock, bestHeader);
      this.latestHeaders = [finalizedBlock, ...bestTail];

      unsub1 = await client.rpc.chain.subscribeNewHeads(async header => {
        if (generation !== this.subscriptionGeneration) {
          return;
        }
        this.processingQueue.add(async () => {
          if (generation !== this.subscriptionGeneration) {
            return;
          }
          const gap = await this.fillNewHeadGap(this.finalizedBlockHeader, header);
          const newBlocks = gap.filter(x => !this.latestHeaders.some(y => y.blockHash === x.blockHash));
          this.latestHeaders = [this.finalizedBlockHeader, ...gap];
          this.finalizedAheadRecoveryFailures = 0;
          if (newBlocks.length) {
            this.events.emit('best-blocks', newBlocks as [...any, IBlockHeaderInfo]);
          }
        });
      });

      unsub2 = await client.rpc.chain.subscribeFinalizedHeads(async header => {
        // slight delay to allow newHeads to process first
        await new Promise(resolve => setTimeout(resolve, 100));
        if (generation !== this.subscriptionGeneration) {
          return;
        }
        this.processingQueue.add(async () => {
          if (generation !== this.subscriptionGeneration) {
            return;
          }
          await this.setFinalizedHeader(header);
        });
      });

      this.unsubscribe = () => {
        unsub1?.();
        unsub2?.();
      };
    } catch (error) {
      unsub1?.();
      unsub2?.();
      throw error;
    }
  }

  public stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.pendingRestart = undefined;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.subscriptionGeneration += 1;
    this.isLoaded = createDeferred(false);
  }

  public destroy(): void {
    this.stop();
    for (const unsubscribe of this.clientEventUnsubscribes) {
      unsubscribe();
    }
    this.clientEventUnsubscribes.length = 0;
  }

  public isSafeForPrunedClient(blockNumber: number): boolean {
    if (this.activeSource !== 'pruned') {
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

    if (this.activeSource === 'pruned') {
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
    return await this.readWithArchiveRetry(blockNumber, `getFinalizedHash(${blockNumber})`, client =>
      client.rpc.chain.getBlockHash(blockNumber).then(x => x.toHex()),
    );
  }

  public async getHeader(blockNumber: number): Promise<IBlockHeaderInfo> {
    if (blockNumber < 0) {
      throw new Error(`[BlockWatch] getHeader called with negative blockNumber (${blockNumber})`);
    }
    const best = this.latestHeaders.find(x => x.blockNumber === blockNumber);
    if (best) {
      return best;
    }
    const header = await this.readWithArchiveRetry(blockNumber, `getHeader(${blockNumber})`, async client => {
      const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
      return await client.rpc.chain.getHeader(blockHash);
    });
    return BlockWatch.readHeader(header, blockNumber <= this.finalizedBlockHeader.blockNumber);
  }

  public async getParentHeader(header: IBlockHeaderInfo): Promise<IBlockHeaderInfo> {
    const parentNumber = header.blockNumber - 1;
    const parentHeader = await this.readWithArchiveRetry(
      parentNumber,
      `getParentHeader(${header.blockNumber})`,
      client => client.rpc.chain.getHeader(header.parentHash),
    );
    return BlockWatch.readHeader(parentHeader);
  }

  public async getBlockTime(blockNumber: number): Promise<Date> {
    const header = await this.getHeader(blockNumber);
    return new Date(header.blockTime);
  }

  public async getApi(block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>): Promise<ApiDecoration<'promise'>> {
    const cached = this.apiByBlockHash.get(block.blockHash);
    if (cached) return await cached;

    const promise = this.readWithArchiveRetry(block.blockNumber, `getApi(${block.blockNumber})`, client =>
      client.at(block.blockHash),
    );
    this.apiByBlockHash.set(block.blockHash, promise);
    this.trimBlockCaches();

    try {
      return await promise;
    } catch (error) {
      if (this.apiByBlockHash.get(block.blockHash) === promise) {
        this.apiByBlockHash.delete(block.blockHash);
      }
      throw error;
    }
  }

  public async getEvents(
    block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>,
  ): Promise<FrameSystemEventRecord[]> {
    const cached = this.eventsByBlockHash.get(block.blockHash);
    if (cached) return await cached;

    const promise = this.getApi(block).then(api => api.query.system.events() as Promise<FrameSystemEventRecord[]>);
    this.eventsByBlockHash.set(block.blockHash, promise);
    this.trimBlockCaches();

    try {
      return await promise;
    } catch (error) {
      if (this.eventsByBlockHash.get(block.blockHash) === promise) {
        this.eventsByBlockHash.delete(block.blockHash);
      }
      throw error;
    }
  }

  public async getBlock(block: Pick<IBlockHeaderInfo, 'blockNumber' | 'blockHash'>): Promise<SignedBlock> {
    return await this.readWithArchiveRetry(block.blockNumber, `getBlock(${block.blockNumber})`, client =>
      client.rpc.chain.getBlock(block.blockHash),
    );
  }

  private trimBlockCaches(): void {
    while (this.apiByBlockHash.size > 10) {
      const oldestKey = this.apiByBlockHash.keys().next().value;
      if (!oldestKey) break;
      this.apiByBlockHash.delete(oldestKey);
    }

    while (this.eventsByBlockHash.size > 10) {
      const oldestKey = this.eventsByBlockHash.keys().next().value;
      if (!oldestKey) break;
      this.eventsByBlockHash.delete(oldestKey);
    }
  }

  private async setFinalizedHeader(header: Header): Promise<void> {
    const finalizedHash = header.hash.toHex();
    const finalizedNumber = header.number.toNumber();
    const bestKnown = this.bestBlockHeader.blockNumber;
    // If finalized is ahead of what we know, or not in our history at all
    if (finalizedNumber > bestKnown || !this.latestHeaders.some(x => x.blockHash === finalizedHash)) {
      if (finalizedNumber > bestKnown) {
        console.warn('[BlockWatch]: Finalized header is ahead of known best, filling gap', {
          finalizedNumber,
          bestKnown,
        });
      } else {
        console.warn('[BlockWatch]: Finalized header not found in known best blocks, filling gap', {
          finalizedNumber,
          latestHeaders: this.latestHeaders,
        });
      }
      try {
        const client = await this.getRpcClient(finalizedNumber);
        const bestHeader = await this.queryWithArchiveRetry(
          client,
          `getBestHeader(${finalizedNumber})`,
          selectedClient => selectedClient.rpc.chain.getHeader(),
          { finalizedNumber },
        );
        // presume our old finalized is still valid, fill in the gap to the new best
        const bestTail = await this.fillNewHeadGap(this.finalizedBlockHeader, bestHeader);
        // New canonical window: [latest finalized ... best]
        this.latestHeaders = [this.finalizedBlockHeader, ...bestTail];

        if (this.bestBlockHeader.blockNumber <= bestKnown) {
          this.finalizedAheadRecoveryFailures += 1;
          if (this.finalizedAheadRecoveryFailures >= 3) {
            this.scheduleRestart(
              this.getRecoverySource(),
              `Finalized head stayed ahead of best (${finalizedNumber} > ${bestKnown})`,
            );
          }
        } else {
          this.finalizedAheadRecoveryFailures = 0;
        }

        // Emit best-blocks for the new chain past finalized
        if (bestTail.length > 0) {
          this.events.emit('best-blocks', bestTail as [...any, IBlockHeaderInfo]);
        }
      } catch (error) {
        this.finalizedAheadRecoveryFailures += 1;
        if (this.finalizedAheadRecoveryFailures >= 3) {
          this.scheduleRestart(this.getRecoverySource(), `Failed to recover finalized gap at block ${finalizedNumber}`);
        }
        throw error;
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

  private async readWithArchiveRetry<T>(
    blockNumber: number,
    label: string,
    query: (client: ArgonClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.getRpcClient(blockNumber);
    return await this.queryWithArchiveRetry(client, label, query, { blockNumber });
  }

  private async queryWithArchiveRetry<T>(
    client: ArgonClient,
    label: string,
    query: (client: ArgonClient) => Promise<T>,
    details: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await query(client);
    } catch (error) {
      if (!this.shouldRetryOnArchive(error)) {
        throw error;
      }

      const archiveClient = await this.clients.archiveClientPromise;
      if (archiveClient === client) {
        throw error;
      }

      console.warn(`[BlockWatch]: ${label} failed on selected client, retrying on archive`, {
        ...details,
        error: String(error),
      });
      return await query(archiveClient);
    }
  }

  private shouldRetryOnArchive(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      (message.includes('4003') &&
        (message.includes('state already discarded') || message.includes('unknown block'))) ||
      message.includes('unable to retrieve header and parent from supplied hash') ||
      message.includes('websocket is not connected') ||
      message.includes('no response received from rpc endpoint') ||
      message.includes('abnormal closure') ||
      message.includes('disconnected from ws://') ||
      message.includes('disconnected from wss://')
    );
  }

  private getPreferredSubscriptionSource(): ISubscriptionSource {
    if (this.forcePrunedClientSubscriptions) {
      return 'pruned';
    }
    return this.clients.prunedClientPromise ? 'pruned' : 'archive';
  }

  private getRecoverySource(): ISubscriptionSource {
    if (this.activeSource === 'pruned' && !this.forcePrunedClientSubscriptions) {
      return 'archive';
    }
    return this.getPreferredSubscriptionSource();
  }

  private async getSubscriptionClient(
    source: ISubscriptionSource,
  ): Promise<{ client: ArgonClient; source: ISubscriptionSource }> {
    if (source === 'pruned') {
      const client = await this.clients.prunedClientPromise;
      if (!client) {
        throw new Error('No pruned client available for BlockWatch subscriptions');
      }
      return { client, source };
    }
    return { client: await this.clients.archiveClientPromise, source };
  }

  private scheduleRestart(source: ISubscriptionSource, reason: string): void {
    if (!this.unsubscribe && !this.isRestarting && !this.isLoaded.isSettled) {
      return;
    }
    this.pendingRestart = { reason, source };
    if (this.isRestarting || this.restartTimer) {
      return;
    }

    console.warn('[BlockWatch]: Restarting subscriptions soon', {
      reason,
      source,
    });
    this.restartTimer = setTimeout(() => {
      const pendingRestart = this.pendingRestart;
      this.restartTimer = undefined;
      this.pendingRestart = undefined;
      if (!pendingRestart) {
        return;
      }
      void this.restart(pendingRestart.source, pendingRestart.reason);
    }, 250);
  }

  private async restart(source: ISubscriptionSource, reason: string): Promise<void> {
    if (this.isRestarting) {
      return;
    }
    this.isRestarting = true;

    try {
      console.warn('[BlockWatch]: Restarting subscriptions', {
        reason,
        source,
      });
      this.stop();
      await this.start(source);
    } catch (error) {
      console.error('[BlockWatch]: Failed to restart subscriptions', { reason, error });
    } finally {
      this.isRestarting = false;
      const pendingRestart = this.pendingRestart;
      if (!pendingRestart) {
        return;
      }
      this.pendingRestart = undefined;
      this.scheduleRestart(pendingRestart.source, pendingRestart.reason);
    }
  }

  public static readHeader(header: Header, isFinalized = false): IBlockHeaderInfo {
    const frameInfo = getFrameInfoFromHeader(header);
    let blockTime = 0;
    for (const x of header.digest.logs) {
      if (x.isConsensus) {
        const [engineId, data] = x.asConsensus;
        if (engineId.toString() === 'ISTM') {
          const blockTimeRaw = getOfflineRegistry().createType('u64', data);
          // timestamp is in seconds
          blockTime = blockTimeRaw.toNumber() * 1000;
          break;
        }
      }
    }
    return {
      isFinalized,
      blockTime,
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
