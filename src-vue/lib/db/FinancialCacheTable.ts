import type { IWallet } from '../Wallet.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, logStartupTiming, toSqlParams } from '../Utils.ts';

export enum FinancialCacheTypes {
  ExternalWalletBalance = 'ExternalWalletBalance',
}

export type ExternalWalletChain = 'ethereum' | 'base';

export type IExternalWalletBalanceCacheRecord = Pick<
  IWallet,
  'availableMicrogons' | 'availableMicronots' | 'otherTokens'
> & {
  chain: ExternalWalletChain;
  address: string;
  observedAt: Date;
};

export interface IFinancialCacheSchemas {
  [FinancialCacheTypes.ExternalWalletBalance]: IExternalWalletBalanceCacheRecord;
}

export class FinancialCacheTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = { json: ['state'] };

  public async get<TYPE extends FinancialCacheTypes>(
    type: TYPE,
    scope: string,
  ): Promise<IFinancialCacheSchemas[TYPE] | undefined> {
    const rows = await this.db.select<{ state: IFinancialCacheSchemas[TYPE] }[]>(
      `SELECT state FROM FinancialCache WHERE type = ? AND scope = ? LIMIT 1`,
      toSqlParams([type, scope]),
    );
    return convertFromSqliteFields<{ state: IFinancialCacheSchemas[TYPE] }[]>(rows, this.fieldTypes)[0]?.state;
  }

  public async upsert<TYPE extends FinancialCacheTypes>(
    type: TYPE,
    scope: string,
    state: IFinancialCacheSchemas[TYPE],
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO FinancialCache (type, scope, state)
       VALUES (?, ?, ?)
       ON CONFLICT(type, scope) DO UPDATE SET
         state = excluded.state,
         updatedAt = CURRENT_TIMESTAMP`,
      toSqlParams([type, scope, state]),
    );
  }
}

export async function restoreCachedExternalWalletBalances(
  financialCache: Promise<FinancialCacheTable> | undefined,
  chain: ExternalWalletChain,
  wallet: IWallet,
): Promise<void> {
  if (!financialCache || wallet.balanceUpdatedAt) return;

  try {
    const cache = await financialCache;
    const cached = await cache.get(FinancialCacheTypes.ExternalWalletBalance, getExternalWalletScope(chain, wallet));
    if (!cached) return;

    wallet.availableMicrogons = cached.availableMicrogons;
    wallet.availableMicronots = cached.availableMicronots;
    wallet.totalMicrogons = cached.availableMicrogons;
    wallet.totalMicronots = cached.availableMicronots;
    wallet.otherTokens = cached.otherTokens;
    wallet.balanceUpdatedAt = cached.observedAt;
    wallet.balanceIsCached = true;
    logStartupTiming({
      milestone: 'external-wallet-cache-restored',
      details: { chain, observedAt: cached.observedAt.toISOString() },
    });
  } catch (error) {
    console.warn(`Unable to restore cached ${chain} wallet balances`, error);
  }
}

export async function cacheExternalWalletBalances(
  financialCache: Promise<FinancialCacheTable> | undefined,
  chain: ExternalWalletChain,
  wallet: IWallet,
): Promise<void> {
  const observedAt = wallet.balanceUpdatedAt;
  if (!financialCache || !observedAt) return;

  try {
    const cache = await financialCache;
    const record: IExternalWalletBalanceCacheRecord = {
      chain,
      address: wallet.address.toLowerCase(),
      availableMicrogons: wallet.availableMicrogons,
      availableMicronots: wallet.availableMicronots,
      otherTokens: wallet.otherTokens,
      observedAt,
    };
    await cache.upsert(FinancialCacheTypes.ExternalWalletBalance, getExternalWalletScope(chain, wallet), record);
  } catch (error) {
    console.warn(`Unable to cache ${chain} wallet balances`, error);
  }
}

function getExternalWalletScope(chain: ExternalWalletChain, wallet: Pick<IWallet, 'address'>): string {
  return `${chain}:${wallet.address.toLowerCase()}`;
}
