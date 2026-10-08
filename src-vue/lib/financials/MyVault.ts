import {
  calculateVaultPositionValue,
  Currency,
  getPercent,
  type ICapitalFlow,
  type IVaultFrameStats,
  type Vault,
} from '@argonprotocol/apps-core';
import {
  createFinancialPosition,
  type IFinancialPositionSource,
  type IVaultBalanceFinancialPosition,
  type IVaultFinancialPosition,
} from '../../interfaces/IFinancialPosition.ts';
import type { IArgonAccountBalance } from '../WalletsForArgon.ts';
import type { IVaultCapitalHistoryRecord } from '../db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../db/VaultRevenueEventsTable.ts';
import type { MyVault } from '../MyVault.ts';
import type { ArgonBonds } from '../ArgonBonds.ts';
import { getVaultBondEarnings } from '../BondEarnings.ts';

type VaultFinancialPositionArgs = {
  account: IArgonAccountBalance;
  liveArgonotRateMicrogons: bigint;
};

type VaultPosition = IVaultFinancialPosition | IVaultBalanceFinancialPosition;
type VaultBondState = Pick<
  ArgonBonds['data'],
  'bondLots' | 'bondHistory' | 'dailyEarnings' | 'isLoaded' | 'currentFrameId'
>;

export class VaultFinancials implements IFinancialPositionSource<VaultFinancialPositionArgs, VaultPosition> {
  constructor(
    private readonly vault: MyVault,
    private readonly bonds: VaultBondState,
  ) {}

  /** Completed-frame income belongs to the vault only after excluding vault-paid bond income. */
  public static getFrameEarnings(
    vaultId: number,
    frames: readonly IVaultFrameStats[],
    { bondLots, bondHistory, dailyEarnings, isLoaded }: VaultBondState,
  ) {
    const earningsByFrame = new Map<number, { income: bigint; returnPercent: number }>();
    if (!isLoaded) return earningsByFrame;

    const vaultEarnings = new Map<number, bigint | undefined>(
      frames.map(frame => [frame.frameId, frame.treasuryPool.vaultEarnings]),
    );
    const lots = new Map(bondLots.filter(lot => lot.vaultId === vaultId).map(lot => [lot.id, lot]));
    const history = new Map(bondHistory.filter(lot => lot.vaultId === vaultId).map(lot => [lot.bondLotId, lot]));
    for (const id of new Set([...lots.keys(), ...history.keys()])) {
      const lot = lots.get(id);
      const record = history.get(id);
      const earningsByFrame = new Map(
        dailyEarnings.filter(earning => earning.bondLotId === id).map(earning => [earning.frameId, earning]),
      );
      const createdFrame = record?.createdFrame ?? lot!.createdFrameId;
      const releaseFrame = record?.releaseFrame ?? lot?.releaseFrameId;
      const wasFlexible = lot?.isFlexible || record?.flexibilityHistory.some(change => change.isFlexible);

      for (const frame of frames) {
        const remaining = vaultEarnings.get(frame.frameId);
        if (remaining === undefined) continue;
        const earning = earningsByFrame.get(frame.frameId);
        if (earning) {
          if (earning.earningsDestination === 'Owner') continue;
          const amount = earning.earningsMicrogons;
          if (amount == null || amount > remaining) vaultEarnings.set(frame.frameId, undefined);
          else vaultEarnings.set(frame.frameId, remaining - amount);
          continue;
        }
        if (frame.frameId < createdFrame) continue;
        if (releaseFrame != null && frame.frameId >= releaseFrame) continue;
        if ((record?.earningsHistoryThroughFrame ?? -1) >= frame.frameId) continue;
        if (record?.flexibilityHistoryComplete && !wasFlexible) continue;
        vaultEarnings.set(frame.frameId, undefined);
      }
    }

    for (const frame of frames) {
      const earnings = vaultEarnings.get(frame.frameId);
      if (earnings === undefined) continue;
      if (frame.bitcoinFeeCouponValueUsed === undefined) continue;
      if (frame.securitization <= 0n) continue;
      const income = earnings + frame.bitcoinFeeRevenue - frame.bitcoinFeeCouponValueUsed;
      earningsByFrame.set(frame.frameId, { income, returnPercent: getPercent(income, frame.securitization) });
    }
    return earningsByFrame;
  }

  public async loadPositions(args: VaultFinancialPositionArgs): Promise<VaultPosition[]> {
    const publication = this.vault.revenuePublication;
    await publication;
    const history = await this.vault.history.loadPositionHistory();
    if (publication !== this.vault.revenuePublication) {
      throw new Error('Vault revenue changed during the financial snapshot; retry after publication');
    }
    const liveVault = this.vault.createdVault ?? undefined;

    return this.createFinancialPositions({
      ...args,
      liveVault,
      capitalHistory: history.capital,
      revenueHistory: history.revenue,
      revenueCoverage: history.revenueCoverage,
    });
  }

