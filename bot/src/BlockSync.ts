import {
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
  getAuthorFromHeader,
  getTickFromHeader,
  type Header,
  type SpRuntimeDispatchError,
  type Vec,
} from '@argonprotocol/mainchain';
import {
  AccountMiners,
  type Accountset,
  type IBlock,
  type IBlockSyncFile,
  type IBotState,
  type IBotStateFile,
  type IBotSyncStatus,
  type IEarningsFile,
  type IWinningBid,
  MainchainClients,
  Mining,
  MiningFrames,
  PriceIndex,
} from '@argonprotocol/commander-core';
import { type Storage } from './Storage.ts';
import { JsonStore } from './JsonStore.ts';
import { Dockers } from './Dockers.ts';

export interface ILastProcessed {
  date: Date;
  frameId: number;
  blockNumber: number;
}

export class BlockSync {
  lastProcessed?: ILastProcessed;
  accountMiners!: AccountMiners;
  latestFinalizedBlockNumber!: number;
  scheduleTimer?: NodeJS.Timeout;
  botStateFile: JsonStore<IBotStateFile>;
  blockSyncFile: JsonStore<IBlockSyncFile>;
  inProcessSync?: ReturnType<BlockSync['processNext']>;

  currentFrameTickRange: [number, number] = [0, 0];

  oldestTickToSync: number = 0;
  latestTick: number = 0;
  lastSynchedTick: number = 0;
  earliestQueuedTick?: number;

  didProcessBlock?: (lastProcessed: ILastProcessed) => void;

  private unsubscribe?: () => void;
  private isStopping: boolean = false;
  private mining!: Mining;
  private lastExchangeRateDate?: Date;
  private lastExchangeRateFrameId?: number;
  private tickDurationMillis!: number;
  private latestBestBlockHeader?: Header;
  private localClient!: ArgonClient;
  private archiveClient!: ArgonClient;
  private priceIndex: PriceIndex;

  constructor(
    public bot: IBotSyncStatus,
    public accountset: Accountset,
    public storage: Storage,
    public mainchainClients: MainchainClients,
    private oldestFrameIdToSync?: number,
  ) {
    this.scheduleNext = this.scheduleNext.bind(this);
    this.botStateFile = this.storage.botStateFile();
    this.blockSyncFile = this.storage.botBlockSyncFile();
    this.mining = new Mining(this.mainchainClients);
    this.priceIndex = new PriceIndex(this.mainchainClients);
  }

