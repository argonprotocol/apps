import type { HistoricalQueryRecord, MergeHistorical } from '@argonprotocol/runtime-client';
import { u8aToString } from '@polkadot/util';
import {
  type ArgonQueryClient,
  type ArgonCurrentQueryClient,
  type ArgonApi,
  bigNumberToBigInt,
  createDeferred,
  Currency,
  FrameIterator,
  type IAllVaultStats,
  type ICallbackFirstBlockMeta,
  type IDeferred,
  type IVaultFrameStats,
  type IVaultStats,
  JsonExt,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import BigNumber from 'bignumber.js';
import { raceWithTimeout } from './utils.js';
import mainnetVaultRevenueHistory from './data/vaultRevenue.mainnet.json' with { type: 'json' };
import testnetVaultRevenueHistory from './data/vaultRevenue.testnet.json' with { type: 'json' };
import { BondLot } from './BondLot.js';
import { BitcoinLock } from './BitcoinLock.js';
import { Vault } from './Vault.js';
import {
  calculateAggregateReturn,
  calculateAnnualPercentageRate,
  calculateAnnualPercentageYield,
} from './FinancialReturns.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const VAULT_REVENUE_BACKFILL_BATCH_FRAMES = 20;
export const VAULT_REVENUE_COUPON_SPEC_VERSION = 145;
export const VAULT_STATS_FORMAT_VERSION = 2;
type RuntimeOperationalAccount = NonNullable<HistoricalQueryRecord<'operationalAccounts', 'operationalAccounts'>>;
type RuntimeVaultFrameRevenue = MergeHistorical<
  NonNullable<HistoricalQueryRecord<'vaults', 'revenuePerFrameByVault'>>[number]
>;

export class Vaults {
  public vaultsById: { [id: number]: Vault } = {};
  public operatorNamesByVaultId: { [id: number]: string } = {};
  public stats?: IAllVaultStats;
  public currentState = { isLoaded: false, isLoading: false, error: '', statsRevision: 0 };
  private currentLoad?: Promise<void>;

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
      await this.loadCurrentState(reload);
      await this.miningFrames.load();
      this.stats ??= await this.loadStats();

      const completedFrameId = this.miningFrames.currentFrameId - 1;
      const needsBondAttribution = this.selectReturnFrames(this.stats).some(
        frame => frame.treasuryPool.vaultCapital > 0n && frame.treasuryPool.flexibleBondEarnings === undefined,
      );
      if (!this.stats.revenueBackfill && (this.stats.synchedToFrame < completedFrameId || needsBondAttribution)) {
        let oldestSnapshotFrameId = this.stats.synchedToFrame + 2;
        if (needsBondAttribution) {
          oldestSnapshotFrameId = Math.max(1, this.stats.synchedToFrame - NetworkConfig.framesPerCohort);
        }
        this.stats.revenueBackfill = {
          nextFrame: this.miningFrames.currentFrameId,
          throughFrame: oldestSnapshotFrameId,
        };
      }

      this.currentState.statsRevision += 1;
      this.waitForLoad.resolve();
      if (this.stats.revenueBackfill) this.queueRevenueUpdate();
    } catch (error) {
      this.waitForLoad.reject(error as Error);
    }
    return this.waitForLoad.promise;
  }

  public async loadCurrentState(reload = false): Promise<void> {
    if (this.currentLoad) return this.currentLoad;
    if (this.currentState.isLoaded && !reload) return;

    this.currentState.isLoading = true;
    this.currentState.error = '';
    this.currentLoad = (async () => {
      try {
        const { client, entries } = await raceWithTimeout(
          (async () => {
            const client = await this.mainchainClients.get(false);
            return { client, entries: await client.query.vaults.vaultsById.entries() };
          })(),
          60_000,
          () => {
            throw new Error('Loading active vaults timed out. Please retry.');
          },
        );
        const records: Record<number, Vault> = {};
        for (const [key, raw] of entries) {
          if (raw) records[key.args[0]] = Vault.fromRuntime(key.args[0], raw, NetworkConfig.tickMillis, client.consts);
        }
        for (const id of Object.keys(this.vaultsById)) {
          if (!records[Number(id)]) delete this.vaultsById[Number(id)];
        }
        Object.assign(this.vaultsById, records);
        this.currentState.isLoaded = true;
        void this.refreshOperatorNames({ client, vaults: Object.values(records) });
      } catch (error) {
        this.currentState.error = error instanceof Error ? error.message : 'Unable to load active vaults.';
        throw error;
      } finally {
        this.currentState.isLoading = false;
        this.currentLoad = undefined;
      }
    })();
    return this.currentLoad;
  }

  public async refreshVault(vaultId: number): Promise<Vault | undefined> {
    if (this.currentLoad) await this.currentLoad;
    const client = await this.mainchainClients.get(false);
    const vaultOption = await client.query.vaults.vaultsById(vaultId);
    if (!vaultOption) {
      delete this.vaultsById[vaultId];
      delete this.operatorNamesByVaultId[vaultId];
      return;
    }

    const raw = vaultOption;
    const vault = Vault.fromRuntime(vaultId, raw, NetworkConfig.tickMillis, client.consts);
    this.vaultsById[vaultId] = vault;
    return vault;
  }

  public async refreshOperatorNames(args: {
    vaults: Pick<Vault, 'vaultId' | 'operatorAccountId'>[];
    client?: ArgonQueryClient;
  }): Promise<void> {
    if (!args.vaults.length) return;

    try {
      const client = args.client ?? (await this.mainchainClients.get(false));
      const [subaccountEntriesRaw, profileEntriesRaw] = await Promise.all([
        client.query.operationalAccounts.operationalAccountBySubAccount.entries(),
        client.query.operationalAccounts.operationalAccounts.entries(),
      ]);
      const operationalAccountBySubAccount = new Map<string, string>();
      for (const [key, operationalAccountId] of subaccountEntriesRaw ?? []) {
        if (operationalAccountId) {
          operationalAccountBySubAccount.set(key.args[0].toString(), operationalAccountId.toString());
        }
      }
      const profilesByOperationalAccount = new Map<string, RuntimeOperationalAccount>();
      for (const [key, profile] of profileEntriesRaw ?? []) {
        if (profile) profilesByOperationalAccount.set(key.args[0].toString(), profile);
      }

      for (const vault of args.vaults) {
        const operationalAccountId = operationalAccountBySubAccount.get(vault.operatorAccountId);
        this.setOperatorName(
          vault.vaultId,
          operationalAccountId ? profilesByOperationalAccount.get(operationalAccountId) : undefined,
        );
      }
    } catch (error) {
      console.warn('[Vaults] Unable to load operator profile names', error);
    }
  }

  public async subscribeToVault(vaultId: number, onUpdate: (vault: Vault) => void): Promise<() => void> {
    const client = await this.mainchainClients.get(false);

    return await client.query.vaults.vaultsById(vaultId, vaultOption => {
      if (!vaultOption) return;
      const raw = vaultOption;
      this.vaultsById[vaultId] = Vault.fromRuntime(vaultId, raw, NetworkConfig.tickMillis, client.consts);
      onUpdate(this.vaultsById[vaultId]);
    });
  }

  protected setOperatorName(vaultId: number, profile?: RuntimeOperationalAccount): string | undefined {
    const profileName = profile && 'name' in profile ? profile.name : undefined;
    const name = profileName ? u8aToString(profileName).trim() : undefined;
    if (name) this.operatorNamesByVaultId[vaultId] = name;
    else delete this.operatorNamesByVaultId[vaultId];
    return name;
  }

  public async updateVaultRevenue(
    vaultId: number,
    frameRevenues: readonly RuntimeVaultFrameRevenue[],
    backfill?: IAllVaultStats,
  ) {
    const stats =
      backfill ??
      (this.stats ??= {
        formatVersion: VAULT_STATS_FORMAT_VERSION,
        synchedToFrame: 0,
        argonotStakingByFrame: [],
        vaultsById: {},
      });
    const vaultStats = stats.vaultsById[vaultId] ?? {
      openedTick: this.vaultsById[vaultId]?.openedTick ?? 0,
      baseline: { bitcoinLocks: 0, feeRevenue: 0n, microgonLiquidityRealized: 0n, satoshis: 0n },
      changesByFrame: [],
    };
    const frameChanges = new Map(vaultStats.changesByFrame.map(frame => [frame.frameId, frame]));
    for (const revenue of frameRevenues) {
      const existing = frameChanges.get(revenue.frameId);
      frameChanges.set(revenue.frameId, {
        ...existing,
        frameId: revenue.frameId,
        satoshisAdded:
          (revenue.bitcoinLocksAddedSatoshis ?? revenue.bitcoinLocksTotalSatoshis ?? 0n) -
          (revenue.bitcoinLocksReleasedSatoshis ?? revenue.satoshisReleased ?? 0n),
        microgonLiquidityAdded:
          (revenue.bitcoinLocksNewSecuritization ??
            revenue.bitcoinLocksNewLiquidityPromised ??
            revenue.bitcoinLocksMarketValue ??
            0n) - (revenue.bitcoinLocksReleasedSecuritization ?? revenue.bitcoinLocksReleasedLiquidity ?? 0n),
        bitcoinFeeRevenue: revenue.bitcoinLockFeeRevenue,
        bitcoinFeeCouponValueUsed: revenue.bitcoinLockFeeCouponValueUsed,
        bitcoinLocksCreated: revenue.bitcoinLocksCreated,
        treasuryPool: {
          ...existing?.treasuryPool,
          totalEarnings: revenue.treasuryTotalEarnings ?? revenue.liquidityPoolTotalEarnings ?? 0n,
          vaultEarnings: revenue.treasuryVaultEarnings ?? revenue.liquidityPoolVaultEarnings ?? 0n,
          externalCapital: revenue.treasuryExternalCapital ?? revenue.liquidityPoolExternalCapital ?? 0n,
          vaultCapital: revenue.treasuryVaultCapital ?? revenue.liquidityPoolVaultCapital ?? 0n,
        },
        securitization: revenue.securitization,
        securitizationActivated: revenue.securitizationActivated,
        securitizationRelockable: revenue.securitizationRelockable ?? 0n,
        uncollectedEarnings: revenue.uncollectedRevenue,
      });
    }
    stats.vaultsById[vaultId] = {
      ...vaultStats,
      changesByFrame: [...frameChanges.values()].sort((a, b) => b.frameId - a.frameId),
    };
    if (!backfill) {
      this.currentState.statsRevision += 1;
      await this.saveStats();
    }
  }

  public async updateRevenue(clients?: MainchainClients): Promise<IAllVaultStats> {
    await this.load();
    if (this.refreshingPromise) return this.refreshingPromise;
    if (!this.stats!.revenueBackfill && this.stats!.synchedToFrame >= this.miningFrames.currentFrameId - 1) {
      return this.stats!;
    }
    const refreshClients = clients ?? this.mainchainClients;
    const refresh = (async () => {
      const initialStats = { ...this.stats!, vaultsById: { ...this.stats!.vaultsById } };
      const stats: IAllVaultStats = {
        ...initialStats,
        formatVersion: VAULT_STATS_FORMAT_VERSION,
        vaultsById: { ...initialStats.vaultsById },
        ...(initialStats.revenueBackfill ? { revenueBackfill: { ...initialStats.revenueBackfill } } : {}),
      };

      const revenueBackfill = (stats.revenueBackfill ??= {
        nextFrame: this.miningFrames.currentFrameId,
        throughFrame: stats.synchedToFrame + 2,
      });
      const { nextFrame: nextSnapshotFrameId, throughFrame: oldestSnapshotFrameId } = revenueBackfill;
      const oldestCompletedFrameId = oldestSnapshotFrameId - 1;
      const finalizedHead = this.miningFrames.blockWatch.finalizedBlockHeader;
      const argonBondPayoutsByFrame = new Map<number, NonNullable<IAllVaultStats['argonBondsByFrame']>[number]>();
      const argonotStakePayoutsByFrame = new Map(stats.argonotStakingByFrame.map(frame => [frame.frameId, frame]));
      let latestCompletedFrameId = Math.min(stats.synchedToFrame, this.miningFrames.currentFrameId - 1);
      let snapshotsProcessed = 0;
      let lastSnapshotFrameId: number | undefined;
      let isBackfillComplete = false;

      const frameIterator = new FrameIterator(refreshClients, this.miningFrames, 'VaultHistory');
      await frameIterator.iterateFramesLimited(async (snapshotFrameId, firstBlockMeta, api, abortController) => {
        if (firstBlockMeta.specVersion < VAULT_REVENUE_COUPON_SPEC_VERSION) {
          console.log(
            `[VaultHistory] Aborting iteration at frame ${snapshotFrameId} as it uses specVersion ${firstBlockMeta.specVersion}`,
          );
          isBackfillComplete = true;
          return abortController.abort();
        }

        snapshotsProcessed += 1;
        lastSnapshotFrameId = snapshotFrameId;

        if (firstBlockMeta.blockNumber <= finalizedHead.blockNumber) {
          const completedFrameId = snapshotFrameId - 1;
          let parentApi: ArgonApi | undefined;
          latestCompletedFrameId = Math.max(latestCompletedFrameId, completedFrameId);

          if ('currentFrameArgonotBondParticipants' in api.query.treasury) {
            const parent = await this.miningFrames.blockWatch.getHeader(firstBlockMeta.blockNumber - 1);
            parentApi = await this.miningFrames.blockWatch.getApi(parent);
            const [participants, events] = await Promise.all([
              parentApi.query.treasury.currentFrameArgonotBondParticipants(),
              api.query.system.events(),
            ]);

            for (const { event } of events) {
              if (event.section !== 'treasury' || event.method !== 'FrameEarningsDistributed') continue;
              const payout = event.data;
              if (payout.frameId !== completedFrameId) continue;
              const argonotStakePayoutMicrogons =
                payout.stakePoolDistributed ?? payout.argonotBondPoolDistributed ?? 0n;
              if (
                argonotStakePayoutMicrogons > 0n &&
                !argonotStakePayoutsByFrame.has(completedFrameId) &&
                participants?.frameId !== completedFrameId
              ) {
                throw new Error(
                  `Frame ${completedFrameId} is missing its Argonot payout participants. Retry history loading.`,
                );
              }
              if (participants?.frameId === completedFrameId && !argonotStakePayoutsByFrame.has(completedFrameId)) {
                const { frame, api: frameStartApi } = await this.miningFrames.getFrameStart(completedFrameId);
                const rates = await this.currency.fetchMainchainRatesAtBlock({
                  api: frameStartApi,
                  block: { blockHash: frame.firstBlockHash! },
                });
                argonotStakePayoutsByFrame.set(completedFrameId, {
                  frameId: completedFrameId,
                  poolDistributed: argonotStakePayoutMicrogons,
                  participatingBonds: participants.totalBonds,
                  microgonsPerArgonot: rates.ARGNOT,
                });
              }
              if (payout.argonBondPoolDistributed === undefined) continue;
              if (argonBondPayoutsByFrame.has(payout.frameId)) continue;
              const savedPayout = stats.argonBondsByFrame?.find(frame => frame.frameId === payout.frameId);
              if (savedPayout?.participatingBonds !== undefined) continue;

              // The payout block has already replaced capital with the next frame's terms.
              const capital = await parentApi.query.treasury.currentFrameVaultCapital();
              let participatingBonds: bigint | undefined;
              if (capital && 'totalActiveBonds' in capital && capital.frameId === payout.frameId) {
                participatingBonds = capital.totalActiveBonds;
              }
              if (payout.argonBondPoolDistributed > 0n && participatingBonds === undefined) {
                throw new Error(
                  `Frame ${completedFrameId} is missing its Argon bond payout capital. Retry history loading.`,
                );
              }
              argonBondPayoutsByFrame.set(payout.frameId, {
                frameId: payout.frameId,
                poolDistributed: payout.argonBondPoolDistributed,
                participatingBonds,
              });
            }
          }

          const vaultRevenues = await api.query.vaults.revenuePerFrameByVault.entries();
          for (const [vaultIdRaw, frameRevenues] of vaultRevenues ?? []) {
            const vaultId = vaultIdRaw.args[0];
            for (const frameRevenue of frameRevenues) {
              if (frameRevenue.frameId !== completedFrameId) continue;
              if (completedFrameId < oldestCompletedFrameId) continue;
              await this.updateVaultRevenue(vaultId, [frameRevenue], stats);
            }
          }

          const flexibleFrames = Object.entries(stats.vaultsById).flatMap(([vaultId, vault]) => {
            const frame = vault.changesByFrame.find(change => change.frameId === completedFrameId);
            return frame?.treasuryPool.vaultCapital ? [{ vaultId: Number(vaultId), frame }] : [];
          });
          if (flexibleFrames.length) {
            if (!parentApi) {
              const parent = await this.miningFrames.blockWatch.getHeader(firstBlockMeta.blockNumber - 1);
              parentApi = await this.miningFrames.blockWatch.getApi(parent);
            }
            const capital = await parentApi.query.treasury.currentFrameVaultCapital();
            if (capital?.frameId === completedFrameId && 'vaults' in capital && capital.vaults) {
              for (const { vaultId, frame } of flexibleFrames) {
                const position = capital.vaults[vaultId];
                if (!position || !('flexibleProrata' in position)) continue;
                const flexibleBondEarnings = bigNumberToBigInt(
                  position.flexibleProrata.times(frame.treasuryPool.totalEarnings),
                );
                const vault = stats.vaultsById[vaultId];
                stats.vaultsById[vaultId] = {
                  ...vault,
                  changesByFrame: vault.changesByFrame.map(change =>
                    change === frame
                      ? { ...frame, treasuryPool: { ...frame.treasuryPool, flexibleBondEarnings } }
                      : change,
                  ),
                };
              }
            }
          }
          if (completedFrameId >= oldestCompletedFrameId) {
            await this.loadFrameHistory(stats, { frameId: completedFrameId, firstBlockMeta, api, parentApi });
          }
        }

        if (snapshotFrameId <= oldestSnapshotFrameId) {
          isBackfillComplete = true;
          abortController.abort();
        } else if (snapshotsProcessed >= VAULT_REVENUE_BACKFILL_BATCH_FRAMES) {
          abortController.abort();
        }
      }, nextSnapshotFrameId);

      if (snapshotsProcessed < VAULT_REVENUE_BACKFILL_BATCH_FRAMES) isBackfillComplete = true;

      if (argonBondPayoutsByFrame.size) {
        const retainedFrames = (stats.argonBondsByFrame ?? []).filter(
          frame => !argonBondPayoutsByFrame.has(frame.frameId),
        );
        stats.argonBondsByFrame = [...retainedFrames, ...argonBondPayoutsByFrame.values()].sort(
          (a, b) => b.frameId - a.frameId,
        );
      }

      stats.argonotStakingByFrame = [...argonotStakePayoutsByFrame.values()].sort((a, b) => b.frameId - a.frameId);
      stats.synchedToFrame = latestCompletedFrameId;

      if (isBackfillComplete || lastSnapshotFrameId === undefined) {
        delete stats.revenueBackfill;
      } else {
        revenueBackfill.nextFrame = lastSnapshotFrameId - 1;
      }

      // Live observations made during the scan keep their newer values and any recovered attribution.
      for (const [id, current] of Object.entries(this.stats!.vaultsById)) {
        const vaultId = Number(id);
        const previousFrames = initialStats.vaultsById[vaultId]?.changesByFrame ?? [];
        const updatedFrames = current.changesByFrame.filter(frame => !previousFrames.includes(frame));
        if (!updatedFrames.length) continue;
        const reconstructed = stats.vaultsById[vaultId] ?? current;
        const frames = new Map(reconstructed.changesByFrame.map(frame => [frame.frameId, frame]));
        for (const frame of updatedFrames) {
          frames.set(frame.frameId, {
            ...frames.get(frame.frameId),
            ...frame,
            argonotSecuritizationMicronots:
              frame.argonotSecuritizationMicronots ?? frames.get(frame.frameId)?.argonotSecuritizationMicronots,
            treasuryPool: { ...frames.get(frame.frameId)?.treasuryPool, ...frame.treasuryPool },
          });
        }
        stats.vaultsById[vaultId] = {
          ...current,
          changesByFrame: [...frames.values()].sort((a, b) => b.frameId - a.frameId),
        };
      }
      this.stats = stats;
      this.currentState.statsRevision += 1;
      await this.saveStats();
      if (stats.revenueBackfill) {
        console.info(`[VaultHistory] Saved revenue backfill through frame ${lastSnapshotFrameId}`);
        this.queueRevenueUpdate(refreshClients);
      }
      return stats;
    })();
    this.refreshingPromise = refresh;

    try {
      return await refresh;
    } catch (error) {
      console.error('Error refreshing vault revenue stats:', error);
      throw error;
    } finally {
      if (this.refreshingPromise === refresh) this.refreshingPromise = undefined;
    }
  }

  private queueRevenueUpdate(clients = this.mainchainClients): void {
    setTimeout(async () => {
      try {
        await this.updateRevenue(clients);
      } catch (error) {
        console.warn('[VaultHistory] Unable to continue revenue backfill', error);
      }
    }, 0);
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
    return Object.values(this.vaultsById).reduce((total, vault) => total + vault.totalSatoshis, 0n);
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

  public calculateArgonBondsApr(vaultId?: number): number | undefined {
    const sharedPoolFrames = this.stats?.argonBondsByFrame;
    if (sharedPoolFrames?.length) {
      const oldestFrameId = this.syncedToFrame - NetworkConfig.framesPerCohort + 1;
      const frames = sharedPoolFrames.filter(
        frame => frame.frameId >= oldestFrameId && frame.frameId <= this.syncedToFrame,
      );
      if (!frames.length) return;
      let participatingCapital = 0n;
      let distributions = 0n;
      for (const frame of frames) {
        if (frame.participatingBonds === undefined) return;
        participatingCapital += frame.participatingBonds * BondLot.bondsToMicrogons(1);
        distributions += frame.poolDistributed;
      }
      return calculateAnnualPercentageRate({
        startingValue: participatingCapital,
        endingValue: participatingCapital + distributions,
        periodDays: this.returnFrameDays,
      });
    }

    const frames = this.selectReturnFrames(this.stats, vaultId);
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

  public calculateTreasuryYearlyRevenue({
    vaultId,
    capital,
    operatorKeepPct,
  }: {
    vaultId: number;
    capital: bigint;
    operatorKeepPct: number;
  }): bigint {
    const stats = this.stats;
    const vaultStats = stats?.vaultsById[vaultId];
    if (!stats || !vaultStats || capital <= 0n || operatorKeepPct <= 0) return 0n;

    const oldestFrameId = stats.synchedToFrame - 364;
    const realized = vaultStats.changesByFrame.reduce(
      (total, frame) => {
        if (frame.frameId < oldestFrameId || frame.frameId > stats.synchedToFrame) return total;

        const frameCapital = frame.treasuryPool.externalCapital + frame.treasuryPool.vaultCapital;
        if (frameCapital <= 0n) return total;

        total.capital += frameCapital;
        total.earnings += frame.treasuryPool.totalEarnings;
        return total;
      },
      { capital: 0n, earnings: 0n },
    );
    if (realized.capital <= 0n || realized.earnings <= 0n) return 0n;

    return bigNumberToBigInt(
      BigNumber(capital)
        .multipliedBy(realized.earnings)
        .dividedBy(realized.capital)
        .multipliedBy(operatorKeepPct)
        .dividedBy(100)
        .multipliedBy(365),
    );
  }

  public calculateArgonotStakingApr(): number {
    if (!this.stats) return 0;

    const oldestFrameId = this.stats.synchedToFrame - NetworkConfig.framesPerCohort + 1;
    const positions = this.stats.argonotStakingByFrame
      .filter(frame => frame.frameId >= oldestFrameId && frame.frameId <= this.stats!.synchedToFrame)
      .map(frame => {
        const startingCapital = BigInt(frame.participatingBonds) * frame.microgonsPerArgonot;
        return {
          startingCapital,
          endingCapital: startingCapital + frame.poolDistributed,
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

      let bondEarnings = 0n;
      if (frame.treasuryPool.vaultCapital > 0n) {
        if (frame.treasuryPool.flexibleBondEarnings === undefined) {
          throw new Error(`Vault frame ${frame.frameId} is missing flexible bond income attribution`);
        }
        bondEarnings = frame.treasuryPool.flexibleBondEarnings;
      }
      const profits =
        frame.treasuryPool.vaultEarnings - bondEarnings + frame.bitcoinFeeRevenue - frame.bitcoinFeeCouponValueUsed;
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
    if (statsFromFile?.formatVersion === 1) {
      return {
        ...statsFromFile,
        formatVersion: VAULT_STATS_FORMAT_VERSION,
        argonotStakingByFrame: [],
      };
    }

    const bundledHistory = {
      testnet: testnetVaultRevenueHistory,
      mainnet: mainnetVaultRevenueHistory,
    }[this.network];
    let stats: IAllVaultStats;
    if (bundledHistory) {
      // JSON imports leave bigint values as strings; JsonExt restores "123n" to 123n throughout the history.
      const historyJson = JSON.stringify(bundledHistory);
      stats = JsonExt.parse<IAllVaultStats>(historyJson);
    } else {
      stats = {
        formatVersion: VAULT_STATS_FORMAT_VERSION,
        synchedToFrame: 0,
        argonotStakingByFrame: [],
        vaultsById: {},
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

  /** Apps enriches the detached batch before the existing history publication. */
  protected async loadFrameHistory(
    _stats: IAllVaultStats,
    _frame: { frameId: number; firstBlockMeta: ICallbackFirstBlockMeta; api: ArgonApi; parentApi?: ArgonApi },
  ): Promise<void> {
    return undefined;
  }

  protected async saveStats(): Promise<void> {
    return undefined;
  }

  protected async loadStatsFromFile(): Promise<IAllVaultStats | void> {
    return undefined;
  }
}

export async function getVaultByOperator(args: {
  client: ArgonCurrentQueryClient;
  operatorAddress: string;
  tickDurationMillis?: number;
}): Promise<Vault | undefined> {
  const vaultId = await args.client.query.vaults.vaultIdByOperator(args.operatorAddress);
  if (vaultId === null) return;

  return await Vault.get(args.client, vaultId, args.tickDurationMillis);
}
