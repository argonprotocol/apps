import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JsonExt } from '@argonprotocol/apps-core';
import type { IFinancialAggregate, IFinancialGroupSummary } from 'src-vue/interfaces/IFinancialPosition.ts';

export interface AccountRecoverySnapshotResult {
  financialHash: string;
  financialState: unknown;
  databaseHash: string;
  tables: Record<string, { rowCount: number; hash: string; state: unknown[] }>;
}

export class AccountRecoverySnapshot {
  private static readonly volatileConfigKeys = new Set(['postWelcomeLaunchCount']);
  private static readonly volatileFields = new Set([
    'observedAt',
    'updatedAt',
    'lastConfirmationCheckAt',
    'releaseLastConfirmationCheckAt',
    'bitcoinLastConfirmationCheckAt',
    'argonBlocksLastUpdatedAt',
    'bitcoinBlocksLastUpdatedAt',
    'botActivityLastUpdatedAt',
  ]);

  public static capture(args: {
    databasePath: string;
    financials: IFinancialAggregate;
  }): AccountRecoverySnapshotResult {
    const { databasePath, financials } = args;
    const database = new DatabaseSync(databasePath, { open: true, readOnly: true });
    try {
      const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string };
      if (quickCheck.quick_check !== 'ok') {
        throw new Error(`Account database quick check failed: ${quickCheck.quick_check}`);
      }

      const tableNames = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map(row => String((row as { name: string }).name));
      const tables: AccountRecoverySnapshotResult['tables'] = {};
      for (const tableName of tableNames) {
        const statement = database.prepare(`SELECT * FROM ${AccountRecoverySnapshot.quoteIdentifier(tableName)}`);
        statement.setReadBigInts(true);
        const rows = statement
          .all()
          .filter(row => {
            if (tableName !== 'Config') return true;
            return !AccountRecoverySnapshot.volatileConfigKeys.has(String((row as { key?: unknown }).key));
          })
          .map(row => {
            if (tableName !== 'BitcoinUtxos') return row;

            const record = row as Record<string, unknown>;
            if (typeof record.mempoolObservation !== 'string') return row;
            const observation = JsonExt.parse(record.mempoolObservation);
            const { confirmations: _confirmations, ...stableObservation } = observation;
            return { ...record, mempoolObservation: stableObservation };
          })
          .map(row => AccountRecoverySnapshot.canonicalJson(row))
          .sort((left, right) => left.localeCompare(right));
        tables[tableName] = {
          rowCount: rows.length,
          hash: AccountRecoverySnapshot.hash(rows),
          state: rows.map(row => JsonExt.parse(row)),
        };
      }

      const financialState = AccountRecoverySnapshot.canonicalizeFinancials(financials);
      return {
        financialHash: AccountRecoverySnapshot.hash(AccountRecoverySnapshot.canonicalJson(financialState)),
        financialState,
        databaseHash: AccountRecoverySnapshot.hash(AccountRecoverySnapshot.canonicalJson(tables)),
        tables,
      };
    } finally {
      database.close();
    }
  }

  public static assertEquivalent(
    before: AccountRecoverySnapshotResult,
    after: AccountRecoverySnapshotResult,
    transition: string,
  ): void {
    const beforeTables = new Set(Object.keys(before.tables));
    const afterTables = new Set(Object.keys(after.tables));
    const changedTables = [...new Set([...beforeTables, ...afterTables])].filter(tableName => {
      const left = before.tables[tableName];
      const right = after.tables[tableName];
      return !left || !right || left.rowCount !== right.rowCount || left.hash !== right.hash;
    });
    const financialChanges =
      before.financialHash === after.financialHash
        ? []
        : AccountRecoverySnapshot.findChangedPaths(before.financialState, after.financialState).slice(0, 8);
    const changes = [
      ...(financialChanges.length ? [`financial projection (${financialChanges.join(', ')})`] : []),
      ...changedTables.map(tableName => {
        const left = before.tables[tableName];
        const right = after.tables[tableName];
        if (!left || !right) return `table ${tableName}`;

        const paths = AccountRecoverySnapshot.findChangedPaths(left.state, right.state).slice(0, 8);
        return paths.length ? `table ${tableName} (${paths.join(', ')})` : `table ${tableName}`;
      }),
    ];
    if (changes.length) {
      throw new Error(`Account recovery changed semantic state during ${transition}: ${changes.join(', ')}`);
    }
    if (before.databaseHash !== after.databaseHash) {
      throw new Error(`Account recovery database fingerprint changed during ${transition}`);
    }
  }

  private static quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }

  private static canonicalJson(value: unknown): string {
    return JsonExt.stringify(AccountRecoverySnapshot.canonicalize(value));
  }

  private static findChangedPaths(before: unknown, after: unknown, path = '$'): string[] {
    if (AccountRecoverySnapshot.canonicalJson(before) === AccountRecoverySnapshot.canonicalJson(after)) return [];
    if (Array.isArray(before) && Array.isArray(after)) {
      const paths = before.length === after.length ? [] : [`${path}.length`];
      for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
        paths.push(...AccountRecoverySnapshot.findChangedPaths(before[index], after[index], `${path}[${index}]`));
      }
      return paths;
    }
    if (
      before &&
      after &&
      typeof before === 'object' &&
      typeof after === 'object' &&
      !(before instanceof Date) &&
      !(after instanceof Date) &&
      !(before instanceof Uint8Array) &&
      !(after instanceof Uint8Array)
    ) {
      const left = before as Record<string, unknown>;
      const right = after as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      return keys.flatMap(key => AccountRecoverySnapshot.findChangedPaths(left[key], right[key], `${path}.${key}`));
    }
    return [path];
  }

  private static canonicalizeFinancials(financials: IFinancialAggregate): unknown {
    const withStableVaultLabel = ({ positions, ...group }: IFinancialGroupSummary) => ({
      ...group,
      // Operator profile names can arrive after the vault position; its ID is the stable identity.
      positions: positions.map(position =>
        position.kind === 'vault' ? { ...position, label: `Vault ${position.vaultId}` } : position,
      ),
    });
    return AccountRecoverySnapshot.canonicalize({
      ...financials,
      groups: financials.groups.map(withStableVaultLabel),
      groupSummaries: Object.fromEntries(
        Object.entries(financials.groupSummaries).map(([group, summary]) => [group, withStableVaultLabel(summary)]),
      ),
    });
  }

  private static canonicalize(value: unknown): unknown {
    if (typeof value === 'bigint' || value instanceof Uint8Array || value instanceof Date) return value;
    if (Array.isArray(value)) return value.map(item => AccountRecoverySnapshot.canonicalize(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !AccountRecoverySnapshot.volatileFields.has(key))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, AccountRecoverySnapshot.canonicalize(item)]),
      );
    }
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        return AccountRecoverySnapshot.canonicalize(JsonExt.parse(value));
      } catch {
        return value;
      }
    }
    return value;
  }

  private static hash(value: string | string[]): string {
    return createHash('sha256')
      .update(typeof value === 'string' ? value : value.join('\n'))
      .digest('hex');
  }
}
