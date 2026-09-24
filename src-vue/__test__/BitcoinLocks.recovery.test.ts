import { describe, expect, it, vi } from 'vitest';
import { createDeferred, type BlockWatch, BitcoinLock } from '@argonprotocol/apps-core';
import * as BitcoinHistory from '../lib/recovery/BitcoinLockHistory.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import BitcoinMempool from '../lib/BitcoinMempool.ts';
import { BitcoinFissions } from '../lib/BitcoinFissions.ts';
import type { Db } from '../lib/Db.ts';
import type { IBitcoinFissionRecord } from '../interfaces/IBitcoinFissionRecord.ts';
import type { WalletKeys } from '../lib/WalletKeys.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoSpendStatus, BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { BitcoinReleaseKind, BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { hexToU8a } from '@argonprotocol/mainchain';
import { historicalEventChanges } from '@argonprotocol/runtime-client/events.generated';
import { bigintCodec, numberCodec, optionCodec } from '../../core/__test__/helpers/codecs.ts';
import { encodeAddress } from '@polkadot/util-crypto';
import { getBitcoinAlertNotices } from '../lib/Alerts.ts';
import { BitcoinFinancials } from '../lib/financials/BitcoinLocks.ts';
import { BitcoinFissionRecovery } from '../lib/recovery/BitcoinFissions.ts';
import { publishBitcoinHistoryReplay } from '../lib/recovery/index.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { createTestDb } from './helpers/db.ts';
import { bitcoinRecoveryEventPolicies } from '../lib/recovery/BitcoinLockReplay.ts';
import {
  createBitcoinLockConfig,
  createCurrentLock,
  createLock,
  createStore,
  createHistoricalLock,
  historyBlock,
  historyEvent,
} from './helpers/bitcoin.ts';
import { nextTick, reactive, watchEffect } from 'vue';

vi.mock('../lib/recovery/BitcoinLockHistory.ts', async importOriginal => ({
  ...(await importOriginal()),
  getHistoricalBitcoinFundingUtxos: vi.fn(),
  getHistoricalBitcoinLock: vi.fn(),
  getHistoricalBitcoinPendingMints: vi.fn(),
  getHistoricalBitcoinReleaseRequest: vi.fn(),
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClient: vi.fn(async () => ({})),
}));

const getBitcoinLock = vi.spyOn(BitcoinLock, 'get');
const getBitcoinLockIdsByOwner = vi.spyOn(BitcoinLock, 'idsByOwner');

async function publishRecoveredHistory(store: BitcoinLocks, asOfBlock = 0) {
  return publishBitcoinHistoryReplay({ bitcoinLocks: store, asOfBlock });
}

