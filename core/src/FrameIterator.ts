import type { MainchainClients } from './MainchainClients.js';
import {
  type ApiDecoration,
  type ArgonClient,
  type BlockHash,
  getTickFromHeader,
  type Header as BlockHeader,
  type u64,
} from '@argonprotocol/mainchain';
import { LRU } from 'tiny-lru';
import { MiningFrames } from './MiningFrames.js';

export type { ApiDecoration };

export type ICallbackFirstBlockMeta = {
  specVersion: number;
  blockNumber: number;
  blockHash: BlockHash;
  blockTick: number;
};

export type ICallbackForFrame<T> = (
  frameId: number,
  firstBlockMeta: ICallbackFirstBlockMeta,
  api: ApiDecoration<'promise'>,
  abortController: AbortController,
) => Promise<T>;

export type ICallbackForFrameAll<T> = (
  frameId: number,
  firstBlockMeta: ICallbackFirstBlockMeta | null,
  api: ApiDecoration<'promise'> | null,
  abortController: AbortController,
) => Promise<T>;

export interface IBlockAndApi {
  blockHash: BlockHash;
  tick: number;
  frameId: number;
  specVersion: number;
  api: ApiDecoration<'promise'>;
}

export class FrameIterator {
  static cachedApiByBlockNumber = new LRU<IBlockAndApi>(200);
  static frameStartBlocksByBlockNumber = new LRU<number[]>(100);

  constructor(
    public readonly clients: MainchainClients,
    private name: string = 'FrameIterator',
  ) {}

  public async iterateFramesByEpoch(callback: ICallbackForFrame<void>): Promise<void> {
    const archiveClient = await this.clients.archiveClientPromise;
    const abortController = new AbortController();
    const seenFrames = new Set<number>();

    const startBlockNumber = await this.getBlockNumber(archiveClient);

    // start with the latest known frame start block
    let blockNumber = (await this.getFrameStartBlockNumbers(startBlockNumber)).at(0) ?? 0;

    while (blockNumber > 0) {
      const { blockHash, api, specVersion, tick, frameId } = await this.getApiAtBlockNumber(blockNumber);
      if (!this.doesApiSupportFrameStartBlocks(api)) break;

      if (!seenFrames.has(frameId)) {
        seenFrames.add(frameId);
        console.log(`[${this.name}] Exploring epoch frame ${frameId} (blockNumber = ${blockNumber})`);
        const meta = {
          specVersion,
          blockNumber,
          blockHash,
          blockTick: tick,
        };
        await callback(frameId, meta, api, abortController);
        if (abortController.signal.aborted || frameId <= 1) {
          let message = `[${this.name}] Aborting iteration as requested at frame ${frameId}`;
          if (frameId <= 1) message = `[${this.name}] Aborting iteration at frame 1`;
          console.log(message);
          break; // Stop processing if the abort signal is triggered
        }
      }

      const startBlockNumbers = await this.getFrameStartBlockNumbers(blockNumber);
      const next = startBlockNumbers.at(-1) ?? 0;
      if (next === blockNumber) {
        break;
      }
      blockNumber = next;
    }
  }

