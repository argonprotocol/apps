import { Db } from './Db';
import { BaseDirectory, remove } from '@tauri-apps/plugin-fs';
import { AdvancedRestartOption } from '../interfaces/IAdvancedRestartOption';
import { SSH } from './SSH';
import { Server } from './Server';
import { Config } from './Config.ts';
import Installer from './Installer.ts';
import { LocalMachine } from './LocalMachine.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import PluginSql from '@tauri-apps/plugin-sql';

export default class Restarter {
  private dbPromise: Promise<Db>;

  private _server?: Server;
  private _config: Config;

  constructor(dbPromise: Promise<Db>, config: Config) {
    this.dbPromise = dbPromise;
    this._config = config;
  }

  public async getServer() {
    if (!this._server) {
      const connection = await SSH.getOrCreateConnection();
      this._server = new Server(connection, this._config.serverDetails);
    }
    return this._server;
  }

  public async run(toRestart: Set<AdvancedRestartOption>, installer: Installer): Promise<void> {
    if (toRestart.has(AdvancedRestartOption.CompletelyWipeAndReinstallCloudMachine)) {
      installer.stop();
      let server: Server | undefined;
      try {
        server = await this.getServer();
      } catch (error) {
        const errorString = String(error).toLowerCase();
        console.log('Error connecting to server to wipe it:', errorString);
        if (errorString.includes('connection refused') || errorString.includes('host unreachable')) {
          // Server is likely already wiped, continue
          if (installer.isDockerHostProxy) {
            await LocalMachine.remove().catch(() => null);
          }
        }
      }
      await server?.completelyWipeEverything();
    } else {
      if (toRestart.has(AdvancedRestartOption.ResyncBitcoinBlocksOnCloudMachine)) {
        const server = await this.getServer();
        await server.resyncBitcoin();
      }

      if (toRestart.has(AdvancedRestartOption.ResyncArgonBlocksOnCloudMachine)) {
        const server = await this.getServer();
        await server.resyncMiner();
      }

      if (toRestart.has(AdvancedRestartOption.ResyncBiddingDataOnCloudMachine)) {
        const server = await this.getServer();
        await server.stopBotDocker();
        await server.deleteBotStorageFiles();
        await server.startBotDocker();
      }

      if (toRestart.has(AdvancedRestartOption.RestartDockers)) {
        const server = await this.getServer();
        await server.restartDocker();
      }
    }

    if (toRestart.has(AdvancedRestartOption.RecreateLocalDatabase)) {
      installer.stop();
      await this.migrateToFreshLocalDatabase(toRestart.has(AdvancedRestartOption.ReloadAppUi));
    }

    if (toRestart.has(AdvancedRestartOption.ReloadAppUi)) {
      this.restart();
    }
  }

  public async migrateToFreshLocalDatabase(restartAfter: boolean = true) {
    const db = await this.dbPromise;
    const config = this._config;

    await this.deleteAndCreateLocalDatabase();
    if (restartAfter) {
      db.pauseWrites();
      config.isRestarting = true;
    }

    // use a different connection since we're paused to avoid conflicts
    const sql = await PluginSql.load(`sqlite:${Db.relativePath}`);

    await config.restoreToConnection(sql);

    if (restartAfter) {
      this.restart();
    } else {
      await db.reconnect();
      await config.load(true);
    }
  }

  public async deleteAndCreateLocalDatabase(): Promise<void> {
    const db = await this.dbPromise;
    await db.close();

    const dbPath = Db.relativePath;
    await remove(dbPath, { baseDir: BaseDirectory.AppConfig });
    await invokeWithTimeout('run_db_migrations', {}, 30e3);
  }

  public restart() {
    window.location.reload();
  }
}
