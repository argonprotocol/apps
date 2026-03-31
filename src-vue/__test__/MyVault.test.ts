import { describe, expect, it, vi } from 'vitest';
import type { MiningFrames } from '@argonprotocol/apps-core';
import { MyVault } from '../lib/MyVault.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { TransactionInfo } from '../lib/TransactionInfo.ts';
import { TxAttemptState, type TransactionTracker } from '../lib/TransactionTracker.ts';
import * as mainchainStore from '../stores/mainchain.ts';
import { ExtrinsicType, TransactionStatus, type ITransactionRecord } from '../lib/db/TransactionsTable.ts';
import {
  TransactionHistoryStatus,
  type ITransactionStatusHistoryRecord,
} from '../lib/db/TransactionStatusHistoryTable.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';

type IMyVaultTestTarget = {
  buildCosignTx(args: {
    utxoId: number;
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint };
  }): Promise<{ tx: unknown; vaultSignature: Uint8Array } | undefined>;
  cosignRelease(args: {
    utxoId: number;
    releaseRequest: { toScriptPubkey: string; bitcoinNetworkFee: bigint };
  }): Promise<{ txInfo: TransactionInfo; vaultSignature: Uint8Array } | undefined>;
  onCosignResult(txInfo: TransactionInfo<{ utxoId: number }>): Promise<void>;
  recordPendingCosignUtxos(rawUtxoIds: Iterable<unknown>, updateSeq: number): Promise<void>;
  updateCollectDueDate(): void;
  trackTxResultFee(txResult: unknown): Promise<void>;
};