  public async forEachFrame<T>(callback: ICallbackForFrame<T>, performBlockStartFidelityCheck = false): Promise<T[]> {
    const archiveClient = await this.clients.archiveClientPromise;
    const abortController = new AbortController();
    const seenFrames = new Set<number>();
    const results: T[] = [];

    const startBlockNumber = await this.getBlockNumber(archiveClient);

    const queue = await this.getFrameStartBlockNumbers(startBlockNumber);
    console.log('Starting frame iteration from block numbers:', queue);
    while (queue.length) {
      const blockNumber = queue.shift()!;
      const { blockHash, specVersion, api, tick, frameId } = await this.getApiAtBlockNumber(blockNumber);
      if (!this.doesApiSupportFrameStartBlocks(api)) break;

      if (!seenFrames.has(frameId)) {
        seenFrames.add(frameId);
        if (performBlockStartFidelityCheck) {
          const isFirstBlockOfFrame = await this.isFirstBlockOfFrame(frameId, blockNumber, archiveClient);
          if (!isFirstBlockOfFrame) {
            console.log(
              `[${this.name}] Stopping iteration at block ${blockNumber} as it is not the first block of frame ${frameId}`,
            );
            break;
          }
        }

        console.log(`[${this.name}] Exploring frame ${frameId} (blockNumber = ${blockNumber})`);

        const firstBlockMeta = { specVersion, blockNumber, blockHash, blockTick: tick };
        const result = await callback(frameId, firstBlockMeta, api, abortController);
        results.push(result);
        if (abortController.signal.aborted || frameId <= 1) {
          let message = `[${this.name}] Aborting iteration as requested at frame ${frameId}`;
          if (frameId <= 1) message = `[${this.name}] Aborting iteration at frame 1`;
          console.log(message);
          break; // Stop processing if the abort signal is triggered
        }
      }

      if (queue.length === 0) {
        console.log(
          `[${this.name}] Reached end of known frame start blocks at ${frameId ?? 'frame'}, retrieving previous list...`,
        );
        const frameStartBlockNumbers = await this.getFrameStartBlockNumbers(blockNumber);
        queue.push(...frameStartBlockNumbers);
      }
    }

    return results;
  }

  public async forEachFrameAll<T>(callback: ICallbackForFrameAll<T>): Promise<T[]> {
    const seenFrameIds = new Set<number>();

    let currentBlockNumber = 0;
    let currentFrameId = 0;

    const results: T[] = await this.forEachFrame(
      async (
        frameId: number,
        firstBlockMeta: ICallbackFirstBlockMeta,
        api: ApiDecoration<'promise'>,
        abortController: AbortController,
      ) => {
        currentBlockNumber = firstBlockMeta?.blockNumber ?? 0;
        currentFrameId = frameId;
        seenFrameIds.add(frameId);
        return await callback(frameId, firstBlockMeta, api, abortController);
      },
    );

    const abortController = new AbortController();

    while (currentFrameId > 1) {
      const [frameId, firstBlockMeta, api] = await this.getStartOfFrame(currentFrameId - 1, currentBlockNumber - 1);
      if (firstBlockMeta) {
        currentBlockNumber = firstBlockMeta.blockNumber;
      }
      currentFrameId = frameId;
      console.log(`[${this.name}] Exploring frame ${currentFrameId} (blockNumber = ${currentBlockNumber}) --`);
      await callback(currentFrameId, firstBlockMeta, api, abortController);
    }

    return results;
  }

  private async getStartOfFrame(
    frameIdToFind: number,
    blockNumber: number,
  ): Promise<[number, ICallbackFirstBlockMeta | null, ApiDecoration<'promise'> | null]> {
    const archiveClient = await this.clients.archiveClientPromise;

    // First, get the meta of initial block
    let blockHash = await archiveClient.rpc.chain.getBlockHash(blockNumber);
    let blockHeader = await archiveClient.rpc.chain.getHeader(blockHash);
    let blockTick = getTickFromHeader(archiveClient, blockHeader)!;
    let frameId = MiningFrames.getForHeader(archiveClient, blockHeader);
    const [frameTickStart, _] = MiningFrames.getTickRangeForFrame(frameIdToFind);

    let isFirstJump = true;
    let isFirstBlockOfFrame = false;
    let earliestSearchData: { blockNumber: number; blockTick: number } | null = null;
    let latestSearchData: { blockNumber: number; blockTick: number } = { blockNumber, blockTick };

    while (!isFirstBlockOfFrame) {
      const jump = await this.nextClosestJump(
        isFirstJump,
        frameTickStart,
        { blockNumber, blockTick },
        earliestSearchData,
        latestSearchData,
        frameIdToFind,
      );
      isFirstJump = false;
      blockNumber = jump.blockNumber;
      blockHash = jump.blockHash;
      blockHeader = jump.header;
      blockTick = jump.blockTick;
      frameId = jump.frameId;
      earliestSearchData = jump.earliestSearchData;
      latestSearchData = jump.latestSearchData;

      if (frameId === frameIdToFind) {
        isFirstBlockOfFrame = await this.isFirstBlockOfFrame(frameIdToFind, blockNumber, archiveClient);
      }
      if (jump.hasExhaustedSearch && !isFirstBlockOfFrame) {
        console.log(`[${this.name}] Exhausted search for first block of frame '${frameIdToFind}'`);
        return [frameIdToFind, null, null];
      }
    }

    const api = await archiveClient.at(blockHash);
    const specVersion = api.runtimeVersion.specVersion.toNumber();
    const firstBlockMeta = { specVersion, blockNumber, blockHash, blockTick };

    return [frameIdToFind, firstBlockMeta, api];
  }

