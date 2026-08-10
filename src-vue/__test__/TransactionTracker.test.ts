import { TransactionEvents } from '@argonprotocol/apps-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { numberCodec } from '../../core/__test__/helpers/codecs.ts';
import { TxAttemptState, TransactionTracker } from '../lib/TransactionTracker.ts';
import { ExtrinsicType, type ITransactionRecord, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { TransactionHistorySource, TransactionHistoryStatus } from '../lib/db/TransactionStatusHistoryTable.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createTestDb } from './helpers/db.ts';

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

type ITransactionTrackerTestApi = {
  updatePendingStatuses: (bestBlockInfo: { blockNumber: number }) => Promise<void>;
  watchForUpdates: () => Promise<void>;
};

describe('TransactionTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries a failed load and clears stale tx type entries on reload', async () => {
    let resolveReload!: (value: ITransactionRecord[]) => void;
    const reloadRows = new Promise<ITransactionRecord[]>(resolve => {
      resolveReload = resolve;
    });
    const initialTx = createTransaction({
      id: 20,
      extrinsicType: ExtrinsicType.VaultCollect,
      status: TransactionStatus.Finalized,
      isFinalized: true,
    });
    const reloadedTx = createTransaction({
      id: 21,
      extrinsicType: ExtrinsicType.Transfer,
      status: TransactionStatus.Finalized,
      isFinalized: true,
    });
    const { tracker, table, blockWatch } = createLoadTracker({
      txsByLoad: [[], [initialTx], reloadRows],
      blockWatch: {
        start: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined),
      },
    });

    await expect(tracker.load()).rejects.toThrow('offline');
    await tracker.load();

    expect(blockWatch.start).toHaveBeenCalledTimes(2);
    expect(tracker.data.txInfosByType[ExtrinsicType.VaultCollect]?.tx.id).toBe(initialTx.id);

    const reloadPromise = tracker.load(true);
    let didReloadResolve = false;
    void reloadPromise.then(() => {
      didReloadResolve = true;
    });
    await Promise.resolve();

    expect(table.fetchAll).toHaveBeenCalledTimes(3);
    expect(didReloadResolve).toBe(false);

    resolveReload([reloadedTx]);
    await reloadPromise;

    expect(tracker.data.txInfos).toHaveLength(1);
    expect(tracker.data.txInfos[0].tx.id).toBe(reloadedTx.id);
    expect(tracker.data.txInfosByType[ExtrinsicType.Transfer]?.tx.id).toBe(reloadedTx.id);
    expect(tracker.data.txInfosByType[ExtrinsicType.VaultCollect]).toBeUndefined();
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

  it('does not retry a transaction based only on its nonce finalizing elsewhere', async () => {
    const db = await createTestDb();
    const call = { section: 'crosschainTransfer', method: 'collateralizeTransfer' };
    const createUnsignedTx = (method = call) => ({
      method,
      signAsync: vi.fn(async (_signer, options) => ({
        hash: { toHex: () => `0x${options.nonce}` },
        method: { toHuman: () => method },
        nonce: numberCodec(options.nonce),
        send: vi.fn(async () => undefined),
      })),
    });
    const client = {
      rpc: {
        chain: {
          getHeader: vi.fn(async () => ({ number: numberCodec(100) })),
        },
        system: {
          accountNextIndex: vi.fn(async () => numberCodec(7)),
        },
      },
      tx: vi.fn((tx: { method: typeof call }) => createUnsignedTx(tx.method)),
    };
    const blockWatch = {
      start: vi.fn().mockResolvedValue(undefined),
      bestBlockHeader: { blockNumber: 105, blockHash: '0x69' },
      finalizedBlockHeader: {
        blockNumber: 105,
        blockTime: new Date('2026-03-20T20:05:00Z').getTime(),
        blockHash: '0x69',
      },
      getApi: vi.fn(async () => ({
        query: {
          system: {
            account: vi.fn(async () => ({ nonce: numberCodec(8) })),
          },
        },
      })),
      events: { on: vi.fn() },
    };
    const tracker = new TransactionTracker(Promise.resolve(db), blockWatch as any);
    vi.spyOn(tracker as any, 'watchForUpdates').mockResolvedValue(undefined);

    try {
      await tracker.load();
      const originalTxInfo = await tracker.submitAndWatch({
        client: client as any,
        tx: createUnsignedTx() as any,
        txSigner: { address: '5Alice' } as any,
        extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
        useLatestNonce: true,
      });
      vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValueOnce(undefined);
      await (tracker as unknown as ITransactionTrackerTestApi).updatePendingStatuses({ blockNumber: 105 });

      const storedTxs = await db.transactionsTable.fetchAll();
      const originalStoredTx = storedTxs.find(record => record.id === originalTxInfo.tx.id)!;
      const history = await db.transactionStatusHistoryTable.fetchByTransactionId(originalTxInfo.tx.id);
      expect(storedTxs).toHaveLength(1);
      expect(originalStoredTx.followOnTxId).toBeNull();
      expect(originalStoredTx.status).toBe(TransactionStatus.Error);
      expect(originalStoredTx.submissionErrorJson?.message).toBe(
        'Transaction nonce was already used by another transaction.',
      );
      expect(history.map(({ status, source }) => [status, source])).toEqual([
        [TransactionHistoryStatus.Submitted, TransactionHistorySource.Local],
        [TransactionHistoryStatus.Invalid, TransactionHistorySource.Local],
        [TransactionHistoryStatus.Error, TransactionHistorySource.Local],
      ]);
    } finally {
      tracker.shutdown();
      await db.close();
    }
  });

  it('retries only a latest-nonce transaction rejected as outdated', async () => {
    const db = await createTestDb();
    const call = { section: 'crosschainTransfer', method: 'collateralizeTransfer' };
    let nextNonce = 7;
    let rejectedNonce = 7;
    let submissionError = new Error('1010: Invalid Transaction: Transaction is outdated');
    const createUnsignedTx = () => ({
      signAsync: vi.fn(async (_signer, options) => ({
        hash: { toHex: () => `0x${options.nonce}` },
        method: { toHuman: () => call },
        nonce: numberCodec(options.nonce),
        send: vi.fn(async () => {
          if (options.nonce === rejectedNonce) {
            nextNonce += 1;
            throw submissionError;
          }
        }),
      })),
    });
    const client = {
      rpc: {
        chain: {
          getHeader: vi.fn(async () => ({ number: numberCodec(100) })),
        },
        system: {
          accountNextIndex: vi.fn(async () => numberCodec(nextNonce)),
        },
      },
      tx: vi.fn(() => createUnsignedTx()),
    };
    const blockWatch = {
      start: vi.fn().mockResolvedValue(undefined),
      bestBlockHeader: { blockNumber: 100, blockHash: '0x64' },
      finalizedBlockHeader: {
        blockNumber: 100,
        blockTime: new Date('2026-03-20T20:00:00Z').getTime(),
        blockHash: '0x64',
      },
      events: { on: vi.fn() },
    };
    const tracker = new TransactionTracker(Promise.resolve(db), blockWatch as any);
    vi.spyOn(tracker as any, 'watchForUpdates').mockResolvedValue(undefined);

    try {
      const txInfo = await tracker.submitAndWatch({
        client: client as any,
        tx: createUnsignedTx() as any,
        txSigner: { address: '5Alice' } as any,
        extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
        useLatestNonce: true,
      });

      const storedTxs = await db.transactionsTable.fetchAll();
      expect(storedTxs).toHaveLength(2);
      expect(storedTxs.map(record => record.txNonce).sort()).toEqual([7, 8]);
      expect(storedTxs.find(record => record.txNonce === 7)?.status).toBe(TransactionStatus.Error);
      expect(txInfo.tx.txNonce).toBe(8);
      expect(txInfo.tx.status).toBe(TransactionStatus.Submitted);

      nextNonce = 9;
      rejectedNonce = 9;
      submissionError = new Error('1010: Invalid Transaction: Payment');
      const rejectedTxInfo = await tracker.submitAndWatch({
        client: client as any,
        tx: createUnsignedTx() as any,
        txSigner: { address: '5Alice' } as any,
        extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
        useLatestNonce: true,
      });

      const storedTxsAfterGenericError = await db.transactionsTable.fetchAll();
      expect(storedTxsAfterGenericError).toHaveLength(3);
      expect(storedTxsAfterGenericError.find(record => record.id === rejectedTxInfo.tx.id)?.status).toBe(
        TransactionStatus.Error,
      );
      expect(storedTxsAfterGenericError.some(record => record.txNonce === 10)).toBe(false);
    } finally {
      tracker.shutdown();
      await db.close();
    }
  });

  it('checks the account nonce at the finalized block used for the status scan', async () => {
    const tx = createTransaction({
      id: 5,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      txNonce: 7,
      blockHeight: undefined,
      blockHash: undefined,
    });
    const { tracker, blockWatch } = await createTracker({
      txs: [tx],
      finalizedHeight: 105,
      finalizedAccountNonce: 7,
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValueOnce(undefined);

    const statusUpdate = trackerApi.updatePendingStatuses({ blockNumber: 105 });
    blockWatch.finalizedBlockHeader = {
      blockNumber: 106,
      blockHash: '0x6a',
      blockTime: new Date('2026-03-20T20:06:00Z').getTime(),
    };
    await statusUpdate;

    expect(blockWatch.getApi).toHaveBeenCalledWith({
      blockNumber: 105,
      blockHash: '0x69',
      blockTime: expect.any(Number),
    });
  });

  it('shares a finalized nonce query across same-account transactions in one status scan', async () => {
    const txs = [
      createTransaction({
        id: 5,
        status: TransactionStatus.Submitted,
        txNonce: 7,
        blockHeight: undefined,
        blockHash: undefined,
      }),
      createTransaction({
        id: 6,
        status: TransactionStatus.Submitted,
        txNonce: 8,
        blockHeight: undefined,
        blockHash: undefined,
      }),
    ];
    const { tracker, finalizedAccountQuery } = await createTracker({
      txs,
      finalizedHeight: 105,
      finalizedAccountNonce: 7,
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);

    await trackerApi.updatePendingStatuses({ blockNumber: 105 });
    await trackerApi.updatePendingStatuses({ blockNumber: 105 });

    expect(finalizedAccountQuery).toHaveBeenCalledOnce();
  });

  it('retries a failed finalized nonce query without waiting for a new finalized block', async () => {
    const tx = createTransaction({
      id: 6,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      txNonce: 7,
      blockHeight: undefined,
      blockHash: undefined,
    });
    const { tracker, table, finalizedAccountQuery } = await createTracker({
      txs: [tx],
      finalizedHeight: 105,
      finalizedAccountError: new Error('WebSocket is not connected'),
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValue(undefined);

    await trackerApi.updatePendingStatuses({ blockNumber: 105 });
    await trackerApi.updatePendingStatuses({ blockNumber: 105 });

    expect(finalizedAccountQuery).toHaveBeenCalledTimes(2);
    expect(table.updateFinalizedHead).not.toHaveBeenCalled();
  });

  it('expires an overdue transaction when the finalized nonce lookup fails', async () => {
    const tx = createTransaction({
      id: 6,
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 60,
      txNonce: 7,
      blockHeight: undefined,
      blockHash: undefined,
    });
    const { tracker, table } = await createTracker({
      txs: [tx],
      finalizedHeight: 125,
      finalizedAccountError: new Error('WebSocket is not connected'),
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValueOnce(undefined);

    await trackerApi.updatePendingStatuses({ blockNumber: 125 });

    expect(table.markExpiredWaitingForBlock).toHaveBeenCalledWith(tx);
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
      fee: 5n,
      tip: 2n,
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
        feePlusTip: 5n,
        tip: 2n,
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
      tx: vi.fn(() => ({ signAsync: vi.fn() })),
      rpc: {
        chain: {
          getHeader: vi.fn(async () => ({ number: numberCodec(125) })),
        },
        system: {
          accountNextIndex: vi.fn(async () => numberCodec(7)),
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
    let releaseFirstSign!: () => void;
    const firstSign = new Promise<void>(resolve => {
      releaseFirstSign = resolve;
    });
    const usedNonces: number[] = [];
    const createSignedTx = (nonce: number, hash: string) => ({
      hash: { toHex: () => hash },
      method: { toHuman: () => ({ section: 'balances', method: 'transferKeepAlive' }) },
      nonce: numberCodec(nonce),
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

  it('uses a provided client for transaction submission and result tracking', async () => {
    const { tracker } = await createTracker({
      txs: [],
      finalizedHeight: 125,
    });
    const client = {
      rpc: {
        chain: {
          getHeader: vi.fn(async () => ({ number: numberCodec(126) })),
        },
      },
    };
    const signedTx = {
      hash: { toHex: () => '0xsubmitted' },
      method: { toHuman: () => ({ section: 'proxy', method: 'addProxy' }) },
      nonce: numberCodec(4),
      send: vi.fn(async () => undefined),
    };
    const tx = {
      signAsync: vi.fn().mockResolvedValue(signedTx),
    };
    vi.mocked(getMainchainClient).mockClear();

    const txInfo = await tracker.submitAndWatch({
      client: client as any,
      tx: tx as any,
      txSigner: { address: '5Alice' } as any,
      extrinsicType: ExtrinsicType.MiningBidProxySetup,
    });

    expect(getMainchainClient).not.toHaveBeenCalled();
    expect(client.rpc.chain.getHeader).toHaveBeenCalledOnce();
    expect((txInfo.txResult as unknown as { client: unknown }).client).toBe(client);
  });

  it('submits a signed transaction before scanning pending transaction statuses', async () => {
    const { tracker } = await createTracker({
      txs: [],
      finalizedHeight: 125,
    });
    let finishStatusScan!: () => void;
    const statusScan = new Promise<void>(resolve => {
      finishStatusScan = resolve;
    });
    const trackerApi = tracker as unknown as ITransactionTrackerTestApi;
    vi.mocked(trackerApi.watchForUpdates).mockImplementationOnce(async () => await statusScan);

    const signedTx = {
      hash: { toHex: () => '0xsubmitted' },
      method: { toHuman: () => ({ section: 'bitcoinLocks', method: 'initialize' }) },
      nonce: numberCodec(4),
      send: vi.fn(async () => undefined),
    };
    const submission = tracker.submitAndWatch({
      client: {
        rpc: {
          chain: {
            getHeader: vi.fn(async () => ({ number: numberCodec(126) })),
          },
        },
      } as any,
      tx: { signAsync: vi.fn().mockResolvedValue(signedTx) } as any,
      txSigner: { address: '5Alice' } as any,
      extrinsicType: ExtrinsicType.BitcoinRequestLock,
    });

    await vi.waitFor(() => expect(signedTx.send).toHaveBeenCalledOnce());
    finishStatusScan();
    await submission;
  });
});

async function createTracker(args: {
  txs: ITransactionRecord[];
  finalizedHeight: number;
  finalizedAccountNonce?: number;
  finalizedAccountError?: Error;
  latestHistoryByTxId?: Map<number, any>;
  headerByHeight?: Record<number, string>;
}) {
  let insertedId = Math.max(0, ...args.txs.map(tx => tx.id));
  const finalizedAccountQuery = vi.fn(async () => {
    if (args.finalizedAccountError) throw args.finalizedAccountError;
    return { nonce: numberCodec(args.finalizedAccountNonce ?? 0) };
  });
  const table = {
    fetchAll: vi.fn().mockResolvedValue(args.txs),
    insert: vi.fn(async (record: Partial<ITransactionRecord>) =>
      createTransaction({
        ...record,
        id: ++insertedId,
        status: TransactionStatus.Submitted,
        blockHeight: undefined,
        blockHash: undefined,
        blockTime: undefined,
        isFinalized: false,
      }),
    ),
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
    getApi: vi.fn(async () => ({
      query: {
        system: {
          account: finalizedAccountQuery,
        },
      },
    })),
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

  return { tracker, table, blockWatch, finalizedAccountQuery };
}

function createLoadTracker(args: {
  txsByLoad: Array<ITransactionRecord[] | Promise<ITransactionRecord[]>>;
  blockWatch?: Record<string, any>;
}) {
  const txLoads = [...args.txsByLoad];
  const table = {
    fetchAll: vi.fn().mockImplementation(async () => await txLoads.shift()),
  };
  const historyTable = {
    fetchLatestByTransactionIds: vi.fn().mockResolvedValue(new Map()),
  };
  const blockWatch = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isLoaded: { isRejected: false },
    bestBlockHeader: { blockNumber: 100 },
    finalizedBlockHeader: {
      blockNumber: 100,
      blockTime: new Date('2026-03-20T20:05:00Z').getTime(),
      blockHash: '0x64',
    },
    getFinalizedHash: vi.fn(async () => '0xfinalized-block'),
    events: { on: vi.fn() },
    ...args.blockWatch,
  };
  const tracker = new TransactionTracker(
    Promise.resolve({
      transactionsTable: table,
      transactionStatusHistoryTable: historyTable,
    } as any),
    blockWatch as any,
  );

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
