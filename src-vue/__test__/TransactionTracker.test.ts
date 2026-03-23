import { describe, expect, it, vi } from 'vitest';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';

type ITransactionTrackerTestApi = {
  findTransactionInBlocks: (
    tx: ITransactionRecord,
    maxBlocksToCheck: number,
    bestBlockHeight: number,
    searchStartBlockHeight?: number,
  ) => Promise<unknown>;
  updatePendingStatuses: (bestBlockInfo: { blockNumber: number }) => Promise<void>;
};

function createTransaction(overrides: Partial<ITransactionRecord> = {}): ITransactionRecord {
  const now = new Date('2026-03-20T20:00:00Z');
  return {
    id: 1,
    status: TransactionStatus.InBlock,
    extrinsicHash: '0x123',
    extrinsicMethodJson: {},
    extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
    metadataJson: {},
    accountAddress: '5Alice',
    submittedAtTime: now,
    submittedAtBlockHeight: 100,
    submissionErrorJson: undefined,
    txTip: undefined,
    txFeePlusTip: undefined,
    blockHeight: 100,
    blockHash: '0xold-block',
    blockTime: now,
    blockExtrinsicIndex: undefined,
    blockExtrinsicEventsJson: [],
    blockExtrinsicErrorJson: undefined,
    lastFinalizedBlockHeight: 120,
    lastFinalizedBlockTime: now,
    isFinalized: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTracker(tx: ITransactionRecord, finalizedBlockNumber: number) {
  const table = {
    markFinalized: vi.fn(async (record: ITransactionRecord) => record),
    recordInBlock: vi.fn(async (record: ITransactionRecord) => record),
    markExpiredWaitingForBlock: vi.fn(async (record: ITransactionRecord) => record),
    updateLastFinalizedBlock: vi.fn(
      async (record: ITransactionRecord, finalizedDetails: { blockNumber: number; blockTime: Date }) => {
        record.lastFinalizedBlockHeight = finalizedDetails.blockNumber;
        record.lastFinalizedBlockTime = finalizedDetails.blockTime;
        return record;
      },
    ),
  };
  const blockWatch = {
    finalizedBlockHeader: {
      blockNumber: finalizedBlockNumber,
      blockTime: new Date('2026-03-20T20:05:00Z').getTime(),
    },
    getFinalizedHash: vi.fn(async () => '0xfinalized-block'),
  };
  const tracker = new TransactionTracker(Promise.resolve({ transactionsTable: table } as any), blockWatch as any);
  const txInfo = {
    tx,
    txResult: {
      setFinalized: vi.fn(),
    },
    finalizedBlockHeight: tx.lastFinalizedBlockHeight,
  };
  tracker.data.txInfos = [txInfo as any];

  return { tracker, txInfo, table, blockWatch };
}

describe('TransactionTracker', () => {
  it('rescans from the finalized boundary when an in-block tx is reorged out', async () => {
    const tx = createTransaction({
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      lastFinalizedBlockHeight: 120,
    });
    const { tracker, table } = createTracker(tx, 121);
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    const findSpy = vi.spyOn(trackerApi, 'findTransactionInBlocks').mockResolvedValueOnce(undefined);

    await trackerApi.updatePendingStatuses({ blockNumber: 125 });

    expect(findSpy).toHaveBeenCalledWith(tx, 5, 125, 120);
    expect(table.markFinalized).not.toHaveBeenCalled();
    expect(table.updateLastFinalizedBlock).toHaveBeenCalledWith(tx, expect.objectContaining({ blockNumber: 121 }));
  });

  it('does not rescan a tx that is already in a non-finalized block', async () => {
    const tx = createTransaction({
      submittedAtBlockHeight: 120,
      blockHeight: 130,
      lastFinalizedBlockHeight: 121,
    });
    const { tracker, table, blockWatch } = createTracker(tx, 125);
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    const findSpy = vi.spyOn(trackerApi, 'findTransactionInBlocks');

    await trackerApi.updatePendingStatuses({ blockNumber: 132 });

    expect(findSpy).not.toHaveBeenCalled();
    expect(blockWatch.getFinalizedHash).not.toHaveBeenCalled();
    expect(table.markFinalized).not.toHaveBeenCalled();
    expect(table.updateLastFinalizedBlock).toHaveBeenCalledWith(tx, expect.objectContaining({ blockNumber: 125 }));
  });
});