  public createFinancialPositions(
    args: Omit<VaultFinancialPositionArgs, 'account' | 'liveArgonotRateMicrogons'> & {
      account?: IArgonAccountBalance;
      liveVault?: Vault;
      liveArgonotRateMicrogons?: bigint;
      capitalHistory?: readonly IVaultCapitalHistoryRecord[];
      revenueHistory?: readonly IVaultRevenueEventsRecord[];
      revenueCoverage?: { fromBlock: number; throughBlock: number };
    },
  ): VaultPosition[] {
    let securitization = args.liveVault?.securitization;
    let committedMicronots = 0n;
    let uncollectedRevenue = 0n;
    if (args.liveVault) {
      if (!args.account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');

      securitization = args.account.microgonHolds
        .filter(hold => hold.id.type === 'Vaults' && hold.id.value.type === 'EnterVault')
        .reduce((sum, hold) => sum + hold.amount, 0n);
      uncollectedRevenue = args.account.microgonHolds
        .filter(hold => hold.id.type === 'Vaults' && hold.id.value.type === 'PendingCollect')
        .reduce((sum, hold) => sum + hold.amount, 0n);
      committedMicronots = args.account.micronotHolds
        .filter(
          hold =>
            hold.id.type === 'Vaults' &&
            (hold.id.value.type === 'EnterVault' || hold.id.value.type === 'PendingCollect'),
        )
        .reduce((sum, hold) => sum + hold.amount, 0n);
    }

    const capitalHistory = args.capitalHistory ?? [];
    const vaultId = args.liveVault?.vaultId ?? capitalHistory[0]?.vaultId;
    if (vaultId === undefined) return [];

    const vaultCapitalHistory = capitalHistory.filter(record => record.vaultId === vaultId);
    const hasClosed = vaultCapitalHistory.some(record => record.eventType === 'closed');
    if (!args.liveVault && !hasClosed) return [];

    const revenueHistory = args.revenueHistory ?? [];
    const label =
      (args.liveVault ? this.vault.vaults.operatorNamesByVaultId[vaultId] : undefined) ?? `Vault ${vaultId}`;
    const value = calculateVaultPositionValue({
      securitization,
      uncollectedRevenue,
      capitalHistory: vaultCapitalHistory,
      collectedRevenue: revenueHistory.filter(record => record.source === 'vaultCollect'),
    });
    const bondEarnings = getVaultBondEarnings(
      this.bonds,
      vaultId,
      revenueHistory,
      args.revenueCoverage,
      this.vault.pendingRevenueFrames,
    );
    let paidIncome: bigint | undefined;
    if (bondEarnings.collectedEarnings !== undefined) paidIncome = value.paidIncome - bondEarnings.collectedEarnings;
    const hasCompleteAttribution =
      bondEarnings.isComplete && (bondEarnings.pendingEarnings ?? 0n) <= uncollectedRevenue;
    let lifecycle: IVaultFinancialPosition['lifecycle'] = 'completed';
    if (args.liveVault && !args.liveVault.isClosed) {
      lifecycle = 'active';
    } else if (value.remainingPrincipal > 0n) {
      lifecycle = 'releasing';
    }

    const created = vaultCapitalHistory.find(record => record.eventType === 'created');
    const finalCapitalEvent = vaultCapitalHistory.at(-1);
    const endedAt = lifecycle === 'completed' ? finalCapitalEvent?.blockTime : undefined;
    const hasCompleteLifecycleTiming = lifecycle !== 'completed' || endedAt !== undefined;
    const capitalFlows: ICapitalFlow[] = [];
    let hasCompleteCapitalTiming = true;
    for (const [index, amount] of value.capitalDeltas.entries()) {
      if (amount === 0n) continue;

      const occurredAt = vaultCapitalHistory[index]?.blockTime;
      if (occurredAt) {
        capitalFlows.push({ amount, occurredAt });
      } else {
        hasCompleteCapitalTiming = false;
      }
    }
    capitalFlows.sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime());
    const hasCompleteCapitalHistory = value.hasCompleteCapitalHistory;
    const positions: VaultPosition[] = [
      createFinancialPosition(
        'vault',
        {
          id: `vault:${vaultId}`,
          label,
          lifecycle,
          startedAt: hasCompleteLifecycleTiming ? (created?.blockTime ?? args.liveVault?.openedDate) : undefined,
          endedAt,
          capitalFlows:
            hasCompleteCapitalHistory && hasCompleteCapitalTiming && hasCompleteLifecycleTiming
              ? capitalFlows
              : undefined,
          vaultId,
          vault: args.liveVault,
          securitization: securitization ?? value.remainingPrincipal,
          uncollectedRevenue,
          capitalHistory: vaultCapitalHistory,
          revenueHistory,
          returnIsComplete: hasCompleteAttribution,
          performanceEndingCapital:
            value.currentValue !== undefined && value.settledPrincipalValue !== undefined
              ? value.currentValue + value.settledPrincipalValue + value.paidIncome - bondEarnings.totalEarnings
              : undefined,
        },
        { ...value, paidIncome },
      ),
    ];

    if (committedMicronots > 0n) {
      positions.push(
        createFinancialPosition('vault-balance', {
          id: `vault:${vaultId}:committed-argonot`,
          label: 'Staked ARGNOT',
          lifecycle: 'held',
          currentValue:
            (args.liveArgonotRateMicrogons ?? 0n) > 0n
              ? Currency.convertMicronotToMicrogonAtPrice(committedMicronots, args.liveArgonotRateMicrogons ?? 0n)
              : undefined,
          asset: 'ARGNOT',
          amount: committedMicronots,
        }),
      );
    }

    return positions;
  }
}
