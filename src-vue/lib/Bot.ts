import { Config } from './Config';
import { Db } from './Db';
import { BotStatus, BotSyncer } from './BotSyncer';
import { ensureOnlyOneInstance } from './Utils';
import { createDeferred, type IBidsFile, IBotState, MiningFrames, waitAtLeast } from '@argonprotocol/apps-core';
import mitt, { type Emitter } from 'mitt';
import Installer from './Installer';
import { SSH } from './SSH';
import { ServerAdmin } from './ServerAdmin';
import { BotWsClient } from './BotWsClient';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';

export type IBotEmitter = {
  'updated-cohort-data': number;
  'updated-bids-data': IBidsFile['winningBids'];
  'updated-server-state': void;
  'status-changed': BotStatus;
};

export const botEmitter: Emitter<IBotEmitter> = mitt<IBotEmitter>();

export class Bot {
  public syncProgress: number;
  public state: IBotState | null;

  private readonly config: Config;
  private readonly dbPromise: Promise<Db>;

  private status: BotStatus | null;
  private botSyncer!: BotSyncer;
  private loadDeferred = createDeferred<void>(false);

  constructor(config: Config, dbPromise: Promise<Db>) {
    ensureOnlyOneInstance(this.constructor);

    this.syncProgress = 0;
    this.state = null;
    this.status = null;

    this.config = config;
    this.dbPromise = dbPromise;
  }

  public async getClient(): Promise<BotWsClient> {
    await this.loadDeferred.promise;
    return this.botSyncer.getClient();
  }

  public async load(installer: Installer, miningFrames: MiningFrames): Promise<void> {
    if (this.loadDeferred.isSettled || this.loadDeferred.isRunning) {
      return this.loadDeferred.promise;
    }
    this.loadDeferred.setIsRunning(true);
    try {
      const db = await this.dbPromise;
      this.botSyncer = new BotSyncer(this.config, db, installer, miningFrames, {
        onEvent: (type, payload) => botEmitter.emit(type, payload),
        setStatus: x => {
          if (this.status === x) return;
          this.status = x;
          botEmitter.emit('status-changed', x);
        },
        setBotState: x => (this.state = x),
        setServerSyncProgress: x => (this.syncProgress = x * 0.9),
        setDbSyncProgress: x => (this.syncProgress = 90 + x * 0.1),
      });

      await this.botSyncer.load();
      await this.loadServerBiddingRules().catch(err => {
        console.error('Error loading server bidding rules:', err);
      });
      this.loadDeferred.resolve();
    } catch (err) {
      this.loadDeferred.reject(err);
    }
    return this.loadDeferred.promise;
  }

  public async refreshState(): Promise<void> {
    await this.loadDeferred.promise;
    await this.botSyncer.refresh();
  }

  public async restart(): Promise<void> {
    const server = new ServerAdmin(await SSH.getOrCreateConnection(), this.config.serverDetails);
    this.botSyncer.isPaused = true;
    await server.stopBotDocker();
    await server.startBotDocker();
    this.botSyncer.isPaused = false;
  }

  public async loadServerBiddingRules(): Promise<void> {
    if (this.config.miningSetupStatus !== MiningSetupStatus.Finished) return;
    const server = new ServerAdmin(await SSH.getOrCreateConnection(), this.config.serverDetails);
    const remoteRules = await server.downloadBiddingRules();
    if (!remoteRules) return;
    this.config.biddingRules = remoteRules;
    await this.config.saveBiddingRules();
  }

  public async resyncBiddingRules(): Promise<void> {
    const server = new ServerAdmin(await SSH.getOrCreateConnection(), this.config.serverDetails);
    try {
      this.status = BotStatus.ServerSyncing;
      this.syncProgress = 50;
      this.botSyncer.isPaused = true;
      await waitAtLeast(1000, server.uploadBiddingRules(this.config.biddingRules));
      this.syncProgress = 100;
      this.status = BotStatus.Ready;
    } catch (err) {
      this.status = BotStatus.Broken;
      throw err;
    } finally {
      this.botSyncer.isPaused = false;
      this.syncProgress = 0;
    }
  }

  public get isStarting(): boolean {
    return this.status === BotStatus.Starting;
  }

  public get isSyncing(): boolean {
    return this.status === BotStatus.ServerSyncing || this.status === BotStatus.DbSyncing;
  }

  public get isBroken(): boolean {
    return this.status === BotStatus.Broken;
  }

  public get isReady(): boolean {
    return this.status === BotStatus.Ready;
  }
}
