import { MainchainClients } from '../MainchainClients.ts';
import type { IFrameHistory, IFramesHistory } from '../interfaces/IFramesHistory.ts';
import { NetworkConfig } from '../NetworkConfig.ts';
import { type ArgonClient, getTickFromHeader } from '@argonprotocol/mainchain';

export class FrameHistoryLoader {
  constructor(
    public readonly clients: MainchainClients,
    private readonly frameHistory: IFramesHistory,
  ) {}

  public async syncToLatestStored(): Promise<boolean> {
    let currentBlockNumber = 0;
    let currentFrameId = 0;

    const archiveClient = await this.clients.archiveClientPromise;
    const seenFrames = new Set<number>();

    const finalizedHash = await archiveClient.rpc.chain.getFinalizedHead();
    const finalizedHeader = await archiveClient.rpc.chain.getHeader(finalizedHash);
    const finalizedBlockNumber = finalizedHeader.number.toNumber();

    let hasChanges = false;

    const lastFrameStartBlocks = await this.getFrameStartBlockNumbers(finalizedBlockNumber);
    const queue = [...lastFrameStartBlocks];
    do {
      const blockNumber = queue.shift()!;
      const blockHash = await archiveClient.rpc.chain.getBlockHash(blockNumber).then(x => x.toHex());
      const api = await archiveClient.at(blockHash);
      const tick = await api.query.ticks.currentTick().then(x => x.toNumber());
      const specVersion = api.runtimeVersion.specVersion.toNumber();
      let frameId = -1;
      if (specVersion >= 124) {
        frameId = await api.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1);
      } else {
        break;
      }

      const existing = this.getFrameHistory(frameId);
      if (existing && existing.firstBlockHash === blockHash) {
        // We've reached a frame we already have recorded up to this tick
        console.log(`Frame ${frameId} at block ${blockNumber} already latest in config.`);
        return hasChanges;
      }

      if (!seenFrames.has(frameId)) {
        seenFrames.add(frameId);
        // prior to spec 141, we need to verify this is the first block of the frame is an exact time
        if (specVersion < 141) {
          const isFirstBlockOfFrame = await this.isFirstBlockOfFrame(frameId, blockNumber, archiveClient);
          if (!isFirstBlockOfFrame) {
            console.log(`Stopping iteration at block ${blockNumber} as it is not the first block of frame ${frameId}`);
            break;
          }
        }

        currentBlockNumber = blockNumber;
        currentFrameId = frameId;
        this.setFrameHistory({
          frameId,
          firstBlockNumber: blockNumber,
          firstBlockHash: blockHash,
          firstBlockTick: tick,
          firstBlockSpecVersion: specVersion,
          frameStartTick: tick,
          dateStart: new Date(tick * NetworkConfig.tickMillis),
        });
        hasChanges = true;
      }

      if (queue.length === 0) {
        if (this.doesApiSupportFrameStartBlocks(specVersion)) {
          console.log(`Looking up additional frame start blocks...`);
          const frameStartBlockNumbers = await this.getFrameStartBlockNumbers(blockNumber);
          queue.push(...frameStartBlockNumbers);
        }
      }
    } while (queue.length > 0);

