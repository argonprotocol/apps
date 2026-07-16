import { describe, expect, it } from 'vitest';
import { buildWalletActivity } from '../lib/WalletActivity.ts';
import { TransactionStatus, ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import type { ITransactionRecord } from '../lib/db/TransactionsTable.ts';
import type { IWalletTransferRecord } from '../lib/db/WalletTransfersTable.ts';

const walletAddress = '5GrwvaEF5zXb26Fz9rcQpDWSxY4CcdkNAW4rNBWb7xGg';

function createTransfer(overrides: Partial<IWalletTransferRecord> = {}): IWalletTransferRecord {
  return {
    id: 1,
    walletAddress,
    walletName: 'defaultArgon',
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
    submissionErrorJson: null,
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
  it('links a persisted transfer to its submitted transaction', () => {
    const [activity] = buildWalletActivity({
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
    expect(activity.transaction?.id).toBe(1);
  });

  it('keeps pending submitted transactions without matching transfers', () => {
    const [activity] = buildWalletActivity({ transfers: [], transactions: [createTransaction()] });

    expect(activity.source).toBe('submittedTransaction');
    expect(activity.blockNumber).toBe(8);
    expect(activity.isFinalized).toBe(false);
  });
});