  public async getClosestToTick(
    tickToFind: number,
    blockNumber: number,
  ): Promise<[number, ICallbackFirstBlockMeta, ApiDecoration<'promise'>]> {
    const archiveClient = await this.clients.archiveClientPromise;

    // First, get the meta of initial block
    let blockHash = await archiveClient.rpc.chain.getBlockHash(blockNumber);
    let blockHeader = await archiveClient.rpc.chain.getHeader(blockHash);
    let blockTick = getTickFromHeader(archiveClient, blockHeader)!;
    let frameId = MiningFrames.getForHeader(archiveClient, blockHeader);

    let isFirstJump = true;
    let hasFoundOptimalBlock = false;
    let earliestSearchData: { blockNumber: number; blockTick: number } | null = null;
    let latestSearchData: { blockNumber: number; blockTick: number } = { blockNumber, blockTick };

    while (!hasFoundOptimalBlock) {
      const jump = await this.nextClosestJump(
        isFirstJump,
        tickToFind,
        { blockNumber, blockTick },
        earliestSearchData,
        latestSearchData,
      );
      isFirstJump = false;
      blockNumber = jump.blockNumber;
      blockHash = jump.blockHash;
      blockHeader = jump.header;
      blockTick = jump.blockTick;
      frameId = jump.frameId;
      earliestSearchData = jump.earliestSearchData;
      latestSearchData = jump.latestSearchData;
      hasFoundOptimalBlock = jump.hasExhaustedSearch;
    }

    const api = await archiveClient.at(blockHash);
    const specVersion = api.runtimeVersion.specVersion.toNumber();
    const firstBlockMeta = { specVersion, blockNumber, blockHash, blockTick };

    return [frameId!, firstBlockMeta, api];
  }

