import { type Vault } from '@argonprotocol/mainchain';
import { calculateVaultPositionValue, Currency } from '@argonprotocol/apps-core';
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
        .filter(hold => hold.id.isVaults && hold.id.asVaults.isEnterVault)
        .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
      uncollectedRevenue = args.account.microgonHolds
        .filter(hold => hold.id.isVaults && hold.id.asVaults.isPendingCollect)
        .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
      committedMicronots = args.account.micronotHolds
        .filter(hold => hold.id.isVaults && (hold.id.asVaults.isEnterVault || hold.id.asVaults.isPendingCollect))
        .reduce((sum, hold) => sum + hold.amount.toBigInt(), 0n);
    }

    const capitalHistory = args.capitalHistory ?? [];
    const vaultId = args.liveVault?.vaultId ?? capitalHistory[0]?.vaultId;
    if (vaultId === undefined) return [];

    const vaultCapitalHistory = capitalHistory.filter(record => record.vaultId === vaultId);
    const hasClosed = vaultCapitalHistory.some(record => record.eventType === 'closed');
    if (!args.liveVault && !hasClosed) return [];

    const revenueHistory = args.revenueHistory ?? [];
    const value = calculateVaultPositionValue({
      securitization,
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
    const positions: VaultPosition[] = [
      createFinancialPosition(
        'vault',
        {
          id: `vault:${vaultId}`,
          label: args.liveVault?.name ?? `Vault ${vaultId}`,
          lifecycle,
          startedAt: created?.blockTime ?? args.liveVault?.openedDate,
          endedAt: lifecycle === 'completed' ? finalCapitalEvent?.blockTime : undefined,
          vaultId,
          vault: args.liveVault,
          securitization: securitization ?? value.remainingPrincipal,
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
