import { describe, expect, it, vi } from 'vitest';
import { BitcoinLock, type ArgonClient } from '@argonprotocol/mainchain';
import type { BlockWatch, Currency as CurrencyBase } from '@argonprotocol/apps-core';
import { CosignScript } from '@argonprotocol/bitcoin';
import { createTestDb } from './helpers/db.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import BitcoinMempool, { type IMempoolTxStatus } from '../lib/BitcoinMempool.ts';
import type { Db } from '../lib/Db.ts';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';

describe('BitcoinLocks release status sync', () => {
  it('syncLockReleaseStatusFromFundingRecord marks lock as Releasing when release has started', async () => {
    const db = await createTestDb();
    const lock = await createLock(db, BitcoinLockStatus.LockedAndMinted);
    const store = createStore(db, {
      isReleaseCompleteStatus: false,
      isReleaseStatus: true,
    });

    await store.syncLockReleaseStatusFromFundingRecord(lock, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    } as IBitcoinUtxoRecord);

    const updated = (await db.bitcoinLocksTable.fetchAll()).find(x => x.uuid === lock.uuid)!;
    expect(updated.status).toBe(BitcoinLockStatus.Releasing);
  });

  it('syncLockReleaseStatusFromFundingRecord marks lock as Released when release is complete', async () => {
    const db = await createTestDb();
    const lock = await createLock(db, BitcoinLockStatus.Releasing);
    const store = createStore(db, {
      isReleaseCompleteStatus: true,
      isReleaseStatus: true,
    });

    await store.syncLockReleaseStatusFromFundingRecord(lock, {
      status: BitcoinUtxoStatus.ReleaseComplete,
      releasedAtBitcoinHeight: 222,
    } as IBitcoinUtxoRecord);

    const updated = (await db.bitcoinLocksTable.fetchAll()).find(x => x.uuid === lock.uuid)!;
    expect(updated.status).toBe(BitcoinLockStatus.Released);
  });

  it('ownerCosignAndSendToBitcoin stores statusError when signing fails', async () => {
    const db = await createTestDb();
    const lock = await createLock(db, BitcoinLockStatus.Releasing);
    lock.utxoId = 1;
    const fundingRecord = createFundingRecord({
      id: 11,
      lockUtxoId: lock.utxoId,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      requestedReleaseAtTick: 123,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseTxid: undefined,
      releasedAtBitcoinHeight: undefined,
    });
    lock.fundingUtxoRecord = fundingRecord;

    const ownerCosignAndGenerateTxBytes = vi.fn<() => Promise<never>>().mockRejectedValue(new Error('signing failed'));
    const store = createRuntimeStore(db, { ownerCosignAndGenerateTxBytes });

    const setStatusError = vi.spyOn(store.utxoTracking, 'setStatusError').mockResolvedValue();
    vi.spyOn(store.utxoTracking, 'clearStatusError').mockResolvedValue();
    vi.spyOn(store.utxoTracking, 'canSubmitFundingRecordReleaseToBitcoin').mockReturnValue(true);

    // @ts-expect-error - private access
    await expect(store.ownerCosignAndSendToBitcoin(lock)).rejects.toThrow('signing failed');
    expect(ownerCosignAndGenerateTxBytes).toHaveBeenCalledTimes(1);
    expect(setStatusError).toHaveBeenCalledTimes(1);
    expect(setStatusError).toHaveBeenCalledWith(fundingRecord, 'Error: signing failed');
  });

  it('release flow waits for Argon cosign visibility before storing local state or submitting to bitcoin', async () => {
    const harness = createReleaseFlowHarness();

    // @ts-expect-error - private access
    await harness.store.syncLockReleaseArgonCosign(harness.lock, createArgonClientStub());

    expect(harness.cosignMyLock).toHaveBeenCalledTimes(1);
    expect(harness.cosignMyLock).toHaveBeenCalledWith(harness.lock);
    expect(harness.setReleaseCosign).not.toHaveBeenCalled();

    const releaseCosignOnChain = {
      blockHeight: 77,
      signature: new Uint8Array([7, 8, 9]),
    };
    harness.state.releaseCosignOnChain = releaseCosignOnChain;

    // @ts-expect-error - private access
    await harness.store.syncLockReleaseArgonCosign(harness.lock, createArgonClientStub());

    expect(harness.setReleaseCosign).toHaveBeenCalledWith(harness.fundingRecord, {
      releaseCosignVaultSignature: releaseCosignOnChain.signature,
      releaseCosignHeight: releaseCosignOnChain.blockHeight,
    });
    expect(harness.ensureLockReleaseProcessing).toHaveBeenCalledTimes(1);

    // @ts-expect-error - private access
    await harness.store.reconcileAcceptedFundingReleaseOnBlock(harness.lock, false);

    expect(harness.ownerCosignAndSendToBitcoin).toHaveBeenCalledTimes(1);
    expect(harness.ownerCosignAndSendToBitcoin).toHaveBeenCalledWith(harness.lock);
  });

  it('syncLockReleaseArgonRequest repairs stale local release metadata from chain', async () => {
    const lock = createLockRecord({ uuid: 'lock-2', utxoId: 22, status: BitcoinLockStatus.Releasing });
    const fundingRecord = createFundingRecord({
      id: 12,
      lockUtxoId: 22,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      requestedReleaseAtTick: 100,
      releaseToDestinationAddress: '0014stale',
      releaseBitcoinNetworkFee: 5n,
    });
    const setReleaseRequest = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const ensureLockReleaseProcessing = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const getReleaseRequestSpy = vi.spyOn(BitcoinLock.prototype, 'getReleaseRequest').mockResolvedValue({
      toScriptPubkey: '0014canonical',
      bitcoinNetworkFee: 9n,
      dueFrame: 44,
      vaultId: 1,
      redemptionPrice: 123n,
    });

    try {
      const store = createStoreStub({
        getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
        utxoTracking: {
          setReleaseRequest,
        },
        ensureLockReleaseProcessing,
      });
      const apiClient = {
        query: {
          ticks: {
            currentTick: vi.fn().mockResolvedValue({ toNumber: () => 123 }),
          },
        },
      } as unknown as ArgonClient;

      // @ts-expect-error - private access
      await store.syncLockReleaseArgonRequest(lock, apiClient);

      expect(setReleaseRequest).toHaveBeenCalledWith(fundingRecord, {
        requestedReleaseAtTick: 123,
        releaseToDestinationAddress: '0014canonical',
        releaseBitcoinNetworkFee: 9n,
      });
      expect(ensureLockReleaseProcessing).toHaveBeenCalledWith(lock);
    } finally {
      getReleaseRequestSpy.mockRestore();
    }
  });

  it('ownerCosignAndSendToBitcoin refuses to build a release tx without an Argon cosign height', async () => {
    const db = await createTestDb();
    const lock = await createLock(db, BitcoinLockStatus.Releasing);
    lock.utxoId = 1;
    const fundingRecord = createFundingRecord({
      id: 11,
      lockUtxoId: lock.utxoId,
      txid: 'funding-txid',
      vout: 0,
      satoshis: 10_000n,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      requestedReleaseAtTick: 123,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: undefined,
      releaseTxid: undefined,
      releasedAtBitcoinHeight: undefined,
    });
    lock.fundingUtxoRecord = fundingRecord;

    const ownerCosignAndGenerateTxBytes = vi.fn();
    const store = createRuntimeStore(db, { ownerCosignAndGenerateTxBytes });

    const clearStatusError = vi.spyOn(store.utxoTracking, 'clearStatusError').mockResolvedValue();
    const setStatusError = vi.spyOn(store.utxoTracking, 'setStatusError').mockResolvedValue();

    // @ts-expect-error - private access
    await store.ownerCosignAndSendToBitcoin(lock);

    expect(clearStatusError).not.toHaveBeenCalled();
    expect(ownerCosignAndGenerateTxBytes).not.toHaveBeenCalled();
    expect(setStatusError).not.toHaveBeenCalled();
  });

  it('reconcileMismatchReturnOnBlock resets stale orphan records that were never submitted', async () => {
    const lock = { utxoId: 11 } as IBitcoinLockRecord;
    const orphanRecord = createFundingRecord({
      id: 7,
      lockUtxoId: 11,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
    });
    const setReleaseError = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);

    const store = createStoreStub({
      utxoTracking: {
        getAcceptedFundingRecordForLock: vi.fn().mockReturnValue(undefined),
        getMismatchOrphanReleases: vi.fn().mockReturnValue([orphanRecord]),
        setReleaseError,
      },
      getOrphanedReturnTxInfoForRecord: vi.fn().mockReturnValue(undefined),
      syncOrphanReleaseRequestFromChain: vi.fn<(...args: any[]) => Promise<boolean>>().mockResolvedValue(false),
      submitOrphanReleaseToBitcoin: vi.fn().mockResolvedValue(undefined),
    });

    // @ts-expect-error - private access
    await store.reconcileMismatchReturnOnBlock(lock);
    expect(setReleaseError).toHaveBeenCalledTimes(1);
    expect(setReleaseError).toHaveBeenCalledWith(
      orphanRecord,
      'Mismatch return was interrupted before submission. Please retry return or collect the adjusted amount.',
    );
  });

  it('reconcileMismatchReturnOnBlock resumes bitcoin submission when argon state exists but tx tracking is missing', async () => {
    const lock = { utxoId: 11 } as IBitcoinLockRecord;
    const orphanRecord = createFundingRecord({
      id: 8,
      lockUtxoId: 11,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      requestedReleaseAtTick: 123,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
    });
    const setReleaseError = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const submitOrphanReleaseToBitcoin = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);

    const store = createStoreStub({
      utxoTracking: {
        getAcceptedFundingRecordForLock: vi.fn().mockReturnValue(undefined),
        getMismatchOrphanReleases: vi.fn().mockReturnValue([orphanRecord]),
        setReleaseError,
      },
      getOrphanedReturnTxInfoForRecord: vi.fn().mockReturnValue(undefined),
      submitOrphanReleaseToBitcoin,
    });

    // @ts-expect-error - private access
    await store.reconcileMismatchReturnOnBlock(lock);
    expect(submitOrphanReleaseToBitcoin).toHaveBeenCalledTimes(1);
    expect(submitOrphanReleaseToBitcoin).toHaveBeenCalledWith(lock, orphanRecord, {
      toScriptPubkey: orphanRecord.releaseToDestinationAddress,
      bitcoinNetworkFee: orphanRecord.releaseBitcoinNetworkFee,
    });
    expect(setReleaseError).not.toHaveBeenCalled();
  });

  it('reconcileMismatchReturnOnBlock resumes bitcoin submission after recovering the orphan request from chain', async () => {
    const lock = { utxoId: 11, lockDetails: createLockDetails() } as IBitcoinLockRecord;
    const orphanRecord = createFundingRecord({
      id: 18,
      lockUtxoId: 11,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
    });
    const setReleaseError = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const submitOrphanReleaseToBitcoin = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const syncOrphanReleaseRequestFromChain = vi.fn<(...args: any[]) => Promise<boolean>>().mockResolvedValue(true);

    const store = createStoreStub({
      utxoTracking: {
        getAcceptedFundingRecordForLock: vi.fn().mockReturnValue(undefined),
        getMismatchOrphanReleases: vi.fn().mockReturnValue([orphanRecord]),
        setReleaseError,
      },
      getOrphanedReturnTxInfoForRecord: vi.fn().mockReturnValue(undefined),
      syncOrphanReleaseRequestFromChain,
      submitOrphanReleaseToBitcoin,
    });

    // @ts-expect-error - private access
    await store.reconcileMismatchReturnOnBlock(lock);

    expect(syncOrphanReleaseRequestFromChain).toHaveBeenCalledWith(lock, orphanRecord);
    expect(submitOrphanReleaseToBitcoin).toHaveBeenCalledTimes(1);
    expect(submitOrphanReleaseToBitcoin).toHaveBeenCalledWith(lock, orphanRecord, {
      toScriptPubkey: orphanRecord.releaseToDestinationAddress,
      bitcoinNetworkFee: orphanRecord.releaseBitcoinNetworkFee,
    });
    expect(setReleaseError).not.toHaveBeenCalled();
  });

  it('reconcileMismatchReturnOnBlock stores confirmed orphan cosign data only after finalization', async () => {
    const lock = { utxoId: 11 } as IBitcoinLockRecord;
    const orphanRecord = createFundingRecord({
      id: 9,
      lockUtxoId: 11,
      txid: 'orphan-txid',
      vout: 0,
      satoshis: 10_000n,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
      releaseCosignVaultSignature: undefined,
      releaseCosignHeight: undefined,
    });
    const createdVaultSignature = new Uint8Array([4, 5, 6]);
    const setReleaseCosign = vi.fn<(...args: any[]) => Promise<void>>().mockImplementation(async (record, update) => {
      Object.assign(record, update);
    });
    const ensureOrphanReleaseObservedAtTick = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const submitOrphanReleaseToBitcoin = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const txInfo = {
      tx: { status: TransactionStatus.Finalized },
      txResult: { blockNumber: 77 },
    } as any;

    const store = createStoreStub({
      utxoTracking: {
        getAcceptedFundingRecordForLock: vi.fn().mockReturnValue(undefined),
        getMismatchOrphanReleases: vi.fn().mockReturnValue([orphanRecord]),
        setReleaseError: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
        setReleaseCosign,
      },
      getOrphanedReturnTxInfoForRecord: vi.fn().mockReturnValue(txInfo),
      getTxFailureMessage: vi.fn().mockReturnValue(undefined),
      ensureOrphanReleaseObservedAtTick,
      createVaultSignatureForOrphanReturn: vi
        .fn<(...args: any[]) => Promise<Uint8Array>>()
        .mockResolvedValue(createdVaultSignature),
      submitOrphanReleaseToBitcoin,
    });

    // @ts-expect-error - private access
    await store.reconcileMismatchReturnOnBlock(lock);

    expect(ensureOrphanReleaseObservedAtTick).toHaveBeenCalledWith(orphanRecord, txInfo);
    expect(setReleaseCosign).toHaveBeenCalledWith(orphanRecord, {
      releaseCosignVaultSignature: createdVaultSignature,
      releaseCosignHeight: txInfo.txResult.blockNumber,
    });
    expect(submitOrphanReleaseToBitcoin).toHaveBeenCalledWith(lock, orphanRecord, {
      toScriptPubkey: orphanRecord.releaseToDestinationAddress,
      bitcoinNetworkFee: orphanRecord.releaseBitcoinNetworkFee,
      vaultSignature: createdVaultSignature,
    });
  });

  it('reconcileMismatchReturnOnBlock excludes the accepted funding UTXO from orphan-return handling', async () => {
    const fundingRecord = createFundingRecord({
      id: 12,
      lockUtxoId: 11,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      requestedReleaseAtTick: 123,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
    });
    const submitOrphanReleaseToBitcoin = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const lockCases: IBitcoinLockRecord[] = [
      {
        utxoId: 11,
        fundingUtxoRecordId: fundingRecord.id,
      } as IBitcoinLockRecord,
      {
        utxoId: 11,
        fundingUtxoRecordId: null,
        fundingUtxoRecord: fundingRecord,
      } as IBitcoinLockRecord,
    ];

    for (const lock of lockCases) {
      const getMismatchOrphanReleases = vi.fn().mockReturnValue([]);
      const store = createStoreStub({
        utxoTracking: {
          getAcceptedFundingRecordForLock: vi.fn().mockReturnValue(fundingRecord),
          getMismatchOrphanReleases,
          setReleaseError: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
        },
        getOrphanedReturnTxInfoForRecord: vi.fn().mockReturnValue(undefined),
        submitOrphanReleaseToBitcoin,
      });

      // @ts-expect-error - private access
      await store.reconcileMismatchReturnOnBlock(lock);

      expect(getMismatchOrphanReleases).toHaveBeenCalledWith(lock.utxoId, undefined, fundingRecord.id);
    }

    expect(submitOrphanReleaseToBitcoin).not.toHaveBeenCalled();
  });

  it('submitOrphanReleaseToBitcoin treats duplicate orphan broadcasts as already submitted', async () => {
    const db = await createTestDb();
    const orphanReturnTxid = 'b'.repeat(64);
    const getTxStatus = vi.fn().mockResolvedValue(undefined);
    const getTipHeight = vi.fn().mockResolvedValue(321);
    const broadcastTx = vi
      .fn()
      .mockRejectedValue(new Error('Failed to broadcast transaction: 400 Bad Request - txn-already-known'));
    const mempool = Object.assign(Object.create(BitcoinMempool.prototype), {
      getTxStatus,
      getTipHeight,
      broadcastTx,
    }) as BitcoinMempool;
    const walletKeys = {
      getBitcoinChildXpriv: vi.fn().mockResolvedValue('owner-xpriv'),
    } as unknown as WalletKeys;
    const store = createRuntimeStore(db, {}, { walletKeys, mempool });
    const lock = createLockRecord({
      uuid: 'lock-1',
      utxoId: 11,
      vaultId: 1,
      lockDetails: createLockDetails(),
    });
    const orphanRecord = createFundingRecord({
      id: 19,
      lockUtxoId: 11,
      txid: 'a'.repeat(64),
      vout: 0,
      satoshis: 10_000n,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
    });
    const cosignAndGenerateTx = vi.spyOn(CosignScript.prototype, 'cosignAndGenerateTx').mockReturnValue({
      id: orphanReturnTxid,
      isFinal: true,
      toBytes: () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    } as any);
    const setReleaseSeenOnBitcoinAndProcessing = vi
      .spyOn(store.utxoTracking, 'setReleaseSeenOnBitcoinAndProcessing')
      .mockResolvedValue(undefined);
    const setReleaseError = vi.spyOn(store.utxoTracking, 'setReleaseError').mockResolvedValue(undefined);

    try {
      // @ts-expect-error - private access
      await store.submitOrphanReleaseToBitcoin(lock, orphanRecord, {
        toScriptPubkey: '0014abc123',
        bitcoinNetworkFee: 10n,
        vaultSignature: new Uint8Array([1, 2, 3]),
      });
    } finally {
      cosignAndGenerateTx.mockRestore();
    }

    expect(broadcastTx).toHaveBeenCalledWith('deadbeef');
    expect(getTxStatus).toHaveBeenCalledWith(orphanReturnTxid, 0);
    expect(setReleaseSeenOnBitcoinAndProcessing).toHaveBeenCalledWith(orphanRecord, orphanReturnTxid, 321);
    expect(setReleaseError).not.toHaveBeenCalled();
  });

  it('submitOrphanReleaseToBitcoin reuses a confirmed orphan return txid on restart', async () => {
    const db = await createTestDb();
    const orphanReturnTxid = 'c'.repeat(64);
    const existingTxStatus: IMempoolTxStatus = {
      isConfirmed: true,
      transactionBlockHeight: 320,
      transactionBlockTime: 1710000000,
      argonBitcoinHeight: 320,
    };
    const getTxStatus = vi.fn().mockResolvedValue(existingTxStatus);
    const getTipHeight = vi.fn().mockResolvedValue(321);
    const broadcastTx = vi.fn().mockResolvedValue(orphanReturnTxid);
    const mempool = Object.assign(Object.create(BitcoinMempool.prototype), {
      getTxStatus,
      getTipHeight,
      broadcastTx,
    }) as BitcoinMempool;
    const walletKeys = {
      getBitcoinChildXpriv: vi.fn().mockResolvedValue('owner-xpriv'),
    } as unknown as WalletKeys;
    const store = createRuntimeStore(db, {}, { walletKeys, mempool });
    const lock = createLockRecord({
      uuid: 'lock-2',
      utxoId: 12,
      vaultId: 1,
      lockDetails: createLockDetails(),
    });
    const orphanRecord = createFundingRecord({
      id: 20,
      lockUtxoId: 12,
      txid: 'd'.repeat(64),
      vout: 0,
      satoshis: 10_000n,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
    });
    const cosignAndGenerateTx = vi.spyOn(CosignScript.prototype, 'cosignAndGenerateTx').mockReturnValue({
      id: orphanReturnTxid,
      isFinal: true,
      toBytes: () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    } as any);
    const setReleaseSeenOnBitcoinAndProcessing = vi
      .spyOn(store.utxoTracking, 'setReleaseSeenOnBitcoinAndProcessing')
      .mockResolvedValue(undefined);

    try {
      // @ts-expect-error - private access
      await store.submitOrphanReleaseToBitcoin(lock, orphanRecord, {
        toScriptPubkey: '0014abc123',
        bitcoinNetworkFee: 10n,
        vaultSignature: new Uint8Array([1, 2, 3]),
      });
    } finally {
      cosignAndGenerateTx.mockRestore();
    }

    expect(broadcastTx).not.toHaveBeenCalled();
    expect(setReleaseSeenOnBitcoinAndProcessing).toHaveBeenCalledWith(orphanRecord, orphanReturnTxid, 321);
  });
});

