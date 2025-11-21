import * as Fs from 'node:fs';
import { type ArgonClient, type KeyringPair } from '@argonprotocol/mainchain';
import { Storage } from './Storage.ts';
import { AutoBidder } from './AutoBidder.ts';
import { BlockSync } from './BlockSync.ts';
import { Dockers } from './Dockers.ts';
import {
  Accountset,
  type IBiddingRules,
  type IBotSyncStatus,
  JsonExt,
  FatalError,
  MainchainClients,
  type IBidReductionReason,
  getRange,
} from '@argonprotocol/apps-core';
import { History } from './History.ts';

interface IBotOptions {
  datadir: string;
  pair: KeyringPair;
  localRpcUrl: string;
  archiveRpcUrl: string;
  biddingRulesPath: string;
  sessionMiniSecret: string;
  oldestFrameIdToSync?: number;
  shouldSkipDockerSync?: boolean;
}

export default class Bot implements IBotSyncStatus {
  public autobidder!: AutoBidder;
  public accountset!: Accountset;
  public blockSync!: BlockSync;
  public storage!: Storage;

  public isStarting: boolean = false;
  public isWaitingForBiddingRules: boolean = false;
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
  private localClient!: ArgonClient;
  private mainchainClients!: MainchainClients;

  constructor(options: IBotOptions) {
    this.options = options;
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

  public async start(): Promise<void> {
    if (this.isStarting || this.isReady) return;
    this.isStarting = true;
    console.log('STARTING BOT');
    try {
      let currentFrameId = await this.currentFrameId.catch(() => 0);
      try {
        this.mainchainClients = new MainchainClients(this.options.archiveRpcUrl, () =>
          Boolean(JSON.parse(process.env.LOG_APIS ?? '0')),
        );
        const client = await this.mainchainClients.archiveClientPromise;
        currentFrameId = await client.query.miningSlot.nextFrameId().then(x => x.toNumber() - 1);
      } catch (error) {
        console.error('Error initializing archive client', error);
        throw error;
      }

      this.storage = new Storage(this.options.datadir);
      this.history = new History(this.storage, currentFrameId);
      this.history.handleStarting();

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      this.options.shouldSkipDockerSync || (await this.waitForDockerConfirmation());
      this.history.handleDockersConfirmed();
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log('CONNECTING TO LOCAL RPC');
      this.errorMessage = null;

      while (!this.localClient) {
        try {
          this.localClient = await this.mainchainClients.setPrunedClient(this.options.localRpcUrl);
        } catch (error) {
          console.error('Error initializing local client, retrying...', error);
          this.errorMessage = (error as Error).toString();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      this.errorMessage = null;

      this.biddingRules = this.loadBiddingRules();
      this.accountset = new Accountset({
        client: this.localClient,
        seedAccount: this.options.pair,
        sessionMiniSecretOrMnemonic: this.options.sessionMiniSecret,
        subaccountRange: getRange(0, 144),
      });
      this.autobidder = new AutoBidder(
        this.accountset,
        this.mainchainClients,
        this.storage,
        this.history,
        this.biddingRules || ({} as IBiddingRules),
      );
      this.blockSync = new BlockSync(
        this,
        this.accountset,
        this.storage,
        this.mainchainClients,
        this.options.oldestFrameIdToSync,
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
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      this.history.handleFinishedSyncing();
      this.isSyncing = false;

      if (!this.biddingRules) {
        console.log('No bidding rules were found, cannot finish loading');
        this.isWaitingForBiddingRules = true;
        return;
      }

      console.log('Starting block sync');
      while (true) {
        try {
          this.history.handleReady();
          await this.blockSync.start();
          break;
        } catch (error) {
          console.error('Error starting block sync (retrying...)', error);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log('Starting autobidder');

      try {
        await this.autobidder.start(this.options.localRpcUrl);
      } catch (error) {
        console.error('Error starting autobidder', error);
        throw error;
      }

      this.isReady = true;
    } finally {
      this.isStarting = false;
    }
  }

  public async shutdown() {
    await this.autobidder.stop();
    await this.blockSync.stop();
    await this.mainchainClients.disconnect();
    await this.history.handleShutdown();
  }

  private loadBiddingRules(): IBiddingRules {
    const rawJsonString = Fs.readFileSync(this.options.biddingRulesPath, 'utf8');
    return JsonExt.parse(rawJsonString);
  }

  private async waitForDockerConfirmation() {
    console.log('Waiting for dockers to sync...');
    while (true) {
      const areDockersSynced = await this.areDockersSynced();
      if (areDockersSynced) break;

      console.log('Dockers are not synced, checking again in 1 second');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('Dockers are synced!');
  }

  private async areDockersSynced() {
    const bitcoinBlockNumbers = await Dockers.getBitcoinBlockNumbers();
    if (!bitcoinBlockNumbers.mainNode) return false;
    if (bitcoinBlockNumbers.localNode < bitcoinBlockNumbers.mainNode) return false;

    const argonBlockNumbers = await Dockers.getArgonBlockNumbers();
    if (!argonBlockNumbers.mainNode) return false;
    if (argonBlockNumbers.localNode < argonBlockNumbers.mainNode) return false;

    const isArgonMinerReady = await Dockers.isArgonMinerReady();
    if (!isArgonMinerReady) return false;

    return true;
  }
}
