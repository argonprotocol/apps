import { Config } from './Config';
import { Db } from './Db';
import { BotSyncer, BotStatus } from './BotSyncer';
import { ensureOnlyOneInstance } from './Utils';
import { type IBidsFile } from '@argonprotocol/commander-bot';
import mitt, { type Emitter } from 'mitt';
import Installer from './Installer';
import { SSH } from './SSH';
import { Server } from './Server';

export type IBotEmitter = {
  'updated-cohort-data': number;
  'updated-bids-data': IBidsFile['winningBids'];
  'updated-server-state': void;
  'status-changed': BotStatus;
};

export const botEmitter: Emitter<IBotEmitter> = mitt<IBotEmitter>();

export class Bot {
  public syncProgress: number;
  public maxSeatsPossible: number;
  public maxSeatsReductionReason: string;

  private status: BotStatus | null = null;
  private config: Config;
  private dbPromise: Promise<Db>;
  private botSyncer!: BotSyncer;

  constructor(config: Config, dbPromise: Promise<Db>) {
    ensureOnlyOneInstance(this.constructor);

    this.syncProgress = 0;
    this.maxSeatsPossible = 10;
    this.maxSeatsReductionReason = '';

    this.config = config;
    this.dbPromise = dbPromise;
  }

  public async load(installer: Installer): Promise<void> {
    const db = await this.dbPromise;
    this.botSyncer = new BotSyncer(this.config, db, installer, {
      onEvent: (type: keyof IBotEmitter, payload?: any) => botEmitter.emit(type, payload),
      setStatus: (x: BotStatus) => {
        this.status = x;
        botEmitter.emit('status-changed', x);
      },
      setServerSyncProgress: (x: number) => (this.syncProgress = x * 0.9),
      setDbSyncProgress: (x: number) => (this.syncProgress = 90 + x * 0.1),
      setMaxSeatsPossible: (x: number) => (this.maxSeatsPossible = x),
      setMaxSeatsReductionReason: (x: string) => (this.maxSeatsReductionReason = x),
    });

    await this.botSyncer.load();
  }

  public async restart(): Promise<void> {
    const server = new Server(await SSH.getOrCreateConnection());
    this.botSyncer.isPaused = true;
    await server.stopBotDocker();
    await server.startBotDocker();
    this.botSyncer.isPaused = false;
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
