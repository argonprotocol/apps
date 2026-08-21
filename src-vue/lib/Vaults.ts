import {
  Currency as CurrencyBase,
  type IAllVaultStats,
  JsonExt,
  MiningFrames,
  Vaults as VaultsBase,
} from '@argonprotocol/apps-core';
import { BaseDirectory, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { getMainchainClient, getMainchainClients } from '../stores/mainchain.ts';
import { INSTANCE_NAME, NETWORK_NAME } from './Env.ts';

export interface IVaultStatsStorage {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

export class Vaults extends VaultsBase {
  constructor(
    network = NETWORK_NAME,
    currency: CurrencyBase,
    miningFrames: MiningFrames,
    private readonly statsStorage?: IVaultStatsStorage,
  ) {
    const clients = getMainchainClients();
    super(network, currency, miningFrames, clients);
  }

  public async subscribeToOperatorName(vaultId: number, onUpdate: (name?: string) => void): Promise<VoidFunction> {
    try {
      const vault = this.vaultsById[vaultId] ?? (await this.refreshVault(vaultId));
      if (!vault) return () => undefined;

      const client = await getMainchainClient(false);
      const operationalAccountId = await client.query.operationalAccounts.operationalAccountBySubAccount(
        vault.operatorAccountId,
      );
      if (!operationalAccountId.isSome) {
        onUpdate(this.setOperatorName(vaultId));
        return () => undefined;
      }

      return await client.query.operationalAccounts.operationalAccounts(operationalAccountId.unwrap(), profileOption =>
        onUpdate(this.setOperatorName(vaultId, profileOption)),
      );
    } catch (error) {
      console.warn(`[Vaults] Unable to subscribe to the operator profile for vault ${vaultId}`, error);
      return () => undefined;
    }
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
    if (!this.stats) return;
    if (this.isSavingStats) return;
    if (!this.statsStorage && typeof window === 'undefined') return;
    this.isSavingStats = true;
    try {
      const statsJson = JsonExt.stringify(this.stats, 2);
      if (this.statsStorage) {
        await this.statsStorage.write(statsJson);
        return;
      }

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
    if (this.statsStorage) {
      const state = await this.statsStorage.read();
      return state ? JsonExt.parse(state) : undefined;
    }
    if (typeof window === 'undefined') return;

    console.log('load stats from file', this.statsFile());
    const state = await readTextFile(this.statsFile(), {
      baseDir: BaseDirectory.AppConfig,
    }).catch(err => console.warn(`No existing vault stats file found: ${err}`));

    return state ? JsonExt.parse(state) : undefined;
  }
}
