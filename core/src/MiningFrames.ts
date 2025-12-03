import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { getFrameInfoFromHeader, getTickFromHeader } from '@argonprotocol/mainchain';
import type { IFrameHistory, IFrameHistoryMap, IFramesHistory } from './interfaces/IFramesHistory.js';
import { NetworkConfig } from './NetworkConfig.js';
import FramesHistoryTestnet from './data/frames.testnet.json' with { type: 'json' };
import FramesHistoryMainnet from './data/frames.mainnet.json' with { type: 'json' };
import type { MainchainClients } from './MainchainClients.js';
import { createDeferred } from './Deferred.js';
import { createTypedEventEmitter, getPercent, SingleFileQueue } from './utils.js';
import { BlockWatch, type IBlockHeaderInfo } from './BlockWatch.js';

dayjs.extend(utc);

export interface IFrameUpdatesWriter {
  write(data: string): Promise<void>;
  read(): Promise<string | null>;
}

/**
 * A frame is the period from noon EDT to the next noon EDT that a cohort of
 * miners rotates. The first frame (frame 0) was the period between bidding start and Frame 1 beginning.
 *
 * NOTE: frames guarantee 1440 reward ticks, so they can drift longer than the noon to noon period over time
 */
export class MiningFrames {
  public currentFrameId: number;
  public currentFrameRewardTicksRemaining;
  public frameHistory: IFrameHistoryMap;
  public readonly blockWatch: BlockWatch;
  public currentTick: number;

  public events = createTypedEventEmitter<{
    'on-frame': (frame: { frameId: number; blockNumber: number; blockHash: string }) => void;
    'on-tick': (tick: number) => void;
  }>();

  public get frameIds(): number[] {
    return Object.keys(this.frameHistory)
      .map(Number)
      .sort((a, b) => a - b);
  }

  private readonly loadDeferred = createDeferred(false);
  private readonly unsubscribes: (() => void)[] = [];
  private readonly updateQueue = new SingleFileQueue();

  constructor(
    private readonly clients: MainchainClients,
    blockWatch?: BlockWatch,
    private updatesWriter?: IFrameUpdatesWriter,
  ) {
    if (!NetworkConfig.networkName) {
      throw new Error('NetworkConfig.networkName is not set');
    }
    this.frameHistory = {};
    this.blockWatch = blockWatch ?? new BlockWatch(this.clients);
    this.currentTick = 0;
    this.currentFrameRewardTicksRemaining = NetworkConfig.rewardTicksPerFrame;
    if (NetworkConfig.networkName === 'mainnet') {
      for (const frame of FramesHistoryMainnet as any) {
        this.frameHistory[frame.frameId] = frame;
      }
    } else if (NetworkConfig.networkName === 'testnet') {
      for (const frame of FramesHistoryTestnet as any) {
        this.frameHistory[frame.frameId] = frame;
      }
    }
    this.currentFrameId = Math.max(...this.frameIds, 0);
  }

  public async load(): Promise<void> {
    if (this.loadDeferred.isResolved || this.loadDeferred.isRunning) return this.loadDeferred.promise;
    this.loadDeferred.setIsRunning(true);
    try {
      if (this.updatesWriter) {
        const updates = await this.updatesWriter
          .read()
          .then(x => JSON.parse(x ?? '[]') as IFramesHistory)
          .catch(() => []);
        if (updates.length > 0) {
          for (const frame of updates) {
            this.frameHistory[frame.frameId] = frame;
          }
          this.currentFrameId = Math.max(...this.frameIds);
        }
      }
      console.log(
        `[Mining Frames] Loading with current frame ID: ${this.currentFrameId} of known frames ${this.frameIds.length}`,
      );
      const client = await this.clients.prunedClientOrArchivePromise;
      const genesisHash = client.genesisHash.toHex();

      if (!this.frameHistory[0]) {
        const spec = client.runtimeVersion;
        const genesisTick = NetworkConfig.get().genesisTick;

        this.setFrameHistory({
          frameId: 0,
          frameStartTick: genesisTick,
          dateStart: MiningFrames.getTickDate(genesisTick),
          firstBlockNumber: 0,
          firstBlockHash: genesisHash,
          firstBlockTick: genesisTick,
          firstBlockSpecVersion: spec.specVersion.toNumber(),
        });
      }
      const realtimeWatch = this.blockWatch.events.on('best-blocks', headers => void this.onBestBlocks(headers));
      await this.blockWatch.start();
      await this.onBestBlocks(this.blockWatch.latestHeaders);
      console.log('[Mining Frames] Loaded...');
      this.unsubscribes.push(realtimeWatch);
      this.loadDeferred.resolve();
    } catch (error) {
      this.loadDeferred.reject(error);
    }
    return this.loadDeferred.promise;
  }