  async load() {
    this.isStopping = false;
    const localClient = await this.mainchainClients.prunedClientPromise;
    if (!localClient) {
      throw new Error('Pruned client is not available');
    }
    // ensure local client has state
    await localClient.query.system.number().catch(x => {
      console.error('Error getting system number from local client', x);
      throw new Error('Local client is not ready');
    });

    this.localClient = localClient;
    this.archiveClient = await this.mainchainClients.archiveClientPromise;

    const archiveFinalizedHash = await this.archiveClient.rpc.chain.getFinalizedHead();
    const archiveFinalizedHeader = await this.archiveClient.rpc.chain.getHeader(archiveFinalizedHash);
    const archiveFinalizedNumber = archiveFinalizedHeader.number.toNumber();
    // get latest finalized from archive client
    const finalizedHash = await this.localClient.rpc.chain.getFinalizedHead();
    const finalizedHeader = await this.localClient.rpc.chain.getHeader(finalizedHash);
    const localFinalizedNumber = finalizedHeader.number.toNumber();
    if (localFinalizedNumber < archiveFinalizedNumber - 10) {
      throw new Error(
        `Local client has not synched within range of the archive client (10 blocks). Archive Client=${archiveFinalizedNumber} vs Local=${localFinalizedNumber}`,
      );
    }
    this.latestFinalizedBlockNumber = localFinalizedNumber;
    this.tickDurationMillis = await this.archiveClient.query.ticks
      .genesisTicker()
      .then(x => x.tickDurationMillis.toNumber());

    await this.botStateFile.mutate(async x => {
      if (!x.oldestFrameIdToSync) {
        x.oldestFrameIdToSync =
          this.oldestFrameIdToSync ??
          MiningFrames.getForHeader(this.archiveClient, finalizedHeader) ??
          MiningFrames.calculateCurrentFrameIdFromSystemTime();
        if (x.oldestFrameIdToSync === 0 && !MiningFrames.canFrameBeZero()) {
          throw new Error(`Oldest frame to sync cannot be be 0`);
        }
        console.log(`Set oldest frame to ${x.oldestFrameIdToSync}`);
      }
      const oldestTickRange = MiningFrames.getTickRangeForFrame(x.oldestFrameIdToSync);
      this.oldestTickToSync = oldestTickRange[0];
      this.oldestFrameIdToSync = x.oldestFrameIdToSync;

      console.log('Sync starting', {
        ...x,
      });
    });

    await this.backfillBestBlockHeader(await this.localClient.rpc.chain.getHeader(), true);

    const data = (await this.blockSyncFile.get())!;
    console.log('After initial sync state', {
      ...data,
      blocksByNumber: Object.keys(data.blocksByNumber).length,
    });

    const oldestBlock =
      data.blocksByNumber[data.syncedToBlockNumber + 1] ?? data.blocksByNumber[data.syncedToBlockNumber];
    if (!oldestBlock) {
      throw new Error(`No block found to start syncing from at ${data.syncedToBlockNumber + 1}`);
    }
    const accountMinersClient = await this.archiveClient.at(oldestBlock.hash);
    const startingMinerState = await this.accountset.loadRegisteredMiners(accountMinersClient);
    const registeredMiners = startingMinerState
      .filter(x => x.seat !== undefined)
      .map(x => ({
        ...x,
        startingFrameId: x.seat?.startingFrameId,
      }));

    this.accountMiners = new AccountMiners(this.accountset, registeredMiners as any);

    // catchup now
    await this.syncToLatest();
  }

  async backfillBestBlockHeader(header: Header, isFirstLoad = false): Promise<IBlockSyncFile | undefined> {
    if (this.isStopping) return;
    // plug any gaps in the sync state
    let final: IBlockSyncFile | undefined;
    this.latestTick = getTickFromHeader(this.localClient, header)!;

    await this.blockSyncFile.mutate(async x => {
      x.finalizedBlockNumber = this.latestFinalizedBlockNumber;
      x.bestBlockNumber = header.number.toNumber();

      while (header != null) {
        const blockHash = header.hash.toHex();
        const blockNumber = header.number.toNumber();
        if (blockNumber === 0) {
          console.info('Block sync backfill reached genesis block, stopping');
          break;
        }
        const tick = getTickFromHeader(this.localClient, header)!;
        const headerFrameId = MiningFrames.getForTick(tick);

        if (x.blocksByNumber[blockNumber]?.hash === blockHash || headerFrameId < this.oldestFrameIdToSync!) {
          if (isFirstLoad) {
            console.info('Found oldest block to backfill', {
              blockNumber,
              headerFrameId,
              oldestToKeep: this.oldestFrameIdToSync,
            });
          }
          break;
        }
        console.log(`Queueing block to sync. Block: ${blockNumber}, Frame ID: ${headerFrameId}, Hash: ${blockHash}`);
        // set synced back if we are syncing to a block that is older than the current synced block
        if (x.syncedToBlockNumber >= blockNumber) {
          x.syncedToBlockNumber = blockNumber - 1;
        }

        const author = getAuthorFromHeader(this.localClient, header)!;
        x.blocksByNumber[blockNumber] = {
          hash: blockHash,
          tick,
          number: blockNumber,
          author,
        };
        if (isFirstLoad) {
          this.earliestQueuedTick ??= tick;
          this.earliestQueuedTick = Math.min(tick, this.earliestQueuedTick);
        }
        // don't go back to genesis
        if (blockNumber === 1) {
          console.log('Reached genesis block, stopping backfill');
          break;
        }
        try {
          // get an rpc client that can get the parent header
          header = await this.getRpcClient(blockNumber - 1).rpc.chain.getHeader(header.parentHash);
        } catch (e) {
          console.error(`Error getting parent header for ${blockNumber}`, e);
          if (isFirstLoad) {
            x.blocksByNumber = {};
            x.syncedToBlockNumber = 0;
            throw e;
          }
          break; // stop if we can't get the parent header
        }
      }

      const blockKeys = Object.keys(x.blocksByNumber).map(Number);
      let minBlock = blockKeys[0] ?? 0;
      for (const key of blockKeys) {
        if (key < minBlock) minBlock = key;
      }
      let oldestToKeep = Math.min(x.syncedToBlockNumber, x.finalizedBlockNumber);
      oldestToKeep -= 5; // keep some overflow
      for (const key of blockKeys) {
        // it is possible that bestBlockNumber is less than the best block if we have a re-org
        if (key < oldestToKeep || key > x.bestBlockNumber) {
          delete x.blocksByNumber[key];
        }
      }
      if (x.syncedToBlockNumber > x.bestBlockNumber) {
        x.syncedToBlockNumber = x.bestBlockNumber;
      }
      if (x.syncedToBlockNumber < minBlock - 1) {
        x.syncedToBlockNumber = minBlock - 1;
      }
      final = x;
    });
    return final;
  }