  private async nextClosestJump(
    isFirstJump: boolean,
    frameTickStart: number,
    currentBlockData: { blockNumber: number; blockTick: number },
    earliestSearchData: { blockNumber: number; blockTick: number } | null,
    latestSearchData: { blockNumber: number; blockTick: number },
    frameIdToFind?: number,
  ): Promise<{
    blockNumber: number;
    blockTick: number;
    frameId: number;
    blockHash: BlockHash;
    header: BlockHeader;
    earliestSearchData: { blockNumber: number; blockTick: number } | null;
    latestSearchData: { blockNumber: number; blockTick: number };
    hasExhaustedSearch: boolean;
  }> {
    const client = await this.clients.archiveClientPromise;

    let blockNumber: number;
    let jumpBy: number;

    if (isFirstJump) {
      // First jump: use tick-based estimation
      const ticksDiff = frameTickStart - currentBlockData.blockTick;
      const ticksPerFrame = MiningFrames.ticksPerFrame; // if first jump, we'll jump by a whole frame
      if (ticksDiff > 0) {
        jumpBy = Math.min(ticksPerFrame, ticksDiff);
      } else if (ticksDiff < 0) {
        jumpBy = Math.max(-ticksPerFrame, ticksDiff);
      } else {
        jumpBy = 0;
      }
      blockNumber = Math.max(0, currentBlockData.blockNumber + jumpBy);
    } else {
      // Subsequent jumps: use binary search between bounds, but respect tick constraints
      const lowerBound = Math.max(0, earliestSearchData ? earliestSearchData.blockNumber + 1 : 0);
      const upperBound = latestSearchData.blockNumber - 1;

      if (lowerBound >= upperBound) {
        // We've narrowed it down to a single block
        blockNumber = lowerBound;
      } else {
        // Binary search: jump to the middle of the remaining range
        const targetBlockNumber = Math.floor((lowerBound + upperBound) / 2);
        const maxJumpBy = Math.max(1, Math.abs(frameTickStart - currentBlockData.blockTick));

        // Respect the tick difference constraint
        if (frameTickStart > currentBlockData.blockTick) {
          // Moving forward: don't jump more than the tick difference
          blockNumber = Math.min(targetBlockNumber, currentBlockData.blockNumber + maxJumpBy);
        } else {
          // Moving backward: don't jump more than the tick difference
          blockNumber = Math.max(targetBlockNumber, currentBlockData.blockNumber - maxJumpBy);
        }
      }
      jumpBy = blockNumber - currentBlockData.blockNumber;
      if (!earliestSearchData) {
        const ticksPerHour = 60; // if we don't have an earlier bound, jump by an hour
        jumpBy = Math.max(-ticksPerHour, jumpBy);
      }
    }

    const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
    const header = await client.rpc.chain.getHeader(blockHash);
    const frameId = MiningFrames.getForHeader(client, header);
    const blockTick = blockNumber === 0 ? await this.getGenesisTick(client) : getTickFromHeader(client, header)!;

    // Update search bounds based on the result. We want to use frameId if it exists.
    const isLessThanTarget = frameIdToFind ? frameId! < frameIdToFind : blockTick < frameTickStart;
    if (isLessThanTarget) {
      // We're before the target, update lower bound
      earliestSearchData = { blockNumber, blockTick };
    } else {
      // We're at or past the target, update upper bound
      latestSearchData = { blockNumber, blockTick };
    }

    return {
      blockNumber,
      blockTick,
      frameId: frameId!,
      blockHash,
      header,
      earliestSearchData,
      latestSearchData,
      hasExhaustedSearch: blockNumber === 0 || jumpBy === 0,
    };
  }

  private doesApiSupportFrameStartBlocks(api: ApiDecoration<'promise'>): boolean {
    return api.runtimeVersion.specVersion.toNumber() >= 124;
  }

  private async getBlockNumber(client: ArgonClient): Promise<number> {
    return await client.query.system.number().then(x => x.toNumber());
  }

  private async isFirstBlockOfFrame(blockFrameId: number, blockNumber: number, client: ArgonClient): Promise<boolean> {
    const previousBlockHash = await client.rpc.chain.getBlockHash(blockNumber - 1);
    const previousBlockHeader = await client.rpc.chain.getHeader(previousBlockHash);
    const previousBlockFrameId = MiningFrames.getForHeader(client, previousBlockHeader) ?? 0;
    return previousBlockFrameId < blockFrameId;
  }

  private async getApiAtBlockNumber(blockNumber: number): Promise<IBlockAndApi> {
    let blockAndApi = FrameIterator.cachedApiByBlockNumber.get(blockNumber);
    if (!blockAndApi) {
      const client = await this.clients.archiveClientPromise;
      const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
      const api = await client.at(blockHash);
      const tick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const specVersion = api.runtimeVersion.specVersion.toNumber();
      let frameId = -1;
      if (specVersion >= 124) {
        frameId = await api.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1);
      } else if (specVersion >= 123) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        frameId = await (api.query.miningSlot as any).nextCohortFrameId().then((x: u64) => x.toNumber() - 1);
      }
      blockAndApi = { blockHash, api, tick, frameId, specVersion };
      FrameIterator.cachedApiByBlockNumber.set(blockNumber, blockAndApi);
    }
    return blockAndApi;
  }

  private async getFrameStartBlockNumbers(blockNumber: number): Promise<number[]> {
    const { api } = await this.getApiAtBlockNumber(blockNumber);

    const rawFrameStartBlocks = await api.query.miningSlot.frameStartBlockNumbers();
    return rawFrameStartBlocks.map(x => x.toNumber());
  }

  private async getGenesisTick(client: ArgonClient): Promise<number> {
    return await client.query.ticks.genesisTick().then((x: { toNumber: () => number }) => x.toNumber());
  }
}
