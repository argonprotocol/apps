import { BitcoinLock, type PalletVaultsVaultFrameRevenue, u128, Vault } from '@argonprotocol/mainchain';
import {
  bigNumberToBigInt,
  convertBigIntStringToNumber,
  createDeferred,
  Currency,
  FrameIterator,
  type IAllVaultStats,
  type IDeferred,
  type IVaultFrameStats,
  type IVaultStats,
  MainchainClients,
  Mining,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import mainnetVaultRevenueHistory from './data/vaultRevenue.mainnet.json' with { type: 'json' };
import testnetVaultRevenueHistory from './data/vaultRevenue.testnet.json' with { type: 'json' };
import { TreasuryBonds } from './TreasuryBonds.js';
import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
export const VAULT_REVENUE_COUPON_SPEC_VERSION = 145;
export const VAULT_STATS_FORMAT_VERSION = 1;

export class Vaults {
  public readonly vaultsById: { [id: number]: Vault } = {};
  public readonly vaultSatoshisById: { [id: number]: { lockedSatoshis: bigint; securitizedSatoshis: bigint } } = {};
  public stats?: IAllVaultStats;

  constructor(
    public network: string,
    public currency: Currency,
    public miningFrames: MiningFrames,
    private mainchainClients: MainchainClients,
  ) {}

  protected waitForLoad?: IDeferred;
  protected refreshingPromise?: Promise<IAllVaultStats>;
  protected isSavingStats: boolean = false;

  public async load(reload = false): Promise<void> {
    if (this.waitForLoad?.isRunning) return this.waitForLoad.promise;
    if (!reload && this.waitForLoad?.isResolved) return this.waitForLoad.promise;

    this.waitForLoad =
      reload || this.waitForLoad?.isRejected ? createDeferred() : (this.waitForLoad ??= createDeferred());
    try {
      const client = await this.mainchainClients.get(false);
      await this.miningFrames.load();
      const vaults = await client.query.vaults.vaultsById.entries();
      for (const [vaultIdRaw, vaultRaw] of vaults) {
        const id = vaultIdRaw.args[0].toNumber();
        const raw = vaultRaw.unwrap();
        this.vaultsById[id] = new Vault(id, raw, NetworkConfig.tickMillis);
        this.vaultSatoshisById[id] = {
          lockedSatoshis: raw.lockedSatoshis.toBigInt(),
          securitizedSatoshis: raw.securitizedSatoshis.toBigInt(),
        };
      }
      this.stats ??= await this.loadStats();

      this.waitForLoad.resolve();
    } catch (error) {
      this.waitForLoad.reject(error as Error);
    }
    return this.waitForLoad.promise;
  }

  public async subscribeToVault(vaultId: number, onUpdate: (vault: Vault) => void): Promise<() => void> {
    const client = await this.mainchainClients.get(false);

    return await client.query.vaults.vaultsById(vaultId, vaultOption => {
      if (!vaultOption.isSome) return;
      const raw = vaultOption.unwrap();
      this.vaultsById[vaultId] = new Vault(vaultId, raw, NetworkConfig.tickMillis);
      this.vaultSatoshisById[vaultId] = {
        lockedSatoshis: raw.lockedSatoshis.toBigInt(),
        securitizedSatoshis: raw.securitizedSatoshis.toBigInt(),
      };
      onUpdate(this.vaultsById[vaultId]);
    });
  }

  public async updateVaultRevenue(vaultId: number, frameRevenues: PalletVaultsVaultFrameRevenue[], skipSaving = false) {
    this.stats ??= { formatVersion: VAULT_STATS_FORMAT_VERSION, synchedToFrame: 0, vaultsById: {} };
    this.stats.vaultsById[vaultId] ??= {
      openedTick: this.vaultsById[vaultId]?.openedTick ?? 0,
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
        bitcoinFeeCouponValueUsed: revenue.bitcoinLockFeeCouponValueUsed?.toBigInt(),
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

  public async updateRevenue(clients?: MainchainClients): Promise<IAllVaultStats> {
    await this.load();
    clients ??= this.mainchainClients;
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
      this.stats ??= { formatVersion: VAULT_STATS_FORMAT_VERSION, synchedToFrame: 0, vaultsById: {} };
      // re-sync the last 10 frames to catch updates to revenue collection
      const oldestFrameToGet = this.stats.synchedToFrame - 10;
      const finalizedHead = this.miningFrames.blockWatch.finalizedBlockHeader;
      const frameIdsSeen = new Set<number>();
      const vaultFramesSeen = new Set<string>();
      let newestFinalizedFrameSeen = 0;

      await new FrameIterator(clients, this.miningFrames, 'VaultHistory').iterateFramesLimited(
        async (frameId, firstBlockMeta, api, abortController) => {
          if (firstBlockMeta.specVersion < VAULT_REVENUE_COUPON_SPEC_VERSION) {
            console.log(
              `[VaultHistory] Aborting iteration at frame ${frameId} as it uses specVersion ${firstBlockMeta.specVersion}`,
            );
            return abortController.abort();
          }
          // don't process until finalized
          if (firstBlockMeta.blockNumber > finalizedHead.blockNumber) {
            return;
          }
          newestFinalizedFrameSeen = Math.max(newestFinalizedFrameSeen, frameId);

          const vaultRevenues = await api.query.vaults.revenuePerFrameByVault.entries();

          for (const [vaultIdRaw, frameRevenues] of vaultRevenues) {
            const vaultId = vaultIdRaw.args[0].toNumber();
            for (const frameRevenue of frameRevenues) {
              const frameId = frameRevenue.frameId.toNumber();
              const vaultFrame = `${vaultId}:${frameId}`;
              if (!vaultFramesSeen.has(vaultFrame)) {
                await this.updateVaultRevenue(vaultId, [frameRevenue], true);
                frameIdsSeen.add(frameId);
                vaultFramesSeen.add(vaultFrame);
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

      this.stats.synchedToFrame = Math.max(newestFinalizedFrameSeen, ...frameIdsSeen, this.stats.synchedToFrame);
      this.stats.formatVersion = VAULT_STATS_FORMAT_VERSION;
      await this.saveStats();
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

  protected get syncedToFrame(): number {
    return this.stats?.synchedToFrame ?? 0;
  }

  public activatedSecuritization(vaultId: number): bigint {
    const vault = this.vaultsById[vaultId];
    if (!vault) return 0n;
    return vault.activatedSecuritization();
  }

  public contributedTotalTreasuryCapital(vaultId: number, maxFrames = 10): bigint {
    if (!this.stats) return 0n;
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    const oldestFrameId = this.syncedToFrame - maxFrames + 1;
    return vaultRevenue.changesByFrame
      .slice(0, maxFrames)
      .filter(x => x.frameId >= oldestFrameId)
      .reduce((total, change) => total + change.treasuryPool.externalCapital + change.treasuryPool.vaultCapital, 0n);
  }

  public contributedInternalTreasuryCapital(vaultId: number, maxFrames = 10): bigint {
    if (!this.stats) return 0n;
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    const oldestFrameId = this.syncedToFrame - maxFrames + 1;
    return vaultRevenue.changesByFrame
      .slice(0, maxFrames)
      .filter(x => x.frameId >= oldestFrameId)
      .reduce((total, change) => total + change.treasuryPool.vaultCapital, 0n);
  }

  public treasuryPoolTotalEarnings(vaultId: number, maxFrames = 10): bigint {
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    const oldestFrameId = this.syncedToFrame - maxFrames + 1;
    return vaultRevenue.changesByFrame
      .slice(0, maxFrames)
      .filter(x => x.frameId >= oldestFrameId)
      .reduce((total, change) => total + change.treasuryPool.totalEarnings, 0n);
  }

  public treasuryPoolInternalEarnings(vaultId: number, maxFrames = 10): bigint {
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    const oldestFrameId = this.syncedToFrame - maxFrames + 1;
    return vaultRevenue.changesByFrame
      .slice(0, maxFrames)
      .filter(x => x.frameId >= oldestFrameId)
      .reduce((total, change) => total + change.treasuryPool.vaultEarnings, 0n);
  }

  public getTrailingYearFeeRevenue(vaultId: number): bigint {
    const vaultRevenue = this.stats?.vaultsById[vaultId];
    if (!vaultRevenue) return 0n;

    return vaultRevenue.changesByFrame
      .slice(0, 365)
      .filter(x => x.frameId >= this.syncedToFrame - 365)
      .reduce((total, change) => total + change.bitcoinFeeRevenue, 0n);
  }

  public async getTotalLiquidityRealized(refresh = true) {
    if (refresh) {
      await this.updateRevenue();
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
    return Object.values(this.vaultSatoshisById).reduce((total, vault) => total + vault.lockedSatoshis, 0n);
  }

  public async fetchAndCalculateRedemptionAmount(lock: {
    satoshis: bigint;
    lockedTargetPrice: bigint;
  }): Promise<bigint> {
    await this.currency.fetchMainchainRates();
    return BitcoinLock.calculateRedemptionAmountFromSatoshis(
      this.currency.priceIndex,
      lock.satoshis,
      lock.lockedTargetPrice,
    );
  }

  public async getSatoshiPriceInTargetMicrogons(satoshis: bigint): Promise<bigint> {
    await this.currency.fetchMainchainRates();
    return this.currency.priceIndex.getSatoshiPriceInTargetMicrogons(satoshis);
  }

  public getTreasuryFillPct(vaultId: number): number {
    const vault = this.vaultsById[vaultId];
    if (!vault) return 0;

    const epochPoolCapital = Number(this.contributedTotalTreasuryCapital(vaultId, 10));
    const activatedSecuritization = Number(
      this.stats?.vaultsById[vaultId]?.changesByFrame[0]?.securitizationActivated ?? 0n,
    );

    if (activatedSecuritization === 0) return 0;

    return Math.round((epochPoolCapital / activatedSecuritization) * 100);
  }

  public calculateBondsApr(): number {
    const frames = this.selectReturnFrames(this.stats);
    const positions = frames.map(frame => {
      const externalEarnings = frame.treasuryPool.totalEarnings - frame.treasuryPool.vaultEarnings;
      const startingCapital = frame.treasuryPool.externalCapital + frame.treasuryPool.vaultCapital;
      return {
        startingCapital,
        endingCapital: startingCapital + externalEarnings,
      };
    });
    const result = calculateAggregateReturn(positions);

    return calculateAnnualPercentageRate({
      startingValue: result.eligibleCapitalInvested,
      endingValue: result.eligibleCapitalInvested + result.totalProfits,
      periodDays: this.returnFrameDays,
    });
  }

  public calculateApr(): number {
    const result = this.calculateVaultReturn();

    return calculateAnnualPercentageRate({
      startingValue: result.eligibleCapitalInvested,
      endingValue: result.eligibleCapitalInvested + result.totalProfits,
      periodDays: this.returnFrameDays,
    });
  }

  public calculateApy(): number {
    const result = this.calculateVaultReturn();

    return calculateAnnualPercentageYield({
      startingValue: result.eligibleCapitalInvested,
      endingValue: result.eligibleCapitalInvested + result.totalProfits,
      periodDays: this.returnFrameDays,
    });
  }

  public calculateVaultApr(vaultId: number): number {
    const result = this.calculateVaultReturn(vaultId);

    return calculateAnnualPercentageRate({
      startingValue: result.eligibleCapitalInvested,
      endingValue: result.eligibleCapitalInvested + result.totalProfits,
      periodDays: this.returnFrameDays,
    });
  }

  public calculateVaultApy(vaultId: number): number {
    const result = this.calculateVaultReturn(vaultId);

    return calculateAnnualPercentageYield({
      startingValue: result.eligibleCapitalInvested,
      endingValue: result.eligibleCapitalInvested + result.totalProfits,
      periodDays: this.returnFrameDays,
    });
  }

  private calculateVaultReturn(vaultId?: number) {
    const frames = this.selectReturnFrames(this.stats, vaultId);
    const positions = frames.map(frame => {
      if (frame.bitcoinFeeCouponValueUsed === undefined) {
        throw new Error(`Vault frame ${frame.frameId} is missing bitcoin fee coupon usage`);
      }

      const profits = frame.treasuryPool.vaultEarnings + frame.bitcoinFeeRevenue - frame.bitcoinFeeCouponValueUsed;
      return {
        startingCapital: frame.securitization,
        endingCapital: frame.securitization + profits,
      };
    });

    return calculateAggregateReturn(positions);
  }

  private selectReturnFrames(stats?: IAllVaultStats, vaultId?: number): IVaultFrameStats[] {
    if (!stats) return [];

    let vaultStats: IVaultStats[] = Object.values(stats.vaultsById);
    if (vaultId !== undefined) {
      const selectedVault = stats.vaultsById[vaultId];
      vaultStats = selectedVault ? [selectedVault] : [];
    }

    const oldestFrameId = stats.synchedToFrame - NetworkConfig.framesPerCohort + 1;
    return vaultStats.flatMap(vault => {
      return vault.changesByFrame.filter(
        frame => frame.frameId >= oldestFrameId && frame.frameId <= stats.synchedToFrame,
      );
    });
  }

  private get returnFrameDays(): number {
    return (NetworkConfig.rewardTicksPerFrame * NetworkConfig.tickMillis) / MILLISECONDS_PER_DAY;
  }

  private async loadStats(): Promise<IAllVaultStats> {
    const statsFromFile = await this.loadStatsFromFile();
    if (statsFromFile?.formatVersion === VAULT_STATS_FORMAT_VERSION) {
      return statsFromFile;
    }

    const { synchedToFrame, vaultsById } =
      {
        testnet: testnetVaultRevenueHistory,
        mainnet: mainnetVaultRevenueHistory,
      }[this.network]! ?? {};

    const stats: IAllVaultStats = {
      formatVersion: VAULT_STATS_FORMAT_VERSION,
      synchedToFrame: synchedToFrame ?? 0,
      vaultsById: {},
    };
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
        changesByFrame: changesByFrame.map(change => ({
          frameId: change.frameId,
          satoshisAdded: convertBigIntStringToNumber(change.satoshisAdded as any) ?? 0n,
          bitcoinLocksCreated: change.bitcoinLocksCreated,
          microgonLiquidityAdded: convertBigIntStringToNumber(change.microgonLiquidityAdded as any) ?? 0n,
          bitcoinFeeRevenue: convertBigIntStringToNumber(change.bitcoinFeeRevenue as any) ?? 0n,
          bitcoinFeeCouponValueUsed:
            'bitcoinFeeCouponValueUsed' in change
              ? convertBigIntStringToNumber(change.bitcoinFeeCouponValueUsed)
              : undefined,
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
        })),
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

  protected async saveStats(): Promise<void> {
    return undefined;
  }

  protected async loadStatsFromFile(): Promise<IAllVaultStats | void> {
    return undefined;
  }

  public static async getPreviousEpochTreasuryPayout(
    clients: MainchainClients,
  ): Promise<{ totalPoolRewards: bigint; totalActivatedCapital: bigint; participatingVaults: number }> {
    const client = await clients.prunedClientOrArchivePromise;
    const bidPoolPercentForVaults = TreasuryBonds.getBidPoolPercentForVaults(client);
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
    const totalPoolRewardsBn = BigNumber(totalMicrogonsBid).multipliedBy(bidPoolPercentForVaults);
    const totalPoolRewards = bigNumberToBigInt(totalPoolRewardsBn);

    return {
      totalPoolRewards,
      totalActivatedCapital,
      participatingVaults,
    };
  }
}