describe('MyVault cosign recovery', () => {
  it('reuses a recent submitted cosign tx', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 11 },
    });
    const { myVault } = createVault({ txInfos: [txInfo], finalizedHeight: 101 });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(11);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Follow });
  });

  it('ignores an old submitted cosign tx after the grace window', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 12 },
    });
    const { myVault } = createVault({ txInfos: [txInfo], finalizedHeight: 103 });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(12);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('ignores a dropped cosign tx immediately so it can be retried', async () => {
    const txInfo = createTxInfo({
      id: 20,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 20 },
    });
    const { myVault } = createVault({
      txInfos: [txInfo],
      finalizedHeight: 100,
      historyByTxId: {
        20: [{ id: 1, transactionId: 20, status: TransactionHistoryStatus.Dropped }],
      },
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(20);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('ignores a reorged in-block cosign tx after the grace window', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.InBlock,
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold',
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 13 },
    });
    const { myVault, blockWatch } = createVault({
      txInfos: [txInfo],
      finalizedHeight: 103,
      headerByHeight: { 100: '0xnew' },
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(13);

    expect(blockWatch.getHeader).toHaveBeenCalledWith(100);
    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('resubmits a cosign when the previous in-block attempt was reorged out', async () => {
    const staleTxInfo = createTxInfo({
      status: TransactionStatus.InBlock,
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold',
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 14 },
    });
    const freshTxInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      submittedAtBlockHeight: 103,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 14 },
    });
    const submitAndWatch = vi.fn().mockResolvedValue(freshTxInfo);
    const { myVault } = createVault({
      txInfos: [staleTxInfo],
      finalizedHeight: 103,
      headerByHeight: { 100: '0xnew' },
      submitAndWatch,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
    vi.spyOn(testVault, 'onCosignResult').mockResolvedValue(undefined);

    const result = await testVault.cosignRelease({
      utxoId: 14,
      releaseRequest: {
        toScriptPubkey: '0014abcd',
        bitcoinNetworkFee: 10n,
      },
    });

    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      txInfo: freshTxInfo,
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
  });

  it('resubmits a dropped cosign and links it as a follow-on attempt', async () => {
    const staleTxInfo = createTxInfo({
      id: 21,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 21 },
    });
    const freshTxInfo = createTxInfo({
      id: 22,
      status: TransactionStatus.Submitted,
      txNonce: 8,
      submittedAtBlockHeight: 101,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 21 },
    });
    const submitAndWatch = vi.fn().mockResolvedValue(freshTxInfo);
    const followOnTx = { resolve: vi.fn(), isSettled: false };
    const createIntentForFollowOnTx = vi.fn().mockReturnValue(followOnTx);
    const { myVault } = createVault({
      txInfos: [staleTxInfo],
      finalizedHeight: 100,
      historyByTxId: {
        21: [{ id: 1, transactionId: 21, status: TransactionHistoryStatus.Dropped }],
      },
      submitAndWatch,
      createIntentForFollowOnTx,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
    vi.spyOn(testVault, 'onCosignResult').mockResolvedValue(undefined);

    const result = await testVault.cosignRelease({
      utxoId: 21,
      releaseRequest: {
        toScriptPubkey: '0014abcd',
        bitcoinNetworkFee: 10n,
      },
    });

    expect(createIntentForFollowOnTx).toHaveBeenCalledWith(staleTxInfo);
    expect(followOnTx.resolve).toHaveBeenCalledWith(freshTxInfo);
    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      txInfo: freshTxInfo,
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
  });

  it('resubmits from the latest dropped cosign attempt in a retry chain', async () => {
    const originalTxInfo = createTxInfo({
      id: 30,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      followOnTxId: 31,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 30 },
    });
    const droppedRetryTxInfo = createTxInfo({
      id: 31,
      status: TransactionStatus.Submitted,
      txNonce: 8,
      submittedAtBlockHeight: 101,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 30 },
    });
    const freshTxInfo = createTxInfo({
      id: 32,
      status: TransactionStatus.Submitted,
      txNonce: 9,
      submittedAtBlockHeight: 102,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 30 },
    });
    const submitAndWatch = vi.fn().mockResolvedValue(freshTxInfo);
    const followOnTx = { resolve: vi.fn(), isSettled: false };
    const createIntentForFollowOnTx = vi.fn().mockReturnValue(followOnTx);
    const { myVault } = createVault({
      txInfos: [droppedRetryTxInfo, originalTxInfo],
      finalizedHeight: 101,
      historyByTxId: {
        31: [{ id: 1, transactionId: 31, status: TransactionHistoryStatus.Dropped }],
      },
      submitAndWatch,
      createIntentForFollowOnTx,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
    vi.spyOn(testVault, 'onCosignResult').mockResolvedValue(undefined);

    const result = await testVault.cosignRelease({
      utxoId: 30,
      releaseRequest: {
        toScriptPubkey: '0014abcd',
        bitcoinNetworkFee: 10n,
      },
    });

    expect(createIntentForFollowOnTx).toHaveBeenCalledTimes(1);
    expect(createIntentForFollowOnTx).toHaveBeenCalledWith(droppedRetryTxInfo);
    expect(followOnTx.resolve).toHaveBeenCalledWith(freshTxInfo);
    expect(submitAndWatch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      txInfo: freshTxInfo,
      vaultSignature: new Uint8Array([1, 2, 3]),
    });
  });

  it('rejects the follow-on intent if cosign resubmission fails', async () => {
    const staleTxInfo = createTxInfo({
      id: 25,
      status: TransactionStatus.Submitted,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 25 },
    });
    const submitError = new Error('submit failed');
    const submitAndWatch = vi.fn().mockRejectedValue(submitError);
    const followOnTx = { resolve: vi.fn(), reject: vi.fn(), isSettled: false };
    const createIntentForFollowOnTx = vi.fn().mockReturnValue(followOnTx);
    const { myVault } = createVault({
      txInfos: [staleTxInfo],
      finalizedHeight: 100,
      historyByTxId: {
        25: [{ id: 1, transactionId: 25, status: TransactionHistoryStatus.Dropped }],
      },
      submitAndWatch,
      createIntentForFollowOnTx,
    });
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'buildCosignTx').mockResolvedValue({
      tx: { kind: 'cosign' },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });

    await expect(
      testVault.cosignRelease({
        utxoId: 25,
        releaseRequest: {
          toScriptPubkey: '0014abcd',
          bitcoinNetworkFee: 10n,
        },
      }),
    ).rejects.toThrow('submit failed');

    expect(createIntentForFollowOnTx).toHaveBeenCalledWith(staleTxInfo);
    expect(followOnTx.reject).toHaveBeenCalledWith(submitError);
    expect(followOnTx.resolve).not.toHaveBeenCalled();
  });

  it('ignores a retracted cosign once the nonce lane has moved on-chain', async () => {
    const txInfo = createTxInfo({
      id: 23,
      status: TransactionStatus.InBlock,
      txNonce: 7,
      submittedAtBlockHeight: 100,
      blockHeight: 100,
      blockHash: '0xold',
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 23 },
    });
    const newerTxInfo = createTxInfo({
      id: 24,
      status: TransactionStatus.Finalized,
      txNonce: 8,
      submittedAtBlockHeight: 101,
      accountAddress: txInfo.tx.accountAddress,
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: { cosignedUtxoIds: [] },
    });
    const { myVault } = createVault({
      txInfos: [txInfo, newerTxInfo],
      finalizedHeight: 101,
      headerByHeight: { 100: '0xold' },
      historyByTxId: {
        23: [{ id: 1, transactionId: 23, status: TransactionHistoryStatus.Retracted }],
      },
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(23);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('ignores failed finalized collect attempts as cosign carriers', async () => {
    const txInfo = createTxInfo({
      id: 26,
      status: TransactionStatus.Finalized,
      extrinsicType: ExtrinsicType.VaultCollect,
      metadataJson: { cosignedUtxoIds: [26] },
      blockExtrinsicErrorJson: { message: 'PendingCosignsBeforeCollect' },
    });
    const { myVault } = createVault({
      txInfos: [txInfo],
      finalizedHeight: 101,
    });

    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(26);

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });

  it('tracks standalone cosign submissions while awaiting finalization', async () => {
    let resolveFinalized: (value: Uint8Array) => void;
    const waitForFinalizedBlock = new Promise<Uint8Array>(resolve => {
      resolveFinalized = resolve;
    });
    const postProcessor = { resolve: vi.fn() };
    const txInfo = {
      tx: {
        metadataJson: { utxoId: 15 },
      },
      txResult: {
        waitForFinalizedBlock,
      },
      createPostProcessor: vi.fn(() => postProcessor),
    } as unknown as TransactionInfo<{ utxoId: number }>;
    const { myVault } = createVault();
    const testVault = myVault as unknown as IMyVaultTestTarget;
    const trackTxResultFee = vi.spyOn(testVault, 'trackTxResultFee').mockResolvedValue(undefined);

    const pending = testVault.onCosignResult(txInfo);

    expect(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.get(15)).toBe(txInfo);

    resolveFinalized!(new Uint8Array([1, 2, 3]));
    await pending;

    expect(trackTxResultFee).toHaveBeenCalledWith(txInfo.txResult);
    expect(postProcessor.resolve).toHaveBeenCalledTimes(1);
    expect(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.size).toBe(0);
  });

  it('prunes stale standalone cosign progress when the utxo is no longer pending', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.Submitted,
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      metadataJson: { utxoId: 16 },
    });
    const { myVault } = createVault();
    const getMainchainClient = vi.spyOn(mainchainStore, 'getMainchainClient').mockResolvedValue({} as any);
    const testVault = myVault as unknown as IMyVaultTestTarget;
    vi.spyOn(testVault, 'updateCollectDueDate').mockImplementation(() => undefined);

    myVault.data.pendingCosignUtxosById.set(16, { marketValue: 1_000n });
    myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.set(16, txInfo as TransactionInfo<{ utxoId: number }>);

    await testVault.recordPendingCosignUtxos([], 0);

    expect(myVault.data.pendingCosignUtxosById.size).toBe(0);
    expect(myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.size).toBe(0);

    getMainchainClient.mockRestore();
  });

  it('ignores failed orphan cosign txs', async () => {
    const txInfo = createTxInfo({
      status: TransactionStatus.TimedOutWaitingForBlock,
      submittedAtBlockHeight: 100,
      extrinsicType: ExtrinsicType.VaultCosignOrphanedUtxoRelease,
      metadataJson: {
        ownerAccount: 'owner-1',
        txid: 'a'.repeat(64),
        vout: 2,
      },
    });
    const { myVault } = createVault({ txInfos: [txInfo], finalizedHeight: 103 });

    const latestTxAttempt = await myVault.findLatestOrphanCosignTxAttempt({
      ownerAccount: 'owner-1',
      txid: 'a'.repeat(64),
      vout: 2,
    });

    expect(latestTxAttempt).toMatchObject({ txInfo, txAttemptState: TxAttemptState.Replace });
  });
});

