import { ExtrinsicError } from '@argonprotocol/mainchain';
import {
  BotActivityType,
  type IBidReductionReason,
  type IBotActivity,
  type IBotActivityBidReceived,
  type IHistoryFile,
  JsonExt,
  MiningFrames,
} from '@argonprotocol/apps-core';
import type { Storage } from './Storage.ts';
import Queue from 'p-queue';
import { LRU } from 'tiny-lru';

export class History {
  public maxSeatsInPlay: number = 0;
  public maxSeatsReductionReason: IBidReductionReason | undefined;
  public lastProcessedBlockNumber: number = 0;

  private storage: Storage;
  private lastBids: { address: string; bidMicrogons: bigint }[] = [];

  private loggedAtTimestamp = new LRU<number>();
  private myAddresses: Set<string> = new Set();

  private queue = new Queue({ concurrency: 1, autoStart: true });

  constructor(
    storage: Storage,
    private cohortStartingFrameId: number,
  ) {
    this.storage = storage;
  }

  public get recent(): Promise<IHistoryFile> {
    return new Promise(async (resolve, reject) => {
      const activities: IBotActivity[] = [];
      let lastModifiedAt: Date | undefined;
      try {
        const historyFile = (await this.storage.historyFile(this.cohortStartingFrameId).get())!;
        lastModifiedAt = historyFile.lastModifiedAt;
        activities.push(...historyFile.activities.slice(-20));
        resolve({
          lastModifiedAt,
          activities,
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  public async initCohort(cohortStartingFrameId: number, myAddresses: Set<string>) {
    this.cohortStartingFrameId = cohortStartingFrameId;
    this.myAddresses = myAddresses;
    this.maxSeatsInPlay = this.myAddresses.size;
  }

  public handleStarting() {
    console.log('STARTING');
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.Starting,
      data: {},
    });
  }

  public handleDockersConfirmed() {
    console.log('DOCKERS CONFIRMED');
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.DockersConfirmed,
      data: {},
    });
  }

  public handleStartedSyncing() {
    console.log('STARTED SYNCING');
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.StartedSyncing,
      data: {},
    });
  }

