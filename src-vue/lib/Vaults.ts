import {
  Currency as CurrencyBase,
  type IAllVaultStats,
  JsonExt,
  MiningFrames,
  Vaults as VaultsBase,
} from '@argonprotocol/apps-core';
import { BaseDirectory, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { getMainchainClients } from '../stores/mainchain.ts';
import { INSTANCE_NAME, NETWORK_NAME } from './Env.ts';

export class Vaults extends VaultsBase {
  constructor(network = NETWORK_NAME, currency: CurrencyBase, miningFrames: MiningFrames) {
    const clients = getMainchainClients();
    super(network, currency, miningFrames, clients);
  }

  private statsDirectory() {
    if (this.network === 'dev-docker') {
      return `${this.network}/${INSTANCE_NAME}`;
    }
    return this.network;
  }

  private statsFile() {
    return `${this.statsDirectory()}/vaultStats.json`;
  }

  protected async saveStats(): Promise<void> {
    // Vitest integration runs in Node, so keep vault stats in memory instead of calling Tauri fs.
    if (typeof window === 'undefined') return;
    if (!this.stats) return;
    if (this.isSavingStats) return;
    this.isSavingStats = true;
    try {
      const statsJson = JsonExt.stringify(this.stats, 2);
      await mkdir(this.statsDirectory(), { baseDir: BaseDirectory.AppConfig, recursive: true }).catch(() => null);
      await writeTextFile(this.statsFile() + '.tmp', statsJson, {
        baseDir: BaseDirectory.AppConfig,
      }).catch(error => {
        console.error('Error saving vault stats:', error);
      });
      await rename(this.statsFile() + '.tmp', this.statsFile(), {
        oldPathBaseDir: BaseDirectory.AppConfig,
        newPathBaseDir: BaseDirectory.AppConfig,
      }).catch(error => {
        console.error('Error renaming vault stats file:', error);
      });
    } finally {
      this.isSavingStats = false;
    }
  }

  protected async loadStatsFromFile(): Promise<IAllVaultStats | void> {
    if (typeof window === 'undefined') return;
    console.log('load stats from file', this.statsFile());
    const state = await readTextFile(this.statsFile(), {
      baseDir: BaseDirectory.AppConfig,
    }).catch(err => console.warn(`No existing vault stats file found: ${err}`));

    return state ? JsonExt.parse(state) : undefined;
  }
}