function createVault(args?: {
  txInfos?: TransactionInfo[];
  finalizedHeight?: number;
  headerByHeight?: Record<number, string>;
  submitAndWatch?: ReturnType<typeof vi.fn>;
  createIntentForFollowOnTx?: ReturnType<typeof vi.fn>;
  historyByTxId?: Record<number, Partial<ITransactionStatusHistoryRecord>[]>;
}) {
  const blockWatch = {
    finalizedBlockHeader: { blockNumber: args?.finalizedHeight ?? 100 },
    getHeader: vi.fn(async (blockHeight: number) => {
      return {
        blockNumber: blockHeight,
        blockHash: args?.headerByHeight?.[blockHeight] ?? `0x${blockHeight.toString(16)}`,
      };
    }),
  };
  const historyByTxId = args?.historyByTxId ?? {};
  const txInfos = args?.txInfos ?? [];
  const submitAndWatch = args?.submitAndWatch ?? vi.fn();
  const getTxAttemptState = vi.fn(async (txInfo: TransactionInfo, finalizedBlockGrace: number) => {
    const latestHistoryStatus = historyByTxId[txInfo.tx.id]?.at(-1)?.status;
    if (
      txInfo.tx.submissionErrorJson ||
      txInfo.tx.blockExtrinsicErrorJson ||
      txInfo.tx.status === TransactionStatus.Error ||
      txInfo.tx.status === TransactionStatus.TimedOutWaitingForBlock
    ) {
      return TxAttemptState.Replace;
    }

    if (
      latestHistoryStatus === TransactionHistoryStatus.Dropped ||
      latestHistoryStatus === TransactionHistoryStatus.Usurped ||
      latestHistoryStatus === TransactionHistoryStatus.Invalid
    ) {
      return TxAttemptState.Replace;
    }

    if (latestHistoryStatus === TransactionHistoryStatus.Retracted && txInfo.tx.txNonce != null) {
      for (const otherTxInfo of txInfos) {
        if (otherTxInfo.tx.id === txInfo.tx.id) continue;
        if (otherTxInfo.tx.accountAddress !== txInfo.tx.accountAddress) continue;
        if (otherTxInfo.tx.txNonce == null || otherTxInfo.tx.txNonce < txInfo.tx.txNonce) continue;

        if (otherTxInfo.tx.status === TransactionStatus.Finalized) {
          return TxAttemptState.Replace;
        }

        if (otherTxInfo.tx.status !== TransactionStatus.InBlock) {
          continue;
        }

        const { blockHeight, blockHash } = otherTxInfo.tx;
        if (blockHeight == null || !blockHash) {
          continue;
        }

        const header = await blockWatch.getHeader(blockHeight).catch(() => undefined);
        if (header?.blockHash === blockHash) {
          return TxAttemptState.Replace;
        }
      }
    }

    const finalizedHeight = blockWatch.finalizedBlockHeader.blockNumber;
    if (txInfo.tx.status === TransactionStatus.Submitted) {
      return finalizedHeight - txInfo.tx.submittedAtBlockHeight <= finalizedBlockGrace
        ? TxAttemptState.Follow
        : TxAttemptState.Replace;
    }

    if (txInfo.tx.status === TransactionStatus.InBlock) {
      const { blockHeight, blockHash } = txInfo.tx;
      if (blockHeight == null || !blockHash) {
        return TxAttemptState.Replace;
      }

      const header = await blockWatch.getHeader(blockHeight).catch(() => undefined);
      if (!header || header.blockHash === blockHash) {
        return TxAttemptState.Follow;
      }

      return finalizedHeight - blockHeight <= finalizedBlockGrace ? TxAttemptState.Follow : TxAttemptState.Replace;
    }

    if (txInfo.tx.status === TransactionStatus.Finalized) {
      return TxAttemptState.Finalized;
    }

    return TxAttemptState.Replace;
  });
  const transactionTracker = {
    data: {
      txInfos,
      txInfosByType: {},
    },
    submitAndWatch,
    createIntentForFollowOnTx: args?.createIntentForFollowOnTx ?? vi.fn(),
    findLatestTxInfo: vi.fn((matcher: (txInfo: TransactionInfo) => boolean) => {
      return txInfos.find(matcher);
    }),
    getTxAttemptState,
  } as unknown as TransactionTracker;
  const miningFrames = {
    blockWatch,
    getFrameDate: vi.fn(() => new Date('2026-01-01T00:00:00Z')),
  } as unknown as MiningFrames;
  const bitcoinLocks = {} as BitcoinLocks;

  const myVault = new MyVault(
    Promise.resolve({
      transactionsTable: {
        fetchStatusHistory: vi.fn(async () => []),
      },
    } as any),
    {} as any,
    createMockWalletKeys(),
    transactionTracker,
    bitcoinLocks,
    miningFrames,
  );

  return { myVault, blockWatch, submitAndWatch };
}

