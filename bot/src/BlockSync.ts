import {
  type Accountset,
  createDeferred,
  type IBlock,
  type IBotStateFile,
  type IDeferred,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { type Storage } from './Storage.ts';
import type { JsonStore } from './JsonStore.ts';
import { MiningCapture } from './MiningCapture.ts';
import type { BlockWatch, IBlockHeaderInfo } from '@argonprotocol/apps-core/src/BlockWatch.ts';

export interface ILastProcessed {
  date: Date;
  frameId: number;
  blockNumber: number;
}

export class BlockSync {
  public lastProcessed?: ILastProcessed;
  public get botStateFile(): JsonStore<IBotStateFile> {
    return this.storage.botStateFile();
  }
  private inProcessSync?: IDeferred<void>;
  private needsProcessing = false;

  public oldestTickToSync: number = 0;

  public latestTick: number = 0;
  public lastSynchedTick: number = 0;
  public didProcessBlock?: (lastProcessed: ILastProcessed) => void;

  private retryTimer?: NodeJS.Timeout;
  private unsubscribes: (() => void)[] = [];

  private isStopping: boolean = false;
  private miningCapture: MiningCapture;

  constructor(
    public accountset: Accountset,
    public storage: Storage,
    public mainchainClients: MainchainClients,
    public miningFrames: MiningFrames,
    public blockWatch: BlockWatch,
    private oldestFrameIdToSync?: number,
  ) {
    this.miningCapture = new MiningCapture(accountset, storage, mainchainClients, miningFrames);
  }

  public load(): Promise<void> {
    return this.processPending(true);
  }

  public async ensureCurrentStateReady(): Promise<void> {
    const localClient = await this.mainchainClients.prunedClientPromise;
    if (!localClient) {
      throw new Error('Pruned client is not available');
    }
    // The local node can be connected before its state is available.
    await localClient.query.system.number().catch(x => {
      console.error('[BlockSync] Error getting system number from local client', x);
      throw new Error('Local client is not ready');
    });

    const archiveClient = await this.mainchainClients.archiveClientPromise;
    if (archiveClient.genesisHash.toHex() !== localClient.genesisHash.toHex()) {
      throw new Error('Archive client and local client have different genesis hashes');
    }
    await this.blockWatch.start();
    await this.miningFrames.load();

    const archiveFinalizedHash = await archiveClient.rpc.chain.getFinalizedHead();
    const archiveFinalizedHeader = await archiveClient.rpc.chain.getHeader(archiveFinalizedHash);
    const archiveFinalizedNumber = archiveFinalizedHeader.number.toNumber();
    const localFinalizedNumber = this.blockWatch.finalizedBlockHeader.blockNumber;
    if (localFinalizedNumber < archiveFinalizedNumber - 10) {
      throw new Error(
        `Local client has not synched within range of the archive client (10 blocks). Archive Client=${archiveFinalizedNumber} vs Local=${localFinalizedNumber}`,
      );
    }
  }

  public start(): Promise<void> {
    if (this.isStopping) return Promise.resolve();
    if (!this.unsubscribes.length) {
      const onBlocks = () => {
        if (this.inProcessSync) {
          this.needsProcessing = true;
          return;
        }
        void this.processPending().catch(() => undefined);
      };
      this.unsubscribes = [
        this.blockWatch.events.on('best-blocks', onBlocks),
        this.blockWatch.events.on('finalized', onBlocks),
      ];
    }
    // Subscribe before draining so a head arriving during startup is included.
    return this.processPending();
  }

  public async stop() {
    if (this.isStopping) return;
    console.time('[BlockSync] STOPPING');
    this.isStopping = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.inProcessSync?.promise.catch(() => undefined);
    console.timeEnd('[BlockSync] STOPPING');
  }

  public calculateSyncProgress(): number {
    return this.calculateProgress(this.lastSynchedTick, [this.oldestTickToSync, this.latestTick]);
  }

  private async processPending(initialize = false): Promise<void> {
    if (this.isStopping) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }

    // Coalesce heads during an active pass, but recheck before becoming idle.
    this.needsProcessing = true;
    if (this.inProcessSync) return this.inProcessSync.promise;

    const processing = createDeferred<void>();
    this.inProcessSync = processing;

    try {
      if (initialize) {
        await this.ensureCurrentStateReady();
        if (!this.isStopping) await this.restoreCheckpoint();
      }
      while (!this.isStopping && this.needsProcessing) {
        this.needsProcessing = false;
        if (await this.processNext()) this.needsProcessing = true;
      }
      if (initialize && !this.isStopping) console.log('[BlockSync] Synched to latest');
      processing.resolve();
    } catch (error) {
      if (!initialize && !this.isStopping) {
        console.error('[BlockSync] Error processing pending blocks', error);
        this.retryTimer = setTimeout(() => void this.processPending().catch(() => undefined), 500);
      }
      processing.reject(error);
    } finally {
      this.inProcessSync = undefined;
    }
    return processing.promise;
  }

  private async processNext(): Promise<boolean> {
    const state = await this.botStateFile.get();
    await this.advanceFinalizedProcessed(state);
    const best = this.blockWatch.bestBlockHeader;
    const bestBlockNumber = best.blockNumber;
    const blockNumber = state.lastProcessedBlockNumber + 1;
    this.latestTick = best.tick;
    if (blockNumber > bestBlockNumber) {
      const chainMovedBehindCheckpoint = state.lastProcessedBlockNumber > bestBlockNumber;
      const checkpointHeadWasReplaced =
        state.lastProcessedBlockNumber === bestBlockNumber && state.lastProcessedBlockHash !== best.blockHash;
      if (chainMovedBehindCheckpoint || checkpointHeadWasReplaced) {
        await this.restoreCheckpoint();
        return true;
      }
      return false;
    }

    // A height alone is not a replay cursor: verify its parent before applying any events.
    const header = await this.blockWatch.getHeader(blockNumber);
    if (header.parentHash !== state.lastProcessedBlockHash) {
      await this.restoreCheckpoint();
      return true;
    }
    await this.miningFrames.waitForTick(header.tick);
    if (header.frameId !== undefined) await this.miningFrames.waitForFrameId(header.frameId);
    const blockMeta: IBlock = {
      number: blockNumber,
      hash: header.blockHash,
      author: header.author,
      tick: header.tick,
      frameId: header.frameId ?? this.miningFrames.getForTick(header.tick),
      frameRewardTicksRemaining: header.frameRewardTicksRemaining,
      isNewFrame: header.isNewFrame,
    };

    console.log(`[BlockSync] Processing block ${blockNumber}`, blockMeta);

    const blockEvents = await this.blockWatch.getEventsWithSpec({
      blockNumber,
      blockHash: blockMeta.hash,
    });
    const { hasMiningBids, hasMiningSeats } = await this.miningCapture.processBlock(blockMeta, blockEvents);
    const tick = blockMeta.tick;
    const currentFrameId = blockMeta.frameId ?? this.miningFrames.getForTick(tick);

    this.latestTick = Math.max(this.latestTick, tick);
    const syncProgress = this.calculateProgress(tick, [this.oldestTickToSync, this.latestTick]);
    const finalizedHeader = this.blockWatch.finalizedBlockHeader;
    const finalizedHeaderFrameId = finalizedHeader?.tick
      ? (finalizedHeader.frameId ?? this.miningFrames.getForTick(finalizedHeader.tick))
      : 0;
    const finalizedFrameId = Math.max(0, finalizedHeaderFrameId - 1);
    // Publish the processed tip only after its bid and earnings files have been written.
    await this.botStateFile.mutate(x => {
      x.hasMiningBids ||= hasMiningBids || hasMiningSeats;
      if (hasMiningBids) {
        x.bidsLastModifiedAt = new Date();
      }
      if (hasMiningSeats) {
        x.hasMiningSeats = true;
      }
      x.earningsLastModifiedAt = new Date();
      x.currentTick = tick;
      x.currentFrameId = currentFrameId;
      x.finalizedFrameId = finalizedFrameId;
      x.syncProgress = syncProgress;
      x.lastProcessedBlockNumber = blockNumber;
      x.lastProcessedBlockHash = blockMeta.hash;
      if (header.isFinalized && blockNumber <= finalizedHeader.blockNumber) {
        x.lastFinalizedProcessedBlockNumber = blockNumber;
        x.lastFinalizedProcessedBlockHash = blockMeta.hash;
      }
    });

    this.lastSynchedTick = tick;
    this.lastProcessed = {
      date: new Date(),
      frameId: currentFrameId,
      blockNumber,
    };
    this.didProcessBlock?.(this.lastProcessed);
    const syncPercent = (blockNumber * 100) / bestBlockNumber;
    const syncString = syncPercent >= 100 ? '' : ` (synced ${syncPercent.toFixed(1)}%)`;
    console.log(`[BlockSync] Processed block ${blockNumber}${syncString}.`);
    return true;
  }

  private async restoreCheckpoint(): Promise<IBlockHeaderInfo> {
    const state = await this.botStateFile.get();
    const finalizedHeader = this.blockWatch.finalizedBlockHeader;
    const capture = new MiningCapture(this.accountset, this.storage, this.mainchainClients, this.miningFrames);

    // The sync lane owns restoration; chain reads leave the saved state and active capture intact.
    if (!state.oldestFrameIdToSync) {
      state.oldestFrameIdToSync =
        this.oldestFrameIdToSync ?? finalizedHeader.frameId ?? this.miningFrames.currentFrameId;
      if (state.oldestFrameIdToSync === 0 && !NetworkConfig.canFrameBeZero()) {
        throw new Error('Oldest frame to sync cannot be 0');
      }
    }
    const oldestFrameId = state.oldestFrameIdToSync;

    // The finalized anchor bounds a rewind; the processed tip can still be on a live fork.
    let finalizedProcessed: IBlockHeaderInfo | undefined;
    if (state.lastFinalizedProcessedBlockHash) {
      finalizedProcessed = await this.blockWatch.getHeader(state.lastFinalizedProcessedBlockNumber);
      if (
        finalizedProcessed.blockHash !== state.lastFinalizedProcessedBlockHash ||
        state.lastFinalizedProcessedBlockNumber > state.lastProcessedBlockNumber
      ) {
        throw new Error('The saved finalized mining checkpoint does not match the processed chain.');
      }
    }

    // Replay begins before the first frame so its first block is included.
    let checkpoint: IBlockHeaderInfo;
    if (!state.lastProcessedBlockHash) {
      checkpoint = await this.getStartingHeader(oldestFrameId);
    } else {
      // A replacement best chain can be shorter than the saved live tip.
      const canonical =
        state.lastProcessedBlockNumber <= this.blockWatch.bestBlockHeader.blockNumber
          ? await this.blockWatch.getHeader(state.lastProcessedBlockNumber)
          : undefined;
      if (canonical?.blockHash === state.lastProcessedBlockHash) {
        checkpoint = canonical;
      } else {
        finalizedProcessed ??= await this.getStartingHeader(oldestFrameId);
        checkpoint = await this.findCommonAncestor(state, finalizedProcessed);
      }
    }

    if (!finalizedProcessed) {
      const finalizedProcessedNumber = Math.min(checkpoint.blockNumber, finalizedHeader.blockNumber);
      finalizedProcessed =
        finalizedProcessedNumber === checkpoint.blockNumber
          ? checkpoint
          : await this.blockWatch.getHeader(finalizedProcessedNumber);
      if (
        finalizedProcessedNumber === finalizedHeader.blockNumber &&
        finalizedProcessed.blockHash !== finalizedHeader.blockHash
      ) {
        throw new Error('The local and archive finalized mining blocks disagree.');
      }
    }

    const api = await this.blockWatch.getApi(checkpoint);
    await capture.restore(api);

    if (checkpoint.blockNumber < state.lastProcessedBlockNumber) {
      // Remove the abandoned suffix before the shorter cursor becomes observable.
      await capture.rewindAfter(checkpoint);
    }

    // Save the restored cursor before publishing its capture and progress.
    const anchor = finalizedProcessed;
    await this.botStateFile.mutate(saved => {
      if (checkpoint.blockNumber < state.lastProcessedBlockNumber) {
        saved.earningsLastModifiedAt = new Date();
        saved.bidsLastModifiedAt = new Date();
      }
      saved.oldestFrameIdToSync = oldestFrameId;
      saved.lastProcessedBlockNumber = checkpoint.blockNumber;
      saved.lastProcessedBlockHash = checkpoint.blockHash;
      saved.lastFinalizedProcessedBlockNumber = anchor.blockNumber;
      saved.lastFinalizedProcessedBlockHash = anchor.blockHash;
    });

    this.oldestFrameIdToSync = oldestFrameId;
    this.oldestTickToSync = this.miningFrames.getTickStart(oldestFrameId);
    this.latestTick = this.blockWatch.bestBlockHeader.tick;
    this.lastSynchedTick = checkpoint.tick;
    this.miningCapture = capture;
    return checkpoint;
  }

  private async getStartingHeader(frameId: number): Promise<IBlockHeaderInfo> {
    const firstBlockNumber = this.miningFrames.framesById[frameId]?.firstBlockNumber;
    if (firstBlockNumber == null) {
      throw new Error(`No starting block for frame ${frameId}.`);
    }
    return this.blockWatch.getHeader(Math.max(0, firstBlockNumber - 1));
  }

  private async findCommonAncestor(
    state: Pick<IBotStateFile, 'lastProcessedBlockNumber' | 'lastProcessedBlockHash'>,
    finalizedProcessed: IBlockHeaderInfo,
  ): Promise<IBlockHeaderInfo> {
    // Follow the saved fork backward until it rejoins the current best chain.
    let previous = await this.blockWatch
      .getHeader({ blockNumber: state.lastProcessedBlockNumber, blockHash: state.lastProcessedBlockHash })
      .catch(() => undefined);
    while (previous && previous.blockNumber > finalizedProcessed.blockNumber) {
      if (previous.blockNumber <= this.blockWatch.bestBlockHeader.blockNumber) {
        const canonical = await this.blockWatch.getHeader(previous.blockNumber);
        if (canonical.blockHash === previous.blockHash) {
          return canonical;
        }
      }
      previous = await this.blockWatch.getParentHeader(previous).catch(() => undefined);
    }

    return finalizedProcessed;
  }

  private async advanceFinalizedProcessed(state: IBotStateFile): Promise<void> {
    const finalized = this.blockWatch.finalizedBlockHeader;
    const blockNumber = Math.min(state.lastProcessedBlockNumber, finalized.blockNumber);
    if (blockNumber <= state.lastFinalizedProcessedBlockNumber) return;

    let blockHash: string;
    if (blockNumber < finalized.blockNumber) {
      const canonical = await this.blockWatch.getHeader(blockNumber);
      if (canonical.blockHash !== state.lastProcessedBlockHash) return;
      blockHash = canonical.blockHash;
    } else if (state.lastProcessedBlockNumber === finalized.blockNumber) {
      if (state.lastProcessedBlockHash !== finalized.blockHash) return;
      blockHash = finalized.blockHash;
    } else {
      const processedTipIsOnBestChain = this.blockWatch.latestHeaders.some(
        header =>
          header.blockNumber === state.lastProcessedBlockNumber && header.blockHash === state.lastProcessedBlockHash,
      );
      if (!processedTipIsOnBestChain) return;
      blockHash = finalized.blockHash;
    }

    await this.botStateFile.mutate(x => {
      x.lastFinalizedProcessedBlockNumber = blockNumber;
      x.lastFinalizedProcessedBlockHash = blockHash;
    });
    state.lastFinalizedProcessedBlockNumber = blockNumber;
    state.lastFinalizedProcessedBlockHash = blockHash;
  }

  private calculateProgress(tick: number | undefined, tickRange: [number, number] | undefined): number {
    if (!tick || !tickRange) return 0;
    const [startTick, endTick] = tickRange;
    if (endTick <= startTick) return tick >= endTick ? 100 : 0;

    const progress = Math.min(Math.max((tick - startTick) / (endTick - startTick), 0), 1);
    return Math.round(progress * 10000) / 100;
  }
}
