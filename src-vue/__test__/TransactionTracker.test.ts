import { TransactionEvents } from '@argonprotocol/apps-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TxAttemptState, TransactionTracker } from '../lib/TransactionTracker.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { TransactionHistorySource, TransactionHistoryStatus } from '../lib/db/TransactionStatusHistoryTable.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { TransactionInfo } from '../lib/TransactionInfo.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

type ITransactionTrackerTestApi = {
  updatePendingStatuses: (bestBlockInfo: { blockNumber: number }) => Promise<void>;
};

describe('TransactionTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not resume dropped attempts at load, but keeps tracking them on-chain', async () => {
    const tx = createTransaction({
      id: 1,
      status: TransactionStatus.Submitted,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 100,
      latestHistoryByTxId: new Map([
        [
          tx.id,
          {
            id: 1,
            transactionId: tx.id,
            status: TransactionHistoryStatus.Dropped,
            source: TransactionHistorySource.Watch,
            createdAt: new Date('2026-03-21T10:00:00Z'),
          },
        ],
      ]),
    });

    expect(tracker.pendingBlockTxInfosAtLoad).toHaveLength(0);
    expect(tracker.data.txInfos[0].txResult.submissionError).toBeUndefined();
  });

  it('restores in-block extrinsic errors without finalizing non-finalized transactions', async () => {
    const tx = createTransaction({
      id: 12,
      status: TransactionStatus.InBlock,
      isFinalized: false,
      blockExtrinsicErrorJson: {
        errorCode: 'bitcoinLocks.InsufficientVaultFunds',
        details: 'bitcoinLocks.InsufficientVaultFunds',
        message: 'bitcoinLocks.InsufficientVaultFunds',
      },
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 101,
    });

    const txResult = tracker.data.txInfos[0].txResult;
    expect(txResult.extrinsicError?.message).toBe('bitcoinLocks.InsufficientVaultFunds');
    expect(txResult.isFinalized).toBe(false);
  });

  it('treats a recent submitted attempt as followable', async () => {
    const tx = createTransaction({
      id: 2,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 101,
    });

    await expect(tracker.getTxAttemptState(tracker.data.txInfos[0], 2)).resolves.toBe(TxAttemptState.Follow);
  });

  it('treats a stale submitted attempt as replaceable', async () => {
    const tx = createTransaction({
      id: 3,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 103,
    });

    await expect(tracker.getTxAttemptState(tracker.data.txInfos[0], 2)).resolves.toBe(TxAttemptState.Replace);
  });

  it('treats a dropped attempt as replaceable', async () => {
    const tx = createTransaction({
      id: 4,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 100,
      latestHistoryByTxId: new Map([
        [
          tx.id,
          {
            id: 1,
            transactionId: tx.id,
            status: TransactionHistoryStatus.Dropped,
            source: TransactionHistorySource.Watch,
            createdAt: new Date('2026-03-21T10:00:00Z'),
          },
        ],
      ]),
    });

    await expect(tracker.getTxAttemptState(tracker.data.txInfos[0], 2)).resolves.toBe(TxAttemptState.Replace);
  });

  it('treats a retracted attempt as replaceable once a newer nonce finalized', async () => {
    const originalTx = createTransaction({
      id: 5,
      status: TransactionStatus.InBlock,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      txNonce: 7,
      blockHeight: 100,
      blockHash: '0xaaa',
    });
    const newerTx = createTransaction({
      id: 6,
      status: TransactionStatus.Finalized,
      extrinsicType: ExtrinsicType.VaultCollect,
      txNonce: 8,
      accountAddress: originalTx.accountAddress,
    });
    const { tracker } = await createTracker({
      txs: [newerTx, originalTx],
      finalizedHeight: 101,
      latestHistoryByTxId: new Map([
        [
          originalTx.id,
          {
            id: 2,
            transactionId: originalTx.id,
            status: TransactionHistoryStatus.Retracted,
            source: TransactionHistorySource.Watch,
            createdAt: new Date('2026-03-21T10:05:00Z'),
          },
        ],
      ]),
      headerByHeight: { 100: '0xaaa' },
    });

    const originalTxInfo = tracker.data.txInfos.find(x => x.tx.id === originalTx.id)!;
    await expect(tracker.getTxAttemptState(originalTxInfo, 2)).resolves.toBe(TxAttemptState.Replace);
  });

  it('treats a failed finalized attempt as replaceable', async () => {
    const tx = createTransaction({
      id: 7,
      status: TransactionStatus.Finalized,
      extrinsicType: ExtrinsicType.VaultCollect,
      blockExtrinsicErrorJson: { message: 'PendingCosignsBeforeCollect' },
      isFinalized: true,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 101,
    });

    await expect(tracker.getTxAttemptState(tracker.data.txInfos[0], 2)).resolves.toBe(TxAttemptState.Replace);
  });

  it('rescans from the finalized boundary when an in-block tx is reorged out', async () => {
    const tx = createTransaction({
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold-block',
      finalizedHeadHeight: 120,
    });
    const { tracker, table } = await createTracker({
      txs: [tx],
      finalizedHeight: 121,
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    const findSpy = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValueOnce(undefined);

    await trackerApi.updatePendingStatuses({ blockNumber: 125 });

    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        extrinsicHash: tx.extrinsicHash,
        searchStartBlockHeight: 120,
        bestBlockHeight: 125,
        maxBlocksToCheck: 5,
      }),
    );
    expect(table.markFinalized).not.toHaveBeenCalled();
    expect(table.updateFinalizedHead).toHaveBeenCalledWith(tx, expect.objectContaining({ blockNumber: 121 }));
  });

  it('does not rescan a tx that is already in a non-finalized block', async () => {
    const tx = createTransaction({
      submittedAtBlockHeight: 120,
      blockHeight: 130,
      blockHash: '0xbest-block',
      finalizedHeadHeight: 121,
    });
    const { tracker, table, blockWatch } = await createTracker({
      txs: [tx],
      finalizedHeight: 125,
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    const findSpy = vi.spyOn(TransactionEvents, 'findByExtrinsicHash');

    await trackerApi.updatePendingStatuses({ blockNumber: 132 });

    expect(findSpy).not.toHaveBeenCalled();
    expect(blockWatch.getFinalizedHash).not.toHaveBeenCalled();
    expect(table.markFinalized).not.toHaveBeenCalled();
    expect(table.updateFinalizedHead).toHaveBeenCalledWith(tx, expect.objectContaining({ blockNumber: 125 }));
  });

  it('rescans a non-finalized block after a retracted watch event', async () => {
    const tx = createTransaction({
      id: 8,
      submittedAtBlockHeight: 120,
      blockHeight: 130,
      blockHash: '0xretracted-block',
      finalizedHeadHeight: 121,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 125,
      latestHistoryByTxId: new Map([
        [
          tx.id,
          {
            id: 3,
            transactionId: tx.id,
            status: TransactionHistoryStatus.Retracted,
            source: TransactionHistorySource.Watch,
            createdAt: new Date('2026-03-21T10:06:00Z'),
          },
        ],
      ]),
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    const findSpy = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValueOnce(undefined);

    await trackerApi.updatePendingStatuses({ blockNumber: 132 });

    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        extrinsicHash: tx.extrinsicHash,
        searchStartBlockHeight: 121,
        bestBlockHeight: 132,
        maxBlocksToCheck: 11,
      }),
    );
  });

  it('does not advance finalized head when a pending status scan fails', async () => {
    const tx = createTransaction({
      id: 9,
      blockHeight: 100,
      blockHash: '0xpending-block',
      finalizedHeadHeight: 101,
    });
    const { tracker, table, blockWatch } = await createTracker({
      txs: [tx],
      finalizedHeight: 125,
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    blockWatch.getFinalizedHash.mockRejectedValueOnce(new Error('WebSocket is not connected'));

    await trackerApi.updatePendingStatuses({ blockNumber: 132 });

    expect(table.markFinalized).not.toHaveBeenCalled();
    expect(table.updateFinalizedHead).not.toHaveBeenCalled();
    expect(tx.finalizedHeadHeight).toBe(101);
  });

  it('records finalized watch updates using the watched block hash', async () => {
    const tx = createTransaction({
      id: 10,
      blockHeight: 130,
      blockHash: '0xold-block',
      finalizedHeadHeight: 129,
    });
    const { tracker, table } = await createTracker({
      txs: [tx],
      finalizedHeight: 130,
    });
    const recordWatchStatus = (
      tracker as unknown as {
        recordWatchStatus: (tx: ITransactionRecord, watchUpdate: any) => Promise<void>;
      }
    ).recordWatchStatus.bind(tracker) as (tx: ITransactionRecord, watchUpdate: any) => Promise<void>;
    const findSpy = vi.spyOn(TransactionEvents, 'findByExtrinsicHashInBlock').mockResolvedValueOnce({
      blockNumber: 130,
      blockHash: '0xwatched-block',
      blockTime: new Date('2026-03-20T20:10:00Z').getTime(),
      extrinsicIndex: 2,
      fee: 1n,
      tip: 0n,
      extrinsicEvents: [],
    });

    await recordWatchStatus(tx, {
      isBroadcast: false,
      isInBlock: false,
      isFinalized: true,
      isRetracted: false,
      isUsurped: false,
      isDropped: false,
      isInvalid: false,
      blockNumber: 130,
      blockHash: '0xwatched-block',
    });

    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        extrinsicHash: tx.extrinsicHash,
        block: {
          blockNumber: 130,
          blockHash: '0xwatched-block',
        },
      }),
    );
    expect(table.recordInBlock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        blockNumber: 130,
        blockHash: '0xwatched-block',
        extrinsicIndex: 2,
      }),
    );
    expect(table.markFinalized).toHaveBeenCalledWith(tx, expect.objectContaining({ blockNumber: 130 }));
  });

  it('ignores non-block watch updates without touching finalized accessors', async () => {
    const tx = createTransaction({
      id: 11,
      status: TransactionStatus.Submitted,
      blockHeight: undefined,
      blockHash: undefined,
    });
    const { tracker } = await createTracker({
      txs: [tx],
      finalizedHeight: 130,
    });
    const handleWatchedResult = (
      tracker as unknown as {
        handleWatchedResult: (tx: ITransactionRecord, txResult: any, result: any) => Promise<void>;
      }
    ).handleWatchedResult.bind(tracker) as (tx: ITransactionRecord, txResult: any, result: any) => Promise<void>;

    await expect(
      handleWatchedResult(
        tx,
        { isFinalized: true },
        {
          status: {
            isBroadcast: true,
            isInBlock: false,
            isFinalized: false,
            isRetracted: false,
            isUsurped: false,
            isDropped: false,
            isInvalid: false,
            get asFinalized() {
              throw new Error('should not touch asFinalized');
            },
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('reserves local nonces above restored pending submissions for concurrent same-account work', async () => {
    vi.mocked(getMainchainClient).mockResolvedValue({
      rpc: {
        chain: {
          getHeader: vi.fn(async () => ({ number: { toNumber: () => 125 } })),
        },
        system: {
          accountNextIndex: vi.fn(async () => ({ toNumber: () => 7 })),
        },
      },
    } as any);

    const { tracker } = await createTracker({
      txs: [
        createTransaction({
          id: 10,
          status: TransactionStatus.Submitted,
          txNonce: 7,
          accountAddress: '5Alice',
          blockHeight: undefined,
          blockHash: undefined,
        }),
      ],
      finalizedHeight: 125,
    });
    vi.spyOn(tracker, 'trackTxResult').mockImplementation(async ({ txResult, extrinsicType, metadata }) => {
      const txInfo = new TransactionInfo({
        tx: createTransaction({
          id: tracker.data.txInfos.length + 20,
          status: TransactionStatus.Submitted,
          txNonce: txResult.extrinsic.nonce,
          accountAddress: txResult.extrinsic.accountAddress,
          extrinsicType,
          metadataJson: metadata ?? {},
          submittedAtBlockHeight: txResult.extrinsic.submittedAtBlockNumber,
          submittedAtTime: txResult.extrinsic.submittedTime,
          blockHeight: undefined,
          blockHash: undefined,
          blockTime: undefined,
          blockExtrinsicIndex: undefined,
          blockExtrinsicEventsJson: undefined,
          isFinalized: false,
        }),
        txResult,
      });
      tracker.data.txInfos.unshift(txInfo);
      return txInfo;
    });

    let releaseFirstSign!: () => void;
    const firstSign = new Promise<void>(resolve => {
      releaseFirstSign = resolve;
    });
    const usedNonces: number[] = [];
    const createSignedTx = (nonce: number, hash: string) => ({
      hash: { toHex: () => hash },
      method: { toHuman: () => ({ section: 'balances', method: 'transferKeepAlive' }) },
      nonce: { toNumber: () => nonce },
      send: vi.fn(async () => undefined),
    });

    const firstTx = {
      signAsync: vi.fn(async (_signer, options) => {
        usedNonces.push(options.nonce);
        await firstSign;
        return createSignedTx(options.nonce, '0xfirst');
      }),
    };
    const secondTx = {
      signAsync: vi.fn(async (_signer, options) => {
        usedNonces.push(options.nonce);
        return createSignedTx(options.nonce, '0xsecond');
      }),
    };

    const firstSubmit = tracker.submitAndWatch({
      tx: firstTx as any,
      txSigner: { address: '5Alice' } as any,
      extrinsicType: ExtrinsicType.Transfer,
      useLatestNonce: true,
    });
    const secondSubmit = tracker.submitAndWatch({
      tx: secondTx as any,
      txSigner: { address: '5Alice' } as any,
      extrinsicType: ExtrinsicType.Transfer,
      useLatestNonce: true,
    });

    await Promise.resolve();
    await Promise.resolve();
    releaseFirstSign();
    await Promise.all([firstSubmit, secondSubmit]);

    expect(usedNonces).toEqual([8, 9]);
  });
});

async function createTracker(args: {
  txs: ITransactionRecord[];
  finalizedHeight: number;
  latestHistoryByTxId?: Map<number, any>;
  headerByHeight?: Record<number, string>;
}) {
  const table = {
    fetchAll: vi.fn().mockResolvedValue(args.txs),
    markFinalized: vi.fn(async (record: ITransactionRecord) => record),
    recordInBlock: vi.fn(async (record: ITransactionRecord) => record),
    markExpiredWaitingForBlock: vi.fn(async (record: ITransactionRecord) => record),
    updateFinalizedHead: vi.fn(
      async (record: ITransactionRecord, finalizedDetails: { blockNumber: number; blockTime: Date }) => {
        record.finalizedHeadHeight = finalizedDetails.blockNumber;
        record.finalizedHeadTime = finalizedDetails.blockTime;
        return record;
      },
    ),
  };
  const historyTable = {
    fetchLatestByTransactionIds: vi.fn().mockResolvedValue(args.latestHistoryByTxId ?? new Map()),
    record: vi.fn(async (entry: Record<string, unknown>) => ({
      id: 1,
      createdAt: new Date('2026-03-20T20:05:00Z'),
      ...entry,
    })),
  };
  const blockWatch = {
    start: vi.fn().mockResolvedValue(undefined),
    bestBlockHeader: { blockNumber: args.finalizedHeight },
    finalizedBlockHeader: {
      blockNumber: args.finalizedHeight,
      blockTime: new Date('2026-03-20T20:05:00Z').getTime(),
      blockHash: `0x${args.finalizedHeight.toString(16)}`,
    },
    getFinalizedHash: vi.fn(async (blockHeight: number) => args.headerByHeight?.[blockHeight] ?? '0xfinalized-block'),
    getHeader: vi.fn(async (blockHeight: number) => {
      return {
        blockNumber: blockHeight,
        blockHash: args.headerByHeight?.[blockHeight] ?? `0x${blockHeight.toString(16)}`,
      };
    }),
    events: { on: vi.fn() },
  };
  const tracker = new TransactionTracker(
    Promise.resolve({
      transactionsTable: table,
      transactionStatusHistoryTable: historyTable,
    } as any),
    blockWatch as any,
  );
  vi.spyOn(tracker as any, 'watchForUpdates').mockResolvedValue(undefined);
  await tracker.load();

  return { tracker, table, blockWatch };
}

function createTransaction(overrides: Partial<ITransactionRecord> = {}): ITransactionRecord {
  const now = new Date('2026-03-20T20:00:00Z');
  return {
    id: overrides.id ?? 1,
    status: overrides.status ?? TransactionStatus.InBlock,
    followOnTxId: overrides.followOnTxId,
    extrinsicHash: overrides.extrinsicHash ?? '0x123',
    extrinsicMethodJson: overrides.extrinsicMethodJson ?? {},
    extrinsicType: overrides.extrinsicType ?? ExtrinsicType.VaultCosignBitcoinRelease,
    metadataJson: overrides.metadataJson ?? {},
    accountAddress: overrides.accountAddress ?? '5Alice',
    submittedAtTime: overrides.submittedAtTime ?? now,
    submittedAtBlockHeight: overrides.submittedAtBlockHeight ?? 100,
    submissionErrorJson: overrides.submissionErrorJson,
    txNonce: overrides.txNonce,
    txTip: overrides.txTip,
    txFeePlusTip: overrides.txFeePlusTip,
    blockHeight: 'blockHeight' in overrides ? overrides.blockHeight : 100,
    blockHash: 'blockHash' in overrides ? overrides.blockHash : '0xold-block',
    blockTime: overrides.blockTime ?? now,
    blockExtrinsicIndex: overrides.blockExtrinsicIndex,
    blockExtrinsicEventsJson: overrides.blockExtrinsicEventsJson ?? [],
    blockExtrinsicErrorJson: overrides.blockExtrinsicErrorJson,
    finalizedHeadHeight: overrides.finalizedHeadHeight,
    finalizedHeadTime: overrides.finalizedHeadTime ?? now,
    isFinalized: overrides.isFinalized ?? false,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
