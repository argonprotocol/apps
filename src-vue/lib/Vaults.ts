import {
  Currency as CurrencyBase,
  type IAllVaultStats,
  JsonExt,
  MiningFrames,
  TreasuryBonds,
  bigNumberToBigInt,
  Vaults as VaultsBase,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { u8aToString } from '@polkadot/util';
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
      if (!operationalAccountId) {
        onUpdate();
        return () => undefined;
      }

      return await client.query.operationalAccounts.operationalAccounts(operationalAccountId, profileOption => {
        const profileName = profileOption?.name;
        const name = profileName ? u8aToString(profileName).trim() : undefined;
        if (name) this.operatorNamesByVaultId[vaultId] = name;
        else delete this.operatorNamesByVaultId[vaultId];
        onUpdate(name);
      });
    } catch (error) {
      console.warn(`[Vaults] Unable to subscribe to the operator profile for vault ${vaultId}`, error);
      return () => undefined;
    }
  }

  protected override async loadFrameHistory(
    stats: IAllVaultStats,
    { frameId, firstBlockMeta, api, parentApi }: Parameters<VaultsBase['loadFrameHistory']>[1],
  ): Promise<void> {
    const constants = api.consts.treasury;
    if (!('percentForVaultPool' in constants)) return;

    const missing = Object.entries(stats.vaultsById).flatMap(([vaultId, vault]) => {
      const frame = vault.changesByFrame.find(change => change.frameId === frameId);
      if (!frame || frame.argonotSecuritizationMicronots !== undefined) return [];
      return [{ vaultId: Number(vaultId), frame }];
    });
    const needsNetworkPool = !stats.networkPoolsByFrame?.[frameId];
    if (!missing.length && !needsNetworkPool) return;

    // Frame-start extrinsics can change holdings after the completed frame's snapshot.
    if (!parentApi) {
      const parent = await this.miningFrames.blockWatch.getHeader(firstBlockMeta.blockNumber - 1);
      parentApi = await this.miningFrames.blockWatch.getApi(parent);
    }
    if (needsNetworkPool) {
      const pool = await parentApi.query.system.account(TreasuryBonds.getBidPoolAccountId(api));
      const auctionPoolMicrogons = pool.data.free;
      const vaultPoolMicrogons = bigNumberToBigInt(
        BigNumber(auctionPoolMicrogons).times(constants.percentForVaultPool),
      );
      stats.networkPoolsByFrame = {
        ...stats.networkPoolsByFrame,
        [frameId]: { auctionPoolMicrogons, vaultPoolMicrogons, includesBondPayments: false },
      };
    }

    if (missing.length) {
      const commitments = await parentApi.query.vaults.argonotSecuritizationByVaultId.entries();
      if (!commitments) return;
      const heldByVault = new Map(commitments.map(([key, value]) => [key.args[0], value?.heldMicronots ?? 0n]));
      for (const { vaultId, frame } of missing) {
        const vault = stats.vaultsById[vaultId];
        stats.vaultsById[vaultId] = {
          ...vault,
          changesByFrame: vault.changesByFrame.map(change =>
            change === frame ? { ...frame, argonotSecuritizationMicronots: heldByVault.get(vaultId) ?? 0n } : change,
          ),
        };
      }
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