async function createLock(db: Awaited<ReturnType<typeof createTestDb>>, status: BitcoinLockStatus) {
  return await db.bitcoinLocksTable.insertPending({
    uuid: `lock-${Math.random().toString(16).slice(2)}`,
    status,
    satoshis: 10_000n,
    cosignVersion: 'v1',
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: 1,
  });
}

function createStore(
  db: Awaited<ReturnType<typeof createTestDb>>,
  overrides?: {
    isReleaseCompleteStatus?: boolean;
    isReleaseStatus?: boolean;
  },
) {
  const utxoTracking = {
    isReleaseCompleteStatus: vi
      .fn<(status: BitcoinUtxoStatus | undefined) => boolean>()
      .mockReturnValue(overrides?.isReleaseCompleteStatus ?? false),
    isReleaseStatus: vi
      .fn<(status: BitcoinUtxoStatus | undefined) => boolean>()
      .mockReturnValue(overrides?.isReleaseStatus ?? false),
    getAcceptedFundingRecordForLock: vi.fn<(lock: IBitcoinLockRecord) => IBitcoinUtxoRecord | undefined>(),
  };

  return createStoreStub({
    utxoTracking,
    getTable: async () => db.bitcoinLocksTable,
  });
}

function createRuntimeStore(
  db: Awaited<ReturnType<typeof createTestDb>>,
  overrides: object = {},
  deps?: { walletKeys?: WalletKeys; mempool?: BitcoinMempool },
) {
  const blockWatch = Object.assign(Object.create(null), {
    start: async () => undefined,
    events: { on: () => () => undefined },
    bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
  }) as BlockWatch;
  const currency = Object.assign(Object.create(null), {
    load: async () => undefined,
    priceIndex: {},
  }) as CurrencyBase;
  const transactionTracker = Object.assign(Object.create(null), {
    load: async () => undefined,
    pendingBlockTxInfosAtLoad: [],
    data: { txInfos: [], txInfosByType: {} },
  }) as TransactionTracker;

  return Object.assign(
    new BitcoinLocks(
      Promise.resolve(db),
      deps?.walletKeys ?? (Object.create(null) as WalletKeys),
      blockWatch,
      currency,
      transactionTracker,
      deps?.mempool,
    ),
    overrides,
  );
}

