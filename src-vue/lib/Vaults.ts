import {
  Currency as CurrencyBase,
  type IAllVaultStats,
  type IBlockHeaderInfo,
  JsonExt,
  MiningFrames,
  TreasuryRewards,
  bigNumberToBigInt,
  bundledVaultRevenueHistory,
  VAULT_STATS_FORMAT_VERSION,
  Vaults as VaultsBase,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { runtimeClient } from '@argonprotocol/runtime-client';
import { u8aToString } from '@polkadot/util';
import { BaseDirectory, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { getMainchainClient, getMainchainClients } from '../stores/mainchain.ts';
import { INSTANCE_NAME, NETWORK_NAME } from './Env.ts';

export interface IVaultStatsStorage {
  read(): Promise<string | null>;
  write(data: string): Promise<void>;
}

export class Vaults extends VaultsBase {
  private finalizedSubscription?: VoidFunction;
  private rewardFrameId?: number;
  private isRewardFrameLoading = false;

  constructor(
    network = NETWORK_NAME,
    currency: CurrencyBase,
    miningFrames: MiningFrames,
    private readonly statsStorage?: IVaultStatsStorage,
  ) {
    const clients = getMainchainClients();
    super(network, currency, miningFrames, clients);
  }

  public override async loadCurrentState(reload = false): Promise<void> {
    this.finalizedSubscription ??= this.miningFrames.blockWatch.events.on('finalized', headers => {
      const header = headers.at(-1)!;
      const frameId = header.frameId;
      void this.refreshRewardFrame(header);
      if (frameId === undefined || !this.stats) return;
      if (!this.stats.revenueBackfill && this.stats.synchedToFrame >= frameId - 1) return;

      void this.updateRevenue().catch(error => {
        console.warn('[VaultHistory] Frame details will retry on the next finalized block', error);
      });
    });
    await super.loadCurrentState(reload);
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
      if (!frame) return [];
      if (frame.argonotSecuritizationMicronots !== undefined && frame.upstreamParticipation !== undefined) return [];
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
      const pool = await parentApi.query.system.account(TreasuryRewards.getBidPoolAccountId(api));
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
      const [commitments, capital] = await Promise.all([
        parentApi.query.vaults.argonotSecuritizationByVaultId.entries(),
        parentApi.query.treasury.currentFrameVaultCapital(),
      ]);
      if (!commitments) return;
      const heldByVault = new Map(commitments.map(([key, value]) => [key.args[0], value?.heldMicronots ?? 0n]));
      for (const { vaultId, frame } of missing) {
        const vault = stats.vaultsById[vaultId];
        stats.vaultsById[vaultId] = {
          ...vault,
          changesByFrame: vault.changesByFrame.map(change => {
            if (change !== frame) return change;
            const updatedFrame = {
              ...frame,
              argonotSecuritizationMicronots: frame.argonotSecuritizationMicronots ?? heldByVault.get(vaultId) ?? 0n,
            };
            if (capital?.frameId === frameId && 'vaultSecuritizationPositions' in capital) {
              const participation = capital.vaultSecuritizationPositions?.[vaultId]?.upstreamParticipation;
              if (participation !== undefined) updatedFrame.upstreamParticipation = participation;
            }
            return updatedFrame;
          }),
        };
      }
    }
  }

  private async refreshRewardFrame(header: IBlockHeaderInfo): Promise<void> {
    const { frameId } = header;
    if (frameId === undefined) return;
    if (frameId === this.rewardFrameId) return;
    if (this.isRewardFrameLoading) return;

    this.isRewardFrameLoading = true;
    try {
      const api = runtimeClient(await this.miningFrames.blockWatch.getApi(header));
      const updated = await this.updateRewardConfig(api);
      if (updated) this.rewardFrameId = frameId;
    } catch (error) {
      console.warn('[Vaults] Reward frame will retry on the next finalized block', error);
    } finally {
      this.isRewardFrameLoading = false;
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

  protected async saveStats(stats = this.stats): Promise<void> {
    if (!stats) return;
    if (this.isSavingStats) return;
    if (!this.statsStorage && typeof window === 'undefined') return;
    this.isSavingStats = true;
    try {
      const statsJson = JsonExt.stringify(stats, 2);
      if (this.statsStorage) {
        await this.statsStorage.write(statsJson);
        return;
      }

      await mkdir(this.statsDirectory(), { baseDir: BaseDirectory.AppConfig, recursive: true });
      await writeTextFile(this.statsFile() + '.tmp', statsJson, {
        baseDir: BaseDirectory.AppConfig,
      });
      await rename(this.statsFile() + '.tmp', this.statsFile(), {
        oldPathBaseDir: BaseDirectory.AppConfig,
        newPathBaseDir: BaseDirectory.AppConfig,
      });
    } catch (error) {
      console.warn('[VaultHistory] Unable to save the cache; retaining loaded history', error);
    } finally {
      this.isSavingStats = false;
    }
  }

  protected async loadStatsFromFile(): Promise<IAllVaultStats | void> {
    if (!this.statsStorage && typeof window === 'undefined') return;

    let state: string | null | void;
    if (this.statsStorage) {
      state = await this.statsStorage.read();
    } else {
      state = await readTextFile(this.statsFile(), {
        baseDir: BaseDirectory.AppConfig,
      }).catch(err => console.warn(`No existing vault stats file found: ${err}`));
    }

    const cachedStats = state ? JsonExt.parse<IAllVaultStats>(state) : undefined;
    if (cachedStats?.formatVersion === VAULT_STATS_FORMAT_VERSION) return cachedStats;

    const bundledHistory = bundledVaultRevenueHistory[this.network];
    if (!bundledHistory) return cachedStats;

    const stats = JsonExt.parse<IAllVaultStats>(JSON.stringify(bundledHistory));
    await this.saveStats(stats);
    return stats;
  }
}
