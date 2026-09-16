import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { createTestDb } from './helpers/db.ts';
import BitcoinUtxoTracking, { type IUtxoTrackingDeps } from '../lib/BitcoinUtxoTracking.ts';
import { BitcoinLockStatus } from '../lib/db/BitcoinLocksTable.ts';
import type { IBitcoinLockRecord } from '../interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type { ArgonClient } from '@argonprotocol/apps-core';
import { createBitcoinLockConfig, createCurrentLock } from './helpers/bitcoin.ts';

type IMempoolTestDeps = Pick<IUtxoTrackingDeps['mempool'], 'getAddressUtxos' | 'getTipHeight' | 'getTxStatus'>;

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    lockId: overrides.lockId ?? 1,
    status: overrides.status ?? BitcoinLockStatus.LockPendingFunding,
    securitizedSatoshis: overrides.securitizedSatoshis ?? 10_000n,
    ownerAccount: overrides.ownerAccount ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    securityFees: overrides.securityFees ?? 0n,
    couponFeesPaid: overrides.couponFeesPaid ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: overrides.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
    cosignVersion: overrides.cosignVersion ?? 'v1',
    scriptDetails: overrides.scriptDetails ?? createLockDetails(),
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    fundedSatoshis: overrides.fundedSatoshis ?? 0n,
    fundingUtxoIds: overrides.fundingUtxoIds ?? [],
  };
}

function createTracking(
  db: Awaited<ReturnType<typeof createTestDb>>,
  overrides?: {
    mempool?: Partial<IMempoolTestDeps>;
    getOracleBitcoinBlockHeight?: () => number;
  },
) {
  const mempool = {
    getAddressUtxos: overrides?.mempool?.getAddressUtxos ?? vi.fn().mockResolvedValue([]),
    getTipHeight: overrides?.mempool?.getTipHeight ?? vi.fn().mockResolvedValue(125),
    getTxStatus: overrides?.mempool?.getTxStatus ?? vi.fn(),
  } satisfies IMempoolTestDeps;

  return new BitcoinUtxoTracking({
    dbPromise: Promise.resolve(db),
    getBitcoinNetwork: () => BitcoinNetwork.Bitcoin,
    getOracleBitcoinBlockHeight: overrides?.getOracleBitcoinBlockHeight ?? (() => 110),
    getConfig: () => createBitcoinLockConfig(),
    getMainchainClient: async () => ({}) as unknown as ArgonClient,
    mempool: mempool as IUtxoTrackingDeps['mempool'],
  });
}

function createLockDetails(): NonNullable<IBitcoinLockRecord['scriptDetails']> {
  return {
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    vaultPubkey: `02${'11'.repeat(32)}`,
    vaultClaimPubkey: `02${'22'.repeat(32)}`,
    ownerPubkey: `02${'33'.repeat(32)}`,
    vaultXpubSources: { parentFingerprint: new Uint8Array(4), cosignHdIndex: 0, claimHdIndex: 0 },
    createdAtHeight: 100,
    vaultClaimHeight: 200,
    openClaimHeight: 300,
  };
}