function createStoreStub(overrides: object): BitcoinLocks {
  return Object.assign(Object.create(BitcoinLocks.prototype), overrides) as BitcoinLocks;
}

function createReleaseFlowHarness(args?: { waitForInFirstBlock?: Promise<unknown>; txFailure?: string | undefined }) {
  const lock = createLockRecord({
    uuid: 'lock-1',
    utxoId: 11,
    vaultId: 1,
    lockDetails: createLockDetails(),
  });
  const fundingRecord = createFundingRecord({
    status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    releaseToDestinationAddress: '0014abc123',
    releaseBitcoinNetworkFee: 10n,
    requestedReleaseAtTick: 123,
  });
  const state = {
    releaseCosignOnChain: undefined as { blockHeight: number; signature: Uint8Array } | undefined,
    txFailure: args?.txFailure,
    waitForInFirstBlock: args?.waitForInFirstBlock ?? Promise.resolve('0x1234'),
  };

  const setReleaseCosign = vi.fn<(...args: any[]) => Promise<void>>().mockImplementation(async (record, update) => {
    Object.assign(record, update);
  });
  const ensureLockReleaseProcessing = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
  const ownerCosignAndSendToBitcoin = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
  const cosignMyLock = vi.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
    txInfo: {
      txResult: {
        waitForInFirstBlock: state.waitForInFirstBlock,
      },
    },
  });

  const utxoTracking = {
    isReleaseStatus: vi.fn((status: BitcoinUtxoStatus | undefined) => {
      return [
        BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
        BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
        BitcoinUtxoStatus.ReleaseComplete,
      ].includes(status as BitcoinUtxoStatus);
    }),
    isReleaseCompleteStatus: vi.fn((status: BitcoinUtxoStatus | undefined) => {
      return status === BitcoinUtxoStatus.ReleaseComplete;
    }),
    isFundingRecordReleaseProcessingOnBitcoin: vi.fn((record: IBitcoinUtxoRecord) => {
      return record.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    }),
    hasFundingRecordReleaseRequestDetails: vi.fn((record: IBitcoinUtxoRecord) => {
      return !!record.releaseToDestinationAddress && record.releaseBitcoinNetworkFee != null;
    }),
    canSubmitFundingRecordReleaseToBitcoin: vi.fn((record: IBitcoinUtxoRecord) => {
      return (
        !record.releaseTxid &&
        !!record.releaseToDestinationAddress &&
        record.releaseBitcoinNetworkFee != null &&
        !!record.releaseCosignVaultSignature &&
        record.releaseCosignHeight != null
      );
    }),
    getAcceptedFundingRecordForLock: vi.fn().mockReturnValue(fundingRecord),
    setReleaseCosign,
    clearStatusError: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
    updateReleaseLastConfirmationCheck: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
    setStatusError: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
  };

  const store = createStoreStub({
    utxoTracking,
    myVault: {
      vaultId: 1,
      cosignMyLock,
    },
    reconcileMismatchReturnOnBlock: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
    getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
    getReleaseCosignOnChain: vi.fn(async () => state.releaseCosignOnChain),
    getTxFailureMessage: vi.fn(() => state.txFailure),
    ensureLockReleaseProcessing,
    syncLockReleaseStatusFromFundingRecord: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
    syncLockReleaseArgonRequest: vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined),
    syncLockReleaseBitcoinComplete: vi.fn<(...args: any[]) => Promise<boolean>>().mockResolvedValue(false),
    ownerCosignAndSendToBitcoin,
  });

  return {
    lock,
    fundingRecord,
    state,
    store,
    setReleaseCosign,
    ensureLockReleaseProcessing,
    ownerCosignAndSendToBitcoin,
    cosignMyLock,
  };
}

