import { BitcoinLock, type PalletVaultsVaultFrameRevenue, u128, Vault } from '@argonprotocol/mainchain';
import {
  bigNumberToBigInt,
  FrameIterator,
  JsonExt,
  MainchainClients,
  Mining,
  MiningFrames,
  NetworkConfig,
  PriceIndex,
} from '@argonprotocol/apps-core';
import { BaseDirectory, mkdir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { getMainchainClient, getMainchainClients } from '../stores/mainchain.ts';
import { convertBigIntStringToNumber, createDeferred, IDeferred } from './Utils.ts';
import { IAllVaultStats, IVaultFrameStats } from '../interfaces/IVaultStats.ts';
import mainnetVaultRevenueHistory from '../data/vaultRevenue.mainnet.json';
import testnetVaultRevenueHistory from '../data/vaultRevenue.testnet.json';
import { NETWORK_NAME } from './Env.ts';
import BigNumber from 'bignumber.js';

export class Vaults {
  public readonly vaultsById: { [id: number]: Vault } = {};
  public stats?: IAllVaultStats;

  constructor(
    public network = NETWORK_NAME,
    public priceIndex: PriceIndex,
    public miningFrames: MiningFrames,
  ) {}

  private waitForLoad?: IDeferred;
  private refreshingPromise?: Promise<IAllVaultStats>;
  private isSavingStats: boolean = false;

  public async load(reload = false): Promise<void> {
    if (this.waitForLoad && !reload) return this.waitForLoad.promise;

    this.waitForLoad ??= createDeferred();
    try {
      const client = await getMainchainClient(false);
      await this.miningFrames.load();
      const vaults = await client.query.vaults.vaultsById.entries();
      for (const [vaultIdRaw, vaultRaw] of vaults) {
        const id = vaultIdRaw.args[0].toNumber();
        this.vaultsById[id] = new Vault(id, vaultRaw.unwrap(), NetworkConfig.tickMillis);
      }
      this.stats ??= await this.loadStatsFromFile();

      this.waitForLoad.resolve();
    } catch (error) {
      this.waitForLoad.reject(error as Error);
    }
    return this.waitForLoad.promise;
  }

  public async updateVaultRevenue(vaultId: number, frameRevenues: PalletVaultsVaultFrameRevenue[], skipSaving = false) {
    this.stats ??= { synchedToFrame: 0, vaultsById: {} };
    this.stats.vaultsById[vaultId] ??= {
      openedTick: this.vaultsById[vaultId]?.openedTick ?? 0n,
      baseline: {
        bitcoinLocks: 0,
        feeRevenue: 0n,
        microgonLiquidityRealized: 0n,
        satoshis: 0n,
      },
      changesByFrame: [],
    };

    const frameChanges = this.stats.vaultsById[vaultId].changesByFrame;
    for (const frameRevenue of frameRevenues) {
      const frameId = frameRevenue.frameId.toNumber();
      const existing = frameChanges.find(x => frameId === x.frameId);

      const revenue = frameRevenue as PalletVaultsVaultFrameRevenue & {
        // renamed to treasury in 133
        liquidityPoolTotalEarnings?: u128;
        liquidityPoolVaultEarnings?: u128;
        liquidityPoolExternalCapital?: u128;
        liquidityPoolVaultCapital?: u128;
        // <= 133
        bitcoinLocksMarketValue?: u128; // renamed to bitcoin_locks_new_liquidity_promised
        bitcoinLocksTotalSatoshis?: u128; // renamed to bitcoin_locks_added_satoshis
        satoshisReleased?: u128; // renamed to bitcoin_locks_released_satoshis
        // new version 134
        securitizationRelockable?: u128;
        bitcoinLocksNewLiquidityPromised?: u128;
        bitcoinLocksAddedSatoshis?: u128;
        bitcoinLocksReleasedSatoshis?: u128;
        bitcoinLocksReleasedLiquidity?: u128;
      };

      const microgonsAdded =
        (revenue.bitcoinLocksNewLiquidityPromised ?? revenue.bitcoinLocksMarketValue)?.toBigInt() ?? 0n;
      const microgonsRemoved = revenue.bitcoinLocksReleasedLiquidity?.toBigInt() ?? 0n;
      const newSatoshis = (revenue.bitcoinLocksAddedSatoshis ?? revenue.bitcoinLocksTotalSatoshis)?.toBigInt() ?? 0n;
      const releasedSatoshis = (revenue.bitcoinLocksReleasedSatoshis ?? revenue.satoshisReleased)?.toBigInt() ?? 0n;

      const entry = {
        satoshisAdded: newSatoshis - releasedSatoshis,
        frameId,
        microgonLiquidityAdded: microgonsAdded - microgonsRemoved,
        bitcoinFeeRevenue: revenue.bitcoinLockFeeRevenue.toBigInt(),
        bitcoinLocksCreated: revenue.bitcoinLocksCreated.toNumber(),
        treasuryPool: {
          totalEarnings: (revenue.liquidityPoolTotalEarnings ?? revenue.treasuryTotalEarnings).toBigInt(),
          vaultEarnings: (revenue.liquidityPoolVaultEarnings ?? revenue.treasuryVaultEarnings).toBigInt(),
          externalCapital: (revenue.liquidityPoolExternalCapital ?? revenue.treasuryExternalCapital).toBigInt(),
          vaultCapital: (revenue.liquidityPoolVaultCapital ?? revenue.treasuryVaultCapital).toBigInt(),
        },
        securitization: revenue.securitization.toBigInt(),
        securitizationActivated: revenue.securitizationActivated.toBigInt(),
        securitizationRelockable: revenue.securitizationRelockable?.toBigInt() ?? 0n,
        uncollectedEarnings: revenue.uncollectedRevenue.toBigInt(),
      } as IVaultFrameStats;
      if (existing) {
        Object.assign(existing, entry);
      } else {
        // insert with highest frameId first
        const position = frameChanges.findIndex(x => x.frameId < frameId);
        if (position >= 0) {
          frameChanges.splice(position, 0, entry);
        } else {
          frameChanges.push(entry);
        }
      }
    }

    if (!skipSaving) {
      void this.saveStats();
    }
  }

  public async refreshRevenue(clients?: MainchainClients): Promise<IAllVaultStats> {
    await this.load();
    clients ??= getMainchainClients();
    if (this.refreshingPromise) return this.refreshingPromise;
    const refreshingDeferred = createDeferred<IAllVaultStats>();
    this.refreshingPromise = refreshingDeferred.promise;

    const scheduleClearance = () => {
      setTimeout(() => {
        if (this.refreshingPromise === refreshingDeferred.promise) {
          this.refreshingPromise = undefined;
        }
      }, 30e3);
    };
    try {
      this.stats ??= { synchedToFrame: 0, vaultsById: {} };
      // re-sync the last 10 frames to catch updates to revenue collection
      const oldestFrameToGet = this.stats.synchedToFrame - 10;
      const finalizedHead = this.miningFrames.blockWatch.finalizedBlockHeader;
      const framesSeen = new Set<number>();

      await new FrameIterator(clients, this.miningFrames, 'VaultHistory').iterateFramesLimited(
        async (frameId, firstBlockMeta, api, abortController) => {
          if (firstBlockMeta.specVersion < 129) {
            console.log(
              `[VaultHistory] Aborting iteration at frame ${frameId} as it uses specVersion ${firstBlockMeta.specVersion}`,
            );
            return abortController.abort();
          }
          // don't process until finalized
          if (firstBlockMeta.blockNumber > finalizedHead.blockNumber) {
            return;
          }
          const vaultRevenues = await api.query.vaults.revenuePerFrameByVault.entries();
          for (const [vaultIdRaw, frameRevenues] of vaultRevenues) {
            const vaultId = vaultIdRaw.args[0].toNumber();
            for (const frameRevenue of frameRevenues) {
              const frameId = frameRevenue.frameId.toNumber();
              if (!framesSeen.has(frameId)) {
                await this.updateVaultRevenue(vaultId, [frameRevenue], true);
                framesSeen.add(frameRevenue.frameId.toNumber());
              }
            }
          }

          if (frameId <= oldestFrameToGet) {
            console.log(
              `[VaultHistory] Aborting iteration at frame ${frameId} as it's older than frame ${oldestFrameToGet}`,
            );
            return abortController.abort();
          }
        },
      );

      this.stats.synchedToFrame = Math.max(...framesSeen, this.stats.synchedToFrame);
      void this.saveStats();
      refreshingDeferred.resolve(this.stats);
      scheduleClearance();
      return this.stats;
    } catch (error) {
      console.error('Error refreshing vault revenue stats:', error);
      refreshingDeferred.reject(error as Error);
      scheduleClearance();
      throw error;
    }
  }

  private get syncedToFrame(): number {
    return this.stats?.synchedToFrame ?? 0;
  }

  public activatedSecuritization(vaultId: number): bigint {
    const vault = this.vaultsById[vaultId];
    if (!vault) return 0n;
    return vault.activatedSecuritization();
  }

  public contributedTreasuryCapital(vaultId: number, maxFrames = 10): bigint {
    if (!this.stats) return 0n;
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    const oldestFrameId = this.syncedToFrame - maxFrames + 1;
    return vaultRevenue.changesByFrame
      .slice(0, maxFrames)
      .filter(x => x.frameId >= oldestFrameId)
      .reduce((total, change) => total + change.treasuryPool.externalCapital + change.treasuryPool.vaultCapital, 0n);
  }

  public treasuryPoolEarnings(vaultId: number, maxFrames = 10): bigint {
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    const oldestFrameId = this.syncedToFrame - maxFrames + 1;
    return vaultRevenue.changesByFrame
      .slice(0, maxFrames)
      .filter(x => x.frameId >= oldestFrameId)
      .reduce((total, change) => total + change.treasuryPool.totalEarnings, 0n);
  }

  public getTrailingYearFeeRevenue(vaultId: number): bigint {
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    return vaultRevenue.changesByFrame
      .slice(0, 365)
      .filter(x => x.frameId >= this.syncedToFrame - 365)
      .reduce((total, change) => total + change.bitcoinFeeRevenue, 0n);
  }

  public getLockedBitcoin(vaultId: number): bigint {
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    return (
      vaultRevenue.changesByFrame.reduce((total, change) => total + change.satoshisAdded, 0n) +
      vaultRevenue.baseline.satoshis
    );
  }

  public async getTotalLiquidityRealized(refresh = true) {
    if (refresh) {
      await this.refreshRevenue();
    }
    return Object.values(this.stats!.vaultsById).reduce((total, vault) => {
      return (
        total +
        vault.baseline.microgonLiquidityRealized +
        vault.changesByFrame.reduce((sum, change) => sum + change.microgonLiquidityAdded, 0n)
      );
    }, 0n);
  }

  public getTotalFeeRevenue(vaultId: number): bigint {
    const vault = this.vaultsById[vaultId];
    if (!vault) return 0n;

    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    return (
      vaultRevenue.baseline.feeRevenue +
      vaultRevenue.changesByFrame.reduce((sum, change) => sum + change.bitcoinFeeRevenue, 0n)
    );
  }

  public getTotalSatoshisLocked(): bigint {
    if (!this.stats) return 0n;
    return Object.values(this.stats.vaultsById).reduce((total, vault) => {
      const changesByFrame = vault.changesByFrame.reduce((sum, change) => sum + change.satoshisAdded, 0n);
      return total + vault.baseline.satoshis + changesByFrame;
    }, 0n);
  }

  public async getRedemptionRate(lock: { satoshis: bigint; peggedPrice: bigint }): Promise<bigint> {
    await this.priceIndex.fetchMicrogonExchangeRatesTo();
    return await BitcoinLock.getRedemptionRate(this.priceIndex.current, lock);
  }

  public async getMarketRate(satoshis: bigint): Promise<bigint> {
    await this.priceIndex.fetchMicrogonExchangeRatesTo();
    return await BitcoinLock.getMarketRate(this.priceIndex.current, satoshis);
  }

  public getTreasuryFillPct(vaultId: number): number {
    const vault = this.vaultsById[vaultId];
    if (!vault) return 0;

    const epochPoolCapital = Number(this.contributedTreasuryCapital(vaultId, 10));
    const activatedSecuritization = Number(
      this.stats?.vaultsById[vaultId]?.changesByFrame[0]?.securitizationActivated ?? 0n,
    );

    if (activatedSecuritization === 0) return 0;

    return Math.round((epochPoolCapital / activatedSecuritization) * 100);
  }

  public calculateVaultApy(vaultId: number): number {
    const vault = this.vaultsById[vaultId];

    const yearFeeRevenue = Number(this.getTrailingYearFeeRevenue(vaultId));

    const epochPoolCapital = Number(this.contributedTreasuryCapital(vaultId, 10));

    const epochPoolEarnings = Number(this.treasuryPoolEarnings(vaultId, 10));
    const epochPoolEarningsRatio = epochPoolCapital ? epochPoolEarnings / epochPoolCapital : 0;

    const poolApy = (1 + epochPoolEarningsRatio) ** 36.5 - 1;
    const feeApr = vault.securitization > 0n ? yearFeeRevenue / Number(vault.securitization) : 0;

    return poolApy + feeApr;
  }

  private statsFile() {
    return `${this.network}/vaultStats.json`;
  }

  private async saveStats(): Promise<void> {
    if (!this.stats) return;
    if (this.isSavingStats) return;
    this.isSavingStats = true;
    try {
      const statsJson = JsonExt.stringify(this.stats, 2);
      await mkdir(`${this.network}`, { baseDir: BaseDirectory.AppConfig, recursive: true }).catch(() => null);
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

  private async loadStatsFromFile(): Promise<IAllVaultStats> {
    console.log('load stats from file', this.statsFile());
    const state = await readTextFile(this.statsFile(), {
      baseDir: BaseDirectory.AppConfig,
    }).catch(err => console.warn(`No existing vault stats file found: ${err}`));
    if (state) {
      return JsonExt.parse(state);
    }

    const { synchedToFrame, vaultsById } =
      {
        testnet: testnetVaultRevenueHistory,
        mainnet: mainnetVaultRevenueHistory,
      }[this.network]! ?? {};

    const stats: (typeof this)['stats'] = { synchedToFrame, vaultsById: {} };
    for (const [vaultId, entry] of Object.entries(vaultsById ?? {})) {
      const { changesByFrame, openedTick, baseline } = entry;
      const id = parseInt(vaultId, 10);
      stats.vaultsById[id] = {
        openedTick,
        baseline: {
          bitcoinLocks: baseline.bitcoinLocks,
          feeRevenue: convertBigIntStringToNumber(baseline.feeRevenue as any) ?? 0n,
          microgonLiquidityRealized: convertBigIntStringToNumber(baseline.microgonLiquidityRealized as any) ?? 0n,
          satoshis: convertBigIntStringToNumber(baseline.satoshis as any) ?? 0n,
        },
        changesByFrame: changesByFrame.map(
          change =>
            ({
              frameId: change.frameId,
              satoshisAdded: convertBigIntStringToNumber(change.satoshisAdded as any) ?? 0n,
              bitcoinLocksCreated: change.bitcoinLocksCreated,
              microgonLiquidityAdded: convertBigIntStringToNumber(change.microgonLiquidityAdded as any) ?? 0n,
              bitcoinFeeRevenue: convertBigIntStringToNumber(change.bitcoinFeeRevenue as any) ?? 0n,
              securitization: convertBigIntStringToNumber(change.securitization as any) ?? 0n,
              securitizationRelockable: convertBigIntStringToNumber((change as any).securitizationRelockable) ?? 0n,
              securitizationActivated: convertBigIntStringToNumber(change.securitizationActivated as any) ?? 0n,
              treasuryPool: {
                externalCapital: convertBigIntStringToNumber(change.treasuryPool.externalCapital as any) ?? 0n,
                vaultCapital: convertBigIntStringToNumber(change.treasuryPool.vaultCapital as any) ?? 0n,
                totalEarnings: convertBigIntStringToNumber(change.treasuryPool.totalEarnings as any) ?? 0n,
                vaultEarnings: convertBigIntStringToNumber(change.treasuryPool.vaultEarnings as any) ?? 0n,
              },
              uncollectedEarnings: 0n,
            }) as IVaultFrameStats,
        ),
      };
    }
    for (const vault of Object.values(this.vaultsById)) {
      stats.vaultsById[vault.vaultId] ??= {
        openedTick: vault.openedTick,
        baseline: {
          bitcoinLocks: 0,
          feeRevenue: 0n,
          microgonLiquidityRealized: 0n,
          satoshis: 0n,
        },
        changesByFrame: [],
      };
    }
    return stats;
  }

  public static async getPreviousEpochTreasuryPoolPayout(
    clients: MainchainClients,
  ): Promise<{ totalPoolRewards: bigint; totalActivatedCapital: bigint; participatingVaults: number }> {
    const client = await clients.prunedClientOrArchivePromise;
    const bidBurnPercent = (100 - client.consts.treasury.bidPoolBurnPercent.toNumber()) / 100;
    const totalMicrogonsBid = await new Mining(clients).fetchAggregateBidCosts();
    const vaultRevenue = await client.query.vaults.revenuePerFrameByVault.entries();
    let totalActivatedCapital = 0n;
    let participatingVaults = 0;
    for (const [_vaultId, revenue] of vaultRevenue) {
      for (const entry of revenue) {
        const capital = entry.treasuryVaultCapital.toBigInt() + entry.treasuryExternalCapital.toBigInt();
        if (capital > 0n) {
          participatingVaults++;
          totalActivatedCapital += capital;
        }
      }
    }

    // treasury burns 20% of total bids
    const totalPoolRewardsBn = BigNumber(totalMicrogonsBid).multipliedBy(bidBurnPercent);
    const totalPoolRewards = bigNumberToBigInt(totalPoolRewardsBn);

    return {
      totalPoolRewards,
      totalActivatedCapital,
      participatingVaults,
    };
  }
}