  private async onBestBlocks(headers: IBlockHeaderInfo[]): Promise<void> {
    const result = this.updateQueue.add(async () => {
      await this.checkForFrameChange(headers);

      const latest = headers.at(-1);
      if (latest) {
        if (this.currentTick < latest.tick) {
          this.currentTick = latest.tick;
          this.events.emit('on-tick', this.currentTick);
        }
        if (latest.frameRewardTicksRemaining !== undefined) {
          this.currentFrameRewardTicksRemaining = latest.frameRewardTicksRemaining;
        } else {
          const client = await this.clients.apiAt(latest.blockHash, false);
          this.currentFrameRewardTicksRemaining = await client.query.miningSlot
            .frameRewardTicksRemaining()
            .then(x => x.toNumber());
        }
      }
    });
    await result.promise.catch(err => {
      console.error('Error processing mining frames update queue', err);
    });
  }

  public async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    await this.updateQueue.stop();
  }

  public earliestWithSpec(specVersion: number): number {
    const frameIds = [...this.frameIds];
    for (const frameId of frameIds) {
      const frame = this.frameHistory[frameId];
      if (frame.firstBlockSpecVersion && frame.firstBlockSpecVersion >= specVersion) {
        return frameId;
      }
    }
    return this.currentFrameId;
  }

  public async waitForFrameId(frameId: number): Promise<void> {
    if (this.currentFrameId >= frameId) {
      return;
    }
    return new Promise(resolve => {
      const unsubscribe = this.events.on('on-frame', ({ frameId: n }) => {
        if (n >= frameId) {
          resolve();
          unsubscribe();
        }
      });
    });
  }

  public async waitForTick(tick: number): Promise<void> {
    if (this.currentTick >= tick) {
      return;
    }
    return new Promise(resolve => {
      const unsubscribe = this.events.on('on-tick', n => {
        if (n >= tick) {
          resolve();
          unsubscribe();
        }
      });
    });
  }

  public onTick(callback: (tick: number) => Promise<void> | void): { unsubscribe: () => void } {
    const unsubscribe = this.events.on('on-tick', tick => {
      void callback(tick);
    });
    void callback(this.currentTick);
    return { unsubscribe };
  }

  public onFrameId(callback: (frameId: number) => Promise<void> | void): { unsubscribe: () => void } {
    const unsubscribe = this.events.on('on-frame', ({ frameId }) => {
      void callback(frameId);
    });
    void callback(this.currentFrameId);
    return { unsubscribe };
  }

  public getForTick(tick: number) {
    for (let frameId = this.currentFrameId; frameId >= 0; frameId--) {
      const frame = this.frameHistory[frameId];
      if (!frame) continue;
      const nextFrame = this.frameHistory[frameId + 1];
      if (!nextFrame && tick >= frame.frameStartTick) {
        return frameId;
      }

      if (nextFrame) {
        if (tick >= frame.frameStartTick && tick < nextFrame.frameStartTick) {
          return frameId;
        }
      }
    }
    console.warn('[MiningFrames] Tick not found in frame history:', tick, this.currentFrameId, this.frameHistory);
    throw new Error(`Tick ${tick} is not present in frame history`);
  }

  public static getTickDate(tick: number): Date {
    const tickMillis = NetworkConfig.tickMillis;
    return new Date(tick * tickMillis);
  }

  public getCurrentFrameProgress(): number {
    const ticksRemaining = this.currentFrameRewardTicksRemaining;
    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;

    return getPercent(ticksPerFrame - ticksRemaining, ticksPerFrame);
  }

  public isFirstFrameTick(tick: number): boolean {
    const frameId = this.getForTick(tick);
    const frameStartTick = this.getTickStart(frameId);
    return tick === frameStartTick;
  }

  public getFrameRewardTicksRemaining(frameId?: number): number {
    if (frameId !== undefined) {
      if (frameId < this.currentFrameId) {
        return 0;
      }
      if (frameId > this.currentFrameId) {
        return NetworkConfig.rewardTicksPerFrame;
      }
    }
    return this.currentFrameRewardTicksRemaining;
  }

  public getFrameDate(frameId: number): Date {
    const tick = frameId > this.currentFrameId ? this.estimateTickForFrame(frameId) : this.getTickStart(frameId);
    return MiningFrames.getTickDate(tick);
  }

  public getTickEnd(frameId: number): number {
    if (frameId === undefined) return 0;
    const nextFrame = this.frameHistory[frameId + 1];
    if (nextFrame) {
      return nextFrame.frameStartTick - 1;
    } else {
      return this.currentTick + this.currentFrameRewardTicksRemaining;
    }
  }

  public getTickStart(frameId: number): number {
    const frame = this.frameHistory[frameId];
    if (!frame) {
      throw new Error(`Frame ID ${frameId} is not present in frame history`);
    }
    return frame.frameStartTick;
  }

  public estimateTickForFrame(frameId: number): number {
    const latestFrame = this.frameHistory[this.currentFrameId];
    if (!latestFrame) {
      throw new Error('No latest frame data available for tick estimation');
    }
    const ticksPerFrame = NetworkConfig.rewardTicksPerFrame;
    const framesAhead = frameId - this.currentFrameId;
    return latestFrame.frameStartTick + framesAhead * ticksPerFrame;
  }

  private setFrameHistory(data: IFrameHistory): boolean {
    const existing = this.frameHistory[data.frameId];
    if (existing) {
      const hasChanges = Object.entries(data).filter(([key, value]) => {
        if (value instanceof Date) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          return (existing as any)[key].getTime() !== value.getTime();
        }
        return (existing as any)[key] !== value;
      });
      if (!hasChanges.length) {
        return false;
      }
      console.log('[Mining Frames] Updating existing frame history entry', data.frameId, hasChanges, existing);
      Object.assign(existing, data);
    } else {
      this.frameHistory[data.frameId] = data;
    }
    if (data.frameId > this.currentFrameId) {
      this.currentFrameId = data.frameId;
    }
    return true;
  }

  private async safeSaveUpdates() {
    if (!this.updatesWriter) return;
    try {
      await this.updatesWriter.write(JSON.stringify(this.frameHistory));
    } catch (error) {
      console.error('[Mining Frames] Error saving frame updates', error);
    }
  }

  private async checkForFrameChange(headers: IBlockHeaderInfo[]): Promise<void> {
    let hasNewFrame = false;

    for (const header of headers) {
      if (header.frameId === undefined) {
        hasNewFrame = true;
      } else if (header.isNewFrame) {
        if (header.frameId > this.currentFrameId) {
          hasNewFrame = true;
        }
        if (this.frameHistory[header.frameId]?.firstBlockHash !== header.blockHash) {
          hasNewFrame = true;
        }
      }
    }

    if (!hasNewFrame) {
      return;
    }

    const localOrArchive = await this.clients.prunedClientOrArchivePromise;
    const rawFrameStartBlocks = await localOrArchive.query.miningSlot.frameStartBlockNumbers();

    const queue = rawFrameStartBlocks.map(x => x.toNumber());
    if (!queue.length) {
      console.warn('[Mining Frames] No frame start block numbers found');
      return;
    }
    let hasChanges = false;
    do {
      const blockNumber = queue.shift()!;
      const blockClient = await this.blockWatch.getRpcClient(blockNumber);
      const blockHash = await blockClient.rpc.chain.getBlockHash(blockNumber).then(x => x.toHex());
      const header = await blockClient.rpc.chain.getHeader(blockHash);
      const api = await blockClient.at(blockHash);
      const frameInfo = getFrameInfoFromHeader(header);
      const startingTick = getTickFromHeader(header)!;
      const frameId: number =
        frameInfo?.frameId ?? (await api.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1));

      const existing = this.frameHistory[frameId];
      if (existing && existing.firstBlockHash === blockHash) {
        break;
      }

      const isChanged = this.setFrameHistory({
        frameId,
        frameStartTick: startingTick,
        dateStart: MiningFrames.getTickDate(startingTick),
        firstBlockNumber: blockNumber,
        firstBlockHash: blockHash,
        firstBlockTick: startingTick,
        firstBlockSpecVersion: api.runtimeVersion.specVersion.toNumber(),
      });
      if (isChanged) {
        this.events.emit('on-frame', { frameId, blockNumber, blockHash });
        this.events.emit('on-tick', startingTick);
        hasChanges = true;
      }

      if (queue.length === 0) {
        const frameStartBlockNumbers = await api.query.miningSlot.frameStartBlockNumbers();
        for (const bn of frameStartBlockNumbers) {
          const bnNumber = bn.toNumber();
          if (bnNumber < blockNumber) {
            queue.push(bnNumber);
          }
        }
      }
    } while (queue.length > 0);

    if (hasChanges) {
      await this.safeSaveUpdates();
    }
  }

  public static calculateCurrentTickFromSystemTime(): number {
    const config = NetworkConfig.get();
    return Math.floor(Date.now() / config.tickMillis);
  }
}
