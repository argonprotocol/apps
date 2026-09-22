import {
  BondLot,
  calculateVaultPositionValue,
  Currency,
  type ICapitalFlow,
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

type VaultFinancialPositionArgs = {
  account: IArgonAccountBalance;
  liveArgonotRateMicrogons: bigint;
};

type VaultPosition = IVaultFinancialPosition | IVaultBalanceFinancialPosition;
type VaultBondState = Pick<ArgonBonds['data'], 'bondLots' | 'bondHistory' | 'isLoaded'>;

export class VaultFinancials implements IFinancialPositionSource<VaultFinancialPositionArgs, VaultPosition> {
  constructor(
    private readonly vault: MyVault,
    private readonly bonds: VaultBondState,
  ) {}

  public async loadPositions(args: VaultFinancialPositionArgs): Promise<VaultPosition[]> {
    const history = await this.vault.history.loadPositionHistory();
    const liveVault = this.vault.createdVault ?? undefined;

    return this.createFinancialPositions({
      ...args,
      liveVault,
      capitalHistory: history.capital,
      revenueHistory: history.revenue,
    });
  }

  public createFinancialPositions(
    args: Omit<VaultFinancialPositionArgs, 'account' | 'liveArgonotRateMicrogons'> & {
      account?: IArgonAccountBalance;
      liveVault?: Vault;
      liveArgonotRateMicrogons?: bigint;
      capitalHistory?: readonly IVaultCapitalHistoryRecord[];
      revenueHistory?: readonly IVaultRevenueEventsRecord[];
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
      collectedRevenue: revenueHistory,
    });
    const vaultBondHistory = this.bonds.bondHistory.filter(record => record.vaultId === vaultId);
    const flexibilityHistory = vaultBondHistory
      .flatMap(history => history.flexibilityHistory.map(transition => ({ history, transition })))
      .sort(
        (left, right) =>
          left.transition.blockNumber - right.transition.blockNumber ||
          (left.transition.extrinsicIndex ?? -1) - (right.transition.extrinsicIndex ?? -1) ||
          (left.transition.eventIndex ?? -1) - (right.transition.eventIndex ?? -1),
      );
    const activeFlexiblePrincipal = BondLot.getTotals(
      this.bonds.bondLots.filter(lot => lot.programType === 'Vault' && lot.vaultId === vaultId && lot.isFlexible),
    ).totalBondMicrogons;
    let observedFlexiblePrincipal = 0n;
    let flexibleInvestedCost = 0n;
    let flexibleSettledPrincipal = 0n;
    let hasCompleteFlexibilityHistory =
      this.bonds.isLoaded &&
      vaultBondHistory.every(record => record.flexibilityHistoryComplete) &&
      this.bonds.bondLots
        .filter(lot => lot.programType === 'Vault' && lot.vaultId === vaultId)
        .every(lot =>
          vaultBondHistory.some(record => record.bondLotId === lot.id && record.flexibilityHistoryComplete),
        );
    const flexibleStateByLot = new Map<number, boolean>();
    const flexibleCapitalFlows: ICapitalFlow[] = [];
    for (const { history, transition } of flexibilityHistory) {
      const wasFlexible = flexibleStateByLot.get(history.bondLotId) ?? false;
      if (wasFlexible === transition.isFlexible) {
        hasCompleteFlexibilityHistory = false;
        continue;
      }
      flexibleStateByLot.set(history.bondLotId, transition.isFlexible);
      const amount = transition.isFlexible ? history.nativePrincipal : -history.nativePrincipal;
      observedFlexiblePrincipal += amount;
      if (amount > 0n) flexibleInvestedCost += amount;
      else flexibleSettledPrincipal -= amount;
      flexibleCapitalFlows.push({ amount, occurredAt: transition.blockTime });
    }
    if (observedFlexiblePrincipal !== activeFlexiblePrincipal) hasCompleteFlexibilityHistory = false;
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
    const capitalFlows: ICapitalFlow[] = [...flexibleCapitalFlows];
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
    const hasCompleteCapitalHistory = value.hasCompleteCapitalHistory && hasCompleteFlexibilityHistory;
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
          performanceEndingCapital:
            flexibleInvestedCost > 0n &&
            hasCompleteCapitalHistory &&
            value.currentValue !== undefined &&
            value.settledPrincipalValue !== undefined
              ? value.currentValue +
                activeFlexiblePrincipal +
                value.settledPrincipalValue +
                flexibleSettledPrincipal +
                value.paidIncome
              : undefined,
        },
        {
          ...value,
          investedCost:
            hasCompleteCapitalHistory && value.investedCost !== undefined
              ? value.investedCost + flexibleInvestedCost
              : undefined,
          settledPrincipalValue:
            hasCompleteCapitalHistory && value.settledPrincipalValue !== undefined
              ? value.settledPrincipalValue + flexibleSettledPrincipal
              : undefined,
        },
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