  async start() {
    const unsub1 = await this.localClient.rpc.chain.subscribeNewHeads(header => {
      this.latestBestBlockHeader = header;
    });
    const unsub2 = await this.localClient.rpc.chain.subscribeFinalizedHeads(header => {
      this.latestFinalizedBlockNumber = header.number.toNumber();
    });
    this.unsubscribe = () => {
      unsub1();
      unsub2();
    };

    await this.scheduleNext();
  }

  async stop() {
    if (this.isStopping) return;
    console.log('BLOCKSYNC STOPPING');
    this.isStopping = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    await this.inProcessSync;
    this.inProcessSync = undefined;
    await this.archiveClient.disconnect();
    console.log('BLOCKSYNC STOPPED');
    // local client is not owned by this service
  }

  async state(): Promise<IBotState> {
    const [argonBlockNumbers, bitcoinBlockNumbers, botStateData, blockSyncData] = await Promise.all([
      Dockers.getArgonBlockNumbers(),
      Dockers.getBitcoinBlockNumbers(),
      this.botStateFile.get(),
      this.blockSyncFile.get(),
    ]);
    const { syncedToBlockNumber, bestBlockNumber, finalizedBlockNumber } = blockSyncData!;
    return {
      ...botStateData!,
      isReady: this.bot.isReady || false,
      isStarting: this.bot.isStarting || undefined,
      isSyncing: this.bot.isSyncing || undefined,
      lastBlockNumber: bestBlockNumber,
      lastFinalizedBlockNumber: finalizedBlockNumber,
      syncedToBlockNumber,
      argonBlockNumbers,
      bitcoinBlockNumbers,
      queueDepth: bestBlockNumber - syncedToBlockNumber,
      maxSeatsPossible: this.bot.maxSeatsInPlay ?? 10, // TODO: instead of hardcoded 10, fetch from chain
      maxSeatsReductionReason: this.bot.maxSeatsReductionReason ?? '',
    };
  }

  async calculateSyncProgress(): Promise<number> {
    const processingProgress = this.calculateProgress(this.lastSynchedTick, [this.oldestTickToSync, this.latestTick]);

    let queueProgress = 100;
    if (processingProgress === 0) {
      const ticksQueued = this.latestTick - (this.earliestQueuedTick ?? this.latestTick);
      queueProgress = this.calculateProgress(this.oldestTickToSync + ticksQueued, [
        this.oldestTickToSync,
        this.latestTick,
      ]);
    }

    const progress = (queueProgress + processingProgress) / 2;

    return Math.round(progress * 100) / 100;
  }

