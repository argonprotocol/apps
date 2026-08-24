import { describe, expect, it, vi } from 'vitest';
import { createDeferred, StorageFinder, TransactionEvents, type BlockWatch } from '@argonprotocol/apps-core';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { BitcoinLock, hexToU8a } from '@argonprotocol/mainchain';
import { historicalEventChanges } from '../../indexer/src/HistoricalEventSpecs.generated.ts';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { getBitcoinAlertNotices } from '../lib/Alerts.ts';
import { BitcoinFinancials } from '../lib/financials/BitcoinLocks.ts';
import { createTestDb } from './helpers/db.ts';
import { bitcoinRecoveryEventPolicies } from '../lib/recovery/BitcoinLocks.ts';
import * as BitcoinLockHistory from '../lib/recovery/BitcoinLockHistory.ts';
import { createLock, createStore, createHistoricalLock, historyBlock, historyEvent } from './helpers/bitcoin.ts';
import { nextTick, reactive, watchEffect } from 'vue';

vi.mock('../lib/recovery/BitcoinLockHistory.ts', () => ({
  getHistoricalBitcoinLock: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

describe('BitcoinLocks recovery', () => {
  it('assigns every copied Bitcoin lock event an explicit replay policy', () => {
    const historicalMethods = new Set(
      historicalEventChanges.filter(change => change.section === 'bitcoinLocks').map(change => change.method),
    );

    expect(Object.keys(bitcoinRecoveryEventPolicies).sort()).toEqual([...historicalMethods].sort());
  });

  it('recognizes and clears recovery flags restored from the database', async () => {
    const store = createStore();
    store.data = reactive(store.data) as BitcoinLocks['data'];
    const lock = createLock({
      uuid: 'loaded-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const pendingLock = createLock({
      uuid: 'loaded-pending-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-02T00:00:00Z',
    });
    lock.isHistoryRecoveryPending = true;
    pendingLock.isHistoryRecoveryPending = true;
    store.data.locksByUtxoId[7] = lock;
    store.data.pendingLocks.push(pendingLock);
    const setHistoryRecoveryPending = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({ setHistoryRecoveryPending } as never);
    const observedPendingFlags: boolean[] = [];
    const stopWatching = watchEffect(() => {
      observedPendingFlags.push(Boolean(store.data.locksByUtxoId[7]?.isHistoryRecoveryPending));
    });

    expect(store.recovery.hasPendingHistoryRecovery).toBe(true);

    await store.recovery.beginHistoryReplay();
    await store.recovery.commitHistoryReplay();

    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(lock.uuid, false);
    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(pendingLock.uuid, false);
    expect(lock.isHistoryRecoveryPending).toBeUndefined();
    expect(pendingLock.isHistoryRecoveryPending).toBeUndefined();
    expect(store.recovery.hasPendingHistoryRecovery).toBe(false);
    await nextTick();
    expect(observedPendingFlags.at(-1)).toBe(false);
    stopWatching();
  });

  it('releases held lock work when replay ends incomplete', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'replay-queue-gate',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 1_000n,
        mintPending: 1_000n,
        lockedTargetPrice: 1_000n,
        blockHeight: 151,
        burned: 0n,
        securityFee: 20n,
        txFee: 11n,
        oracleBitcoinBlockHeight: 500,
      },
    ];
    store.data.locksByUtxoId[7] = record;

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    let didRun = false;
    const queuedWork = store.runInQueueForUtxo(
      record,
      30e3,
      async () => {
        didRun = true;
      },
      { waitForHistoryRecovery: true },
    );
    await nextTick();

    expect(didRun).toBe(false);
    expect(record.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.commitHistoryReplay(false);
    await queuedWork;

    expect(didRun).toBe(true);
  });

  it('gates later work when replay starts inside the lock queue', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'replay-queue-owner',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByUtxoId[7] = record;
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
    } as never);

    await store.recovery.beginHistoryReplay();
    await store.runInQueueForUtxo(record, 30e3, async () => {
      await store.recovery.recoverLock({
        lock: { utxoId: 7 } as BitcoinLock,
        createdAtArgonBlockHeight: 1,
        finalFee: 0n,
        lockQueueOwnerUuid: record.uuid,
      });
    });

    let didRun = false;
    const queuedWork = store.runInQueueForUtxo(
      record,
      30e3,
      async () => {
        didRun = true;
      },
      { waitForHistoryRecovery: true },
    );
    await nextTick();

    expect(didRun).toBe(false);

    await store.recovery.cancelHistoryReplay();
    await queuedWork;

    expect(didRun).toBe(true);
  });

  it('replays each orphan UTXO through request and vault cosign history', async () => {
    const db = await createTestDb();
    const lock = createLock({
      uuid: 'orphan-history',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const utxoRef = { txid: `0x${'44'.repeat(32)}`, outputIndex: 2 };
    const api = {
      query: {
        ticks: { currentTick: vi.fn(async () => numberCodec(700)) },
        bitcoinLocks: {
          orphanedUtxosByAccount: vi.fn(async () =>
            optionCodec({
              utxoId: numberCodec(7),
              satoshis: bigintCodec(12_000n),
              cosignRequest: optionCodec({
                toScriptPubkey: new Uint8Array([0, 20, 1, 2, 3]),
                bitcoinNetworkFee: bigintCodec(120n),
              }),
            }),
          ),
        },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      db,
    });
    store.data.locksByUtxoId[7] = lock;

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(201), [
      historyEvent(147, 'bitcoinLocks', 'OrphanedUtxoReceived', {
        utxoId: 7,
        utxoRef,
        vaultId: 1,
        satoshis: 12_000n,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(202), [
      historyEvent(147, 'bitcoinLocks', 'OrphanedUtxoReleaseRequested', {
        utxoId: 7,
        utxoRef,
        vaultId: 1,
        accountId: lock.lockDetails.ownerAccount,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(203), [
      historyEvent(145, 'bitcoinLocks', 'OrphanedUtxoCosigned', {
        utxoId: 7,
        utxoRef,
        vaultId: 1,
        signature: '0x010203',
      }),
    ]);

    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([]);
    expect(store.utxoTracking.getUtxosForLock(lock)).toEqual([]);

    await store.recovery.commitHistoryReplay();

    expect(store.utxoTracking.getUtxosForLock(lock)).toEqual([
      expect.objectContaining({
        txid: utxoRef.txid,
        vout: utxoRef.outputIndex,
        satoshis: 12_000n,
        status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
        releaseToDestinationAddress: '0014010203',
        releaseBitcoinNetworkFee: 120n,
        releaseCosignVaultSignature: hexToU8a('0x010203'),
        releaseCosignHeight: 203,
      }),
    ]);
  });

  it('publishes a rediscovered orphan after current-state reconciliation', async () => {
    const db = await createTestDb();
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      db,
    });
    const lock = createLock({
      uuid: 'late-orphan',
      utxoId: 7,
      status: BitcoinLockStatus.Released,
      createdAt: '2026-01-01T00:00:00Z',
    });
    lock.removalReason = 'released';
    const utxoRef = { txid: `0x${'55'.repeat(32)}`, outputIndex: 1 };
    store.data.locksByUtxoId[7] = lock;
    const releaseReconciliation = createDeferred<void>();
    vi.spyOn(store.orphanReleases, 'reconcileOrphanReturns').mockImplementation(async () => {
      await releaseReconciliation.promise;
      const orphan = store.utxoTracking.getUtxosForLock(lock)[0];
      await store.utxoTracking.setReleaseComplete(orphan);
    });

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(201), [
      historyEvent(147, 'bitcoinLocks', 'OrphanedUtxoReceived', {
        utxoId: 7,
        utxoRef,
        vaultId: 1,
        satoshis: 12_000n,
      }),
    ]);
    expect(store.recovery.hasPendingHistoryRecovery).toBe(true);

    await store.recovery.commitHistoryReplay();

    expect(store.data.isReconciliationPending).toBe(true);
    expect(store.utxoTracking.getUnresolvedOrphanRecords([lock])).toHaveLength(1);

    releaseReconciliation.resolve();
    await vi.waitFor(() => expect(store.data.isReconciliationPending).toBe(false));

    expect(lock.isHistoryRecoveryPending).toBeUndefined();
    expect(store.getLockByUtxoId(7)).toBe(lock);
    expect(store.utxoTracking.getAllOrphanLifecycleUtxos()).toEqual([
      expect.objectContaining({
        txid: utxoRef.txid,
        vout: utxoRef.outputIndex,
        satoshis: 12_000n,
        status: BitcoinUtxoStatus.ReleaseComplete,
      }),
    ]);
    expect(store.utxoTracking.getUnresolvedOrphanRecords([lock])).toEqual([]);
  });

  it('quarantines recovering locks from actions while keeping their current values visible', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'interim-release',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndIsMinting,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 80n,
        mintPending: 10n,
        lockedTargetPrice: 100n,
        securityFee: 2n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 10,
        oracleBitcoinBlockHeight: 100,
      },
    ];
    record.fundingUtxoRecord = {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      statusError: 'PSBT finalize error',
    } as never;
    record.isHistoryRecoveryPending = true;
    store.data.locksByUtxoId[7] = record;
    expect(getBitcoinAlertNotices(store)).toEqual([]);

    const regularRecord = createLock({
      uuid: 'regular-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-02-01T00:00:00Z',
    });
    store.data.locksByUtxoId[8] = regularRecord;
    vi.spyOn(store, 'getMismatchViewState').mockReturnValue({
      phase: 'review',
      candidateCount: 1,
      isFundingExpired: false,
    } as never);

    expect(getBitcoinAlertNotices(store).map(alert => alert.lock)).toEqual([regularRecord]);

    vi.spyOn(store, 'getTable').mockResolvedValue({ setStatus: vi.fn() } as never);

    expect(store.getActiveLocks()).toEqual([regularRecord]);
    expect(store.getAllLocks()).toEqual([regularRecord]);
    expect(store.getAllLocks({ includeHistoryRecoveryPending: true })).toEqual([regularRecord, record]);
    expect(store.getLockByUtxoId(7)).toBeUndefined();
    expect(store.getLockByUtxoId(8)).toBe(regularRecord);
    await expect(store.acknowledgeFailed(record)).rejects.toThrow('Bitcoin history recovery is still in progress');

    const releasingRecord = { status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin } as never;
    await store.syncLockReleaseStatusFromFundingRecord(record, releasingRecord);

    expect(record.status).toBe(BitcoinLockStatus.LockedAndIsMinting);

    vi.spyOn(store, 'load').mockResolvedValue();
    const recoverySummary = {
      uuid: record.uuid,
      record,
      status: record.status,
      satoshis: record.satoshis,
      valueOfBtc: 100n,
      startingCapital: 80n,
      endingCapital: 88n,
      pendingLiquidity: 10n,
      receivedLiquidity: 70n,
      totalFees: 2n,
      unlockAmount: 60n,
    } as ReturnType<typeof store.createLockSummary>;
    const regularSummary = {
      uuid: regularRecord.uuid,
      record: regularRecord,
      status: regularRecord.status,
      satoshis: regularRecord.satoshis,
      valueOfBtc: 0n,
      startingCapital: 0n,
      endingCapital: 0n,
      pendingLiquidity: 0n,
      receivedLiquidity: 0n,
      totalFees: 0n,
      unlockAmount: 0n,
    } as ReturnType<typeof store.createLockSummary>;
    const createLockSummaryAt = vi
      .spyOn(store, 'createLockSummaryAt')
      .mockImplementation(async lock => (lock === record ? recoverySummary : regularSummary));
    const financials = await new BitcoinFinancials(store).loadSnapshot({
      clientAt: Object.create(null),
      hasCurrentPrice: true,
    });

    expect(createLockSummaryAt).toHaveBeenCalledTimes(2);
    expect(financials.summaries).toEqual([regularSummary, recoverySummary]);

    delete record.isHistoryRecoveryPending;
    expect(store.getAllLocks()).toEqual([regularRecord, record]);
  });

  it('resumes an in-flight release that has already left the active chain index', async () => {
    const store = createStore({
      blockWatch: { getFinalizedApi: vi.fn(async () => ({})) } as never,
    });
    const releasingLock = createLock({
      uuid: 'releasing-lock',
      utxoId: 7,
      status: BitcoinLockStatus.Releasing,
      createdAt: '2026-01-01T00:00:00Z',
    });
    releasingLock.fundingUtxoRecord = {
      id: 1,
      lockUtxoId: 7,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    } as never;
    const activeLock = createLock({
      uuid: 'active-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-02-01T00:00:00Z',
    });
    activeLock.ratchets = [
      {
        mintAmount: activeLock.liquidityPromised,
        mintPending: 0n,
        lockedTargetPrice: activeLock.lockedTargetPrice,
        securityFee: 0n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 10,
        oracleBitcoinBlockHeight: 100,
      },
    ];
    store.data.locksByUtxoId[7] = releasingLock;
    store.data.locksByUtxoId[8] = activeLock;

    const saveRecoveredHistory = vi.fn(async () => undefined);
    const getByUtxoId = vi.fn(async utxoId => store.data.locksByUtxoId[utxoId]);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId,
      saveRecoveredHistory,
    } as never);
    vi.spyOn(store as any, 'runPendingLoadReconciliation').mockResolvedValue(undefined);
    vi.spyOn(store.recovery, 'findActiveLockIds').mockResolvedValue([8]);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue({
      utxoId: 8,
      createdAtArgonBlock: 10,
      liquidityPromised: activeLock.liquidityPromised,
      lockedTargetPrice: activeLock.lockedTargetPrice,
    } as BitcoinLock);
    vi.spyOn(store, 'unlockDeadlineTime').mockReturnValue(Date.now() + 60_000);

    await store.recovery.recoverActiveLocks();
    expect(releasingLock.status).toBe(BitcoinLockStatus.Releasing);
    expect(releasingLock.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    expect(releasingLock.isHistoryRecoveryPending).toBeUndefined();
    getByUtxoId.mockResolvedValue({
      ...releasingLock,
      status: BitcoinLockStatus.LockedAndMinted,
      ratchets: [],
    });
    await store.recovery.recoverLock({
      lock: { utxoId: 7 } as BitcoinLock,
      createdAtArgonBlockHeight: 1,
      finalFee: 0n,
    });
    await store.recovery.commitHistoryReplay(false);

    expect(activeLock.isHistoryRecoveryPending).toBeUndefined();
    expect(releasingLock.isHistoryRecoveryPending).toBeUndefined();
    expect(releasingLock.status).toBe(BitcoinLockStatus.Releasing);
    expect(store.getActiveLocks()).toEqual([activeLock, releasingLock]);
  });

  it('leaves an unresolved release unchanged when active recovery cannot advance it', async () => {
    const store = createStore({
      blockWatch: { getFinalizedApi: vi.fn(async () => ({})) } as never,
    });
    const unresolvedRelease = createLock({
      uuid: 'unresolved-release',
      utxoId: 7,
      status: BitcoinLockStatus.Releasing,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByUtxoId[7] = unresolvedRelease;

    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => undefined),
    } as never);
    vi.spyOn(store.recovery, 'findActiveLockIds').mockResolvedValue([]);

    await store.recovery.recoverActiveLocks();

    expect(unresolvedRelease.status).toBe(BitcoinLockStatus.Releasing);
    expect(unresolvedRelease.isHistoryRecoveryPending).toBeUndefined();
    expect(store.getActiveLocks()).toEqual([unresolvedRelease]);
    expect(store.recovery.hasPendingHistoryRecovery).toBe(false);
  });

  it('repairs pending locks without replaying healthy locks', async () => {
    const blockWatch = Object.assign(Object.create(null), {
      getApi: async () => ({}),
    }) as BlockWatch;
    const store = createStore({ blockWatch });
    const pendingRecord = createLock({
      uuid: 'pending-recovery',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    pendingRecord.isHistoryRecoveryPending = true;
    const healthyRecord = createLock({
      uuid: 'healthy-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-02T00:00:00Z',
    });
    store.data.locksByUtxoId[7] = pendingRecord;
    store.data.locksByUtxoId[8] = healthyRecord;
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async utxoId => store.data.locksByUtxoId[utxoId]),
      saveRecoveredHistory: vi.fn(async () => undefined),
      setHistoryRecoveryPending: vi.fn(),
    } as never);

    await store.recovery.beginHistoryReplay({ lockScope: 'pending' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(151, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 7, vaultId: 1 }),
      historyEvent(151, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 8, vaultId: 1 }),
    ]);
    await store.recovery.commitHistoryReplay();

    expect(pendingRecord.removalReason).toBe('released');
    expect(healthyRecord.removalReason).toBeUndefined();
    expect(healthyRecord.isHistoryRecoveryPending).toBeUndefined();
  });

  it('shares concurrent active-lock recovery so one UTXO cannot create multiple rows', async () => {
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => ({})),
      } as never,
    });
    const record = createLock({
      uuid: 'chain-recovery',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const chainLock = { utxoId: 7, createdAtArgonBlock: 10 } as BitcoinLock;
    let finishRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => {
      finishRecovery = resolve;
    });
    vi.spyOn(store.recovery, 'findActiveLockIds').mockResolvedValue([7]);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue(chainLock);
    const recoverLock = vi.spyOn(store.recovery, 'recoverLock').mockImplementation(async () => {
      await recoveryGate;
      return record;
    });

    const firstRecovery = store.recovery.recoverActiveLocks();
    const concurrentRecovery = store.recovery.recoverActiveLocks();

    expect(concurrentRecovery).toBe(firstRecovery);
    await vi.waitFor(() => expect(recoverLock).toHaveBeenCalledOnce());
    finishRecovery();
    await expect(firstRecovery).resolves.toEqual([record]);
    await expect(concurrentRecovery).resolves.toEqual([record]);
    expect(recoverLock).toHaveBeenCalledOnce();
  });

  it('keeps successful active locks usable while retrying a transient per-lock failure', async () => {
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => ({})),
      } as never,
    });
    const retriedRecord = createLock({
      uuid: 'recovered-on-retry',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const recoveredRecord = createLock({
      uuid: 'recovered-after-failure',
      utxoId: 8,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const retriedChainLock = { utxoId: 7, createdAtArgonBlock: 10 } as BitcoinLock;
    const recoveredChainLock = { utxoId: 8, createdAtArgonBlock: 20 } as BitcoinLock;
    const ratchet = {
      mintAmount: 0n,
      mintPending: 0n,
      lockedTargetPrice: 0n,
      securityFee: 0n,
      txFee: 0n,
      burned: 0n,
      blockHeight: 0,
      oracleBitcoinBlockHeight: 0,
    };
    retriedRecord.ratchets = [{ ...ratchet, blockHeight: 10 }];
    recoveredRecord.ratchets = [{ ...ratchet, blockHeight: 20 }];
    vi.spyOn(store.recovery, 'findActiveLockIds').mockResolvedValue([7, 8]);
    vi.spyOn(BitcoinLock, 'get')
      .mockRejectedValueOnce(new Error('lock 7 unavailable'))
      .mockResolvedValueOnce(recoveredChainLock)
      .mockResolvedValueOnce(retriedChainLock)
      .mockResolvedValueOnce(recoveredChainLock);
    vi.spyOn(store.recovery, 'recoverLock').mockImplementation(async ({ lock }) => {
      return lock.utxoId === 7 ? retriedRecord : recoveredRecord;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(store.recovery.recoverActiveLocks({ requireComplete: true })).rejects.toThrow(
      'Active Bitcoin lock recovery is incomplete.',
    );
    expect(store.recovery.hasPendingHistoryRecovery).toBe(true);

    await expect(store.recovery.recoverActiveLocks()).resolves.toEqual([recoveredRecord, retriedRecord]);
    expect(store.recovery.hasPendingHistoryRecovery).toBe(false);
  });

  it('rebuilds an incomplete active lock from canonical state', async () => {
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => ({})),
      } as never,
    });
    const record = createLock({
      uuid: 'complete-active-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.isHistoryRecoveryPending = true;
    record.liquidityPromised = 500n;
    record.lockedTargetPrice = 1_000n;
    record.ratchets = [];
    store.data.locksByUtxoId[7] = record;
    const chainLock = {
      utxoId: 7,
      createdAtArgonBlock: 10,
      liquidityPromised: 500n,
      lockedTargetPrice: 1_000n,
    } as BitcoinLock;
    const setHistoryRecoveryPending = vi.fn(async () => undefined);
    const saveRecoveredHistory = vi.fn(async () => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory,
      setHistoryRecoveryPending,
    } as never);
    vi.spyOn(store.recovery, 'findActiveLockIds').mockResolvedValue([7]);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue(chainLock);

    expect(store.getLockByUtxoId(7)).toBeUndefined();

    await store.recovery.recoverActiveLocks();

    expect(saveRecoveredHistory).toHaveBeenCalledOnce();
    expect(setHistoryRecoveryPending).toHaveBeenCalledWith(record.uuid, false);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(store.getLockByUtxoId(7)).toBe(record);
    expect(record.ratchets).toEqual([
      expect.objectContaining({
        liquidityPromised: 500n,
        lockedTargetPrice: 1_000n,
      }),
    ]);
  });

  it('recovers a migrated lock creation from full history and preserves its known fee', async () => {
    const api = {};
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => api),
      } as never,
    });
    const record = createLock({
      uuid: 'known-creation-fee',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.ratchets = [
      {
        mintAmount: 500n,
        mintPending: 0n,
        burned: 0n,
        securityFee: 0n,
        txFee: 21n,
        lockedTargetPrice: 1_000n,
        blockHeight: 10,
        oracleBitcoinBlockHeight: 100,
      },
    ];
    store.data.locksByUtxoId[7] = record;
    const saveRecoveredHistory = vi.fn(async () => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async () => record),
      saveRecoveredHistory,
    } as never);
    vi.spyOn(store.recovery, 'findActiveLockIds').mockResolvedValue([7]);
    vi.spyOn(BitcoinLock, 'get').mockResolvedValue({
      utxoId: 7,
      createdAtArgonBlock: 0,
      ownerAccount: record.lockDetails.ownerAccount,
    } as BitcoinLock);
    const binarySearchForStorageAddition = vi.spyOn(StorageFinder, 'binarySearchForStorageAddition').mockResolvedValue({
      blockNumber: 3,
      blockHash: new Uint8Array([3]),
    } as never);
    vi.spyOn(TransactionEvents, 'findFromFeePaidEvent').mockResolvedValue(undefined);

    const mainchainClients = {
      archiveClientPromise: Promise.resolve({
        query: { bitcoinLocks: { locksByUtxoId: { key: vi.fn(() => 'lock-key') } } },
        events: { bitcoinLocks: { BitcoinLockCreated: { is: vi.fn(() => false) } } },
      }),
    } as never;

    await store.recovery.recoverActiveLockCreationDetails(mainchainClients);

    expect(saveRecoveredHistory).toHaveBeenCalledOnce();
    expect(record.ratchets[0].blockHeight).toBe(3);
    expect(record.ratchets[0].txFee).toBe(21n);
    expect(binarySearchForStorageAddition).toHaveBeenCalledWith(mainchainClients, 'lock-key', 0);
  });

  it('keeps recovered expired locks retired during a full history replay', async () => {
    const db = await createTestDb();
    const chainLock = new BitcoinLock(
      createHistoricalLock({
        accountId: encodeAddress(new Uint8Array(32).fill(0x33)),
        liquidityPromised: 1_000n,
      }),
    );
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'expired-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: chainLock,
      createdAtArgonBlockHeight: 100,
      finalFee: 0n,
    });
    record.status = BitcoinLockStatus.LockPendingFunding;
    record.removalReason = 'expired';
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const store = createStore({ db });
    store.data.locksByUtxoId[7] = record;

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverLock({
      lock: chainLock,
      createdAtArgonBlockHeight: 100,
      finalFee: 0n,
    });

    expect(record.isHistoryRecoveryPending).toBe(false);

    await store.recovery.commitHistoryReplay();

    expect(store.getActiveLocks()).toEqual([]);
    expect(store.getAllLocks()).toEqual([record]);
    expect(store.getLockByUtxoId(7)).toBe(record);
    expect(record.isHistoryRecoveryPending).toBe(false);
    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.isHistoryRecoveryPending).toBe(false);

    await store.syncLockReleaseStatusFromFundingRecord(record, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
    } as never);

    expect(record.status).toBe(BitcoinLockStatus.LockPendingFunding);
  });
});