    while (currentBlockNumber > 1) {
      const result = await this.getStartOfFrame(currentFrameId - 1, currentBlockNumber - 1);
      if (!result) {
        console.error(`Failed to find start of frame ${currentFrameId - 1}`);
        break;
      }
      const { specVersion, blockNumber, blockHash, blockTick, frameId } = result;
      currentBlockNumber = blockNumber;
      currentFrameId = frameId;
      const frameStartTick = FrameHistoryLoader.calculatePreSpec141TickForFrame(frameId);

      this.setFrameHistory({
        frameId,
        firstBlockNumber: blockNumber,
        firstBlockHash: blockHash,
        firstBlockTick: blockTick,
        firstBlockSpecVersion: specVersion,
        frameStartTick,
        dateStart: new Date(frameStartTick * NetworkConfig.tickMillis),
      });
      hasChanges = true;
    }
    return hasChanges;
  }

  private getFrameHistory(frameId: number): IFrameHistory | undefined {
    return this.frameHistory.find(f => f.frameId === frameId);
  }

  private setFrameHistory(newEntry: IFrameHistory) {
    const existing = this.getFrameHistory(newEntry.frameId);
    if (existing) {
      Object.assign(existing, newEntry);
      return;
    }
    this.frameHistory.push(newEntry);
  }

  private async getStartOfFrame(frameIdToFind: number, blockNumber: number) {
    const archiveClient = await this.clients.archiveClientPromise;

    // First, get the meta of initial block
    let blockHash = await archiveClient.rpc.chain.getBlockHash(blockNumber).then(x => x.toHex());
    const blockHeader = await archiveClient.rpc.chain.getHeader(blockHash);

    let blockTick = getTickFromHeader(blockHeader)!;

    const { ticksBetweenFrames, biddingStartTick } = NetworkConfig.get();

    // calculate frame based on ticks
    const ticksSinceMiningStart = blockTick - biddingStartTick;
    let frameId = Math.floor(ticksSinceMiningStart / ticksBetweenFrames);
    const frameTickStart = biddingStartTick + frameId * ticksBetweenFrames;

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
      blockTick = jump.blockTick;
      frameId = jump.frameId;
      earliestSearchData = jump.earliestSearchData;
      latestSearchData = jump.latestSearchData;

      console.log('Tried jump to block', { blockNumber, blockTick, frameId, frameIdToFind });
      if (frameId === frameIdToFind) {
        isFirstBlockOfFrame = await this.isFirstBlockOfFrame(frameIdToFind, blockNumber, archiveClient);
      }
      if (jump.hasExhaustedSearch && !isFirstBlockOfFrame) {
        return undefined;
      }
    }

    const runtimeVersion = await archiveClient.rpc.state.getRuntimeVersion(blockHash);
    const specVersion = runtimeVersion.specVersion.toNumber();

    return { specVersion, blockNumber, blockHash, blockTick, frameId };
  }

  private async nextClosestJump(
    isFirstJump: boolean,
    frameTickStart: number,
    currentBlockData: { blockNumber: number; blockTick: number },
    earliestSearchData: { blockNumber: number; blockTick: number } | null,
    latestSearchData: { blockNumber: number; blockTick: number },
    frameIdToFind?: number,
  ) {
    const client = await this.clients.archiveClientPromise;

    let blockNumber: number;
    let jumpBy: number;

    if (isFirstJump) {
      // First jump: use tick-based estimation
      const ticksDiff = frameTickStart - currentBlockData.blockTick;
      const ticksPerFrame = NetworkConfig.rewardTicksPerFrame; // if first jump, we'll jump by a whole frame
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

    const blockHash = await client.rpc.chain.getBlockHash(blockNumber).then(x => x.toHex());
    const header = await client.rpc.chain.getHeader(blockHash);
    const blockTick = blockNumber === 0 ? await this.getGenesisTick(client) : getTickFromHeader(header)!;
    const frameId = this.calculatePreSpec141FrameIdForTick(blockTick);

    // Update search bounds based on the result. We want to use frameId if it exists.
    const isLessThanTarget = frameIdToFind ? frameId < frameIdToFind : blockTick < frameTickStart;
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
      frameId,
      blockHash,
      header,
      earliestSearchData,
      latestSearchData,
      hasExhaustedSearch: blockNumber === 0 || jumpBy === 0,
    };
  }

  private doesApiSupportFrameStartBlocks(specVersion: number): boolean {
    return specVersion >= 123;
  }

  private async isFirstBlockOfFrame(blockFrameId: number, blockNumber: number, client: ArgonClient): Promise<boolean> {
    const previousBlockNumber = blockNumber - 1;
    if (previousBlockNumber < 0) {
      return true;
    }
    const previousBlockHash = await client.rpc.chain.getBlockHash(previousBlockNumber);
    const previousBlockHeader = await client.rpc.chain.getHeader(previousBlockHash);
    const tick = previousBlockNumber === 0 ? await this.getGenesisTick(client) : getTickFromHeader(previousBlockHeader);
    if (tick === undefined) {
      throw new Error(`Cannot determine tick for block ${previousBlockNumber}`);
    }
    const previousBlockFrameId = this.calculatePreSpec141FrameIdForTick(tick);
    return previousBlockFrameId < blockFrameId;
  }

  private async getFrameStartBlockNumbers(blockNumber: number): Promise<number[]> {
    const client = await this.clients.archiveClientPromise;
    const blockHash = await client.rpc.chain.getBlockHash(blockNumber);
    const api = await client.at(blockHash);

    const rawFrameStartBlocks = await api.query.miningSlot.frameStartBlockNumbers();
    return rawFrameStartBlocks.map(x => x.toNumber());
  }

  private async getGenesisTick(client: ArgonClient): Promise<number> {
    return await client.query.ticks.genesisTick().then((x: { toNumber: () => number }) => x.toNumber());
  }

  public static calculatePreSpec141TickForFrame(frameId: number): number {
    const { ticksBetweenFrames, biddingStartTick } = NetworkConfig.get();

    return biddingStartTick + Math.floor(frameId * ticksBetweenFrames);
  }

  /**
   * Prior to specVersion 141, frames were consistently 1440 ticks long, so we could calculate frame ids directly.
   */
  private calculatePreSpec141FrameIdForTick(tick: number) {
    const { ticksBetweenFrames, biddingStartTick } = NetworkConfig.get();

    const ticksSinceMiningStart = tick - biddingStartTick;

    return Math.floor(ticksSinceMiningStart / ticksBetweenFrames);
  }
}