  async syncToLatest() {
    while (true) {
      const result = await this.processNext();
      if (!result) {
        break;
      }
    }
    console.log('Synched to latest');
  }

  async scheduleNext(waitTime: number = 500): Promise<void> {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    if (this.isStopping) return;

    try {
      const latestBestBlockHeader = this.latestBestBlockHeader;
      this.latestBestBlockHeader = undefined;
      if (latestBestBlockHeader) {
        await this.backfillBestBlockHeader(latestBestBlockHeader);
      }
      this.inProcessSync = this.processNext();
      const result = await this.inProcessSync;
      if (result?.remaining ?? 0 > 0) {
        waitTime = 0;
      }
    } catch (e) {
      console.error(`Error processing next header`, e);
      if (this.isStopping) return;
      throw e;
    }
    this.scheduleTimer = setTimeout(() => void this.scheduleNext(), waitTime);
  }

  async processNext(): Promise<{ processed: IBlock; remaining: number } | undefined> {
    const blockSyncData = (await this.blockSyncFile.get())!;
    const bestBlockNumber = blockSyncData.bestBlockNumber;
    const syncedToBlockNumber = blockSyncData.syncedToBlockNumber;
    if (syncedToBlockNumber >= bestBlockNumber) {
      return undefined;
    }

    const blockNumber = syncedToBlockNumber + 1;
    if (blockNumber < 1) return;
    const blockMeta = blockSyncData.blocksByNumber[blockNumber];

    console.log(`Processing block ${blockNumber}`, blockMeta);

    const client = this.getRpcClient(blockNumber);
    const api = await client.at(blockMeta.hash);
    const events = await api.query.system.events();
    const { duringFrameId: _r, ...cohortEarningsAtFrameId } = await this.accountMiners.onBlock(
      null as any,
      blockMeta,
      events.map(x => x.event),
    );
    const tick = blockMeta.tick;
    const tickDate = new Date(tick * this.tickDurationMillis);

    const currentFrameId = MiningFrames.getForTick(tick);
    if (this.lastProcessed?.frameId !== currentFrameId) {
      this.currentFrameTickRange = MiningFrames.getTickRangeForFrame(currentFrameId);
    }

    const { hasMiningBids, hasMiningSeats } = await this.syncBidding(currentFrameId, blockMeta, events);
    await this.storage.earningsFile(currentFrameId).mutate(async x => {
      x.frameTickRange = this.currentFrameTickRange;
      x.firstBlockNumber ||= blockNumber;
      x.lastBlockNumber = blockNumber;

      const secondsSinceLastExchangeRate = this.lastExchangeRateDate
        ? (new Date().getTime() - this.lastExchangeRateDate.getTime()) / 1000
        : null;
      const checkedExchangeRateThisHour = secondsSinceLastExchangeRate !== null && secondsSinceLastExchangeRate < 3600;
      const checkedExchangeRateThisFrame = this.lastExchangeRateFrameId === currentFrameId;

      if (!checkedExchangeRateThisFrame || !checkedExchangeRateThisHour) {
        this.lastExchangeRateDate = new Date();
        this.lastExchangeRateFrameId = currentFrameId;
        const microgonExchangeRateTo = await this.priceIndex.fetchMicrogonExchangeRatesTo(api);
        x.microgonToUsd.push(microgonExchangeRateTo.USD);
        x.microgonToBtc.push(microgonExchangeRateTo.BTC);
        x.microgonToArgonot.push(microgonExchangeRateTo.ARGNOT);
      }

      // there can only be one mining cohort that mines a block, so we can safely use the first one
      const miningEarnings = Object.entries(cohortEarningsAtFrameId)[0];
      if (miningEarnings) {
        const {
          argonsMinted: microgonsMinted,
          argonsMined: microgonsMined,
          argonotsMined: micronotsMined,
        } = miningEarnings[1];

        x.earningsByBlock[blockNumber] = {
          blockHash: blockMeta.hash,
          authorCohortActivationFrameId: Number(miningEarnings[0]),
          authorAddress: blockMeta.author,
          blockMinedAt: tickDate.toString(),
          microgonFeesCollected: await api.query.blockRewards.blockFees().then(x => x.toBigInt()),
          micronotsMined,
          microgonsMined,
          microgonsMinted,
        };
      } else {
        // there's a chance we've re-orged and the block is not a mining block anymore, so clear it
        delete x.earningsByBlock[blockNumber];
      }

      const calculatedProfits = await this.calculateAccruedProfits(x);
      x.accruedMicrogonProfits = calculatedProfits.accruedMicrogonProfits;
      x.previousFrameAccruedMicrogonProfits = calculatedProfits.previousFrameAccruedMicrogonProfits;
      x.accruedMicronotProfits = calculatedProfits.accruedMicronotProfits;
      x.previousFrameAccruedMicronotProfits = calculatedProfits.previousFrameAccruedMicronotProfits;
    });

    this.lastSynchedTick = tick;
    this.latestTick = Math.max(this.latestTick, tick);

    this.lastProcessed = {
      date: new Date(),
      frameId: currentFrameId,
      blockNumber,
    };

    await this.blockSyncFile.mutate(x => {
      x.syncedToBlockNumber = blockNumber;
    });

    await this.botStateFile.mutate(x => {
      if (hasMiningBids) x.bidsLastModifiedAt = new Date();
      if (hasMiningSeats) x.hasMiningSeats = true;
      x.earningsLastModifiedAt = new Date();
      x.currentFrameId = currentFrameId;
      x.currentTick = tick;
      x.currentFrameTickRange = this.currentFrameTickRange;
      x.syncProgress = this.calculateProgress(this.lastSynchedTick, [this.oldestTickToSync, this.latestTick]);
      x.lastBlockNumberByFrameId[currentFrameId] = blockNumber;
    });

    this.didProcessBlock?.(this.lastProcessed);
    const remaining = bestBlockNumber - blockNumber;
    const syncPercent = (blockNumber * 100) / bestBlockNumber;
    const syncString = syncPercent >= 100 ? '' : ` (synced ${syncPercent.toFixed(1)}%)`;
    console.log(`Processed block ${blockNumber} at tick ${tick}${syncString}.`);
    return {
      processed: blockMeta,
      remaining,
    };
  }

