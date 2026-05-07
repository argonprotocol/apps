import { describe, expect, it } from 'vitest';
import { buildWalletActivity } from '../lib/WalletActivity.ts';
import { TransactionStatus, ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import type { ITransactionRecord } from '../lib/db/TransactionsTable.ts';
import type { IWalletLedgerRecord } from '../lib/db/WalletLedgerTable.ts';
import type { IWalletTransferRecord } from '../lib/db/WalletTransfersTable.ts';

const walletAddress = '5GrwvaEF5zXb26Fz9rcQpDWSxY4CcdkNAW4rNBWb7xGg';

function createLedger(overrides: Partial<IWalletLedgerRecord> = {}): IWalletLedgerRecord {
  return {
    id: 1,
    walletAddress,
    walletName: 'investment',
    availableMicrogons: 100n,
    availableMicronots: 0n,
    reservedMicrogons: 0n,
    reservedMicronots: 0n,
    microgonChange: 25n,
    micronotChange: 0n,
    microgonsForUsd: 1n,
    microgonsForArgonot: 1n,
    inboundTransfersJson: [],
    extrinsicEventsJson: [[3, { pallet: 'balances', method: 'Transfer', data: {} }]],
    blockNumber: 10,
    blockHash: '0xblock',
    isFinalized: true,
    createdAt: new Date('2026-03-20T20:00:00Z'),
    updatedAt: new Date('2026-03-20T20:00:00Z'),
    ...overrides,
  };
}

function createTransfer(overrides: Partial<IWalletTransferRecord> = {}): IWalletTransferRecord {
  return {
    id: 1,
    walletAddress,
    walletName: 'investment',
    amount: 25n,
    currency: 'argon',
    otherParty: '5Other',
    transferType: 'transfer',
    isInternal: false,
    extrinsicIndex: 3,
    microgonsForArgonot: 1n,
    microgonsForUsd: 1n,
    blockNumber: 10,
    blockHash: '0xblock',
    createdAt: new Date('2026-03-20T20:00:00Z'),
    updatedAt: new Date('2026-03-20T20:00:00Z'),
    ...overrides,
  };
}

function createTransaction(overrides: Partial<ITransactionRecord> = {}): ITransactionRecord {
  return {
    id: 1,
    status: TransactionStatus.Submitted,
    extrinsicHash: '0xtx',
    extrinsicMethodJson: {},
    extrinsicType: ExtrinsicType.Transfer,
    metadataJson: {},
    accountAddress: walletAddress,
    submittedAtTime: new Date('2026-03-20T20:00:00Z'),
    submittedAtBlockHeight: 8,
    submissionErrorJson: undefined,
    txTip: undefined,
    txFeePlusTip: undefined,
    blockHeight: undefined,
    blockHash: undefined,
    blockTime: undefined,
    blockExtrinsicIndex: undefined,
    blockExtrinsicEventsJson: [],
    blockExtrinsicErrorJson: undefined,
    finalizedHeadHeight: undefined,
    finalizedHeadTime: undefined,
    isFinalized: false,
    createdAt: new Date('2026-03-20T20:00:00Z'),
    updatedAt: new Date('2026-03-20T20:00:00Z'),
    ...overrides,
  };
}

describe('WalletActivity', () => {
  it('uses matching transfers as primary activity rows', () => {
    const [activity] = buildWalletActivity({
      ledgerRecords: [createLedger()],
      transfers: [createTransfer()],
      transactions: [
        createTransaction({
          status: TransactionStatus.Finalized,
          blockHeight: 10,
          blockHash: '0xblock',
          blockExtrinsicIndex: 3,
          isFinalized: true,
        }),
      ],
    });

    expect(activity.source).toBe('walletTransfer');
    expect(activity.activityType).toBe('transfer');
    expect(activity.amount).toBe(25n);
    expect(activity.ledger?.id).toBe(1);
    expect(activity.transaction?.id).toBe(1);
  });

  it('breaks ledger event groups into ledger activity when no transfer matches', () => {
    const activities = buildWalletActivity({
      ledgerRecords: [
        createLedger({
          extrinsicEventsJson: [
            [2, { pallet: 'transactionPayment', method: 'TransactionFeePaid', data: {} }],
            [3, { pallet: 'balances', method: 'Deposit', data: {} }],
          ],
        }),
      ],
      transfers: [],
    });

    expect(activities).toHaveLength(2);
    expect(activities.map(x => x.activityType)).toEqual(['balanceChange', 'fee']);
    expect(activities.every(x => x.microgonChange === undefined)).toBe(true);
  });

  it('keeps pending submitted transactions without ledger rows', () => {
    const [activity] = buildWalletActivity({
      ledgerRecords: [],
      transfers: [],
      transactions: [createTransaction()],
    });

    expect(activity.source).toBe('submittedTransaction');
    expect(activity.blockNumber).toBe(8);
    expect(activity.isFinalized).toBe(false);
  });
});