function createTxInfo(overrides: Partial<ITransactionRecord>): TransactionInfo {
  const submittedAtTime = new Date('2026-01-01T00:00:00Z');
  const tx = {
    id: overrides.id ?? 1,
    status: overrides.status ?? TransactionStatus.Submitted,
    followOnTxId: overrides.followOnTxId,
    extrinsicHash: overrides.extrinsicHash ?? '0x1234',
    extrinsicMethodJson: overrides.extrinsicMethodJson ?? {},
    extrinsicType: overrides.extrinsicType ?? ExtrinsicType.VaultCosignBitcoinRelease,
    metadataJson: overrides.metadataJson ?? {},
    accountAddress: overrides.accountAddress ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    submittedAtTime: overrides.submittedAtTime ?? submittedAtTime,
    submittedAtBlockHeight: overrides.submittedAtBlockHeight ?? 100,
    submissionErrorJson: overrides.submissionErrorJson,
    txNonce: overrides.txNonce,
    txTip: overrides.txTip,
    txFeePlusTip: overrides.txFeePlusTip,
    blockHeight: overrides.blockHeight,
    blockHash: overrides.blockHash,
    blockTime: overrides.blockTime,
    blockExtrinsicIndex: overrides.blockExtrinsicIndex,
    blockExtrinsicEventsJson: overrides.blockExtrinsicEventsJson ?? [],
    blockExtrinsicErrorJson: overrides.blockExtrinsicErrorJson,
    finalizedHeadHeight: overrides.finalizedHeadHeight,
    finalizedHeadTime: overrides.finalizedHeadTime,
    isFinalized: overrides.isFinalized ?? overrides.status === TransactionStatus.Finalized,
    createdAt: overrides.createdAt ?? submittedAtTime,
    updatedAt: overrides.updatedAt ?? submittedAtTime,
  } satisfies ITransactionRecord;

  return {
    tx,
  } as TransactionInfo;
}