  private async syncBidding(
    cohortBiddingFrameId: number,
    block: IBlock,
    events: Vec<FrameSystemEventRecord>,
  ): Promise<{ hasMiningBids: boolean; hasMiningSeats: boolean }> {
    const client = this.getRpcClient(block.number);
    const api = await client.at(block.hash);

    const blockNumber = block.number;

    let biddingTransactionFees = 0n;
    let hasMiningBids = false;
    let hasMiningSeats = false;

    for (const { event, phase } of events) {
      if (phase.isApplyExtrinsic) {
        const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
        const extrinsicEvents = events.filter(
          x => x.phase.isApplyExtrinsic && x.phase.asApplyExtrinsic.toNumber() === extrinsicIndex,
        );
        biddingTransactionFees += await this.extractOwnPaidTransactionFee(client, event, extrinsicEvents);
      }

      if (phase.isFinalization && client.events.miningSlot.NewMiners.is(event)) {
        console.log('New miners event', event.data.toJSON());
        const { frameId, newMiners } = event.data;
        const activationFrameIdOfNewCohort = frameId.toNumber();
        const biddingFrameIdOfNewCohort = activationFrameIdOfNewCohort - 1;
        const activeMiners = await api.query.miningSlot.activeMinersCount().then(x => x.toNumber());
        const biddingFrameTickRange = MiningFrames.getTickRangeForFrame(biddingFrameIdOfNewCohort);
        const lastBidsFile = this.storage.bidsFile(biddingFrameIdOfNewCohort, activationFrameIdOfNewCohort);
        await lastBidsFile.mutate(async x => {
          x.seatCountWon = 0;
          x.microgonsBidTotal = 0n;
          x.winningBids = [];
          x.biddingFrameTickRange = biddingFrameTickRange;
          x.lastBlockNumber = blockNumber;
          x.allMinersCount = activeMiners;

          if (x.micronotsStakedPerSeat === 0n) {
            x.micronotsStakedPerSeat = await api.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
          }
          if (x.microgonsToBeMinedPerBlock === 0n) {
            x.microgonsToBeMinedPerBlock = await this.mining.getMicrogonsPerBlockForMiner(api);
          }

          let bidPosition = 0;
          for (const miner of newMiners) {
            const address = miner.accountId.toHuman();
            const microgonsPerSeat = miner.bid.toBigInt();
            const ourSubAccount = this.accountset.subAccountsByAddress[address];
            if (ourSubAccount) {
              hasMiningSeats = true;
              x.seatCountWon += 1;
              x.microgonsBidTotal += microgonsPerSeat;
            }
            x.winningBids.push({
              address,
              subAccountIndex: ourSubAccount?.index,
              lastBidAtTick: miner.bidAtTick?.toNumber(),
              bidPosition,
              microgonsPerSeat,
            });
            bidPosition++;
          }
        });
      }
    }

    const cohortActivationFrameId = await api.query.miningSlot.nextFrameId().then(x => x.toNumber());
    const bidsFile = this.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId);
    const nextCohort = await api.query.miningSlot.bidsForNextSlotCohort();
    let transactionFeesTotal = 0n;

