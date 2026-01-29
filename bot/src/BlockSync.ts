import {
  type ArgonClient,
  type FrameSystemEventRecord,
  type GenericEvent,
  type Header,
  type SpRuntimeDispatchError,
  type Vec,
} from '@argonprotocol/mainchain';
import {
  AccountMiners,
  type Accountset,
  type IBlock,
  type IBlockSyncFile,
  type IBotStateFile,
  type IEarningsFile,
  type IWinningBid,
  MainchainClients,
  Mining,
  MiningFrames,
  NetworkConfig,
  Currency,
} from '@argonprotocol/apps-core';
import { type Storage } from './Storage.ts';
import { JsonStore } from './JsonStore.ts';
import type { BlockWatch, IBlockHeaderInfo } from '@argonprotocol/apps-core/src/BlockWatch.ts';

export interface ILastProcessed {
  date: Date;
  frameId: number;
  blockNumber: number;
}

export class BlockSync {
  public lastProcessed?: ILastProcessed;
  public accountMiners!: AccountMiners;
  public get localNodeFinalizedBlockNumber(): number {
    return this.blockWatch.finalizedBlockHeader.blockNumber;
  }
  public get botStateFile(): JsonStore<IBotStateFile> {
    return this.storage.botStateFile();
  }
  public get blockSyncFile(): JsonStore<IBlockSyncFile> {
    return this.storage.botBlockSyncFile();
  }
  public inProcessSync?: ReturnType<BlockSync['processNext']>;

  public oldestTickToSync: number = 0;

  public latestTick: number = 0;
  public lastSynchedTick: number = 0;
  public earliestQueuedTick?: number;
  public didProcessBlock?: (lastProcessed: ILastProcessed) => void;

  private scheduleTimer?: NodeJS.Timeout;

  private unsubscribe?: () => void;
  private isStopping: boolean = false;
  private mining!: Mining;
  private lastExchangeRateDate?: Date;
  private lastExchangeRateFrameId?: number;
  private localClient!: ArgonClient;
  private archiveClient!: ArgonClient;
  private currency: Currency;

  constructor(
    public accountset: Accountset,
    public storage: Storage,
    public mainchainClients: MainchainClients,
    public miningFrames: MiningFrames,
    public blockWatch: BlockWatch,
    private oldestFrameIdToSync?: number,
  ) {
    this.scheduleNext = this.scheduleNext.bind(this);
    this.mining = new Mining(this.mainchainClients);
    this.currency = new Currency(this.mainchainClients);
  }

