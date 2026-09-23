import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FinancialGroup,
  type IFinancialAggregate,
  type IFinancialGroupSummary,
  type IWalletHoldingFinancialPosition,
} from 'src-vue/interfaces/IFinancialPosition.ts';
import { AccountRecoverySnapshot } from '../local-mainnet/AccountRecoverySnapshot.ts';

function createGroupSummary(
  group: FinancialGroup,
  positions: IFinancialGroupSummary['positions'] = [],
): IFinancialGroupSummary {
  return {
    group,
    state: 'ready',
    isStale: false,
    positions,
    currentValue: 1200n,
    grossAssets: 1200n,
    grossLiabilities: 0n,
    observation: { blockNumber: 42, observedAt: new Date('2026-09-21T12:00:00Z') },
    returnSummary: {
      availability: 'available',
      investedCost: 1000n,
      paidIncome: 0n,
      settledPrincipalValue: 0n,
      basisPoints: 250n,
      percent: 2.5,
      eligiblePositionCount: positions.length,
      investmentPositionCount: positions.length,
    },
  };
}

function createFinancials(
  args: {
    groupLabel?: string;
    summaryLabel?: string;
    startedAt?: Date;
    grossAssets?: bigint;
  } = {},
): IFinancialAggregate {
  const createPosition = (label: string): IWalletHoldingFinancialPosition => ({
    id: 'wallet-holding:1',
    kind: 'wallet-holding',
    group: 'liquid',
    label,
    lifecycle: 'held',
    accountId: 'account-1',
    nativeAsset: 'ARGNOT',
    nativeAmount: 1200n,
    investedCost: 1000n,
    paidIncome: 0n,
    settledPrincipalValue: 0n,
    startedAt: args.startedAt ?? new Date('2026-09-20T12:00:00Z'),
  });
  const groupSummaries = {
    liquid: createGroupSummary('liquid', [createPosition(args.summaryLabel ?? 'Summary label')]),
    ethereum: createGroupSummary('ethereum'),
    base: createGroupSummary('base'),
    mining: createGroupSummary('mining'),
    vaulting: createGroupSummary('vaulting'),
    bonds: createGroupSummary('bonds'),
    bitcoin: createGroupSummary('bitcoin'),
  } satisfies IFinancialAggregate['groupSummaries'];
  const grossAssets = args.grossAssets ?? 1200n;
  return {
    readiness: 'ready',
    isStale: false,
    grossAssets,
    grossLiabilities: 0n,
    netWorth: grossAssets,
    accountReturn: {
      availability: 'available',
      basisPoints: 250n,
      percent: 2.5,
      eligiblePositionCount: 1,
      investmentPositionCount: 1,
    },
    groups: [createGroupSummary('liquid', [createPosition(args.groupLabel ?? 'Group label')])],
    groupSummaries,
  };
}

describe('account recovery snapshots', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('ignores observation timestamps but detects changed durable financial state', () => {
    const directory = mkdtempSync(Path.join(os.tmpdir(), 'account-recovery-snapshot-'));
    temporaryDirectories.push(directory);
    const databasePath = Path.join(directory, 'database.sqlite');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE PositionHistory (
        id INTEGER PRIMARY KEY,
        amount INTEGER NOT NULL,
        state TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO PositionHistory (id, amount, state, updatedAt)
      VALUES (1, 1200, '{"asOfBlock":42,"updatedAt":"first"}', 'first');
      CREATE TABLE Config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO Config (key, value, updatedAt)
      VALUES ('postWelcomeLaunchCount', '1', 'first');
      CREATE TABLE BitcoinUtxos (
        id INTEGER PRIMARY KEY,
        satoshis TEXT NOT NULL,
        mempoolObservation TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      INSERT INTO BitcoinUtxos (id, satoshis, mempoolObservation, updatedAt)
      VALUES (1, '5000', '{"confirmations":1,"txid":"tx-1"}', 'first');
    `);
    database.close();

    const financials = createFinancials();
    const first = AccountRecoverySnapshot.capture({ databasePath, financials });

    const timestampUpdate = new DatabaseSync(databasePath);
    timestampUpdate.exec(
      `UPDATE PositionHistory SET updatedAt = 'second', state = '{"updatedAt":"second","asOfBlock":42}';
       UPDATE Config SET value = '2', updatedAt = 'second' WHERE key = 'postWelcomeLaunchCount';
       UPDATE BitcoinUtxos
       SET mempoolObservation = '{"confirmations":2,"txid":"tx-1"}', updatedAt = 'second'
       WHERE id = 1;`,
    );
    timestampUpdate.close();
    const second = AccountRecoverySnapshot.capture({
      databasePath,
      financials: createFinancials(),
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(first, second, 'retry')).not.toThrow();

    const changedLabel = AccountRecoverySnapshot.capture({
      databasePath,
      financials: createFinancials({ groupLabel: 'Wrong holding label' }),
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(first, changedLabel, 'retry')).toThrow(
      /financial projection .*label/,
    );

    const financialUpdate = new DatabaseSync(databasePath);
    financialUpdate.exec('UPDATE PositionHistory SET amount = 1300');
    financialUpdate.close();
    const third = AccountRecoverySnapshot.capture({
      databasePath,
      financials: createFinancials({ grossAssets: 1300n }),
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(second, third, 'retry')).toThrow(
      /financial projection .*grossAssets.*netWorth.*table PositionHistory .*amount/,
    );

    const changedDate = AccountRecoverySnapshot.capture({
      databasePath,
      financials: createFinancials({ startedAt: new Date('2026-09-20T12:01:00Z') }),
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(first, changedDate, 'retry')).toThrow(
      /financial projection .*startedAt.*table PositionHistory .*amount/,
    );
  });
});