describe('BitcoinLocks recovery', () => {
  it('can retry a failed current-state load without replacing the state owner', async () => {
    const db = await createTestDb();
    const transientError = new Error('archive unavailable');
    const start = vi.fn().mockRejectedValueOnce(transientError).mockResolvedValue(undefined);
    const blockWatch = {
      start,
      events: { on: () => () => undefined },
      finalizedBlockHeader: { blockNumber: 0, blockHash: '0x0' },
      bestBlockHeader: { blockNumber: 0, blockHash: '0x0' },
    } as unknown as BlockWatch;
    const archiveClient = {
      consts: { bitcoinLocks: { argonTicksPerDay: { toNumber: () => 1_440 } } },
    };
    vi.mocked(getMainchainClient).mockResolvedValue(archiveClient as never);
    const configSpy = vi.spyOn(BitcoinLock, 'getConfig').mockResolvedValue(createBitcoinLockConfig());
    const store = createStore({ blockWatch, db });
    vi.spyOn(store.utxoTracking, 'load').mockResolvedValue(undefined);
    vi.spyOn(store.utxoTracking, 'syncArgonOrphans').mockResolvedValue([]);
    vi.spyOn(store, 'syncCurrentLocks').mockResolvedValue([]);

    store.data = reactive(store.data) as BitcoinLocks['data'];
    const observedReadiness: string[] = [];
    const stopWatching = watchEffect(() => {
      observedReadiness.push(store.data.readiness);
    });

    const firstAttempt = store.load();
    await expect(firstAttempt).rejects.toBe(transientError);
    await expect(store.currentLoadPromise).rejects.toBe(transientError);
    expect(store.data.readiness).toBe('error');
    expect(store.data.loadError).toBe(transientError);

    const retry = store.load();
    const concurrentRetry = store.load();
    expect(store.data.readiness).toBe('loading');
    await expect(Promise.all([retry, concurrentRetry])).resolves.toEqual([undefined, undefined]);
    await expect(store.currentLoadPromise).resolves.toBeUndefined();
    expect(store.data.readiness).toBe('ready');
    expect(store.data.loadError).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    await nextTick();
    expect(observedReadiness).toEqual(['idle', 'loading', 'error', 'loading', 'ready']);
    stopWatching();

    configSpy.mockRestore();
  });

  it('assigns every copied Bitcoin lock event an explicit replay policy', () => {
    const historicalMethods = new Set(
      historicalEventChanges.filter(change => change.section === 'bitcoinLocks').map(change => change.method),
    );

    expect(Object.keys(bitcoinRecoveryEventPolicies).sort()).toEqual([...historicalMethods].sort());
  });

  it('recognizes and clears recovery flags restored from the database', async () => {
    const db = await createTestDb();
    const store = createStore({ db });
    store.data = reactive(store.data) as BitcoinLocks['data'];
    const lock = createLock({
      uuid: 'loaded-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const pendingLock = createLock({
      uuid: 'loaded-pending-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-01-02T00:00:00Z',
    });
    lock.isHistoryRecoveryPending = true;
    pendingLock.isHistoryRecoveryPending = true;
    store.data.locksByLockId[7] = lock;
    store.data.pendingLocks.push(pendingLock);
    const setHistoryRecoveryPending = vi.fn();
    vi.spyOn(store, 'getTable').mockResolvedValue({ setHistoryRecoveryPending } as never);
    const observedPendingFlags: boolean[] = [];
    const stopWatching = watchEffect(() => {
      observedPendingFlags.push(Boolean(store.data.locksByLockId[7]?.isHistoryRecoveryPending));
    });

    expect(store.recovery.hasPendingHistoryRecovery).toBe(true);

    await store.recovery.beginHistoryReplay();
    await publishRecoveredHistory(store);

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
    store.data.locksByLockId[7] = record;

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    let didRun = false;
    const queuedWork = store.runInQueueForLock(
      record,
      async () => {
        didRun = true;
      },
      { waitForHistoryRecovery: true },
    );
    await nextTick();

    expect(didRun).toBe(false);
    expect(record.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.cancelHistoryReplay();
    await queuedWork;

    expect(didRun).toBe(true);
  });

  it('gates later work when replay starts inside the lock queue', async () => {
    const db = await createTestDb();
    const store = createStore({ db });
    const record = createLock({
      uuid: 'replay-queue-owner',
      utxoId: 7,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByLockId[7] = record;
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByLockId: vi.fn(async () => record),
    } as never);

    await store.recovery.beginHistoryReplay();
    await store.runInQueueForLock(record, async () => {
      await store.recovery.recoverLock({
        lock: createHistoricalLock({
          accountId: record.ownerAccount!,
          lockedTargetPrice: record.microgonsAtTargetPerBtc,
          liquidityPromised: 0n,
        }),
        createdAtArgonBlockHeight: 1,
        finalFee: 0n,
        lockQueueOwnerUuid: record.uuid,
      });
    });

    let didRun = false;
    const queuedWork = store.runInQueueForLock(
      record,
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

  it('continues queued UTXO work after an earlier task rejects', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'failed-queue-task',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const failed = store.runInQueueForLock(record, async () => {
      throw new Error('Unable to update the UTXO');
    });
    let didRunNextTask = false;
    const next = store.runInQueueForLock(record, async () => {
      didRunNextTask = true;
    });

    await expect(failed).rejects.toThrow('Unable to update the UTXO');
    await expect(next).resolves.toBeUndefined();
    expect(didRunNextTask).toBe(true);
  });

  it('replays each orphan UTXO through request and vault cosign history', async () => {
    const db = await createTestDb();
    const lock = createLock({
      uuid: 'orphan-history',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const utxoRef = { txid: `0x${'44'.repeat(32)}`, outputIndex: 2 };
    const observedUtxo = await db.bitcoinUtxosTable.insert({
      lockId: lock.lockId!,
      txid: utxoRef.txid,
      vout: utxoRef.outputIndex,
      satoshis: 12_000n,
      network: lock.network,
      status: BitcoinUtxoStatus.SeenOnMempool,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      firstSeenAt: new Date('2026-01-01T00:01:00Z'),
      firstSeenBitcoinHeight: 200,
    });
    const api = {
      query: {
        ticks: { currentTick: vi.fn(async () => 700) },
        bitcoinLocks: {
          orphanedUtxosByAccount: vi.fn(async () => ({
            utxoId: 7,
            satoshis: 12_000n,
            cosignRequest: {
              toScriptPubkey: new Uint8Array([0, 20, 1, 2, 3]),
              bitcoinNetworkFee: 120n,
            },
          })),
        },
      },
    };
    const store = createStore({
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      db,
    });
    store.data.locksByLockId[7] = lock;
    store.utxoTracking.load([observedUtxo]);

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
        accountId: lock.ownerAccount,
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

    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([
      expect.objectContaining({
        id: observedUtxo.id,
        status: BitcoinUtxoStatus.SeenOnMempool,
        activeReleaseId: undefined,
      }),
    ]);
    expect(store.utxoTracking.getUtxosForLock(lock.lockId!)).toEqual([
      expect.objectContaining({ status: BitcoinUtxoStatus.SeenOnMempool, activeReleaseId: undefined }),
    ]);

    await publishRecoveredHistory(store);

    const [recoveredUtxo] = store.utxoTracking.getUtxosForLock(lock.lockId!);
    expect(recoveredUtxo).toEqual(
      expect.objectContaining({
        id: observedUtxo.id,
        txid: utxoRef.txid,
        status: BitcoinUtxoStatus.SeenOnMempool,
        activeReleaseId: undefined,
      }),
    );
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([
      expect.objectContaining({
        txid: utxoRef.txid,
        vout: utxoRef.outputIndex,
        satoshis: 12_000n,
        status: BitcoinUtxoStatus.SeenOnMempool,
        activeReleaseId: undefined,
      }),
    ]);
    expect(await db.bitcoinReleasesTable.fetchAll()).toEqual([
      expect.objectContaining({
        kind: BitcoinReleaseKind.Orphan,
        status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
        toScriptPubkey: '0x0014010203',
        bitcoinNetworkFee: 120n,
        vaultSignatures: [hexToU8a('0x010203')],
        cosignBlockNumber: 203,
      }),
    ]);
    expect(store.releases.getActiveForUtxo(recoveredUtxo)).toBeUndefined();
  });

  it('persists a rediscovered orphan without replacing current wallet state', async () => {
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
    store.data.locksByLockId[7] = lock;
    const reconcileOrphanReleases = vi.spyOn(store.releases, 'reconcileOrphanReleases').mockResolvedValue();

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

    await publishRecoveredHistory(store);

    expect(store.data.isReconciliationPending).toBe(false);
    expect(store.utxoTracking.getUnresolvedOrphanRecords([lock])).toEqual([
      expect.objectContaining({ txid: utxoRef.txid, status: BitcoinUtxoStatus.Orphaned }),
    ]);
    expect(reconcileOrphanReleases).not.toHaveBeenCalled();
    expect(store.getLockById(7)).toBe(lock);
    expect(store.utxoTracking.getAllOrphanLifecycleUtxos()).toEqual([
      expect.objectContaining({ txid: utxoRef.txid, status: BitcoinUtxoStatus.Orphaned }),
    ]);
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([
      expect.objectContaining({
        txid: utxoRef.txid,
        vout: utxoRef.outputIndex,
        satoshis: 12_000n,
        status: BitcoinUtxoStatus.Orphaned,
      }),
    ]);
  });

  it('quarantines recovering locks from actions while keeping their current values visible', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'interim-release',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.isHistoryRecoveryPending = true;
    store.data.locksByLockId[7] = record;
    expect(getBitcoinAlertNotices(store)).toEqual([]);

    const regularRecord = createLock({
      uuid: 'regular-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-02-01T00:00:00Z',
    });
    store.data.locksByLockId[8] = regularRecord;
    vi.spyOn(store, 'config', 'get').mockReturnValue(createBitcoinLockConfig());
    vi.spyOn(store, 'unlockDeadlineTime').mockReturnValue(Number.MAX_SAFE_INTEGER);
    vi.spyOn(store, 'getSecuritizationHoldExpirationTime').mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect(getBitcoinAlertNotices(store)).toEqual([]);

    vi.spyOn(store, 'getTable').mockResolvedValue({ setStatus: vi.fn() } as never);

    expect(store.getActiveLocks()).toEqual([regularRecord]);
    expect(store.getAllLocks()).toEqual([regularRecord]);
    expect(store.getAllLocks({ includeHistoryRecoveryPending: true })).toEqual([regularRecord, record]);
    expect(store.getLockById(7)).toBeUndefined();
    expect(store.getLockById(8)).toBe(regularRecord);
    await expect(store.acknowledgeFailed(record)).rejects.toThrow('Bitcoin history recovery is still in progress');

    vi.spyOn(store, 'load').mockResolvedValue();
    const recoverySummary = {
      ...store.createLockSummary(record),
      valueOfBtc: 100n,
      startingCapital: 80n,
      endingCapital: 88n,
      pendingLiquidity: 10n,
      receivedLiquidity: 70n,
      totalFees: 2n,
      unlockAmount: 60n,
    };
    const regularSummary = {
      ...store.createLockSummary(regularRecord),
      valueOfBtc: 0n,
      startingCapital: 0n,
      endingCapital: 0n,
      pendingLiquidity: 0n,
      receivedLiquidity: 0n,
      totalFees: 0n,
      unlockAmount: 0n,
    };
    const createLockSummary = vi
      .spyOn(store, 'createLockSummary')
      .mockImplementation(lock => (lock === record ? recoverySummary : regularSummary));
    const fissions = {
      ownerAccount: record.ownerAccount,
      getAll: () => [],
      getRecords: () => [],
    };
    const dbPromise = Promise.resolve({
      bitcoinFissionsTable: { fetchAll: async () => [] },
      bitcoinSecuritizationHistoryTable: { getPublishedSnapshot: async () => undefined },
    }) as never;
    const financials = await new BitcoinFinancials(store, fissions as never, dbPromise).loadSnapshot({
      clientAt: { query: { ticks: { currentTick: async () => 100 } } } as never,
      hasCurrentPrice: true,
    });

    expect(createLockSummary).toHaveBeenCalledTimes(2);
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
    releasingLock.activeReleaseId = 'release-7';
    releasingLock.fundingUtxoIds = [1];
    const releaseCreatedAt = new Date('2026-01-01T00:00:00Z');
    store.utxoTracking.load([
      {
        id: 1,
        lockId: 7,
        txid: '11'.repeat(32),
        vout: 0,
        satoshis: 10_000n,
        network: 'testnet',
        status: BitcoinUtxoStatus.FundingUtxo,
        spendStatus: BitcoinUtxoSpendStatus.Unspent,
        activeReleaseId: 'release-7',
        firstSeenAt: releaseCreatedAt,
        firstSeenBitcoinHeight: 100,
        createdAt: releaseCreatedAt,
        updatedAt: releaseCreatedAt,
      },
    ]);
    store.releases.data.releasesById['release-7'] = {
      id: 'release-7',
      sendId: 'release-7',
      kind: BitcoinReleaseKind.Lock,
      lockId: 7,
      releaseNumber: 1,
      status: BitcoinReleaseStatus.WaitingForVaultCosign,
      inputUtxoIds: [1],
      toScriptPubkey: '0x0014',
      bitcoinNetworkFee: 10n,
      destinationSatoshis: 9_990n,
      changeSatoshis: 0n,
      vaultSignatures: [],
      createdAt: releaseCreatedAt,
      updatedAt: releaseCreatedAt,
    };
    const activeLock = createLock({
      uuid: 'active-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-02-01T00:00:00Z',
    });
    store.data.locksByLockId[7] = releasingLock;
    store.data.locksByLockId[8] = activeLock;

    const saveRecoveredHistory = vi.fn(async () => undefined);
    const getByLockId = vi.fn(async utxoId => store.data.locksByLockId[utxoId]);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByLockId,
      saveRecoveredHistory,
    } as never);
    vi.spyOn(store as any, 'runPendingLoadReconciliation').mockResolvedValue(undefined);
    getBitcoinLockIdsByOwner.mockResolvedValue([8]);
    vi.spyOn(store.utxoTracking, 'syncFundingUtxos').mockResolvedValue([]);
    getBitcoinLock.mockResolvedValue(new BitcoinLock(createCurrentLock({ lockId: 8, createdAtArgonBlock: 10 })));
    vi.spyOn(store, 'unlockDeadlineTime').mockReturnValue(Date.now() + 60_000);

    await store.syncCurrentLocks();
    expect(releasingLock.status).toBe(BitcoinLockStatus.Releasing);
    expect(releasingLock.isHistoryRecoveryPending).toBeUndefined();

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    expect(releasingLock.isHistoryRecoveryPending).toBeUndefined();
    getByLockId.mockResolvedValue({
      ...releasingLock,
      status: BitcoinLockStatus.LockFunded,
    });
    await store.recovery.recoverLock({
      lock: createHistoricalLock({
        accountId: releasingLock.ownerAccount!,
        lockedTargetPrice: releasingLock.microgonsAtTargetPerBtc,
        liquidityPromised: 0n,
      }),
      createdAtArgonBlockHeight: 1,
      finalFee: 0n,
    });
    await store.recovery.cancelHistoryReplay();

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
    store.data.locksByLockId[7] = unresolvedRelease;

    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByLockId: vi.fn(async () => undefined),
    } as never);
    getBitcoinLockIdsByOwner.mockResolvedValue([]);

    await store.syncCurrentLocks();

    expect(unresolvedRelease.status).toBe(BitcoinLockStatus.Releasing);
    expect(unresolvedRelease.isHistoryRecoveryPending).toBeUndefined();
    expect(store.getActiveLocks()).toEqual([unresolvedRelease]);
    expect(store.recovery.hasPendingHistoryRecovery).toBe(false);
  });

  it('repairs pending locks without replaying healthy locks', async () => {
    const db = await createTestDb();
    const blockWatch = Object.assign(Object.create(null), {
      getApi: async () => ({}),
    }) as BlockWatch;
    const store = createStore({ blockWatch, db });
    const pendingRecord = createLock({
      uuid: 'pending-recovery',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    pendingRecord.isHistoryRecoveryPending = true;
    const healthyRecord = createLock({
      uuid: 'healthy-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-02T00:00:00Z',
    });
    store.data.locksByLockId[7] = pendingRecord;
    store.data.locksByLockId[8] = healthyRecord;
    await store.recovery.beginHistoryReplay({ lockScope: 'pending' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(151, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 7, vaultId: 1 }),
      historyEvent(151, 'bitcoinLocks', 'BitcoinSpentAfterRelease', { utxoId: 8, vaultId: 1 }),
    ]);
    await publishRecoveredHistory(store);

    expect(await db.bitcoinLocksTable.getByLockId(7)).toMatchObject({ status: BitcoinLockStatus.LockFunded });
    expect((await db.bitcoinLocksTable.getByLockId(7))?.removalReason).toBeUndefined();
    expect(pendingRecord.removalReason).toBeUndefined();
    expect(healthyRecord.removalReason).toBeUndefined();
    expect(healthyRecord.isHistoryRecoveryPending).toBeUndefined();
  });

  it('shares concurrent active-lock recovery so one UTXO is queried once', async () => {
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => ({})),
      } as never,
    });
    const chainLock = new BitcoinLock(createCurrentLock({ lockId: 7, createdAtArgonBlock: 10 }));
    store.data.locksByLockId[7] = createLock({
      uuid: 'concurrent-active-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    let finishRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => {
      finishRecovery = resolve;
    });
    getBitcoinLockIdsByOwner.mockResolvedValue([7]);
    vi.spyOn(store.utxoTracking, 'syncFundingUtxos').mockResolvedValue([]);
    getBitcoinLock.mockReset();
    getBitcoinLock.mockImplementation(async () => {
      await recoveryGate;
      return chainLock;
    });

    const firstRecovery = store.syncCurrentLocks();
    const concurrentRecovery = store.syncCurrentLocks();

    expect(concurrentRecovery).toBe(firstRecovery);
    await vi.waitFor(() => expect(getBitcoinLock).toHaveBeenCalledOnce());
    finishRecovery();
    await expect(firstRecovery).resolves.toEqual([chainLock]);
    await expect(concurrentRecovery).resolves.toEqual([chainLock]);
    expect(getBitcoinLock).toHaveBeenCalledOnce();
  });

  it('keeps successful active locks usable while retrying a transient per-lock failure', async () => {
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => ({})),
      } as never,
    });
    const retriedChainLock = new BitcoinLock(createCurrentLock({ lockId: 7, createdAtArgonBlock: 10 }));
    const recoveredChainLock = new BitcoinLock(createCurrentLock({ lockId: 8, createdAtArgonBlock: 20 }));
    store.data.locksByLockId[7] = createLock({
      uuid: 'retried-active-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByLockId[8] = createLock({
      uuid: 'recovered-active-lock',
      utxoId: 8,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-02T00:00:00Z',
    });
    getBitcoinLockIdsByOwner.mockResolvedValue([7, 8]);
    vi.spyOn(store.utxoTracking, 'syncFundingUtxos').mockResolvedValue([]);
    getBitcoinLock
      .mockReset()
      .mockRejectedValueOnce(new Error('lock 7 unavailable'))
      .mockResolvedValueOnce(recoveredChainLock)
      .mockResolvedValueOnce(retriedChainLock)
      .mockResolvedValueOnce(recoveredChainLock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(store.syncCurrentLocks({ requireComplete: true })).rejects.toThrow(
      'Current Bitcoin lock loading is incomplete.',
    );
    expect(store.recovery.hasPendingHistoryRecovery).toBe(false);

    await expect(store.syncCurrentLocks()).resolves.toEqual([recoveredChainLock, retriedChainLock]);
    expect(store.recovery.hasPendingHistoryRecovery).toBe(false);
  });

  it('keeps historical recovery pending when a current Lock snapshot is available', async () => {
    const store = createStore({
      blockWatch: {
        getFinalizedApi: vi.fn(async () => ({})),
      } as never,
    });
    const record = createLock({
      uuid: 'complete-active-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    record.isHistoryRecoveryPending = true;
    store.data.locksByLockId[7] = record;
    const chainLock = createCurrentLock({ lockId: 7, createdAtArgonBlock: 10 });
    const setHistoryRecoveryPending = vi.fn(async () => undefined);
    const saveRecoveredHistory = vi.fn(async () => undefined);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByLockId: vi.fn(async () => record),
      saveRecoveredHistory,
      setHistoryRecoveryPending,
    } as never);
    getBitcoinLockIdsByOwner.mockResolvedValue([7]);
    vi.spyOn(store.utxoTracking, 'syncFundingUtxos').mockResolvedValue([]);
    getBitcoinLock.mockReset().mockResolvedValue(new BitcoinLock(chainLock));

    expect(store.getLockById(7)).toBeUndefined();

    await expect(store.syncCurrentLocks()).resolves.toEqual([chainLock]);

    expect(saveRecoveredHistory).not.toHaveBeenCalled();
    expect(setHistoryRecoveryPending).not.toHaveBeenCalled();
    expect(record.isHistoryRecoveryPending).toBe(true);
    expect(store.getLockById(7)).toBeUndefined();
    expect(record).not.toHaveProperty('ratchets');
  });

  it('keeps recovered expired locks retired during a full history replay', async () => {
    const db = await createTestDb();
    const chainLock = createHistoricalLock({
      accountId: encodeAddress(new Uint8Array(32).fill(0x33)),
      liquidityPromised: 1_000n,
    });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'expired-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(chainLock)),
    });
    record.status = BitcoinLockStatus.LockPendingFunding;
    record.removalReason = 'expired';
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const store = createStore({ db });
    store.data.locksByLockId[7] = record;

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverLock({
      lock: chainLock,
      createdAtArgonBlockHeight: 100,
      finalFee: 0n,
    });

    expect(record.isHistoryRecoveryPending).toBe(false);

    await publishRecoveredHistory(store);

    expect(store.getActiveLocks()).toEqual([]);
    expect(store.getAllLocks()).toEqual([record]);
    expect(store.getLockById(7)).toBe(record);
    expect(record.isHistoryRecoveryPending).toBe(false);
    const durable = await db.bitcoinLocksTable.getByLockId(7);
    expect(durable?.isHistoryRecoveryPending).toBe(false);
    expect(durable?.securitizationHoldExpirationBitcoinHeight).toBe(506);
    expect(durable).not.toHaveProperty('lockedTargetPrice');
    expect(durable).not.toHaveProperty('liquidityPromised');
  });
});