function createFundingRecord(overrides: Partial<IBitcoinUtxoRecord>): IBitcoinUtxoRecord {
  return overrides as IBitcoinUtxoRecord;
}

function createArgonClientStub(): ArgonClient {
  return Object.assign(Object.create(null), {
    query: Object.create(null),
  }) as ArgonClient;
}

function createLockDetails(): IBitcoinLockRecord['lockDetails'] {
  return {
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    createdAtHeight: 100,
    vaultClaimHeight: 200,
  } as IBitcoinLockRecord['lockDetails'];
}

function createLockRecord(overrides: Partial<IBitcoinLockRecord>): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock',
    utxoId: overrides.utxoId,
    status: overrides.status ?? BitcoinLockStatus.LockPendingFunding,
    satoshis: overrides.satoshis ?? 10_000n,
    liquidityPromised: overrides.liquidityPromised ?? 0n,
    lockedMarketRate: overrides.lockedMarketRate ?? 0n,
    ratchets: overrides.ratchets ?? [],
    cosignVersion: overrides.cosignVersion ?? 'v1',
    lockDetails: overrides.lockDetails ?? createLockDetails(),
    fundingUtxoRecordId: overrides.fundingUtxoRecordId ?? null,
    fundingUtxoRecord: overrides.fundingUtxoRecord,
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}
