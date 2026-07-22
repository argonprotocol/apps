import { type Vault } from '@argonprotocol/mainchain';
import { calculateVaultPositionValue, Currency, type ICapitalFlow } from '@argonprotocol/apps-core';
import {
  createFinancialPosition,
  type IFinancialPositionSource,
  type IVaultBalanceFinancialPosition,
  type IVaultFinancialPosition,
  withInvestmentBasis,
} from '../../interfaces/IFinancialPosition.ts';
import type { IArgonAccountBalance } from '../WalletsForArgon.ts';
import type { IVaultCapitalHistoryRecord } from '../db/VaultCapitalHistoryTable.ts';
import type { IVaultRevenueEventsRecord } from '../db/VaultRevenueEventsTable.ts';
import type { MyVault } from '../MyVault.ts';

type VaultFinancialPositionArgs = {
  hasConfirmedHistoryCoverage: boolean;
  account: IArgonAccountBalance;
  liveArgonotRateMicrogons: bigint;
};

type VaultPosition = IVaultFinancialPosition | IVaultBalanceFinancialPosition;

export class VaultFinancials implements IFinancialPositionSource<VaultFinancialPositionArgs, VaultPosition> {
  constructor(private readonly vault: MyVault) {}

  public async loadPositions(args: VaultFinancialPositionArgs): Promise<VaultPosition[]> {
    await this.vault.load();

    const history = await this.vault.history.loadPositionHistory();
    const liveVault = this.vault.createdVault ?? undefined;

    return this.createFinancialPositions({
      ...args,
      liveVault,
      committedMicronots: liveVault ? this.vault.data.argonotCommitment.committedMicronots : 0n,
      uncollectedRevenue: liveVault ? this.vault.data.pendingCollectRevenue : 0n,
      capitalHistory: history.capital,
      revenueHistory: history.revenue,
    });
  }

  public createFinancialPositions(
    args: Omit<VaultFinancialPositionArgs, 'account' | 'liveArgonotRateMicrogons'> & {
      account?: IArgonAccountBalance;
      liveVault?: Vault;
      liveArgonotRateMicrogons?: bigint;
      committedMicronots?: bigint;
      uncollectedRevenue?: bigint;
      capitalHistory?: readonly IVaultCapitalHistoryRecord[];
      revenueHistory?: readonly IVaultRevenueEventsRecord[];
    },
  ): VaultPosition[] {
    const committedMicronots = args.liveVault ? (args.committedMicronots ?? 0n) : 0n;
    if (args.liveVault) {
      if (!args.account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');
      validateVaultHolds(args.account, args.liveVault, args.uncollectedRevenue ?? 0n, committedMicronots);
    }

    const capitalHistory = args.capitalHistory ?? [];
    const vaultId = args.liveVault?.vaultId ?? capitalHistory[0]?.vaultId;
    if (vaultId === undefined) return [];

    const vaultCapitalHistory = capitalHistory.filter(record => record.vaultId === vaultId);
    const hasClosed = vaultCapitalHistory.some(record => record.eventType === 'closed');
    if (!args.liveVault && !hasClosed) return [];

    const revenueHistory = args.revenueHistory ?? [];
    const uncollectedRevenue = args.liveVault ? (args.uncollectedRevenue ?? 0n) : 0n;
    const value = calculateVaultPositionValue({
      securitization: args.liveVault?.securitization,
      uncollectedRevenue,
      capitalHistory: vaultCapitalHistory,
      collectedRevenue: revenueHistory,
    });
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
    const positions: VaultPosition[] = [
      createFinancialPosition(
        'vault',
        {
          id: `vault:${vaultId}`,
          label: args.liveVault?.name ?? `Vault ${vaultId}`,
          lifecycle,
          startedAt: hasCompleteLifecycleTiming ? (created?.blockTime ?? args.liveVault?.openedDate) : undefined,
          endedAt,
          capitalFlows: hasCompleteCapitalTiming && hasCompleteLifecycleTiming ? capitalFlows : undefined,
          vaultId,
          vault: args.liveVault,
          securitization: args.liveVault?.securitization ?? value.remainingPrincipal,
          uncollectedRevenue,
          capitalHistory: vaultCapitalHistory,
          revenueHistory,
        },
        withInvestmentBasis(value, args.hasConfirmedHistoryCoverage),
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

function validateVaultHolds(
  account: IArgonAccountBalance,
  vault: Vault,
  uncollectedRevenue: bigint,
  committedMicronots: bigint,
): void {
  const enterVaultHolds = account.microgonHolds
    .filter(hold => hold.id.isVaults && hold.id.asVaults.isEnterVault)
    .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
  const pendingCollectHolds = account.microgonHolds
    .filter(hold => hold.id.isVaults && hold.id.asVaults.isPendingCollect)
    .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
  const micronotVaultHolds = account.micronotHolds
    .filter(hold => hold.id.isVaults && (hold.id.asVaults.isEnterVault || hold.id.asVaults.isPendingCollect))
    .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);

  if (enterVaultHolds !== vault.securitization) {
    throw new Error('Vault capital holds do not match current securitization');
  }
  if (pendingCollectHolds !== uncollectedRevenue || micronotVaultHolds !== committedMicronots) {
    throw new Error('Vault revenue holds do not match pending collect revenue');
  }
}