function createFissionHistoryRecord(
  ownerAccount: string,
  fissionId: number,
  lockId: number,
  liquidityPromised: bigint,
): IBitcoinFissionRecord {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  return {
    origin: 'created',
    ownerAccount,
    fissionId,
    liquidId: fissionId,
    lockId,
    satoshis: 10_000n,
    microgonsAtTargetPerBtc: 1_000n,
    liquidityPromised,
    createdAtArgonBlock: 159,
    ratchetNumber: 0,
    lastUpdatedArgonBlock: 159,
    ratchets: [
      {
        source: 'fission',
        sourceRatchetIndex: 0,
        ratchetNumber: 0,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised,
        amountMinted: liquidityPromised,
        amountBurned: 0n,
        mintPending: liquidityPromised,
        blockNumber: 159,
      },
    ],
    createdAt,
    updatedAt: createdAt,
  };
}

describe('BitcoinLocks history replay publication', () => {
  it('restores readonly Bitcoin lock history from public account ownership', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x44));
    const creationLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n });
    const walletKeys = {
      canSign: false,
      defaultArgonAddress: accountId,
      getBitcoinChildXpriv: async () => {
        throw new Error('Wallet encryption key is unavailable');
      },
    } as unknown as WalletKeys;
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys,
    });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(creationLock);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(151), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
    ]);
    await publishRecoveredHistory(store);

    expect(store.getLockById(7)).toMatchObject({
      lockId: 7,
      vaultId: 1,
      ownerAccount: accountId,
      scriptDetails: { ownerPubkey: `02${'33'.repeat(32)}` },
    });
    const durable = await db.bitcoinLocksTable.getByLockId(7);
    expect(durable).toMatchObject({
      lockId: 7,
      vaultId: 1,
      ownerAccount: accountId,
      scriptDetails: { ownerPubkey: `02${'33'.repeat(32)}` },
    });
    expect(durable?.hdPath).toBe('');
  });

  it('restores a readonly historical release under its current Lock ID', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x44));
    const fundingTxid = `0x${'44'.repeat(32)}`;
    const releaseTxid = `0x${'55'.repeat(32)}`;
    const creationLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n });
    const fundedLock = {
      ...createHistoricalLock({ accountId, liquidityPromised: 1_000n, lockedTargetPrice: 1_000n }),
      fundedSatoshis: 10_000n,
    };
    const getBitcoinChildXpriv = vi.fn(async () => {
      throw new Error('Wallet encryption key is unavailable');
    });
    const walletKeys = {
      canSign: false,
      defaultArgonAddress: accountId,
      getBitcoinChildXpriv,
    } as unknown as WalletKeys;
    const api = {
      query: {
        ticks: { currentTick: vi.fn(async () => 700) },
      },
    };
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      walletKeys,
    });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'translated-historical-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: creationLock.securitizedSatoshis,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: creationLock.vaultId,
    });
    const currentLock = createCurrentLock({ ...BitcoinHistory.toBitcoinLockDetails(creationLock), lockId: 70 });
    const currentRecord = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });
    await db.bitcoinLocksTable.setStatus(currentRecord, BitcoinLockStatus.Releasing);
    store.data.locksByLockId[70] = currentRecord;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(creationLock)
      .mockResolvedValueOnce(fundedLock);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinFundingUtxos).mockResolvedValue([
      { utxoRef: { txid: fundingTxid, vout: 1 }, satoshis: fundedLock.fundedSatoshis },
    ]);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinReleaseRequest).mockResolvedValue({
      toScriptPubkey: '0x0014',
      bitcoinNetworkFee: 8n,
      liquidRedemptionAmount: 900n,
    });
    const getOutspendStatus = vi.spyOn(BitcoinMempool.prototype, 'getOutspendStatus').mockResolvedValue({
      txid: releaseTxid,
      isConfirmed: true,
      transactionBlockHeight: 600,
      transactionBlockTime: 1_700_000_000,
      argonBitcoinHeight: 610,
    });

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(151), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 1_000n,
        securitization: 1_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 20n,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(152), [
      historyEvent(157, 'bitcoinUtxos', 'UtxoVerified', {
        utxoId: 7,
        satoshisReceived: 10_000n,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(155), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinUtxoCosignRequested', { utxoId: 7, vaultId: 1 }),
      historyEvent(157, 'bitcoinLocks', 'BitcoinUtxoCosigned', {
        utxoId: 7,
        vaultId: 1,
        signature: '0x11',
      }),
    ]);
    await publishRecoveredHistory(store);

    expect(getOutspendStatus).toHaveBeenCalledWith(fundingTxid, 1, 0);
    expect(getBitcoinChildXpriv).not.toHaveBeenCalled();
    expect(store.getActiveLocks()).toEqual([currentRecord]);
    expect(store.getLockById(7)).toBeUndefined();
    expect(store.getLockById(70)).toBe(currentRecord);
    expect(store.getLockById(70)).toMatchObject({ status: BitcoinLockStatus.Releasing });
    expect(store.getLockById(70)?.removalReason).toBeUndefined();
    expect(await db.bitcoinLocksTable.getByLockId(7)).toBeUndefined();
    expect(await db.bitcoinLocksTable.getByLockId(70)).toMatchObject({ status: BitcoinLockStatus.Releasing });
    expect((await db.bitcoinLocksTable.getByLockId(70))?.removalReason).toBeUndefined();
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([
      expect.objectContaining({
        lockId: 70,
        txid: fundingTxid,
        vout: 1,
        status: BitcoinUtxoStatus.FundingUtxo,
        spendStatus: BitcoinUtxoSpendStatus.Spent,
      }),
    ]);
    const releases = await db.bitcoinReleasesTable.fetchAll();
    expect(releases).toEqual([
      expect.objectContaining({
        kind: BitcoinReleaseKind.Lock,
        lockId: 70,
        status: BitcoinReleaseStatus.Complete,
        bitcoinTxid: releaseTxid,
        bitcoinConfirmedHeight: 600,
      }),
    ]);
    expect(releases[0]).not.toHaveProperty('insuredMicrogons');
    expect((await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(accountId))?.terms).toEqual([
      expect.objectContaining({ lockId: 70 }),
    ]);
  });

  it('does not block live Lock work while financial history is replaying', async () => {
    const store = createStore();
    const record = createLock({
      uuid: 'live-during-backfill',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByLockId[7] = record;

    await store.recovery.beginHistoryReplay({ lockScope: 'all', purpose: 'financial-backfill' });
    await expect(
      store.runInQueueForLock(record, async () => 'live work completed', { waitForHistoryRecovery: true }),
    ).resolves.toBe('live work completed');
    expect(store.getLockById(7)).toBe(record);

    await store.recovery.cancelHistoryReplay();
  });

  it('keeps Bitcoin alerts stable while history replay is uncommitted or discarded', async () => {
    const db = await createTestDb();
    const store = createStore({ db });
    const record = createLock({
      uuid: 'settled-lock',
      utxoId: 7,
      status: BitcoinLockStatus.LockFunded,
      createdAt: '2026-01-01T00:00:00Z',
    });
    store.data.locksByLockId[7] = record;
    vi.spyOn(store, 'unlockDeadlineTime').mockReturnValue(Number.MAX_SAFE_INTEGER);
    vi.spyOn(store, 'getTable').mockResolvedValue({
      getByLockId: vi.fn(async utxoId => (utxoId === 7 ? record : undefined)),
    } as never);
    const alertsBeforeReplay = getBitcoinAlertNotices(store).map(alert => alert.lock.uuid);

    await store.recovery.beginHistoryReplay();
    await store.recovery.recoverLock({
      lock: createHistoricalLock({
        accountId: record.ownerAccount!,
        lockedTargetPrice: record.microgonsAtTargetPerBtc,
        liquidityPromised: 0n,
      }),
      createdAtArgonBlockHeight: 1,
      finalFee: 0n,
    });

    expect(record.status).toBe(BitcoinLockStatus.LockFunded);
    expect(record.isHistoryRecoveryPending).toBeUndefined();
    expect(store.getAllLocks()).toEqual([record]);
    expect(getBitcoinAlertNotices(store).map(alert => alert.lock.uuid)).toEqual(alertsBeforeReplay);

    await store.recovery.cancelHistoryReplay();

    expect(record.status).toBe(BitcoinLockStatus.LockFunded);
    expect(store.getAllLocks()).toEqual([record]);
    expect(getBitcoinAlertNotices(store).map(alert => alert.lock.uuid)).toEqual(alertsBeforeReplay);
  });

  it('discards every staged history mutation when replay fails', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const lockDetails = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'failed-shadow-replay',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(lockDetails)),
    });
    record.status = BitcoinLockStatus.LockFunded;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { canSign: true, defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
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
      lock: recoveredLockDetails,
      createdAtArgonBlockHeight: 151,
      finalFee: 11n,
    });
    await store.recovery.cancelHistoryReplay();

    const durable = await db.bitcoinLocksTable.getByLockId(7);
    expect(durable?.status).toBe(BitcoinLockStatus.LockFunded);
    expect(durable?.removalReason ?? undefined).toBeUndefined();
    expect(Boolean(durable?.isHistoryRecoveryPending)).toBe(false);
    expect(await db.bitcoinLocksTable.getByLockId(8)).toBeUndefined();
    expect(
      await db.walletHdKeysTable.fetchByScope({
        keyRole: 'bitcoinLock',
        scopeKey: '1',
      }),
    ).toEqual([]);
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual([]);
    expect(store.utxoTracking.getUtxosForLock(record.lockId!)).toEqual([]);
  });

  it('uses persisted transaction identity when recovered lock and HD key records commit', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const lockDetails = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    lockDetails.ownerPubkey = `0x${lockDetails.ownerPubkey}`;
    const lock = lockDetails;
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
      walletKeys: { canSign: true, defaultArgonAddress: accountId } as WalletKeys,
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

    expect(await db.bitcoinLocksTable.getByLockId(7)).toBeUndefined();
    expect(await db.bitcoinLocksTable.fetchAll()).toEqual([]);
    expect(await db.walletHdKeysTable.fetchByScope({ keyRole: 'bitcoinLock', scopeKey: '1' })).toEqual([]);

    await publishRecoveredHistory(store);

    const recoveredLocks = await db.bitcoinLocksTable.fetchAll();
    expect(recoveredLocks).toHaveLength(1);
    expect(recoveredLocks[0]).toEqual(
      expect.objectContaining({
        uuid: 'out-of-order-history-lock',
        lockId: 7,
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

  it('rolls back a failed Lock and Fission unit while publishing an independent unit', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'successful-shadow-replay',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(initialLock)),
    });
    record.status = BitcoinLockStatus.LockFunded;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const initialLock8 = {
      ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
      utxoId: 8,
    };
    const pending8 = await db.bitcoinLocksTable.insertPending({
      uuid: 'successful-second-replay',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'/1",
      vaultId: 1,
    });
    const record8 = await db.bitcoinLocksTable.finalizePending({
      uuid: pending8.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(initialLock8)),
    });
    record8.status = BitcoinLockStatus.LockFunded;
    await db.bitcoinLocksTable.saveRecoveredHistory(record8);

    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { canSign: true, defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    store.data.locksByLockId[8] = record8;
    store.data.readiness = 'ready';
    const fissions = new BitcoinFissions(Promise.resolve(db), accountId);
    fissions.data.readiness = 'ready';
    const priorFission7 = createFissionHistoryRecord(accountId, 41, 7, 400n);
    await db.bitcoinFissionsTable.replaceRecords([priorFission7]);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockImplementation(async (_api, utxoId) => {
      return {
        ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
        utxoId,
        isFlexible: true,
      };
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
    const fissionEvents = [
      historyEvent(159, 'bitcoinFissions', 'FissionRatcheted', {
        accountId,
        fissionId: 41,
        ratchetNumber: 1,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 600n,
        amountMinted: 200n,
        amountBurned: 0n,
      }),
      historyEvent(159, 'bitcoinFissions', 'FissionCreated', {
        accountId,
        fissionId: 42,
        liquidId: 42,
        lockId: 8,
        satoshis: 10_000n,
        microgonsAtTargetPerBtc: 1_000n,
        liquidityPromised: 700n,
      }),
    ];

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(block, replayEvents);
    await fissions.recovery.beginHistoryReplay();
    await fissions.recovery.recoverBlock(block, fissionEvents);

    expect((await db.bitcoinLocksTable.getByLockId(7))?.isFlexible).toBe(false);
    expect(record.isFlexible).toBe(false);

    const replaceFission = db.bitcoinFissionsTable.replaceRecord.bind(db.bitcoinFissionsTable);
    let successfulUnitWasPublishedBeforeNextUnit = false;
    let failFission8 = true;
    vi.spyOn(db.bitcoinFissionsTable, 'replaceRecord').mockImplementation(async fission => {
      if (fission.lockId === 8 && failFission8) {
        failFission8 = false;
        successfulUnitWasPublishedBeforeNextUnit = fissions.getRecords().some(record => record.lockId === 7);
        throw new Error('temporary Fission write failure');
      }
      await replaceFission(fission);
    });
    await expect(
      publishBitcoinHistoryReplay({
        bitcoinLocks: store,
        bitcoinFissions: fissions,
        asOfBlock: 200,
      }),
    ).rejects.toThrow('temporary Fission write failure');

    expect(successfulUnitWasPublishedBeforeNextUnit).toBe(true);
    expect(record.isFlexible).toBe(false);
    expect((await db.bitcoinLocksTable.getByLockId(7))?.isFlexible).toBe(false);
    expect(record8.isFlexible).toBe(false);
    expect((await db.bitcoinLocksTable.getByLockId(8))?.isFlexible).toBe(false);
    expect(await db.bitcoinFissionsTable.fetchAll(accountId)).toEqual([
      expect.objectContaining({ fissionId: 41, liquidityPromised: 600n }),
    ]);
    expect(fissions.getRecords()).toEqual([expect.objectContaining({ fissionId: 41 })]);
    expect(fissions.data.financialRevision).toBe(1);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(block, replayEvents);
    await fissions.recovery.beginHistoryReplay();
    await fissions.recovery.recoverBlock(block, fissionEvents);

    await publishBitcoinHistoryReplay({
      bitcoinLocks: store,
      bitcoinFissions: fissions,
      asOfBlock: 200,
    });

    expect((await db.bitcoinLocksTable.getByLockId(7))?.isFlexible).toBe(false);
    expect(record.isFlexible).toBe(false);
    expect(await db.bitcoinFissionsTable.fetchAll(accountId)).toEqual([
      expect.objectContaining({ fissionId: 41, liquidityPromised: 600n }),
      expect.objectContaining({ fissionId: 42, liquidityPromised: 700n }),
    ]);
    expect(fissions.getRecords()).toEqual([
      expect.objectContaining({ fissionId: 41 }),
      expect.objectContaining({ fissionId: 42 }),
    ]);
  });

  it('preserves newer live operational state when history replay commits', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'concurrent-live-state',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(initialLock)),
    });
    record.status = BitcoinLockStatus.LockFunded;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { canSign: true, defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    const release = await db.bitcoinReleasesTable.insert({
      id: 'concurrent-release',
      sendId: 'concurrent-release',
      kind: BitcoinReleaseKind.Lock,
      lockId: 7,
      releaseNumber: 1,
      status: BitcoinReleaseStatus.SubmittingRequestOnArgon,
      inputUtxoIds: [],
      toScriptPubkey: `0x0020${'ab'.repeat(32)}`,
      bitcoinNetworkFee: 10n,
      destinationSatoshis: 0n,
      changeSatoshis: 0n,
      vaultSignatures: [],
    });
    await db.bitcoinLocksTable.setActiveRelease(record, release.id);
    await store.releases.load();
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue({
      ...createHistoricalLock({ accountId, liquidityPromised: 1_000n }),
      isFlexible: true,
    });

    await store.recovery.beginHistoryReplay({ lockScope: 'all', purpose: 'financial-backfill' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 7,
        vaultId: 1,
        isBackfill: true,
      }),
    ]);
    await db.bitcoinReleasesTable.update(release, {
      status: BitcoinReleaseStatus.WaitingForArgonRecognition,
    });
    store.releases.getById(release.id)!.status = BitcoinReleaseStatus.WaitingForArgonRecognition;

    await publishRecoveredHistory(store);

    expect((await db.bitcoinLocksTable.getByLockId(7))?.status).toBe(BitcoinLockStatus.Releasing);
    expect((await db.bitcoinReleasesTable.getById(release.id))?.status).toBe(
      BitcoinReleaseStatus.WaitingForArgonRecognition,
    );
    expect(record.status).toBe(BitcoinLockStatus.Releasing);
    expect(record.isFlexible).toBe(false);
  });

  it('uses the durable Lock revision as the history replay baseline', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const initialLock = createHistoricalLock({ accountId, liquidityPromised: 1_000n });
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'stale-loaded-revision',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(initialLock)),
    });
    await db.bitcoinLocksTable.updateFromCurrentLock(
      record,
      createCurrentLock({ ...BitcoinHistory.toBitcoinLockDetails(initialLock), isFlexible: false }),
    );
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { canSign: true, defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue({
      ...initialLock,
      isFlexible: true,
    });
    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockBackfillChanged', {
        utxoId: 7,
        vaultId: 1,
        isBackfill: true,
      }),
    ]);
    await publishRecoveredHistory(store);

    expect((await db.bitcoinLocksTable.getByLockId(7))?.isFlexible).toBe(false);
  });

  it('replays sequential partial releases without retiring the retained Lock', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'sequential-partial-release-history',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock({
        ownerAccount: accountId,
        fundedSatoshis: 4_800n,
        securitizedSatoshis: 4_800n,
      }),
    });
    record.status = BitcoinLockStatus.LockFunded;
    record.fundedSatoshis = 4_800n;
    record.securitizedSatoshis = 4_800n;
    const currentChange = await db.bitcoinUtxosTable.insert({
      lockId: 7,
      txid: `0x${'33'.repeat(32)}`,
      vout: 1,
      satoshis: 4_800n,
      network: 'testnet',
      status: BitcoinUtxoStatus.FundingUtxo,
      spendStatus: BitcoinUtxoSpendStatus.Unspent,
      createdByReleaseId: 'lock:7:2',
      firstSeenAt: new Date('2026-01-03T00:00:00Z'),
      firstSeenBitcoinHeight: 601,
    });
    record.fundingUtxoIds = [currentChange.id];
    await db.bitcoinLocksTable.saveRecoveredHistory(record);

    const api = { query: { ticks: { currentTick: vi.fn(async () => 700) } } };
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => api) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    store.utxoTracking.load([currentChange]);

    const createdLock = createHistoricalLock({ accountId, liquidityPromised: 0n });
    const fundedLock = { ...createdLock, fundedSatoshis: 10_000n };

    vi.mocked(BitcoinHistory.getHistoricalBitcoinReleaseRequest)
      .mockResolvedValueOnce({
        releaseNumber: 1,
        toScriptPubkey: '0x0014',
        bitcoinNetworkFee: 100n,
        destinationSatoshis: 3_000n,
        changeSatoshis: 6_900n,
        cosignDueFrame: 10,
        expectedTransactionId: `0x${'22'.repeat(32)}`,
        securitizationAtRisk: 3_100n,
      })
      .mockResolvedValueOnce({
        releaseNumber: 2,
        toScriptPubkey: '0x0014',
        bitcoinNetworkFee: 100n,
        destinationSatoshis: 2_000n,
        changeSatoshis: 4_800n,
        cosignDueFrame: 11,
        expectedTransactionId: `0x${'33'.repeat(32)}`,
        securitizationAtRisk: 2_100n,
      });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(fundedLock)
      .mockResolvedValueOnce({
        ...createHistoricalLock({ accountId, liquidityPromised: 0n }),
        fundedSatoshis: 6_900n,
        securitizedSatoshis: 6_900n,
        securitizationCoverageMicrogons: 6_900n,
      })
      .mockResolvedValueOnce({
        ...createHistoricalLock({ accountId, liquidityPromised: 0n }),
        fundedSatoshis: 4_800n,
        securitizedSatoshis: 4_800n,
        securitizationCoverageMicrogons: 4_800n,
      });
    vi.mocked(BitcoinHistory.getHistoricalBitcoinFundingUtxos)
      .mockResolvedValueOnce([{ utxoRef: { txid: `0x${'11'.repeat(32)}`, vout: 0 }, satoshis: 10_000n }])
      .mockResolvedValueOnce([{ utxoRef: { txid: `0x${'22'.repeat(32)}`, vout: 1 }, satoshis: 6_900n }])
      .mockResolvedValueOnce([{ utxoRef: { txid: `0x${'33'.repeat(32)}`, vout: 1 }, satoshis: 4_800n }]);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock(historyBlock(198), [
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 0n,
        securitization: 10_000n,
        lockedTargetPrice: 1_000n,
        accountId,
        securityFee: 0n,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(199), [
      historyEvent(157, 'bitcoinUtxos', 'UtxoVerified', {
        utxoId: 7,
        satoshisReceived: 10_000n,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(200), [
      historyEvent(159, 'bitcoinLocks', 'BitcoinUtxoCosignRequested', {
        lockId: 7,
        vaultId: 1,
        releaseNumber: 1,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(201), [
      historyEvent(159, 'bitcoinLocks', 'BitcoinUtxoCosigned', {
        lockId: 7,
        vaultId: 1,
        releaseNumber: 1,
        signatures: ['0x01'],
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(202), [
      historyEvent(159, 'bitcoinLocks', 'BitcoinSpentAfterRelease', {
        lockId: 7,
        vaultId: 1,
        releaseNumber: 1,
        bitcoinHeight: 600,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(203), [
      historyEvent(159, 'bitcoinLocks', 'BitcoinUtxoCosignRequested', {
        lockId: 7,
        vaultId: 1,
        releaseNumber: 2,
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(204), [
      historyEvent(159, 'bitcoinLocks', 'BitcoinUtxoCosigned', {
        lockId: 7,
        vaultId: 1,
        releaseNumber: 2,
        signatures: ['0x02'],
      }),
    ]);
    await store.recovery.recoverBlock(historyBlock(205), [
      historyEvent(159, 'bitcoinLocks', 'BitcoinSpentAfterRelease', {
        lockId: 7,
        vaultId: 1,
        releaseNumber: 2,
        bitcoinHeight: 601,
      }),
    ]);
    await publishRecoveredHistory(store, 205);

    const retainedLock = await db.bitcoinLocksTable.getByLockId(7);
    expect(retainedLock).toMatchObject({
      status: BitcoinLockStatus.LockFunded,
      fundedSatoshis: 4_800n,
      securitizedSatoshis: 4_800n,
      activeReleaseId: undefined,
    });
    expect(retainedLock?.removalReason).toBeUndefined();
    expect(await db.bitcoinReleasesTable.fetchAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lock:7:1', releaseNumber: 1, status: BitcoinReleaseStatus.Complete }),
        expect.objectContaining({ id: 'lock:7:2', releaseNumber: 2, status: BitcoinReleaseStatus.Complete }),
      ]),
    );
    expect(await db.bitcoinUtxosTable.fetchAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          txid: `0x${'11'.repeat(32)}`,
          spendStatus: BitcoinUtxoSpendStatus.Spent,
          spentByReleaseId: 'lock:7:1',
        }),
        expect.objectContaining({
          txid: `0x${'22'.repeat(32)}`,
          spendStatus: BitcoinUtxoSpendStatus.Spent,
          spentByReleaseId: 'lock:7:2',
        }),
        expect.objectContaining({
          txid: `0x${'33'.repeat(32)}`,
          satoshis: 4_800n,
          spendStatus: BitcoinUtxoSpendStatus.Unspent,
          createdByReleaseId: 'lock:7:2',
        }),
      ]),
    );
  });

  it('rebuilds exact securitization terms from native snapshots and Argon event ticks', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const createdLock = {
      ...createHistoricalLock({ accountId, liquidityPromised: 0n }),
      securityFees: 100n,
      couponFeesPaid: 0n,
    };
    const resecuritizedLock = {
      ...createdLock,
      securitizationCoverageMicrogons: 1_200n,
      securityFees: 130n,
      couponFeesPaid: 10n,
    };
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'securitization-term-history',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock({
        ...BitcoinHistory.toBitcoinLockDetails(createdLock),
        securitizationCoverageMicrogons: 1_000n,
      }),
    });
    record.status = BitcoinLockStatus.LockFunded;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(resecuritizedLock);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock({ ...historyBlock(159), tick: 500 }, [
      historyEvent(159, 'bitcoinLocks', 'BitcoinLockCreated', {
        lockId: 7,
        vaultId: 1,
        securitizationBasis: { satoshis: 10_000n, microgonsAtTargetPerBtc: 1_000n },
        collateralRequired: 2_000n,
        accountId,
        securityFee: 100n,
      }),
    ]);
    await store.recovery.recoverBlock({ ...historyBlock(170), tick: 550 }, [
      historyEvent(159, 'bitcoinLocks', 'BitcoinLockResecuritized', {
        lockId: 7,
        vaultId: 1,
        securitizationBasis: { satoshis: 10_000n, microgonsAtTargetPerBtc: 1_200n },
        accountId,
      }),
    ]);
    await store.recovery.recoverBlock({ ...historyBlock(180), tick: 600 }, [
      historyEvent(159, 'bitcoinLocks', 'BitcoinLockTerminated', {
        lockId: 7,
        vaultId: 1,
        wasUtxoSpent: true,
        burnedArgons: 0n,
      }),
    ]);
    await publishRecoveredHistory(store);

    expect(await db.bitcoinLocksTable.getByLockId(7)).toMatchObject({
      securityFees: 100n,
      couponFeesPaid: 0n,
    });
    expect((await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(accountId))?.terms).toEqual([
      expect.objectContaining({
        origin: 'created',
        startTick: 500,
        endTick: 550,
        endReason: 'resecuritized',
        securitizedSatoshis: 10_000n,
        cumulativeNetSecurityFee: 100n,
        addedNetSecurityFee: 100n,
      }),
      expect.objectContaining({
        origin: 'resecuritized',
        startTick: 550,
        endTick: 600,
        endReason: 'released',
        securitizationCoverageMicrogons: 1_200n,
        cumulativeNetSecurityFee: 120n,
        addedNetSecurityFee: 20n,
      }),
    ]);
  });

  it('preserves the chain-recorded coupon while replaying Lock creation', async () => {
    const db = await createTestDb();
    const accountId = encodeAddress(new Uint8Array(32).fill(0x33));
    const chainLock = {
      ...createHistoricalLock({ accountId, liquidityPromised: 0n }),
      securityFees: 3_000_000n,
      couponFeesPaid: 1_000_000n,
    };
    chainLock.ownerPubkey = `0x${chainLock.ownerPubkey}`;
    await db.transactionsTable.insert({
      extrinsicHash: `0x${'11'.repeat(32)}`,
      extrinsicMethodJson: { section: 'bitcoinLocks', method: 'initialize' },
      extrinsicType: ExtrinsicType.BitcoinRequestLock,
      metadataJson: {
        bitcoin: {
          uuid: 'partial-security-fee-coupon',
          vaultId: 1,
          satoshis: 10_000n,
          hdPath: "m/84'/0'/0'/3",
          lockedTargetPrice: chainLock.lockedTargetPrice,
          liquidityPromised: 0n,
          securityFee: 3_000_000n,
        },
      },
      accountAddress: accountId,
      submittedAtBlockHeight: 158,
      submittedAtTime: new Date('2026-01-01T00:00:00Z'),
      txNonce: 1,
    });
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => ({})) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: accountId } as WalletKeys,
    });
    vi.spyOn(store, 'getDerivedPubkey').mockResolvedValue({
      address: 'tb1qhistory',
      hdIndex: 3,
      hdPath: "m/84'/0'/0'/3",
      ownerBitcoinPubkey: hexToU8a(`02${'33'.repeat(32)}`),
    } as Awaited<ReturnType<BitcoinLocks['getDerivedPubkey']>>);
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock).mockResolvedValue(chainLock);

    await store.recovery.beginHistoryReplay({ lockScope: 'all' });
    await store.recovery.recoverBlock({ ...historyBlock(159), tick: 500 }, [
      historyEvent(159, 'bitcoinLocks', 'BitcoinLockCreated', {
        lockId: 7,
        vaultId: 1,
        securitizationBasis: { satoshis: 10_000n, microgonsAtTargetPerBtc: 1_000n },
        collateralRequired: 2_000n,
        accountId,
        securityFee: 3_000_000n,
      }),
    ]);
    await publishRecoveredHistory(store);

    expect(await db.bitcoinLocksTable.getByLockId(7)).toMatchObject({
      securityFees: 3_000_000n,
      couponFeesPaid: 1_000_000n,
    });
  });

  it('reconstructs legacy operator securitization coupons from event-time vault ownership', async () => {
    const db = await createTestDb();
    const operatorAccount = encodeAddress(new Uint8Array(32).fill(0x44));
    const createdLock = {
      ...createHistoricalLock({ accountId: operatorAccount, liquidityPromised: 100n }),
      securityFees: 4n,
      couponFeesPaid: 0n,
    };
    const increasedLock = {
      ...createdLock,
      securityFees: 7n,
    };
    const ratchetedLock = {
      ...increasedLock,
      lockedTargetPrice: 1_200n,
      liquidityPromised: 130n,
      securityFees: 10n,
      // Older storage did not preserve the operator exemption as a coupon.
      couponFeesPaid: 0n,
    };
    const pending = await db.bitcoinLocksTable.insertPending({
      uuid: 'operator-ratchet-coupon',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      securitizedSatoshis: 10_000n,
      cosignVersion: 'v1',
      network: 'testnet',
      hdPath: "m/84'/0'/0'",
      vaultId: 1,
    });
    const record = await db.bitcoinLocksTable.finalizePending({
      uuid: pending.uuid,
      lock: createCurrentLock(BitcoinHistory.toBitcoinLockDetails(ratchetedLock)),
    });
    record.status = BitcoinLockStatus.LockFunded;
    await db.bitcoinLocksTable.saveRecoveredHistory(record);
    const archiveApi = {
      runtimeVersion: { specVersion: { toNumber: () => 157 } },
      query: {
        bitcoinUtxos: { confirmedBitcoinBlockTip: async () => ({ blockHeight: 500n }) },
        vaults: {
          vaultsById: async () => ({ operatorAccountId: { toString: () => 'historical-operator' } }),
        },
      },
    };
    const store = createStore({
      db,
      blockWatch: { getApi: vi.fn(async () => archiveApi) } as unknown as BlockWatch,
      walletKeys: { defaultArgonAddress: operatorAccount } as WalletKeys,
    });
    store.data.locksByLockId[7] = record;
    vi.mocked(BitcoinHistory.getHistoricalBitcoinLock)
      .mockResolvedValueOnce(createdLock)
      .mockResolvedValueOnce(increasedLock)
      .mockResolvedValueOnce(ratchetedLock);

    await store.recovery.beginHistoryReplay({ lockScope: 'all', ownedVaultId: 1 });
    await store.recovery.recoverBlock({ ...historyBlock(157), tick: 500 }, [
      historyEvent(157, 'vaults', 'FundsLocked', {
        vaultId: 1,
        locker: operatorAccount,
        liquidityPromised: 100n,
        isRatchet: false,
        feeRevenue: 4n,
        didUseFeeCoupon: false,
      }),
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockCreated', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 100n,
        securitization: 1_000n,
        lockedTargetPrice: createdLock.lockedTargetPrice,
        accountId: operatorAccount,
        securityFee: 0n,
      }),
      historyEvent(157, 'transactionPayment', 'TransactionFeePaid', {
        who: operatorAccount,
        actualFee: 5n,
        tip: 0n,
      }),
    ]);
    await store.recovery.recoverBlock({ ...historyBlock(158), tick: 505 }, [
      historyEvent(158, 'bitcoinLocks', 'SecuritizationIncreased', {
        utxoId: 7,
        vaultId: 1,
        newSatoshis: increasedLock.securitizedSatoshis,
        accountId: operatorAccount,
      }),
    ]);
    await store.recovery.recoverBlock({ ...historyBlock(157), blockNumber: 160, tick: 510 }, [
      historyEvent(157, 'vaults', 'FundsLocked', {
        vaultId: 1,
        locker: operatorAccount,
        liquidityPromised: 130n,
        isRatchet: true,
        feeRevenue: 3n,
        didUseFeeCoupon: false,
      }),
      historyEvent(157, 'bitcoinLocks', 'BitcoinLockRatcheted', {
        utxoId: 7,
        vaultId: 1,
        liquidityPromised: 130n,
        oldTargetPrice: createdLock.lockedTargetPrice,
        securityFee: 3n,
        newTargetPrice: ratchetedLock.lockedTargetPrice,
        amountBurned: 0n,
        accountId: operatorAccount,
      }),
      historyEvent(157, 'transactionPayment', 'TransactionFeePaid', {
        who: operatorAccount,
        actualFee: 7n,
        tip: 0n,
      }),
    ]);
    const fissions = new BitcoinFissions(Promise.resolve(db), operatorAccount);
    await fissions.recovery.beginHistoryReplay({ replace: true });
    await publishBitcoinHistoryReplay({
      bitcoinLocks: store,
      bitcoinFissions: fissions,
      asOfBlock: 160,
    });

    expect(await db.bitcoinLocksTable.getByLockId(7)).toMatchObject({ securityFees: 10n, couponFeesPaid: 0n });
    expect((await db.bitcoinSecuritizationHistoryTable.getPublishedSnapshot(operatorAccount))?.terms).toEqual([
      expect.objectContaining({ cumulativeNetSecurityFee: 0n, addedNetSecurityFee: 0n }),
    ]);
    expect(await db.bitcoinFissionsTable.fetchAll(operatorAccount)).toEqual([
      expect.objectContaining({
        ratchets: [
          expect.objectContaining({ securityFee: 7n, securityFeeCoupon: 7n, txFee: 5n }),
          expect.objectContaining({ securityFee: 3n, securityFeeCoupon: 3n, txFee: 7n }),
        ],
      }),
    ]);
  });
});
