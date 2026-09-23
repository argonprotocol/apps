import { DatabaseSync } from 'node:sqlite';
import { SyncStateKeys, type IFinancialHistoryDomain, type ISyncSchemas } from 'src-vue/lib/db/SyncStateTable.ts';

const REQUIRED_HISTORY_DOMAINS = ['bitcoin', 'bonds', 'vaulting'] as const satisfies readonly IFinancialHistoryDomain[];

export interface StartingDatabaseRecoveryProgress {
  walletHistoryThroughBlock: number;
  financialDomains: IFinancialHistoryDomain[];
  partialFinancialDomains: IFinancialHistoryDomain[];
  pendingBitcoinLocks?: number;
}

export interface StartingDatabaseInspection extends StartingDatabaseRecoveryProgress {
  migration?: number;
  quickCheck: string;
  bondLotIds: number[];
  stakeLotIds: number[];
  configuredServer: boolean;
  operations: boolean;
  treasury: boolean;
  upstream: boolean;
}

export function inspectStartingDatabaseRecovery(path: string, throughBlock: number): StartingDatabaseRecoveryProgress {
  const database = new DatabaseSync(path, { open: true, readOnly: true });
  try {
    return readRecoveryProgress(database, throughBlock);
  } finally {
    database.close();
  }
}

export function inspectStartingDatabase(
  path: string,
  throughBlock: number,
  accountId: string,
): StartingDatabaseInspection {
  const database = new DatabaseSync(path, { open: true, readOnly: true });
  try {
    const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
    const recovery = readRecoveryProgress(database, throughBlock);
    let migration: number | undefined;
    try {
      migration = (
        database.prepare('SELECT MAX(version) AS version FROM _sqlx_migrations').get() as {
          version?: number;
        }
      ).version;
    } catch {
      // A database created before its first migration is still useful candidate-app input.
    }

    let bondLots: Array<{ programType: 'Vault' | 'Argonot'; bondLotId: number }> = [];
    try {
      bondLots = database
        .prepare(
          'SELECT programType, bondLotId FROM BondLotHistory WHERE accountId = ? AND releaseBlockHash IS NOT NULL ORDER BY bondLotId',
        )
        .all(accountId) as unknown as typeof bondLots;
    } catch {
      // The previous release may not have created bond history yet; current chain expectations still apply.
    }
    const config = new Map<string, string>();
    try {
      const rows = database
        .prepare(
          `SELECT key, value FROM Config
           WHERE key IN ('hasExtensionOperations', 'hasExtensionTreasury', 'serverAdd', 'upstreamOperator')`,
        )
        .all() as unknown as Array<{ key: string; value: string }>;
      for (const row of rows) config.set(row.key, row.value);
    } catch {
      // A missing Config table means the expected optional features remain disabled.
    }

    return {
      migration,
      quickCheck: quickCheck.quick_check,
      ...recovery,
      bondLotIds: bondLots.filter(lot => lot.programType === 'Vault').map(lot => lot.bondLotId),
      stakeLotIds: bondLots.filter(lot => lot.programType === 'Argonot').map(lot => lot.bondLotId),
      configuredServer: hasConfigValue(config, 'serverAdd'),
      operations: hasConfigValue(config, 'hasExtensionOperations'),
      treasury: hasConfigValue(config, 'hasExtensionTreasury'),
      upstream: hasConfigValue(config, 'upstreamOperator'),
    };
  } finally {
    database.close();
  }
}

export function isStartingDatabaseHistoryRecovered(
  progress: StartingDatabaseRecoveryProgress,
  throughBlock: number,
): boolean {
  return (
    progress.walletHistoryThroughBlock >= throughBlock &&
    REQUIRED_HISTORY_DOMAINS.every(domain => progress.financialDomains.includes(domain)) &&
    progress.partialFinancialDomains.length === 0 &&
    progress.pendingBitcoinLocks === 0
  );
}

export function isStartingDatabaseComplete(
  inspection: Pick<StartingDatabaseInspection, 'quickCheck'> & StartingDatabaseRecoveryProgress,
  throughBlock: number,
): boolean {
  return inspection.quickCheck === 'ok' && isStartingDatabaseHistoryRecovered(inspection, throughBlock);
}

function readRecoveryProgress(database: DatabaseSync, throughBlock: number): StartingDatabaseRecoveryProgress {
  let states: Array<{
    key: SyncStateKeys.WalletHistory | SyncStateKeys.FinancialHistory;
    state: string;
  }> = [];
  try {
    states = database
      .prepare('SELECT key, state FROM SyncState WHERE key IN (?, ?)')
      .all(SyncStateKeys.WalletHistory, SyncStateKeys.FinancialHistory) as unknown as typeof states;
  } catch {
    // Missing recovery tables make the package incomplete.
  }

  let walletHistory: Partial<ISyncSchemas[SyncStateKeys.WalletHistory]> = {};
  let financialHistory: Partial<ISyncSchemas[SyncStateKeys.FinancialHistory]> = {};
  try {
    walletHistory = JSON.parse(
      states.find(state => state.key === SyncStateKeys.WalletHistory)?.state ?? '{}',
    ) as typeof walletHistory;
    financialHistory = JSON.parse(
      states.find(state => state.key === SyncStateKeys.FinancialHistory)?.state ?? '{}',
    ) as typeof financialHistory;
  } catch {
    // Invalid recovery state makes the package incomplete.
  }

  const checkpoints = financialHistory.domainCheckpoints ?? {};
  let pendingBitcoinLocks: number | undefined;
  try {
    pendingBitcoinLocks = (
      database.prepare('SELECT COUNT(*) AS count FROM BitcoinLocks WHERE isHistoryRecoveryPending = 1').get() as {
        count: number;
      }
    ).count;
  } catch {
    // Missing Bitcoin recovery state cannot be claimed complete.
  }

  return {
    walletHistoryThroughBlock: walletHistory.asOfBlock ?? 0,
    financialDomains: REQUIRED_HISTORY_DOMAINS.filter(domain => (checkpoints[domain]?.asOfBlock ?? 0) >= throughBlock),
    partialFinancialDomains: REQUIRED_HISTORY_DOMAINS.filter(domain => checkpoints[domain]?.partialRecovery),
    pendingBitcoinLocks,
  };
}

function hasConfigValue(config: ReadonlyMap<string, string>, key: string): boolean {
  const value = config.get(key);
  if (!value) return false;
  try {
    return Boolean(JSON.parse(value));
  } catch {
    return false;
  }
}
