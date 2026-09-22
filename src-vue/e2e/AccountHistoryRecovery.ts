import { getConfig, type Config } from '../stores/config.ts';
import { getDbPromise } from '../stores/helpers/dbPromise.ts';
import { getWalletHistoryRecovery, getWalletKeys, useWallets } from '../stores/wallets.ts';
import { useFinancialHistory } from '../stores/financialHistory.ts';
import Importer from '../lib/Importer.ts';
import { SyncStateKeys, type IFinancialHistoryDomain, type ISyncSchemas } from '../lib/db/SyncStateTable.ts';

export interface IAccountHistoryRecoveryReport {
  accountId: string;
  throughBlock: number;
  previousLife: {
    detected: boolean;
    recovered: boolean;
  };
  walletHistory: ISyncSchemas[SyncStateKeys.WalletHistory];
  financialHistory: ISyncSchemas[SyncStateKeys.FinancialHistory];
}

export class AccountHistoryRecovery {
  private readonly config = getConfig() as Config;
  private readonly dbPromise = getDbPromise();
  private readonly walletKeys = getWalletKeys();
  private readonly wallets = useWallets();

  public async recoverThrough(throughBlock: number): Promise<IAccountHistoryRecoveryReport> {
    if (!Number.isSafeInteger(throughBlock) || throughBlock < 1) {
      throw new Error(`History recovery block must be a positive safe integer, got ${throughBlock}`);
    }

    await new Importer(this.config, this.walletKeys, this.dbPromise).recoverCurrentAccountState();
    await this.config.recoverPreviousWalletHistory();
    await this.wallets.isLoadedPromise;

    const walletHistoryRecovery = getWalletHistoryRecovery();
    await walletHistoryRecovery.prepare();
    await walletHistoryRecovery.recoverNow(throughBlock, true);
    await useFinancialHistory().restoreFinancialHistory(true, throughBlock);

    const db = await this.dbPromise;
    const [walletHistory, financialHistory] = await Promise.all([
      db.syncStateTable.get(SyncStateKeys.WalletHistory),
      db.syncStateTable.get(SyncStateKeys.FinancialHistory),
    ]);
    if (!walletHistory || walletHistory.asOfBlock < throughBlock) {
      throw new Error(
        `Wallet history is only complete through block ${walletHistory?.asOfBlock.toLocaleString() ?? 'none'}`,
      );
    }
    if (!financialHistory || financialHistory.accountId !== this.walletKeys.defaultArgonAddress) {
      throw new Error(`Financial history has no checkpoint for ${this.walletKeys.defaultArgonAddress}`);
    }
    for (const domain of ['bitcoin', 'bonds', 'vaulting'] satisfies IFinancialHistoryDomain[]) {
      const checkpoint = financialHistory.domainCheckpoints?.[domain];
      if (!checkpoint || checkpoint.asOfBlock < throughBlock || checkpoint.partialRecovery) {
        throw new Error(
          `${domain} history is only complete through block ${checkpoint?.asOfBlock.toLocaleString() ?? 'none'}`,
        );
      }
    }
    if (this.config.walletAccountsHadPreviousLife && !this.config.walletPreviousLifeRecovered) {
      throw new Error('Previous account history recovery has not completed');
    }

    return {
      accountId: this.walletKeys.defaultArgonAddress,
      throughBlock,
      previousLife: {
        detected: this.config.walletAccountsHadPreviousLife,
        recovered: !this.config.walletAccountsHadPreviousLife || this.config.walletPreviousLifeRecovered,
      },
      walletHistory,
      financialHistory,
    };
  }
}