describe('BitcoinUtxoTracking', () => {
  it('upserts funding records and stores mempool observations', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock();

    const record = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'a'.repeat(64), vout: 0, satoshis: 11_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 11_000n,
          txid: 'a'.repeat(64),
          vout: 0,
          transactionBlockHeight: 120,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    const reloaded = tracking.getUtxoRecord(lock.lockId!, record.txid, record.vout)!;
    expect(reloaded.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(reloaded.firstSeenBitcoinHeight).toBe(120);
    expect(reloaded.mempoolObservation?.satoshis).toBe(11_000n);
    expect(tracking.hasObservedFundingSignal(lock)).toBe(true);
  });

  it('tracks every observed deposit while funding remains pending', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ securitizedSatoshis: 10_000n });

    await tracking.upsertUtxoRecord(lock, { txid: 'a'.repeat(64), vout: 0, satoshis: 8_000n }, {});
    await tracking.upsertUtxoRecord(lock, { txid: 'b'.repeat(64), vout: 1, satoshis: 10_200n }, {});
    await tracking.upsertUtxoRecord(lock, { txid: 'c'.repeat(64), vout: 2, satoshis: 14_000n }, {});

    const observed = tracking.getObservedFundingUtxos(lock);
    expect(observed.map(record => record.txid)).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    expect(tracking.getReceivedFundingSatoshis(lock)).toBe(32_200n);
  });

  it('tracks a later observed deposit independently of an already funded lock', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded, fundedSatoshis: 10_000n });
    const fundingUtxo = await tracking.upsertUtxoRecord(lock, { txid: 'a'.repeat(64), vout: 0, satoshis: 10_000n }, {});
    await db.bitcoinUtxosTable.setFundingUtxo(fundingUtxo);
    lock.fundingUtxoIds = [fundingUtxo.id];

    await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 1, satoshis: 5_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 5_000n,
          txid: 'b'.repeat(64),
          vout: 1,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    expect(tracking.getLockProcessingDetails(lock)).toMatchObject({
      progressPct: 0,
      confirmations: -1,
      receivedSatoshis: 15_000n,
    });
  });

  it('reports confirmation progress for each observed deposit independently', async () => {
    const db = await createTestDb();
    let oracleBitcoinBlockHeight = 111;
    const tracking = createTracking(db, { getOracleBitcoinBlockHeight: () => oracleBitcoinBlockHeight });
    const lock = createLock({ status: BitcoinLockStatus.LockFunded, fundedSatoshis: 10_000n });
    const confirmed = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 0, satoshis: 5_000n },
      {
        mempoolObservation: {
          isConfirmed: true,
          confirmations: 1,
          satoshis: 5_000n,
          txid: 'b'.repeat(64),
          vout: 0,
          transactionBlockHeight: 120,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 111,
        },
      },
    );
    oracleBitcoinBlockHeight = 118;
    const unconfirmed = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 1, satoshis: 6_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 6_000n,
          txid: 'c'.repeat(64),
          vout: 1,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 118,
        },
      },
    );

    expect(tracking.getFundingUtxoProcessingDetails(confirmed).confirmations).toBe(7);
    expect(tracking.getFundingUtxoProcessingDetails(unconfirmed).confirmations).toBe(-1);
  });

  it('captures the oracle height when funding first becomes confirmed', async () => {
    const db = await createTestDb();
    let oracleBitcoinBlockHeight = 110;
    const tracking = createTracking(db, {
      getOracleBitcoinBlockHeight: () => oracleBitcoinBlockHeight,
    });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const record = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 0, satoshis: 10_000n },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: 10_000n,
          txid: 'c'.repeat(64),
          vout: 0,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    oracleBitcoinBlockHeight = 111;
    await tracking.upsertUtxoRecord(
      lock,
      { txid: record.txid, vout: record.vout, satoshis: record.satoshis },
      {
        mempoolObservation: {
          isConfirmed: true,
          confirmations: 1,
          satoshis: 10_000n,
          txid: record.txid,
          vout: record.vout,
          transactionBlockHeight: 120,
          transactionBlockTime: 1710000300,
          argonBitcoinHeight: 111,
        },
      },
    );

    oracleBitcoinBlockHeight = 118;

    const details = tracking.getLockProcessingDetails(lock);

    expect(record.firstSeenOracleHeight).toBe(111);
    expect(details.confirmations).toBe(7);
    expect(details.expectedConfirmations).toBe(9);
  });

  it('hydrates a runtime-classified orphan into the local table', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });
    const chainTxid = 'f'.repeat(64);
    const orphanedEntriesQuery = vi.fn().mockResolvedValue([
      [
        { args: [{}, { txid: chainTxid, outputIndex: 2 }] },
        {
          lockId: lock.lockId,
          satoshis: 10_200n,
          cosignRequest: null,
        },
      ],
    ]);
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinLocks: Object.assign(Object.create(null), {
          orphanedUtxosByAccount: Object.assign(Object.create(null), {
            entries: orphanedEntriesQuery,
          }),
        }),
      }),
    }) as ArgonClient;

    await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(orphanedEntriesQuery).toHaveBeenCalledWith(lock.ownerAccount);
    const orphan = tracking.getUnresolvedOrphanRecords([lock])[0];
    expect(orphan.txid).toBe(chainTxid);
    expect(orphan.vout).toBe(2);
    expect(orphan.satoshis).toBe(10_200n);
    expect(orphan.firstSeenOnArgonAt).toBeInstanceOf(Date);
    expect(orphan.status).toBe(BitcoinUtxoStatus.Orphaned);
  });

  it('records mempool funding while runtime orphan classification is unavailable', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db, {
      mempool: {
        getAddressUtxos: vi.fn().mockResolvedValue([
          {
            txid: 'd'.repeat(64),
            vout: 0,
            value: 10_100,
            status: {
              confirmed: true,
              block_height: 125,
              block_time: 1710000000,
            },
          },
        ]),
      },
    });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinLocks: Object.assign(Object.create(null), {
          orphanedUtxosByAccount: Object.assign(Object.create(null), {
            entries: vi.fn().mockRejectedValue(new Error('rpc timeout')),
          }),
        }),
      }),
    }) as ArgonClient;

    const hasSignals = await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(hasSignals).toBe(true);
    const [observed] = tracking.getObservedFundingUtxos(lock);
    expect(observed?.txid).toBe('d'.repeat(64));
    expect(observed?.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(observed?.mempoolObservation?.isConfirmed).toBe(true);
  });

  it('still records a runtime orphan when mempool observation fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = await createTestDb();
    const tracking = createTracking(db, {
      mempool: {
        getAddressUtxos: vi.fn().mockRejectedValue(new Error('esplora unavailable')),
      },
    });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });
    const chainTxid = 'e'.repeat(64);
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinLocks: Object.assign(Object.create(null), {
          orphanedUtxosByAccount: Object.assign(Object.create(null), {
            entries: vi.fn().mockResolvedValue([
              [
                { args: [{}, { txid: chainTxid, outputIndex: 1 }] },
                {
                  lockId: lock.lockId,
                  satoshis: 10_100n,
                  cosignRequest: null,
                },
              ],
            ]),
          }),
        }),
      }),
    }) as ArgonClient;

    const hasSignals = await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(hasSignals).toBe(true);
    expect(tracking.getUnresolvedOrphanRecords([lock])).toEqual([
      expect.objectContaining({ txid: chainTxid, status: BitcoinUtxoStatus.Orphaned }),
    ]);
    expect(warning).toHaveBeenCalledWith(
      '[BitcoinUtxoTracking] Failed to observe mempool funding for lock lock-1 (lockId 1)',
      expect.objectContaining({ message: 'esplora unavailable' }),
    );
    warning.mockRestore();
  });

  it('keeps an observed deposit when its mempool observation is refreshed', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const deposit = await tracking.upsertUtxoRecord(lock, { txid: 'e'.repeat(64), vout: 3, satoshis: 10_200n }, {});

    await tracking.upsertUtxoRecord(
      lock,
      { txid: deposit.txid, vout: deposit.vout, satoshis: deposit.satoshis },
      {
        mempoolObservation: {
          isConfirmed: false,
          confirmations: 0,
          satoshis: deposit.satoshis,
          txid: deposit.txid,
          vout: deposit.vout,
          transactionBlockHeight: 0,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 110,
        },
      },
    );

    const reloaded = tracking.getUtxoRecord(lock.lockId!, deposit.txid, deposit.vout)!;
    expect(reloaded.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(reloaded.mempoolObservation?.txid).toBe(deposit.txid);
  });

  it('keeps a failed orphan return actionable while lock is pending funding', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const orphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: '9'.repeat(64), vout: 0, satoshis: 9_900n },
      { markOrphaned: true },
    );
    await tracking.setStatusError(orphan, 'temporary failure');

    const unresolved = tracking.getUnresolvedOrphanRecords([lock]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].id).toBe(orphan.id);
    expect(unresolved[0].status).toBe(BitcoinUtxoStatus.Orphaned);
    expect(unresolved[0].statusError).toBe('temporary failure');
  });

  it('does not infer that another observed deposit is an orphan when funding is accepted', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    tracking.data = Vue.reactive(tracking.data) as typeof tracking.data;
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 10_000n,
      fundingUtxos: [{ utxoRef: { txid: '8'.repeat(64), vout: 0 }, satoshis: 10_000n }],
    });
    const pending = await db.bitcoinLocksTable.insertPending(createLock({ lockId: undefined }));
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });

    const acceptedRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '8'.repeat(64), vout: 0, satoshis: lock.securitizedSatoshis },
      {},
    );
    const otherObservedDeposit = await tracking.upsertUtxoRecord(
      lock,
      { txid: '9'.repeat(64), vout: 1, satoshis: lock.securitizedSatoshis + 200n },
      {},
    );
    const unresolvedOrphans = Vue.computed(() => tracking.getUnresolvedOrphanRecords([lock]));
    expect(unresolvedOrphans.value).toEqual([]);

    await tracking.syncFundingUtxos(lock, currentLock);

    expect(acceptedRecord.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(otherObservedDeposit.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(unresolvedOrphans.value).toEqual([]);

    const history = await db.bitcoinUtxosTable.fetchStatusHistory(otherObservedDeposit.id);
    expect(history.at(-1)?.newStatus).toBe(BitcoinUtxoStatus.SeenOnMempool);
  });

  it('materializes every runtime-accepted funding outpoint without promoting other observations', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 10_000n,
      fundingUtxos: [
        { utxoRef: { txid: '8'.repeat(64), vout: 0 }, satoshis: 4_000n },
        { utxoRef: { txid: '9'.repeat(64), vout: 2 }, satoshis: 6_000n },
      ],
    });
    const pending = await db.bitcoinLocksTable.insertPending(createLock({ lockId: undefined }));
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });
    lock.fissionedSatoshis = lock.securitizedSatoshis;
    await tracking.syncFundingUtxos(lock, currentLock);
    const observed = await tracking.upsertUtxoRecord(lock, { txid: '7'.repeat(64), vout: 3, satoshis: 2_000n }, {});

    const fundingUtxos = tracking.getFundingUtxos(lock);
    expect(lock.fundingUtxoIds).toEqual(fundingUtxos.map(utxo => utxo.id));
    expect(lock.fundedSatoshis).toBe(10_000n);
    expect(lock.fissionedSatoshis).toBe(0n);
    expect(fundingUtxos).toEqual([
      expect.objectContaining({ txid: '8'.repeat(64), vout: 0, satoshis: 4_000n }),
      expect.objectContaining({ txid: '9'.repeat(64), vout: 2, satoshis: 6_000n }),
    ]);
    expect(tracking.getUtxosForLock(lock.lockId!)).toContain(observed);
    expect(observed.status).toBe(BitcoinUtxoStatus.SeenOnMempool);

    const reloadedLock = await db.bitcoinLocksTable.getByLockId(lock.lockId!);
    const reloadedTracking = createTracking(db);
    reloadedTracking.load(await db.bitcoinUtxosTable.fetchAll());
    expect(reloadedLock?.fundingUtxoIds).toEqual(lock.fundingUtxoIds);
    expect(reloadedLock && reloadedTracking.getFundingUtxos(reloadedLock).map(utxo => utxo.id)).toEqual(
      lock.fundingUtxoIds,
    );
  });

  it('does not overwrite a release transition that completes while funding synchronization publishes', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const currentLock = createCurrentLock({
      lockId: 1,
      fundedSatoshis: 10_000n,
      fundingUtxos: [{ utxoRef: { txid: '8'.repeat(64), vout: 0 }, satoshis: 10_000n }],
    });
    const pending = await db.bitcoinLocksTable.insertPending(createLock({ lockId: undefined }));
    const lock = await db.bitcoinLocksTable.finalizePending({ uuid: pending.uuid, lock: currentLock });
    await db.bitcoinLocksTable.setStatus(lock, BitcoinLockStatus.LockFunded);

    let finishFundingSync!: () => void;
    let fundingSyncPersisted!: () => void;
    const waitForFundingSyncToPersist = new Promise<void>(resolve => (fundingSyncPersisted = resolve));
    const waitToPublishFundingSync = new Promise<void>(resolve => (finishFundingSync = resolve));
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      const result = await transaction(callback);
      fundingSyncPersisted();
      await waitToPublishFundingSync;
      return result;
    });

    const fundingSync = tracking.syncFundingUtxos(lock, currentLock);
    await waitForFundingSyncToPersist;
    await db.bitcoinLocksTable.setActiveRelease(lock, 'release-1');
    finishFundingSync();
    await fundingSync;

    expect(lock.status).toBe(BitcoinLockStatus.Releasing);
    expect(lock.activeReleaseId).toBe('release-1');

    const staleLock = { ...lock, status: BitcoinLockStatus.LockFunded, activeReleaseId: undefined };
    await tracking.syncFundingUtxos(staleLock, currentLock);
    await expect(db.bitcoinLocksTable.getByLockId(lock.lockId!)).resolves.toMatchObject({
      status: BitcoinLockStatus.Releasing,
      activeReleaseId: 'release-1',
    });
  });

  it('selects unresolved orphan records independently from their lock state', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded });
    const additionalOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'e'.repeat(64), vout: 4, satoshis: lock.securitizedSatoshis + 1_000n },
      { markOrphaned: true },
    );
    const exactAmountOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 1, satoshis: lock.securitizedSatoshis },
      { markOrphaned: true },
    );
    const returningOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 2, satoshis: lock.securitizedSatoshis + 500n },
      { markOrphaned: true },
    );
    const returnedOrphan = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'd'.repeat(64), vout: 3, satoshis: lock.securitizedSatoshis - 500n },
      { markOrphaned: true },
    );

    await db.bitcoinUtxosTable.setSpent(returnedOrphan, 'completed-release');

    const records = tracking.getUnresolvedOrphanRecords([lock]);
    expect(records).toHaveLength(3);
    expect(records).toEqual(expect.arrayContaining([additionalOrphan, returningOrphan, exactAmountOrphan]));
  });

  it('synchronizes all chain orphans with one query per owner', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const firstLock = createLock({ lockId: 1, uuid: 'lock-1' });
    const secondLock = createLock({ lockId: 2, uuid: 'lock-2' });
    const thirdLock = createLock({
      lockId: 3,
      uuid: 'lock-3',
      ownerAccount: 'owner-2',
    });
    const orphanEntry = (lockId: number, txid: string, vout: number, satoshis: bigint) => [
      { args: [{}, { txid, outputIndex: vout }] },
      {
        lockId,
        satoshis,
        cosignRequest: null,
      },
    ];
    const entries = vi.fn().mockImplementation(async (owner: string) => {
      if (owner === thirdLock.ownerAccount) {
        return [orphanEntry(3, 'c'.repeat(64), 0, 12_000n)];
      }
      return [
        orphanEntry(1, 'a'.repeat(64), 0, 10_000n),
        orphanEntry(1, 'b'.repeat(64), 1, 11_000n),
        orphanEntry(99, 'f'.repeat(64), 0, 99_000n),
      ];
    });
    const client = {
      query: { bitcoinLocks: { orphanedUtxosByAccount: { entries } } },
    } as unknown as ArgonClient;

    const records = await tracking.syncArgonOrphans([firstLock, secondLock, thirdLock], client);

    expect(entries).toHaveBeenCalledTimes(2);
    expect(records.map(record => `${record.lockId}:${record.txid}:${record.vout}`)).toEqual([
      `1:${'a'.repeat(64)}:0`,
      `1:${'b'.repeat(64)}:1`,
      `3:${'c'.repeat(64)}:0`,
    ]);
    await tracking.syncArgonOrphans([firstLock, secondLock, thirdLock], client);
    expect(tracking.getUtxosForLock(firstLock.lockId!)).toHaveLength(2);
    expect(tracking.getUtxosForLock(thirdLock.lockId!)).toHaveLength(1);
  });
});