  public async load() {
    this.isStopping = false;
    const localClient = await this.mainchainClients.prunedClientPromise;
    if (!localClient) {
      throw new Error('Pruned client is not available');
    }
    // ensure local client has state
    await localClient.query.system.number().catch(x => {
      console.error('[BlockSync] Error getting system number from local client', x);
      throw new Error('Local client is not ready');
    });

    this.localClient = localClient;
    this.archiveClient = await this.mainchainClients.archiveClientPromise;
    if (this.archiveClient.genesisHash.toHex() !== localClient.genesisHash.toHex()) {
      throw new Error('Archive client and local client have different genesis hashes');
    }
    await this.blockWatch.start();
    await this.miningFrames.load();

    const archiveFinalizedHash = await this.archiveClient.rpc.chain.getFinalizedHead();
    const archiveFinalizedHeader = await this.archiveClient.rpc.chain.getHeader(archiveFinalizedHash);
    const archiveFinalizedNumber = archiveFinalizedHeader.number.toNumber();
    // get latest finalized from archive client
    const finalizedHeader = this.blockWatch.finalizedBlockHeader;
    const localFinalizedNumber = finalizedHeader.blockNumber;
    if (localFinalizedNumber < archiveFinalizedNumber - 10) {
      throw new Error(
        `Local client has not synched within range of the archive client (10 blocks). Archive Client=${archiveFinalizedNumber} vs Local=${localFinalizedNumber}`,
      );
    }

    await this.botStateFile.mutate(async x => {
      if (!x.oldestFrameIdToSync) {
        x.oldestFrameIdToSync = this.oldestFrameIdToSync ?? finalizedHeader.frameId ?? this.miningFrames.currentFrameId;
        if (x.oldestFrameIdToSync === 0 && !NetworkConfig.canFrameBeZero()) {
          throw new Error(`Oldest frame to sync cannot be be 0`);
        }
        console.log(`[BlockSync] Set oldest frame to ${x.oldestFrameIdToSync}`);
      }

      this.oldestTickToSync = this.miningFrames.getTickStart(x.oldestFrameIdToSync);
      this.oldestFrameIdToSync = x.oldestFrameIdToSync;

      console.log('[BlockSync] Sync starting', {
        ...x,
      });
    });

    await this.backfillBestBlockHeader(this.blockWatch.bestBlockHeader, true);

    const data = await this.blockSyncFile.get();
    console.log('[BlockSync] After initial sync state', {
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

  public async backfillBestBlockHeader(
    headerInfo: IBlockHeaderInfo,
    isFirstLoad = false,
  ): Promise<IBlockSyncFile | undefined> {
    if (this.isStopping) return;
    // plug any gaps in the sync state
    let final: IBlockSyncFile | undefined;
    this.latestTick = headerInfo.tick;

    await this.blockSyncFile.mutate(async x => {
      x.finalizedBlockNumber = this.localNodeFinalizedBlockNumber;
      x.bestBlockNumber = headerInfo.blockNumber;

      while (headerInfo != null) {
        const { tick, author, blockHash, blockNumber } = headerInfo;
        if (blockNumber === 0) {
          console.info('[BlockSync] Block sync backfill reached genesis block, stopping');
          break;
        }
        await this.miningFrames.waitForTick(tick);
        if (headerInfo.frameId) {
          await this.miningFrames.waitForFrameId(headerInfo.frameId);
        }
        const frameId = headerInfo?.frameId ?? this.miningFrames.getForTick(tick);
        const frameRewardTicksRemaining =
          headerInfo?.frameRewardTicksRemaining ?? this.miningFrames.getFrameRewardTicksRemaining(frameId);
        const isNewFrame = headerInfo?.isNewFrame ?? this.miningFrames.isFirstFrameTick(tick);

        if (x.blocksByNumber[blockNumber]?.hash === blockHash || frameId < this.oldestFrameIdToSync!) {
          if (isFirstLoad) {
            console.info('[BlockSync] Found oldest block to backfill', {
              blockNumber,
              headerFrameId: frameId,
              oldestToKeep: this.oldestFrameIdToSync,
            });
          }
          break;
        }
        console.log(
          `[BlockSync] Queueing block to sync. Block: ${blockNumber}, Frame ID: ${frameId}, Hash: ${blockHash}`,
        );
        // set synced back if we are syncing to a block that is older than the current synced block
        if (x.syncedToBlockNumber >= blockNumber) {
          x.syncedToBlockNumber = blockNumber - 1;
        }

        x.blocksByNumber[blockNumber] = {
          hash: blockHash,
          tick,
          number: blockNumber,
          author,
          frameId,
          isNewFrame,
          frameRewardTicksRemaining,
        };
        if (isFirstLoad) {
          this.earliestQueuedTick ??= tick;
          this.earliestQueuedTick = Math.min(tick, this.earliestQueuedTick);
        }
        // don't go back to genesis
        if (blockNumber === 1) {
          console.log('[BlockSync] Reached genesis block, stopping backfill');
          break;
        }
        try {
          headerInfo = await this.blockWatch.getParentHeader(headerInfo);
        } catch (e) {
          console.error(`[BlockSync] Error getting parent header for ${blockNumber}`, e);
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

  public async start() {
    await this.scheduleNext(500, true);
  }

  public async stop() {
    if (this.isStopping) return;
    console.time('[BlockSync] STOPPING');
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
    console.timeEnd('[BlockSync] STOPPING');
    // local client is not owned by this service
  }

  public calculateSyncProgress(): number {
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

  public async syncToLatest() {
    while (true) {
      const result = await this.processNext();
      if (!result) {
        break;
      }
    }
    console.log('[BlockSync] Synched to latest');
  }

  public async scheduleNext(waitTime: number = 500, throwIfFails = false): Promise<void> {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    if (this.isStopping) return;

    try {
      const latestBestBlockHeader = this.blockWatch.bestBlockHeader;
      if (latestBestBlockHeader) {
        await this.backfillBestBlockHeader(latestBestBlockHeader);
      }
      this.inProcessSync = this.processNext();
      const result = await this.inProcessSync;
      if (result?.remaining ?? 0 > 0) {
        waitTime = 0;
      }
    } catch (e) {
      console.error(`[BlockSync] Error processing next header`, e);
      if (this.isStopping) return;
      if (throwIfFails) throw e;
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    this.scheduleTimer = setTimeout(this.scheduleNext, waitTime);
  }

  public async processNext(): Promise<{ processed: IBlock; remaining: number } | undefined> {
    const blockSyncData = await this.blockSyncFile.get();
    const bestBlockNumber = blockSyncData.bestBlockNumber;
    const syncedToBlockNumber = blockSyncData.syncedToBlockNumber;
    if (syncedToBlockNumber >= bestBlockNumber) {
      return undefined;
    }

    const blockNumber = syncedToBlockNumber + 1;
    if (blockNumber < 1) return;
    const blockMeta = blockSyncData.blocksByNumber[blockNumber];

    console.log(`[BlockSync] Processing block ${blockNumber}`, blockMeta);

    const client = this.getRpcClient(blockNumber);
    const api = await client.at(blockMeta.hash);
    const events = await api.query.system.events();
    const cohortEarningsAtFrameId = await this.accountMiners.onBlock(
      blockMeta,
      events.map(x => x.event),
    );
    const tick = blockMeta.tick;
    const tickDate = MiningFrames.getTickDate(tick);
    const currentFrameId = blockMeta.frameId ?? this.miningFrames.getForTick(tick);
    const isFrameChange = blockMeta.isNewFrame ?? this.miningFrames.isFirstFrameTick(tick);
    await this.miningFrames.waitForFrameId(currentFrameId);

    // The previous miners earn the rewards for the frame transition.
    const earningsFrameId = Math.max(0, isFrameChange ? currentFrameId - 1 : currentFrameId);

    const { hasMiningBids, hasMiningSeats, transactionFeesTotal } = await this.syncBidding(
      earningsFrameId,
      blockMeta,
      events,
    );
    await this.storage.earningsFile(earningsFrameId).mutate(async x => {
      x.frameFirstTick = this.miningFrames.getTickStart(earningsFrameId);
      x.frameRewardTicksRemaining = this.miningFrames.getFrameRewardTicksRemaining(earningsFrameId);
      x.firstBlockNumber ||= blockNumber;
      x.lastBlockNumber = blockNumber;

      const secondsSinceLastExchangeRate = this.lastExchangeRateDate
        ? (new Date().getTime() - this.lastExchangeRateDate.getTime()) / 1000
        : null;
      const checkedExchangeRateThisHour = secondsSinceLastExchangeRate !== null && secondsSinceLastExchangeRate < 3600;
      const checkedExchangeRateThisFrame = this.lastExchangeRateFrameId === earningsFrameId;

      if (!checkedExchangeRateThisFrame || !checkedExchangeRateThisHour) {
        this.lastExchangeRateDate = new Date();
        this.lastExchangeRateFrameId = earningsFrameId;
        const microgonExchangeRateTo = await this.currency.fetchMainchainRates(api);
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

      x.transactionFeesTotal = transactionFeesTotal;
      const calculatedProfits = await this.calculateAccruedProfits(x);
      x.accruedMicrogonProfits = calculatedProfits.accruedMicrogonProfits;
      x.accruedMicronotProfits = calculatedProfits.accruedMicronotProfits;
    });

    if (isFrameChange) {
      await this.storage.earningsFile(currentFrameId).mutate(async x => {
        x.frameRewardTicksRemaining = this.miningFrames.getFrameRewardTicksRemaining(currentFrameId);
        x.frameFirstTick = this.miningFrames.getTickStart(currentFrameId);
        x.firstBlockNumber ||= blockNumber;
        x.lastBlockNumber = blockNumber;
        const calculatedProfits = await this.calculateAccruedProfits(x);
        x.previousFrameAccruedMicrogonProfits = calculatedProfits.previousFrameAccruedMicrogonProfits;
        x.previousFrameAccruedMicronotProfits = calculatedProfits.previousFrameAccruedMicronotProfits;
      });
    }

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

    const syncProgress = this.calculateProgress(this.lastSynchedTick, [this.oldestTickToSync, this.latestTick]);
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
      x.syncProgress = syncProgress;
    });

    this.didProcessBlock?.(this.lastProcessed);
    const remaining = bestBlockNumber - blockNumber;
    const syncPercent = (blockNumber * 100) / bestBlockNumber;
    const syncString = syncPercent >= 100 ? '' : ` (synced ${syncPercent.toFixed(1)}%)`;
    console.log(`[BlockSync] Processed block ${blockNumber}${syncString}.`);
    return {
      processed: blockMeta,
      remaining,
    };
  }

  private async syncBidding(
    biddingFrameId: number,
    block: IBlock,
    events: Vec<FrameSystemEventRecord>,
  ): Promise<{ hasMiningBids: boolean; hasMiningSeats: boolean; transactionFeesTotal: bigint }> {
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
        console.log(
          `[BlockSync] New miners event for frame #${event.data.frameId.toNumber()} (${event.data.newMiners.length} miners added).`,
        );
        const { frameId, newMiners } = event.data;
        const activationFrameIdOfNewCohort = frameId.toNumber();
        const biddingFrameIdOfNewCohort = activationFrameIdOfNewCohort - 1;
        const activeMiners = await api.query.miningSlot.activeMinersCount().then(x => x.toNumber());
        const lastBidsFile = this.storage.bidsFile(biddingFrameIdOfNewCohort, activationFrameIdOfNewCohort);
        const firstFrameTick = this.miningFrames.getTickStart(biddingFrameIdOfNewCohort);
        await lastBidsFile.mutate(async x => {
          x.seatCountWon = 0;
          x.microgonsBidTotal = 0n;
          x.winningBids = [];
          x.biddingFrameFirstTick = firstFrameTick;
          x.biddingFrameRewardTicksRemaining = 0;
          x.lastBlockNumber = blockNumber;
          x.allMinersCount = activeMiners;

          if (x.micronotsStakedPerSeat === 0n) {
            x.micronotsStakedPerSeat = await api.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
          }
          if (x.microgonsToBeMinedPerBlock === 0n) {
            x.microgonsToBeMinedPerBlock = await this.mining.fetchMicrogonsPerBlockForMiner(
              api,
              activationFrameIdOfNewCohort,
            );
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

    const cohortActivationFrameId = biddingFrameId + 1;
    const bidsFile = this.storage.bidsFile(biddingFrameId, cohortActivationFrameId);
    const nextCohort = await api.query.miningSlot.bidsForNextSlotCohort();
    let transactionFeesTotal = 0n;

    await bidsFile.mutate(async x => {
      if (x.micronotsStakedPerSeat === 0n) {
        x.micronotsStakedPerSeat = await api.query.miningSlot.argonotsPerMiningSeat().then(x => x.toBigInt());
      }
      if (x.microgonsToBeMinedPerBlock === 0n) {
        x.microgonsToBeMinedPerBlock = await this.mining.fetchMicrogonsPerBlockForMiner(api, cohortActivationFrameId);
      }
      x.biddingFrameFirstTick = this.miningFrames.getTickStart(biddingFrameId);
      x.biddingFrameRewardTicksRemaining = this.miningFrames.getFrameRewardTicksRemaining(biddingFrameId);
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
    return { hasMiningBids, hasMiningSeats, transactionFeesTotal };
  }

  /**
   * Gets an appropriate client for this header. The local node will be pruned to 256 finalized blocks.
   * @param headerOrNumber
   */
  private getRpcClient(headerOrNumber: Header | number): ArgonClient {
    const headerNumber = typeof headerOrNumber === 'number' ? headerOrNumber : headerOrNumber.number.toNumber();
    // TODO: this is currently broken when using fast sync, so setting to 0
    const SYNCHED_STATE_DEPTH = 0;
    if (headerNumber < this.localNodeFinalizedBlockNumber - SYNCHED_STATE_DEPTH) {
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