    await bidsFile.mutate(async x => {
      if (x.micronotsStakedPerSeat === 0n) {
        x.micronotsStakedPerSeat = await api.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
      }
      if (x.microgonsToBeMinedPerBlock === 0n) {
        x.microgonsToBeMinedPerBlock = await this.mining.getMicrogonsPerBlockForMiner(api);
      }
      x.biddingFrameTickRange = this.currentFrameTickRange;
      x.lastBlockNumber = blockNumber;
      x.winningBids = nextCohort.map((c, i): IWinningBid => {
        const address = c.accountId.toHuman();
        const microgonsPerSeat = c.bid.toBigInt();
        const ourSubAccount = this.accountset.subAccountsByAddress[address];
        if (ourSubAccount) {
          hasMiningBids = true;
        }
        return {
          address,
          subAccountIndex: ourSubAccount?.index,
          lastBidAtTick: c.bidAtTick?.toNumber(),
          bidPosition: i,
          microgonsPerSeat,
        };
      });
      if (biddingTransactionFees > 0n) {
        x.transactionFeesByBlock[blockNumber] = biddingTransactionFees;
      } else {
        delete x.transactionFeesByBlock[blockNumber];
      }
      transactionFeesTotal = Object.values(x.transactionFeesByBlock).reduce((acc, curr) => acc + curr, 0n);
    });
    await this.storage.earningsFile(cohortBiddingFrameId).mutate(async x => {
      x.transactionFeesTotal = transactionFeesTotal;
      const calculatedProfits = await this.calculateAccruedProfits(x);
      x.accruedMicrogonProfits = calculatedProfits.accruedMicrogonProfits;
      x.previousFrameAccruedMicrogonProfits = calculatedProfits.previousFrameAccruedMicrogonProfits;
      x.accruedMicronotProfits = calculatedProfits.accruedMicronotProfits;
      x.previousFrameAccruedMicronotProfits = calculatedProfits.previousFrameAccruedMicronotProfits;
    });
    return { hasMiningBids, hasMiningSeats };
  }

  /**
   * Gets an appropriate client for this header. The local node will be pruned to 256 finalized blocks.
   * @param headerOrNumber
   */
  private getRpcClient(headerOrNumber: Header | number): ArgonClient {
    const headerNumber = typeof headerOrNumber === 'number' ? headerOrNumber : headerOrNumber.number.toNumber();
    // TODO: this is currently broken when using fast sync, so setting to 0
    const SYNCHED_STATE_DEPTH = 0;
    if (headerNumber < this.latestFinalizedBlockNumber - SYNCHED_STATE_DEPTH) {
      return this.archiveClient;
    }
    return this.localClient;
  }

  private async calculateAccruedProfits(x: IEarningsFile): Promise<{
    accruedMicrogonProfits: bigint;
    previousFrameAccruedMicrogonProfits: bigint | null;
    accruedMicronotProfits: bigint;
    previousFrameAccruedMicronotProfits: bigint | null;
  }> {
    if (x.previousFrameAccruedMicrogonProfits === null || x.previousFrameAccruedMicronotProfits === null) {
      const previousFrameId = x.frameId - 1;
      const previousFrame = await this.storage.earningsFile(previousFrameId).get();
      x.previousFrameAccruedMicrogonProfits = previousFrame?.accruedMicrogonProfits || 0n;
      x.previousFrameAccruedMicronotProfits = previousFrame?.accruedMicronotProfits || 0n;
    }
    let microgonRevenue = 0n;
    let micronotRevenue = 0n;
    for (const blockEarnings of Object.values(x.earningsByBlock)) {
      microgonRevenue += blockEarnings.microgonsMinted + blockEarnings.microgonsMined;
      micronotRevenue += blockEarnings.micronotsMined;
    }

    const microgonProfits = microgonRevenue - x.transactionFeesTotal;
    const accruedMicrogonProfits = x.previousFrameAccruedMicrogonProfits + microgonProfits;

    const accruedMicronotProfits = x.previousFrameAccruedMicronotProfits + micronotRevenue;

    return {
      accruedMicrogonProfits,
      previousFrameAccruedMicrogonProfits: x.previousFrameAccruedMicrogonProfits,
      accruedMicronotProfits,
      previousFrameAccruedMicronotProfits: x.previousFrameAccruedMicronotProfits,
    };
  }

  private async extractOwnPaidTransactionFee(
    client: ArgonClient,
    event: GenericEvent,
    extrinsicEvents: FrameSystemEventRecord[],
  ) {
    if (!client.events.transactionPayment.TransactionFeePaid.is(event)) {
      return 0n;
    }

    const [account, fee] = event.data;
    if (account.toHuman() !== this.accountset.txSubmitterPair.address) {
      return 0n;
    }
    const isMiningTx = extrinsicEvents.some(x => {
      let dispatchError: SpRuntimeDispatchError | undefined;
      if (client.events.utility.BatchInterrupted.is(x.event)) {
        const [_index, error] = x.event.data;
        dispatchError = error;
      }
      if (client.events.system.ExtrinsicFailed.is(x.event)) {
        dispatchError = x.event.data[0];
      }
      if (dispatchError && dispatchError.isModule) {
        const decoded = client.registry.findMetaError(dispatchError.asModule);
        if (decoded.section === 'miningSlot') {
          return true;
        }
      }
      if (client.events.miningSlot.SlotBidderAdded.is(x.event)) {
        return true;
      }
    });
    if (isMiningTx) {
      return fee.toBigInt();
    }
    return 0n;
  }

  private calculateProgress(tick: number | undefined, tickRange: [number, number] | undefined): number {
    if (!tick || !tickRange) return 0;
    const progress = tick ? (tick - tickRange[0]) / (tickRange[1] - tickRange[0]) : 0;
    return Math.round(progress * 10000) / 100;
  }
}
