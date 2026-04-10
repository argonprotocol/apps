import * as Fs from 'node:fs';
import { promises as fs } from 'node:fs';
import { type ArgonClient, type KeyringPair } from '@argonprotocol/mainchain';
import { Storage } from './Storage.ts';
import { AutoBidder } from './AutoBidder.ts';
import { BlockSync } from './BlockSync.ts';
import { BitcoinLockRelayService } from './BitcoinLockRelayService.ts';
import { Db } from './Db.ts';
import { DockerStatus } from './DockerStatus.ts';
import { setTimeout } from 'node:timers/promises';
import {
  Accountset,
  createDeferred,
  FatalError,
  getRange,
  type IBiddingRules,
  type IBidReductionReason,
  type IBotState,
  type IHistoryFile,
  type IMiningFrameDetail,
  JsonExt,
  MainchainClients,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { MiningFrameHistory } from './MiningFrameHistory.ts';
import { History } from './History.ts';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';

interface IBotOptions {
  datadir: string;
  db: Db;
  bidderKeypair: KeyringPair;
  vaultOperatorAddress: string;
  localRpcUrl: string;
  archiveRpcUrl: string;
  biddingRulesPath: string;
  sessionMiniSecret: string;
  bitcoinInitializerDelegateKeypair: KeyringPair;
  oldestFrameIdToSync?: number;
  shouldSkipDockerSync?: boolean;
}

export default class Bot {
  public autobidder!: AutoBidder;
  public accountset!: Accountset;
  public blockSync!: BlockSync;
  public storage!: Storage;
  public miningFrames!: MiningFrames;
  public blockWatch!: BlockWatch;
  public miningFrameHistory!: MiningFrameHistory;
  public db: Db;
  public relayService: BitcoinLockRelayService;

  public isStarting: boolean = false;
  public isSyncing: boolean = false;
  public isReady: boolean = false;
  public get maxSeatsInPlay(): number {
    return this.history.maxSeatsInPlay;
  }

  public get maxSeatsReductionReason(): IBidReductionReason | undefined {
    return this.history.maxSeatsReductionReason;
  }

  public history!: History;
  public errorMessage: string | null = null;

  private options: IBotOptions;
  private biddingRules: IBiddingRules | null = null;
  private biddingRulesJson: string | null = null;
  private localClient!: ArgonClient;
  private readonly mainchainClients!: MainchainClients;
  private shutdownDeferred = createDeferred(false);

  constructor(options: IBotOptions) {
    this.options = options;
    this.db = options.db;
    this.mainchainClients = new MainchainClients(this.options.archiveRpcUrl, () =>
      Boolean(JSON.parse(process.env.ARGON_LOG_APIS ?? '0')),
    );
    this.blockWatch = new BlockWatch(this.mainchainClients, true);
    this.relayService = new BitcoinLockRelayService(
      this.db,
      this.mainchainClients,
      this.blockWatch,
      this.options.vaultOperatorAddress,
      this.options.bitcoinInitializerDelegateKeypair,
    );
  }

  public async state(startupError: string | null = null): Promise<IBotState> {
    const isBooted = !!this.blockSync && !!this.history;
    if (!isBooted) {
      const [argonBlockNumbers, bitcoinBlockNumbers] = await Promise.all([
        DockerStatus.getArgonBlockNumbers(),
        DockerStatus.getBitcoinBlockNumbers(),
      ]);
      return {
        bidsLastModifiedAt: new Date(),
        earningsLastModifiedAt: new Date(),
        oldestFrameIdToSync: this.options.oldestFrameIdToSync ?? 0,
        syncProgress: 0,
        hasMiningBids: false,
        hasMiningSeats: false,
        currentTick: 0,
        currentFrameId: 0,
        finalizedFrameId: 0,
        botLastActiveDate: new Date(),
        botLastActiveBlockNumber: 0,
        isReady: this.isReady,
        ...(this.isStarting ? { isStarting: true } : {}),
        ...(this.isSyncing ? { isSyncing: true } : {}),
        argonBlockNumbers,
        bitcoinBlockNumbers,
        maxSeatsInPlay: 0,
        bidsInCurrentFrame: 0,
        bidsInPreviousFrame: 0,
        isBiddingOpen: false,
        serverError: this.errorMessage ?? startupError,
      } as IBotState;
    }

    const [argonBlockNumbers, bitcoinBlockNumbers, botStateData] = await Promise.all([
      DockerStatus.getArgonBlockNumbers(),
      DockerStatus.getBitcoinBlockNumbers(),
      this.blockSync.botStateFile.get(),
    ]);
    const currentBidder = this.autobidder.currentBidder;
    const previousBidder = this.autobidder.previousBidder;
    const finalizedFrameId = this.getFinalizedFrameId();
    const nextBid = currentBidder?.nextBid
      ? {
          atTick: currentBidder.nextBid.bidAtTick,
          microgonsPerSeat: currentBidder.nextBid.microgonsPerSeat,
          alreadyWinningSeats: currentBidder.nextBid.alreadyWinningSeats,
          seats: currentBidder.nextBid.subaccounts.length,
        }
      : undefined;

    return {
      ...botStateData,
      finalizedFrameId,
      botLastActiveDate: currentBidder?.latestUpdateDate ?? MiningFrames.getTickDate(this.history.lastActivityTick),
      botLastActiveBlockNumber: currentBidder?.latestBlockNumber ?? this.history.lastProcessedBlockNumber,
      syncProgress: this.blockSync.calculateSyncProgress(),
      isReady: this.isReady,
      isStarting: this.isStarting,
      isSyncing: this.isSyncing,
      argonBlockNumbers,
      bitcoinBlockNumbers,
      maxSeatsInPlay: this.maxSeatsInPlay,
      maxSeatsReductionReason: this.maxSeatsReductionReason,
      bidsInCurrentFrame: currentBidder?.bidsAttempted ?? 0,
      bidsInPreviousFrame: previousBidder?.bidsAttempted ?? 0,
      isBiddingOpen: currentBidder?.isBiddingOpen ?? false,
      nextBid,
      lastBid: currentBidder?.lastBid,
      serverError: this.errorMessage ?? startupError,
    } as IBotState;
  }

  public get currentFrameId(): Promise<number> {
    return new Promise(async (resolve, reject) => {
      try {
        const state = await this.storage.botStateFile().get();
        resolve(state?.currentFrameId ?? 0);
      } catch (error) {
        reject(error);
      }
    });
  }

  public async getHistoryForFrame(frameId?: number): Promise<IHistoryFile> {
    if (frameId === undefined) {
      return (await this.history?.recent) || { activities: [] };
    }

    return await this.storage.historyFile(frameId).get();
  }

  public async getMiningFrameDetail(frameId: number): Promise<IMiningFrameDetail> {
    return this.miningFrameHistory.getDetail(frameId);
  }

  public async start(): Promise<void> {
    if (this.isStarting || this.isReady) return;
    this.isStarting = true;
    console.log('STARTING BOT');
    try {
      let currentFrameId = await this.currentFrameId.catch(() => 0);
      try {
        const client = await this.mainchainClients.archiveClientPromise;
        currentFrameId = await client.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1);
      } catch (error) {
        console.error('Error initializing archive client', error);
        throw error;
      }

      this.storage = new Storage(this.options.datadir);
      await this.storage.migrate();
      this.history = new History(this.storage, currentFrameId);
      this.history.handleStarting();

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      this.options.shouldSkipDockerSync || (await this.waitForDockerConfirmation());
      this.history.handleDockersConfirmed();

      console.log('CONNECTING TO LOCAL RPC');
      this.errorMessage = null;

      while (!this.localClient) {
        try {
          this.localClient = await this.mainchainClients.setPrunedClient(this.options.localRpcUrl);
        } catch (error) {
          console.error('Error initializing local client, retrying...', error);
          this.errorMessage = (error as Error).toString();
          await setTimeout(1000);
        }
      }
      this.errorMessage = null;

      await this.relayService.start();

      this.biddingRules = this.loadBiddingRules();
      this.biddingRulesJson = this.biddingRules ? JsonExt.stringify(this.biddingRules) : null;
      this.accountset = new Accountset({
        client: this.localClient,
        seedAccount: this.options.bidderKeypair,
        sessionMiniSecretOrMnemonic: this.options.sessionMiniSecret,
        subaccountRange: getRange(0, 144),
      });
      const miningFramesPath = this.storage.getPath('miningFrames.json');
      this.miningFrames = new MiningFrames(this.mainchainClients, this.blockWatch, {
        read: () => fs.readFile(miningFramesPath, 'utf8').catch(() => '[]'),
        write: data => fs.writeFile(miningFramesPath, data, 'utf8'),
      });
      await this.miningFrames.load();
      this.autobidder = new AutoBidder(
        this.accountset,
        this.mainchainClients,
        this.storage,
        this.history,
        this.biddingRules,
        this.miningFrames,
      );
      this.blockSync = new BlockSync(
        this.accountset,
        this.storage,
        this.mainchainClients,
        this.miningFrames,
        this.blockWatch,
        this.options.oldestFrameIdToSync,
      );
      this.miningFrameHistory = new MiningFrameHistory(
        this.storage,
        this.accountset,
        this.mainchainClients,
        this.miningFrames,
        this.blockWatch,
        () => this.currentFrameId,
      );

      this.isSyncing = true;
      this.history.handleStartedSyncing();
      while (true) {
        try {
          await this.blockSync.load();
          break;
        } catch (error) {
          if (error instanceof FatalError) {
            console.error('Fatal error loading block sync (exiting...)', error);
            throw error;
          }
          if (String(error).includes('getHeader(hash?: BlockHash): Header:: 4003')) {
            error = (error as Error).message;
          }
          console.error('Error loading block sync (retrying...)', error);
          await setTimeout(1000);
        }
      }
      this.history.handleFinishedSyncing();
      this.isSyncing = false;

      console.log('Starting block sync');
      while (true) {
        try {
          this.history.handleReady();
          await this.blockSync.start();
          break;
        } catch (error) {
          console.error('Error starting block sync (retrying...)', error);
          await setTimeout(1000);
        }
      }

      console.log('Starting autobidder');

      try {
        await this.autobidder.start(this.options.localRpcUrl);
      } catch (error) {
        console.error('Error starting autobidder', error);
        throw error;
      }

      this.watchBiddingRulesFile();
      this.isReady = true;
    } finally {
      this.isStarting = false;
    }
  }

  public async shutdown() {
    if (this.shutdownDeferred.isSettled || this.shutdownDeferred.isRunning) {
      return this.shutdownDeferred.promise;
    }
    this.shutdownDeferred.setIsRunning(true);
    console.log('SHUTTING DOWN BOT');
    if (this.options.biddingRulesPath) {
      Fs.unwatchFile(this.options.biddingRulesPath);
    }
    await this.autobidder.stop();
    await this.relayService.shutdown();
    this.blockWatch.stop();
    await this.miningFrames?.stop?.();
    await this.blockSync?.stop?.();
    await this.history?.handleShutdown?.();
    await this.storage?.close?.();
    this.db.close();
    await this.mainchainClients.disconnect();
    console.log('BOT SHUT DOWN');
    this.shutdownDeferred.resolve();
    return this.shutdownDeferred.promise;
  }

  private loadBiddingRules(): IBiddingRules | null {
    if (!this.options.biddingRulesPath) {
      return null;
    }

    if (!Fs.existsSync(this.options.biddingRulesPath)) {
      return null;
    }

    const rawJsonString = Fs.readFileSync(this.options.biddingRulesPath, 'utf8');
    return JsonExt.parse<IBiddingRules>(rawJsonString);
  }

  private getFinalizedFrameId(): number {
    return this.miningFrameHistory?.getFinalizedFrameId() ?? 0;
  }

  private async waitForDockerConfirmation() {
    console.log('Waiting for dockers to sync...');
    while (true) {
      const areDockersSynced = await this.areDockersSynced();
      if (areDockersSynced) break;

      console.log('Dockers are not synced, checking again in 1 second');
      await setTimeout(1000);
    }

    console.log('Dockers are synced!');
  }

  private async areDockersSynced() {
    const bitcoinBlockNumbers = await DockerStatus.getBitcoinBlockNumbers();
    if (!bitcoinBlockNumbers.mainNode) return false;
    if (bitcoinBlockNumbers.localNode < bitcoinBlockNumbers.mainNode) return false;

    const argonBlockNumbers = await DockerStatus.getArgonBlockNumbers();
    if (!argonBlockNumbers.mainNode) return false;
    if (argonBlockNumbers.localNode < argonBlockNumbers.mainNode) return false;

    const isArgonMinerReady = await DockerStatus.isArgonMinerReady();
    if (!isArgonMinerReady) return false;

    return true;
  }

  private watchBiddingRulesFile() {
    if (!this.options.biddingRulesPath) return;

    Fs.watchFile(this.options.biddingRulesPath, { interval: 1_000 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs) return;
      void this.reloadBiddingRules();
    });
  }

  private async reloadBiddingRules() {
    try {
      const nextBiddingRules = this.loadBiddingRules();
      const nextBiddingRulesJson = nextBiddingRules ? JsonExt.stringify(nextBiddingRules) : null;
      if (nextBiddingRulesJson === this.biddingRulesJson) {
        return;
      }

      this.biddingRules = nextBiddingRules;
      this.biddingRulesJson = nextBiddingRulesJson;
      await this.autobidder.updateBiddingRules(this.biddingRules);
    } catch (error) {
      console.error('Error reloading bidding rules', error);
    }
  }
}
