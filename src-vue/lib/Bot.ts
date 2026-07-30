import { Config } from './Config';
import { Db } from './Db';
import { ensureOnlyOneInstance } from './Utils';
import {
  createDeferred,
  IBotState,
  type IBotStateStarting,
  type IMiningSummary,
  MiningFrames,
  waitAtLeast,
} from '@argonprotocol/apps-core';
import mitt, { type Emitter } from 'mitt';
import Installer from './Installer';
import { SSH } from './SSH';
import { ServerAdmin } from './ServerAdmin';
import { BotWsClient } from './BotWsClient';
import { MiningSetupStatus } from '../interfaces/IConfig.ts';
import type { ServerApiClient } from './ServerApiClient.ts';
import { FinancialCacheTypes, MiningSummaryCacheScope } from './db/FinancialCacheTable.ts';
import { SyncStateKeys } from './db/SyncStateTable.ts';

export enum BotStatus {
  Starting = 'Starting',
  ServerSyncing = 'ServerSyncing',
  Ready = 'Ready',
  Broken = 'Broken',
}

export type IBotEmitter = {
  'updated-mining-summary': IMiningSummary;
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
  private db!: Db;
  private client!: BotWsClient;
  private miningFrames!: MiningFrames;
  private stateUpdatePromise = Promise.resolve();
  private miningSummaryRevision = '';
  private isBiddingRulesUploadInProgress = false;
  private loadDeferred = createDeferred<void>(false);

  constructor(
    config: Config,
    dbPromise: Promise<Db>,
    private readonly serverApiClient: ServerApiClient,
  ) {
    ensureOnlyOneInstance(this.constructor);

    this.syncProgress = 0;
    this.state = null;
    this.status = null;

    this.config = config;
    this.dbPromise = dbPromise;
  }

  public async getClient(): Promise<BotWsClient> {
    await this.loadDeferred.promise;
    await this.client.connectDeferred.promise;
    return this.client;
  }

  public async load(installer: Installer, miningFrames: MiningFrames): Promise<void> {
    if (this.loadDeferred.isSettled || this.loadDeferred.isRunning) {
      return this.loadDeferred.promise;
    }
    this.loadDeferred.setIsRunning(true);
    try {
      await this.config.isLoadedPromise;
      await installer.isLoadedPromise;
      await miningFrames.load();
      this.miningFrames = miningFrames;
      this.db = await this.dbPromise;
      this.setStatus(BotStatus.Starting);

      await this.loadServerConfig().catch(err => {
        console.error('Error loading server config:', err);
      });

      if (this.config.isServerInstalled && !(await this.serverApiClient.isGatewayReady())) {
        await installer.refreshLocalGatewayPort();
      }

      this.client = new BotWsClient(this.serverApiClient);
      this.client.events.on('/state', state => {
        void this.enqueueState(state);
      });
      this.client.events.on('ws:disconnected', () => {
        this.setStatus(BotStatus.Starting);
      });
      this.loadDeferred.resolve();
    } catch (err) {
      this.loadDeferred.reject(err);
    }
    return this.loadDeferred.promise;
  }

  public async refreshState(): Promise<void> {
    const client = await this.getClient();
    const state = await client.fetch('/state');
    await this.enqueueState(state);
  }

  public async restart(): Promise<void> {
    const server = new ServerAdmin(await SSH.getOrCreateConnection(), this.config.serverDetails);
    await server.stopBotDocker();
    await server.startBotDocker();
  }

  public async loadServerConfig(): Promise<void> {
    if (this.config.miningSetupStatus !== MiningSetupStatus.Finished) return;
    const server = new ServerAdmin(await SSH.getOrCreateConnection(), this.config.serverDetails);
    const { biddingRules, oldestFrameIdToSync, ethereumBeaconApiUrl, ethereumExecutionRpcUrl } =
      await server.downloadConfigState();

    if (biddingRules) {
      this.config.biddingRules = biddingRules;
    }

    if (oldestFrameIdToSync !== undefined) {
      this.config.oldestFrameIdToSync = oldestFrameIdToSync;
    }
    if (ethereumBeaconApiUrl !== undefined) {
      this.config.ethereumBeaconApiUrl = ethereumBeaconApiUrl;
    }
    if (ethereumExecutionRpcUrl !== undefined) {
      this.config.ethereumExecutionRpcUrl = ethereumExecutionRpcUrl;
    }

    if (biddingRules) {
      await this.config.saveBiddingRules();
      return;
    }
    await this.config.save();
  }

  private enqueueState(state: IBotState | IBotStateStarting): Promise<void> {
    this.stateUpdatePromise = this.stateUpdatePromise.then(() => this.applyState(state));
    return this.stateUpdatePromise;
  }

  private async applyState(state: IBotState | IBotStateStarting): Promise<void> {
    try {
      if (state.serverError) {
        this.setStatus(BotStatus.Broken);
        console.error('Bot state error:', state.serverError);
        return;
      }
      if (state.isSyncing) {
        this.setStatus(BotStatus.ServerSyncing);
        this.syncProgress = state.syncProgress;
        return;
      }
      if (!state.isReady) {
        this.setStatus(BotStatus.Starting);
        return;
      }

      const readyState = state as IBotState;
      this.state = readyState;
      await this.updateConfig(readyState);

      const summaryRevision = [
        readyState.currentFrameId,
        readyState.earningsLastModifiedAt.getTime(),
        readyState.bidsLastModifiedAt.getTime(),
      ].join(':');
      let miningSummary: IMiningSummary | undefined;
      if (summaryRevision !== this.miningSummaryRevision) {
        miningSummary = await this.client.fetch('/mining-summary');
        try {
          await this.db.financialCacheTable.upsert(
            FinancialCacheTypes.MiningSummary,
            MiningSummaryCacheScope,
            miningSummary,
          );
        } catch (error) {
          console.warn('[Bot] Unable to cache mining summary', error);
        }
        this.miningSummaryRevision = summaryRevision;
      }

      await this.persistServerState(readyState);
      if (miningSummary) botEmitter.emit('updated-mining-summary', miningSummary);
      if (!this.isBiddingRulesUploadInProgress) this.setStatus(BotStatus.Ready);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isWebSocketEventError = Boolean(error && typeof error === 'object' && 'isTrusted' in error);
      const isTransientConnectionError =
        isWebSocketEventError ||
        message.includes('No response received from RPC endpoint') ||
        message.includes('BotWsClient') ||
        message.includes('request timed out') ||
        message.includes('heartbeat-timeout');

      if (isTransientConnectionError) {
        if (!this.state) this.setStatus(BotStatus.Starting);
        console.warn('Bot state transient error:', error);
        return;
      }

      this.setStatus(BotStatus.Broken);
      console.error('Bot state error:', error);
    }
  }

  private async updateConfig(state: IBotState): Promise<void> {
    let hasChanges = false;
    if (state.oldestFrameIdToSync > 0 && this.config.oldestFrameIdToSync !== state.oldestFrameIdToSync) {
      this.config.oldestFrameIdToSync = state.oldestFrameIdToSync;
      hasChanges = true;
    }
    if (!this.config.hasMiningSeats && state.hasMiningSeats) {
      this.config.hasMiningSeats = true;
      hasChanges = true;
    }
    if (!this.config.hasMiningBids && (state.hasMiningBids || state.hasMiningSeats)) {
      this.config.hasMiningBids = true;
      hasChanges = true;
    }
    if (hasChanges) await this.config.save();
  }

  private async persistServerState(state: IBotState): Promise<void> {
    const latestBitcoinBlockNumbers = state.bitcoinBlockNumbers;
    const latestArgonBlockNumbers = state.argonBlockNumbers;
    const savedState = await this.db.syncStateTable.get(SyncStateKeys.Server);
    const hasBitcoinChanges =
      savedState?.bitcoinLocalNodeBlockNumber !== latestBitcoinBlockNumbers.localNode ||
      savedState?.bitcoinMainNodeBlockNumber !== latestBitcoinBlockNumbers.mainNode;
    const hasArgonChanges =
      savedState?.argonLocalNodeBlockNumber !== latestArgonBlockNumbers.localNode ||
      savedState?.argonMainNodeBlockNumber !== latestArgonBlockNumbers.mainNode;
    const botLastActivityDate = state.botLastActiveDate;
    const hasBotActivityChanges = botLastActivityDate?.getTime() !== savedState?.botActivityLastUpdatedAt?.getTime();
    if (!hasBotActivityChanges && !hasBitcoinChanges && !hasArgonChanges) return;

    let bitcoinLastUpdatedAt = savedState?.bitcoinBlocksLastUpdatedAt;
    if (hasBitcoinChanges) {
      bitcoinLastUpdatedAt = new Date(latestBitcoinBlockNumbers.localNodeBlockTime * 1000);
      if (bitcoinLastUpdatedAt > new Date()) bitcoinLastUpdatedAt = new Date();
    }

    let argonBlocksLastUpdatedAt = savedState?.argonBlocksLastUpdatedAt;
    if (hasArgonChanges) {
      try {
        argonBlocksLastUpdatedAt = await this.miningFrames.blockWatch.getBlockTime(latestArgonBlockNumbers.localNode);
      } catch (error) {
        console.error('Error fetching argon block timestamp:', error);
        argonBlocksLastUpdatedAt = new Date();
      }
    }

    await this.db.syncStateTable.upsert(SyncStateKeys.Server, {
      latestFrameId: state.currentFrameId,
      argonBlocksLastUpdatedAt,
      argonLocalNodeBlockNumber: latestArgonBlockNumbers.localNode,
      argonMainNodeBlockNumber: latestArgonBlockNumbers.mainNode,
      bitcoinLocalNodeBlockNumber: latestBitcoinBlockNumbers.localNode,
      bitcoinMainNodeBlockNumber: latestBitcoinBlockNumbers.mainNode,
      bitcoinBlocksLastUpdatedAt: bitcoinLastUpdatedAt,
      botActivityLastUpdatedAt: botLastActivityDate || savedState?.botActivityLastUpdatedAt || new Date(),
      botActivityLastBlockNumber: state.botLastActiveBlockNumber ?? savedState?.botActivityLastBlockNumber ?? 0,
    });
    botEmitter.emit('updated-server-state');
  }

  private setStatus(status: BotStatus): void {
    if (this.status === status) return;
    this.status = status;
    botEmitter.emit('status-changed', status);
  }

  public async resyncBiddingRules(): Promise<void> {
    const server = new ServerAdmin(await SSH.getOrCreateConnection(), this.config.serverDetails);
    try {
      this.isBiddingRulesUploadInProgress = true;
      this.status = BotStatus.ServerSyncing;
      this.syncProgress = 50;
      await waitAtLeast(1000, server.uploadBiddingRules(this.config.biddingRules));
      this.syncProgress = 100;
      this.status = BotStatus.Ready;
    } catch (err) {
      this.status = BotStatus.Broken;
      throw err;
    } finally {
      this.isBiddingRulesUploadInProgress = false;
      this.syncProgress = 0;
    }
  }

  public get isStarting(): boolean {
    return this.status === BotStatus.Starting;
  }

  public get isSyncing(): boolean {
    return this.status === BotStatus.ServerSyncing;
  }

  public get isBroken(): boolean {
    return this.status === BotStatus.Broken;
  }

  public get isReady(): boolean {
    return this.status === BotStatus.Ready;
  }
}
