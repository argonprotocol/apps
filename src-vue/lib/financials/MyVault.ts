import { type Vault } from '@argonprotocol/mainchain';
import { calculateVaultPositionValue } from '@argonprotocol/apps-core';
import {
  createFinancialPosition,
  type IFinancialPositionSource,
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
};

export class VaultFinancials implements IFinancialPositionSource<VaultFinancialPositionArgs, IVaultFinancialPosition> {
  constructor(private readonly vault: MyVault) {}

  public async loadPositions(args: VaultFinancialPositionArgs): Promise<IVaultFinancialPosition[]> {
    await this.vault.load();

    const history = await this.vault.history.loadPositionHistory();
    const liveVault = this.vault.createdVault ?? undefined;

    return this.createFinancialPositions({
      ...args,
      liveVault,
      uncollectedRevenue: liveVault ? this.vault.data.pendingCollectRevenue : 0n,
      capitalHistory: history.capital,
      revenueHistory: history.revenue,
    });
  }

  public createFinancialPositions(
    args: Omit<VaultFinancialPositionArgs, 'account'> & {
      account?: IArgonAccountBalance;
      liveVault?: Vault;
      uncollectedRevenue?: bigint;
      capitalHistory?: readonly IVaultCapitalHistoryRecord[];
      revenueHistory?: readonly IVaultRevenueEventsRecord[];
    },
  ): IVaultFinancialPosition[] {
    if (args.liveVault) {
      if (!args.account) throw new Error('Vault operator account is missing from the Argon wallet snapshot');
      validateVaultHolds(args.account, args.liveVault, args.uncollectedRevenue ?? 0n);
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
    return [
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
          securitization: args.liveVault?.securitization ?? value.remainingPrincipal,
          uncollectedRevenue,
          capitalHistory: vaultCapitalHistory,
          revenueHistory,
        },
        withInvestmentBasis(value, args.hasConfirmedHistoryCoverage),
      ),
    ];
  }
}

function validateVaultHolds(account: IArgonAccountBalance, vault: Vault, uncollectedRevenue: bigint): void {
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
  if (pendingCollectHolds !== uncollectedRevenue || micronotVaultHolds !== 0n) {
    throw new Error('Vault revenue holds do not match pending collect revenue');
  }
}