describe('BitcoinLocks history replay publication', () => {
  it('restores missing creation history while preserving later ratchets across restart', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const creationLock = new BitcoinLock(
      createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }),
    );
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'unknown-creation-height',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: creationLock,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    record.status = BitcoinLockStatus.LockedAndMinted;
    record.ratchets[0].mintPending = 0n;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const blockWatch = { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch;
    const walletKeys = { defaultArgonAddress: accountId } as WalletKeys;
    const store = createStore({ db, blockWatch, walletKeys });
    store.data.locksByUtxoId[7] = record;
    const currentLock = new BitcoinLock({
      ...createHistoricalLock({ accountId, liquidityPromised: 1_400n, lockedTargetPrice: 1_500n }),
      createdAtArgonBlock: 0,
    });

    await store.recovery.recoverLock({
      lock: currentLock,
      createdAtArgonBlockHeight: 0,
      finalFee: 0n,
    });

    const provisional = (await db.bitcoinLocksTable.getByUtxoId(7))!;
    expect(provisional.ratchets).toEqual([expect.objectContaining({ blockHeight: 0 })]);
    delete provisional.ratchets[0].liquidityPromised;
    provisional.ratchets.push({
      ...provisional.ratchets[0],
      blockHeight: 200,
      mintAmount: 400n,
      mintPending: 0n,
      liquidityPromised: 1_400n,
      lockedTargetPrice: 1_500n,
    });
    await db.bitcoinLocksTable.saveRecoveredHistory(provisional);
    store.data.locksByUtxoId[7] = provisional;

    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(creationLock);
    const creationBlock = historyBlock(151);
    const creationEvents = [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
    ];

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(creationBlock, creationEvents);
    await store.recovery.commitHistoryReplay();

    const durable = await db.bitcoinLocksTable.getByUtxoId(7);
    expect(durable?.ratchets).toEqual([
      expect.objectContaining({
        blockHeight: 151,
        mintAmount: 1_000n,
        lockedTargetPrice: 1_000n,
      }),
      expect.objectContaining({
        blockHeight: 200,
        mintAmount: 400n,
        liquidityPromised: 1_400n,
        lockedTargetPrice: 1_500n,
      }),
    ]);
    expect(durable?.ratchets[0].liquidityPromised).toBeUndefined();
    expect(store.getLockByUtxoId(7)?.ratchets).toEqual(durable?.ratchets);

    const restartedStore = createStore({ db, blockWatch, walletKeys });
    for (const persisted of await db.bitcoinLocksTable.fetchAll()) {
      if (persisted.utxoId !== undefined) restartedStore.data.locksByUtxoId[persisted.utxoId] = persisted;
    }

    await restartedStore.recovery.beginHistoryReplay({ lockScope: 'all' });
    await restartedStore.recovery.recoverBlock(creationBlock, creationEvents);
    await restartedStore.recovery.commitHistoryReplay();

    expect(restartedStore.getLockByUtxoId(7)?.ratchets).toEqual((await db.bitcoinLocksTable.getByUtxoId(7))?.ratchets);
  });

  it('keeps Bitcoin alerts stable while history replay is uncommitted or discarded', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'settled-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockedAndMinted,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByUtxoId[7] = record;
    vi.spyOn(store, 'getMismatchViewState').mockReturnValue({ phase: 'review' } as never);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByUtxoId: vi.fn(async utxoId => (utxoId === 7 ? record : undefined)),
    } as never);
    const alertsBeforeReplay = getBitcoinAlertNotices(store).map(alert => alert.lock.uuid);

    await store.recovery.beginHistoryReplay();
    await store.recovery.recoverLock({
      lock: { utxoId: 7 } as BitcoinLock,
      createdAtArgonBlockHeight: 1,
      finalFee: 0n,
    });

    expect(record.status).toBe(BitcoinLockStatus.LockedAndMinted);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(store.getAllLocks()).toEqual([record]);
    expect(getBitcoinAlertNotices(store).map(alert => alert.lock.uuid)).toEqual(alertsBeforeReplay);

    await store.recovery.commitHistoryReplay(false);

    expect(record.status).toBe(BitcoinLockStatus.LockedAndMinted);
    expect(store.getAllLocks()).toEqual([record]);
    expect(getBitcoinAlertNotices(store).map(alert => alert.lock.uuid)).toEqual(alertsBeforeReplay);
  });

  it('discards every staged history mutation when replay fails', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const lockDetails = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'failed-shadow-replay',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: lockDetails,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    record.status = BitcoinLockStatus.LockedAndMinted;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    const recoveredLockDetails = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    recoveredLockDetails.utxoId = 8;
    recoveredLockDetails.ownerPubkey = `0x${recoveredLockDetails.ownerPubkey}`;
    vi.spyOn(store, 'getDerivedPubkey').mockResolvedValue({
      address: 'tb1qhistory',
      hdIndex: 3,
      hdPath: "m/84'/0'/0'/3",
      ownerBitcoinPubkey: hexToU8a(`02${'33'.repeat(32)}`),
    } as Awaited<ReturnType<BitcoinLocks['getDerivedPubkey']>>);
    const utxoRef = { txid: `0x${'44'.repeat(32)}`, outputIndex: 2 };

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 7, vaultId: 1 }),
      historyEvent(157, 'bitcoinLocks', 'OrphanedUtxoReceived', {
        utxoId: 7,
        utxoRef,
        vaultId: 1,
        satoshis: 12_000n,
      }),
    ]);
    await store.recovery.recoverLock({
      lock: new BitcoinLock(recoveredLockDetails),
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    await store.recovery.commitHistoryReplay(false);

    const durable = await db.bitcoinLocksTable.getByUtxoId(7);
    expect(durable?.status).toBe(BitcoinLockStatus.LockedAndMinted);
    expect(durable?.removalReason ?? undefined).toBeUndefined();
    expect(Boolean(durable?.isHistoryRecoveryPending)).toBe(false);
    expect(await db.bitcoinLocksTable.getByUtxoId(8)).toBeUndefined();
    expect(
      await db.walletHdKeysTable.fetchByScope({
        keyRole: 'bitcoinLock',
        scopeKey: '1',
      }),
    ).toEqual([]);
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([]);
    expect(store.utxoTracking.getUtxosForLock(record)).toEqual([]);
  });

  it('uses persisted transaction identity when recovered lock and HD key records commit', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const lockDetails = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    lockDetails.ownerPubkey = `0x${lockDetails.ownerPubkey}`;
    const lock = new BitcoinLock(lockDetails);
    await db.transactionsTable.insert({
      extrinsicHash: `0x${'11'.repeat(32)}`,
      extrinsicMethodJson: { section: 'bitcoinLocks', method: 'initialize' },
      extrinsicType: ExtrinsicType.BitcoinRequestLock,
      metadataJson: {
        bitcoin: {
          uuid: 'out-of-order-history-lock',
          vaultId: 1,
          satoshis: 10_000n,
          hdPath: "m/84'/0'/0'/3",
          lockedTargetPrice: 1_000n,
          liquidityPromised: 1_000n,
          securityFee: 11n,
        },
      },
      accountAddress: accountId,
      submittedAtBlockHeight: 150,
      submittedAtTime: new Date('2026-01-01T00:00:00Z'),
      txNonce: 1,
    });
    const store = createStore({
      db,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.spyOn(store, 'getDerivedPubkey').mockResolvedValue({
      address: 'tb1qhistory',
      hdIndex: 3,
      hdPath: "m/84'/0'/0'/3",
      ownerBitcoinPubkey: hexToU8a(`02${'33'.repeat(32)}`),
    } as Awaited<ReturnType<BitcoinLocks['getDerivedPubkey']>>);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverLock({
      lock,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });

    expect(await db.bitcoinLocksTable.getByUtxoId(7)).toBeUndefined();
    expect(await db.bitcoinLocksTable.fetchAll()).toEqual([]);
    expect(await db.walletHdKeysTable.fetchByScope({ keyRole: 'bitcoinLock', scopeKey: '1' })).toEqual([]);

    await store.recovery.commitHistoryReplay();

    const recoveredLocks = await db.bitcoinLocksTable.fetchAll();
    expect(recoveredLocks).toHaveLength(1);
    expect(recoveredLocks[0]).toEqual(
      expect.objectContaining({
        uuid: 'out-of-order-history-lock',
        utxoId: 7,
        status: BitcoinLockStatus.LockPendingFunding,
        hdPath: "m/84'/0'/0'/3",
      }),
    );
    expect(await db.walletHdKeysTable.fetchByScope({ keyRole: 'bitcoinLock', scopeKey: '1' })).toEqual([
      expect.objectContaining({
        hdIndex: 3,
        hdPath: "m/84'/0'/0'/3",
      }),
    ]);
  });

  it('leaves a partially saved lock retryable and publishes the remaining recovered locks', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'successful-shadow-replay',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: initialLock,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    record.status = BitcoinLockStatus.LockedAndMinted;
    record.ratchets[0].mintPending = 0n;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const initialLock8 = new BitcoinLock({
      ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
      utxoId: 8,
    });
    const pending8 = await db.bitcoinLocksTable.insertPending({
      uuid: 'successful-second-replay',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'/1",
      vaultId: 1,
    });
    const record8 = await db.bitcoinLocksTable.finalizePending({
      uuid: pending8.uuid,
      lock: initialLock8,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    record8.status = BitcoinLockStatus.LockedAndMinted;
    record8.ratchets[0].mintPending = 0n;
    await db.bitcoinLocksTable.saveRecoveredHistory(record8);

    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    store.data.locksByUtxoId[8] = record8;
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockImplementation(async (_api, utxoId) => {
      return new BitcoinLock({
        ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
        utxoId,
        isFlexible: true,
      });
    });
    const block = historyBlock(200);
    const replayEvents = [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 7,
        vaultId: 1,
        isBackfill: true,
      }),
      historyEvent(157, 'bitcoinLocks', 'OrphanedUtxoReceived', {
        utxoId: 7,
        utxoRef: { txid: `0x${'44'.repeat(32)}`, outputIndex: 2 },
        vaultId: 1,
        satoshis: 12_000n,
      }),
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 8,
        vaultId: 1,
        isBackfill: true,
      }),
    ];

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(block, replayEvents);

    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.lockDetails.isFlexible).toBe(false);
    expect(record.lockDetails.isFlexible).toBe(false);

    vi.spyOn(db.bitcoinUtxosTable, 'insert').mockRejectedValueOnce(new Error('temporary UTXO write failure'));
    await expect(store.recovery.commitHistoryReplay()).rejects.toThrow('temporary UTXO write failure');

    expect(record.lockDetails.isFlexible).toBe(false);
    expect(record.isHistoryRecoveryPending).toBe(false);
    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.lockDetails.isFlexible).toBe(true);
    expect(record8.lockDetails.isFlexible).toBe(true);
    expect((await db.bitcoinLocksTable.getByUtxoId(8))?.lockDetails.isFlexible).toBe(true);
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([]);

    await store.recovery.cancelHistoryReplay();

    expect(record.lockDetails.isFlexible).toBe(false);
    expect(record.isHistoryRecoveryPending).toBe(false);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(block, replayEvents);

    await store.recovery.commitHistoryReplay();

    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.lockDetails.isFlexible).toBe(true);
    expect(record.lockDetails.isFlexible).toBe(true);
    expect(record.isHistoryRecoveryPending).toBe(false);
  });

  it('preserves newer live operational state when history replay commits', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'concurrent-live-state',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: initialLock,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    record.status = BitcoinLockStatus.LockedAndMinted;
    record.ratchets[0].mintPending = 0n;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(
      new BitcoinLock({ ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }), isFlexible: true }),
    );

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 7,
        vaultId: 1,
        isBackfill: true,
      }),
    ]);
    await db.bitcoinLocksTable.setStatus(record, BitcoinLockStatus.Releasing);

    await store.recovery.commitHistoryReplay();

    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.status).toBe(BitcoinLockStatus.Releasing);
    expect(record.status).toBe(BitcoinLockStatus.Releasing);
    expect(record.lockDetails.isFlexible).toBe(true);
  });

  it('snapshots a lock after its queued live ratchet finishes', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'queued-live-ratchet',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: initialLock,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(
      new BitcoinLock({ ...createHistoricalLock({ accountId, liquidityPromised: 1_200n }), isFlexible: true }),
    );
    const liveRatchetStarted = createDeferred<void>();
    const finishLiveRatchet = createDeferred<void>();
    const liveRatchet = store.runInQueueForUtxo(record, 30e3, async () => {
      liveRatchetStarted.resolve();
      await finishLiveRatchet.promise;
      record.lockedTargetPrice = 1_100n;
      record.liquidityPromised = 1_200n;
      record.ratchets.push({
        mintAmount: 200n,
        mintPending: 200n,
        lockedTargetPrice: 1_100n,
        blockHeight: 199,
        burned: 0n,
        securityFee: 2n,
        txFee: 3n,
        oracleBitcoinBlockHeight: 600,
      });
      await db.bitcoinLocksTable.saveNewRatchet(record);
    });
    await liveRatchetStarted.promise;

    const beginReplay = store.recovery.beginHistoryReplay({ lockScope: 'all' });
    finishLiveRatchet.resolve();
    await Promise.all([liveRatchet, beginReplay]);
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 7,
        vaultId: 1,
        isBackfill: true,
      }),
    ]);
    await store.recovery.commitHistoryReplay();

    const durable = await db.bitcoinLocksTable.getByUtxoId(7);
    expect(durable?.ratchets).toHaveLength(2);
    expect(durable?.ratchets[1]).toEqual(expect.objectContaining({ blockHeight: 199, mintAmount: 200n }));
    expect(record.ratchets).toHaveLength(2);
  });

  it('rejects replay commit when durable economics change outside the lock queue', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = new BitcoinLock(createHistoricalLock({ accountId, liquidityPromised: 1_000n }));
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'replay-economic-conflict',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: initialLock,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByUtxoId[7] = record;
    vi.mocked(BitcoinLockHistory.getHistoricalBitcoinLock).mockResolvedValue(
      new BitcoinLock({ ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }), isFlexible: true }),
    );

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 7,
        vaultId: 1,
        isBackfill: true,
      }),
    ]);
    const newerDurable = (await db.bitcoinLocksTable.getByUtxoId(7))!;
    newerDurable.ratchets.push({
      mintAmount: 200n,
      mintPending: 200n,
      lockedTargetPrice: 1_100n,
      blockHeight: 201,
      burned: 0n,
      securityFee: 2n,
      txFee: 3n,
      oracleBitcoinBlockHeight: 600,
    });
    newerDurable.lockedTargetPrice = 1_100n;
    newerDurable.liquidityPromised = 1_200n;
    await db.bitcoinLocksTable.saveNewRatchet(newerDurable);

    await expect(store.recovery.commitHistoryReplay()).rejects.toThrow(
      'Bitcoin lock 7 changed during history recovery',
    );
    expect((await db.bitcoinLocksTable.getByUtxoId(7))?.ratchets).toHaveLength(2);

    await store.recovery.cancelHistoryReplay();
  });
});
