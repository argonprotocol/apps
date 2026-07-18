import type { IWallet } from '../Wallet.ts';
import { BaseTable, type IFieldTypes } from './BaseTable.ts';
import { convertFromSqliteFields, logStartupTiming, toSqlParams } from '../Utils.ts';

export type ExternalWalletChain = 'ethereum' | 'base';

export type IExternalWalletBalanceCacheRecord = Pick<
  IWallet,
  'availableMicrogons' | 'availableMicronots' | 'otherTokens'
> & {
  chain: ExternalWalletChain;
  address: string;
  observedAt: Date;
};

export class ExternalWalletBalanceCacheTable extends BaseTable {
  private readonly fieldTypes: IFieldTypes = {
    bigint: ['availableMicrogons', 'availableMicronots'] satisfies (keyof IExternalWalletBalanceCacheRecord)[],
    json: ['otherTokens'] satisfies (keyof IExternalWalletBalanceCacheRecord)[],
    date: ['observedAt'] satisfies (keyof IExternalWalletBalanceCacheRecord)[],
  };

  public async get(
    chain: ExternalWalletChain,
    address: string,
  ): Promise<IExternalWalletBalanceCacheRecord | undefined> {
    const rows = await this.db.select<IExternalWalletBalanceCacheRecord[]>(
      `SELECT chain, address, availableMicrogons, availableMicronots, otherTokensJson AS otherTokens, observedAt
       FROM ExternalWalletBalanceCache
       WHERE chain = ? AND address = ?
       LIMIT 1`,
      toSqlParams([chain, address.toLowerCase()]),
    );
    return convertFromSqliteFields<IExternalWalletBalanceCacheRecord[]>(rows, this.fieldTypes)[0];
  }

  public async upsert(record: IExternalWalletBalanceCacheRecord): Promise<void> {
    await this.db.execute(
      `INSERT INTO ExternalWalletBalanceCache (
         chain, address, availableMicrogons, availableMicronots, otherTokensJson, observedAt
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, address) DO UPDATE SET
         availableMicrogons = excluded.availableMicrogons,
         availableMicronots = excluded.availableMicronots,
         otherTokensJson = excluded.otherTokensJson,
         observedAt = excluded.observedAt`,
      toSqlParams([
        record.chain,
        record.address.toLowerCase(),
        record.availableMicrogons,
        record.availableMicronots,
        record.otherTokens,
        record.observedAt,
      ]),
    );
  }
}

export async function restoreCachedExternalWalletBalances(
  balanceCache: Promise<ExternalWalletBalanceCacheTable> | undefined,
  chain: ExternalWalletChain,
  wallet: IWallet,
): Promise<void> {
  if (!balanceCache || wallet.balanceUpdatedAt) return;

  try {
    const cache = await balanceCache;
    const cached = await cache.get(chain, wallet.address);
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
  balanceCache: Promise<ExternalWalletBalanceCacheTable> | undefined,
  chain: ExternalWalletChain,
  wallet: IWallet,
): Promise<void> {
  const observedAt = wallet.balanceUpdatedAt;
  if (!balanceCache || !observedAt) return;

  try {
    const cache = await balanceCache;
    await cache.upsert({
      chain,
      address: wallet.address,
      availableMicrogons: wallet.availableMicrogons,
      availableMicronots: wallet.availableMicronots,
      otherTokens: wallet.otherTokens,
      observedAt,
    });
  } catch (error) {
    console.warn(`Unable to cache ${chain} wallet balances`, error);
  }
}