  public handleFinishedSyncing() {
    console.log('FINISHED SYNCING');
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.FinishedSyncing,
      data: {},
    });
  }

  public handleReady() {
    console.log('READY');
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.Ready,
      data: {},
    });
  }

  public handleError(error: Error) {
    console.log('ERROR', error);
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.Error,
      data: { name: error.name, message: error.message },
    });
  }

  public async handleShutdown() {
    console.log('SHUTDOWN');
    this.appendActivities({
      tick: MiningFrames.calculateCurrentTickFromSystemTime(),
      type: BotActivityType.Shutdown,
      data: {},
    });
    await this.queue.onIdle();
  }

  public handleBidsSubmitted(args: {
    tick: number;
    blockNumber: number;
    frameId: number;
    microgonsPerSeat: bigint;
    txFeePlusTip: bigint;
    submittedCount: number;
  }) {
    const { tick, blockNumber, frameId, ...param } = args;
    console.log('BIDS SUBMITTED', { tick, blockNumber, param, frameId });
    this.appendActivities({
      tick,
      blockNumber,
      frameId,
      type: BotActivityType.BidsSubmitted,
      data: param,
    });
  }

  public handleBidsRejected(args: {
    tick: number;
    blockNumber: number;
    frameId: number;
    microgonsPerSeat: bigint;
    rejectedCount: number;
    submittedCount: number;
    bidError?: ExtrinsicError;
  }) {
    const { tick, blockNumber, frameId, ...param } = args;
    console.log('BIDS REJECTED', { tick, blockNumber, param, frameId });
    this.appendActivities({
      tick,
      blockNumber,
      frameId,
      type: BotActivityType.BidsRejected,
      data: param,
    });
  }

  public handleSeatFluctuation(args: {
    tick: number;
    blockNumber: number;
    newMaxSeats: number;
    reason: IBidReductionReason | undefined;
    availableMicrogons: bigint;
    availableMicronots: bigint;
    frameId: number;
  }) {
    const { tick, blockNumber, newMaxSeats, reason, availableMicrogons, availableMicronots, frameId } = args;
    if (newMaxSeats < this.maxSeatsInPlay) {
      this.appendActivities({
        tick,
        blockNumber,
        frameId,
        type: BotActivityType.SeatReduction,
        data: {
          reason,
          maxSeatsInPlay: newMaxSeats,
          prevSeatsInPlay: this.maxSeatsInPlay,
          availableMicrogons,
          availableMicronots,
        },
      });
    } else if (newMaxSeats > this.maxSeatsInPlay) {
      this.appendActivities({
        tick,
        frameId,
        blockNumber,
        type: BotActivityType.SeatExpansion,
        data: {
          reason,
          maxSeatsInPlay: newMaxSeats,
          prevSeatsInPlay: this.maxSeatsInPlay,
          availableMicrogons,
          availableMicronots,
        },
      });
    }

    this.maxSeatsInPlay = newMaxSeats;
    this.maxSeatsReductionReason = reason;
  }

  public handleIncomingBids(args: {
    tick: number;
    blockNumber: number;
    frameId: number;
    nextEntrants: { address: string; bidMicrogons: bigint }[];
    isReloadingInitialState: boolean;
  }) {
    const { tick, blockNumber, nextEntrants, frameId } = args;
    this.lastProcessedBlockNumber = Math.max(blockNumber, this.lastProcessedBlockNumber);
    const hasDiffs = JsonExt.stringify(nextEntrants) !== JsonExt.stringify(this.lastBids);
    if (hasDiffs) {
      if (args.isReloadingInitialState) {
        this.lastBids = nextEntrants;
        return;
      }
      console.log('INCOMING BIDS', { tick, blockNumber, bids: nextEntrants, frameId });
      for (const [i, { address, bidMicrogons }] of nextEntrants.entries()) {
        const prevBidIndex = this.lastBids.findIndex(y => y.address === address);
        const entry: IBotActivityBidReceived = {
          bidderAddress: address,
          microgonsPerSeat: bidMicrogons,
          bidPosition: i,
        };
        if (prevBidIndex !== -1) {
          const prevBidAmount = this.lastBids[prevBidIndex].bidMicrogons;
          if (prevBidAmount !== bidMicrogons) {
            entry.previousMicrogonsPerSeat = prevBidAmount;
          }
          if (prevBidAmount === bidMicrogons && prevBidIndex === i) {
            // no change
            continue;
          }
          entry.previousBidPosition = prevBidIndex;
        }
        this.appendActivities({
          tick,
          blockNumber,
          frameId,
          type: BotActivityType.BidReceived,
          data: entry,
        });
      }

      for (const [i, { address, bidMicrogons }] of this.lastBids.entries()) {
        const nextBid = nextEntrants.some(y => y.address === address);
        if (!nextBid) {
          this.appendActivities({
            tick,
            blockNumber,
            frameId,
            type: BotActivityType.BidReceived,
            data: {
              bidderAddress: address,
              microgonsPerSeat: bidMicrogons,
              bidPosition: null,
              previousBidPosition: i,
            },
          });
        }
      }
      this.lastBids = nextEntrants;
    }
  }

  private createId(tick: number): number {
    const timestamp = Date.now();
    let count = 0;
    if (!this.loggedAtTimestamp.get(timestamp)) {
      this.loggedAtTimestamp.set(timestamp, 1);
    } else {
      // prevent multiple activities getting the same ID if created in the same millisecond
      count = this.loggedAtTimestamp.get(timestamp)!;
      this.loggedAtTimestamp.set(timestamp, count + 1);
    }

    const countStr = count.toString().padStart(4, '0');
    return Number(`${tick}${countStr}`);
  }

  private appendActivities(...activities: Omit<IBotActivity, 'id'>[]) {
    for (const activity of activities) {
      (activity as IBotActivity).id ??= this.createId(activity.tick);
      const frameId = ((activity as IBotActivity).frameId ??= this.cohortStartingFrameId);
      void this.queue.add(() =>
        this.storage.historyFile(frameId).mutate((history: IHistoryFile) => {
          history.activities.push(...(activities as IBotActivity[]));
        }),
      );
    }
  }
}
