import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { createTestDb } from './helpers/db.ts';
import BitcoinUtxoTracking, { type IUtxoTrackingDeps } from '../lib/BitcoinUtxoTracking.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoRole, BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type { ArgonClient, MiningFrames } from '@argonprotocol/apps-core';
import { createBitcoinLockConfig } from './helpers/bitcoin.ts';

type IMempoolTestDeps = Pick<IUtxoTrackingDeps['mempool'], 'getAddressUtxos' | 'getTipHeight' | 'getTxStatus'>;

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    utxoId: overrides.utxoId ?? 1,
    status: overrides.status ?? BitcoinLockStatus.LockPendingFunding,
    securitizedSatoshis: overrides.securitizedSatoshis ?? 10_000n,
    ownerAccount: overrides.ownerAccount ?? '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    securityFees: overrides.securityFees ?? 0n,
    couponFeesPaid: overrides.couponFeesPaid ?? 0n,
    fundHoldExtensionsByBitcoinExpirationHeight: overrides.fundHoldExtensionsByBitcoinExpirationHeight ?? {},
    utxos: overrides.utxos ?? [],
    fundedSatoshis: overrides.fundedSatoshis ?? 0n,
    cosignVersion: overrides.cosignVersion ?? 'v1',
    scriptDetails: overrides.scriptDetails ?? createLockDetails(),
    fundingUtxo: overrides.fundingUtxo,
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
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

    const reloaded = tracking.getUtxoRecord(lock.utxoId!, record.txid, record.vout)!;
    expect(reloaded.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(reloaded.firstSeenBitcoinHeight).toBe(120);
    expect(reloaded.mempoolObservation?.satoshis).toBe(11_000n);
    expect(tracking.hasObservedFundingSignal(lock)).toBe(true);
  });

  it('uses the earliest observed deposit while funding remains pending', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ securitizedSatoshis: 10_000n });

    await tracking.upsertUtxoRecord(lock, { txid: 'a'.repeat(64), vout: 0, satoshis: 8_000n }, {});
    await tracking.upsertUtxoRecord(lock, { txid: 'b'.repeat(64), vout: 1, satoshis: 10_200n }, {});
    await tracking.upsertUtxoRecord(lock, { txid: 'c'.repeat(64), vout: 2, satoshis: 14_000n }, {});

    const observed = tracking.getObservedFundingRecord(lock);
    expect(observed?.txid).toBe('a'.repeat(64));
    expect(tracking.getReceivedFundingSatoshis(lock)).toBe(8_000n);
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

  it('tracks the release lifecycle and restores a missing funding-record pointer', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded });

    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'f'.repeat(64), vout: 0, satoshis: lock.securitizedSatoshis },
      { markFundingUtxo: true },
    );

    expect(fundingRecord.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(fundingRecord.role).toBe(BitcoinUtxoRole.Funding);
    expect(fundingRecord.firstSeenOnArgonAt).toBeInstanceOf(Date);
    expect(tracking.getAcceptedFundingRecordForLock(lock)?.id).toBe(fundingRecord.id);

    await tracking.setReleaseRequest(fundingRecord, {
      requestedReleaseAtTick: 55,
      releaseToDestinationAddress: '0014abcd',
      releaseBitcoinNetworkFee: 400n,
    });
    expect(fundingRecord.status).toBe(BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);

    await tracking.setReleaseSeenOnBitcoinAndProcessing(fundingRecord, 'r'.repeat(64), 210);
    expect(fundingRecord.status).toBe(BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin);
    expect(tracking.isFundingRecordReleaseProcessingOnBitcoin(fundingRecord)).toBe(true);

    await tracking.setReleaseComplete(fundingRecord, 220);
    expect(tracking.isReleaseCompleteStatus(fundingRecord.status)).toBe(true);
    expect(fundingRecord.role).toBe(BitcoinUtxoRole.Funding);

    lock.status = BitcoinLockStatus.Released;
    lock.fundingUtxo = undefined;

    expect(tracking.getAcceptedFundingRecordForLock(lock)).toBe(fundingRecord);
    expect(lock.fundingUtxo).toBe(fundingRecord);
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
          utxoId: lock.utxoId,
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
    const observed = tracking.getObservedFundingRecord(lock);
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
                  utxoId: lock.utxoId,
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
      '[BitcoinUtxoTracking] Failed to observe mempool funding for lock lock-1 (utxoId 1)',
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

    const reloaded = tracking.getUtxoRecord(lock.utxoId!, deposit.txid, deposit.vout)!;
    expect(reloaded.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(reloaded.mempoolObservation?.txid).toBe(deposit.txid);
  });

  it('getRequestReleaseByVaultProgress starts at 0 when release metadata is not ready', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.Releasing });
    const miningFrames = {
      currentTick: 1_000,
      getForTick: (tick: number) => Math.floor(tick / 10),
      estimateTickStart: (frame: number) => frame * 10,
    } satisfies Pick<MiningFrames, 'currentTick' | 'getForTick' | 'estimateTickStart'>;

    expect(tracking.getRequestReleaseByVaultProgress(lock, miningFrames as MiningFrames, 4)).toBe(0);

    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'e'.repeat(64), vout: 5, satoshis: lock.securitizedSatoshis },
      { markFundingUtxo: true },
    );
    lock.fundingUtxo = fundingRecord;

    expect(tracking.getRequestReleaseByVaultProgress(lock, miningFrames as MiningFrames, 4)).toBe(0);
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
    await tracking.setReleaseError(orphan, 'temporary failure');

    const unresolved = tracking.getUnresolvedOrphanRecords([lock]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].id).toBe(orphan.id);
    expect(unresolved[0].status).toBe(BitcoinUtxoStatus.Orphaned);
    expect(unresolved[0].statusError).toBe('temporary failure');
  });

  it('ignores a stale funding pointer that belongs to a different lock', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const firstLock = createLock({ utxoId: 1, uuid: 'lock-1' });
    const secondLock = createLock({ utxoId: 2, uuid: 'lock-2' });

    const firstFundingRecord = await tracking.upsertUtxoRecord(
      firstLock,
      { txid: '1'.repeat(64), vout: 0, satoshis: firstLock.securitizedSatoshis },
      { markFundingUtxo: true },
    );
    const secondFundingRecord = await tracking.upsertUtxoRecord(
      secondLock,
      { txid: '2'.repeat(64), vout: 1, satoshis: secondLock.securitizedSatoshis },
      { markFundingUtxo: true },
    );

    firstLock.fundingUtxo = secondFundingRecord;

    const resolved = tracking.getAcceptedFundingRecordForLock(firstLock);

    expect(resolved?.id).toBe(firstFundingRecord.id);
    expect(resolved?.lockUtxoId).toBe(firstLock.utxoId);
    expect(firstLock.fundingUtxo?.id).toBe(firstFundingRecord.id);
  });

  it('recovers the accepted funding record when the pointer is missing', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ utxoId: 3, uuid: 'lock-3' });

    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '3'.repeat(64), vout: 0, satoshis: lock.securitizedSatoshis },
      { markFundingUtxo: true },
    );

    lock.fundingUtxo = undefined;

    const resolved = tracking.getAcceptedFundingRecordForLock(lock);

    expect(resolved?.id).toBe(fundingRecord.id);
    expect(lock.fundingUtxo).toBe(fundingRecord);
  });

  it('clears stale accepted funding pointers when no funding record exists', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({
      utxoId: 4,
      uuid: 'lock-4',
      fundingUtxo: { id: 999, lockUtxoId: 9 } as never,
    });

    const resolved = tracking.getAcceptedFundingRecordForLock(lock);

    expect(resolved).toBeUndefined();
    expect(lock.fundingUtxo).toBeUndefined();
  });

  it('does not reuse an old release record as active funding progress', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const oldReleaseRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '5'.repeat(64), vout: 0, satoshis: 9_900n },
      {
        mempoolObservation: {
          isConfirmed: true,
          confirmations: 6,
          satoshis: 9_900n,
          txid: '5'.repeat(64),
          vout: 0,
          transactionBlockHeight: 105,
          transactionBlockTime: 1710000000,
          argonBitcoinHeight: 104,
        },
      },
    );
    await tracking.setReleaseComplete(oldReleaseRecord, 105);

    const details = tracking.getLockProcessingDetails(lock);

    expect(details.progressPct).toBe(0);
    expect(details.confirmations).toBe(-1);
    expect(details.receivedSatoshis).toBeUndefined();
    expect(tracking.hasObservedFundingSignal(lock)).toBe(false);
  });

  it('observeMempoolFunding ignores old Argon-seen release records', async () => {
    const db = await createTestDb();
    const getAddressUtxos = vi.fn().mockResolvedValue([
      {
        txid: '6'.repeat(64),
        vout: 1,
        value: 10_100,
        status: {
          confirmed: false,
          block_height: undefined,
          block_time: undefined,
        },
      },
    ]);
    const tracking = createTracking(db, { mempool: { getAddressUtxos } });
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

    const oldRecord = await tracking.upsertUtxoRecord(lock, { txid: '7'.repeat(64), vout: 0, satoshis: 10_000n }, {});
    await tracking.setReleaseComplete(oldRecord, 105);

    const observation = await tracking.observeMempoolFunding(lock);

    expect(observation?.txid).toBe('6'.repeat(64));
    expect(observation?.vout).toBe(1);
  });

  it('does not infer that another observed deposit is an orphan when funding is accepted', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    tracking.data = Vue.reactive(tracking.data) as typeof tracking.data;
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, securitizedSatoshis: 10_000n });

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

    await tracking.setAcceptedFundingRecordForLock(lock, acceptedRecord);

    expect(acceptedRecord.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(otherObservedDeposit.status).toBe(BitcoinUtxoStatus.SeenOnMempool);
    expect(unresolvedOrphans.value).toEqual([]);

    const history = await db.bitcoinUtxosTable.fetchStatusHistory(otherObservedDeposit.id);
    expect(history.at(-1)?.newStatus).toBe(BitcoinUtxoStatus.SeenOnMempool);
  });

  it('selects unresolved orphan records independently from their lock state', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockFunded });
    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'a'.repeat(64), vout: 0, satoshis: lock.securitizedSatoshis },
      { markFundingUtxo: true },
    );
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

    await tracking.setReleaseIsProcessingOnArgon(fundingRecord, {
      releaseToDestinationAddress: '0014aaaa',
      releaseBitcoinNetworkFee: 100n,
    });
    await tracking.setReleaseIsProcessingOnArgon(additionalOrphan, {
      releaseToDestinationAddress: '0014cccc',
      releaseBitcoinNetworkFee: 300n,
    });
    await tracking.setReleaseIsProcessingOnArgon(returningOrphan, {
      releaseToDestinationAddress: '0014bbbb',
      releaseBitcoinNetworkFee: 200n,
    });
    await tracking.setReleaseComplete(returnedOrphan, 120);

    const records = tracking.getUnresolvedOrphanRecords([lock]);
    expect(records).toHaveLength(3);
    expect(records).toEqual(expect.arrayContaining([additionalOrphan, returningOrphan, exactAmountOrphan]));
  });

  it('synchronizes all chain orphans with one query per owner', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const firstLock = createLock({ utxoId: 1, uuid: 'lock-1' });
    const secondLock = createLock({ utxoId: 2, uuid: 'lock-2' });
    const thirdLock = createLock({
      utxoId: 3,
      uuid: 'lock-3',
      ownerAccount: 'owner-2',
    });
    const orphanEntry = (
      utxoId: number,
      txid: string,
      vout: number,
      satoshis: bigint,
      releaseRequest?: { bitcoinNetworkFee: bigint; toScriptPubkey: Uint8Array },
    ) => [
      { args: [{}, { txid, outputIndex: vout }] },
      {
        utxoId,
        satoshis,
        cosignRequest: releaseRequest ?? null,
      },
    ];
    const entries = vi.fn().mockImplementation(async (owner: string) => {
      if (owner === thirdLock.ownerAccount) {
        return [orphanEntry(3, 'c'.repeat(64), 0, 12_000n)];
      }
      return [
        orphanEntry(1, 'a'.repeat(64), 0, 10_000n, {
          bitcoinNetworkFee: 250n,
          toScriptPubkey: new Uint8Array([0, 20, 171]),
        }),
        orphanEntry(1, 'b'.repeat(64), 1, 11_000n),
        orphanEntry(99, 'f'.repeat(64), 0, 99_000n),
      ];
    });
    const client = {
      query: { bitcoinLocks: { orphanedUtxosByAccount: { entries } } },
    } as unknown as ArgonClient;

    const records = await tracking.syncArgonOrphans([firstLock, secondLock, thirdLock], client);

    expect(entries).toHaveBeenCalledTimes(2);
    expect(records.map(record => `${record.lockUtxoId}:${record.txid}:${record.vout}`)).toEqual([
      `1:${'a'.repeat(64)}:0`,
      `1:${'b'.repeat(64)}:1`,
      `3:${'c'.repeat(64)}:0`,
    ]);
    expect(records[0]).toEqual(
      expect.objectContaining({
        releaseBitcoinNetworkFee: 250n,
        releaseToDestinationAddress: '0014ab',
      }),
    );

    await tracking.syncArgonOrphans([firstLock, secondLock, thirdLock], client);
    expect(tracking.getUtxosForLock(firstLock)).toHaveLength(2);
    expect(tracking.getUtxosForLock(thirdLock)).toHaveLength(1);
  });

  it('restores an orphan return and its release state after restart', async () => {
    const db = await createTestDb();
    const lock = createLock();
    const tracking = createTracking(db);
    const record = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'a'.repeat(64), vout: 2, satoshis: 12_000n },
      { markOrphaned: true },
    );

    await tracking.setReleaseIsProcessingOnArgon(record, {
      requestedReleaseAtTick: 321,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 200n,
    });
    await tracking.setReleaseCosign(record, {
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 456,
    });
    await tracking.setReleaseSeenOnBitcoinAndProcessing(record, 'b'.repeat(64), 789);

    const restartedTracking = createTracking(db);
    await restartedTracking.load();

    expect(restartedTracking.getUnresolvedOrphanRecords([lock])).toEqual([
      expect.objectContaining({
        id: record.id,
        role: BitcoinUtxoRole.Orphan,
        status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
        requestedReleaseAtTick: 321,
        releaseToDestinationAddress: '0014abc123',
        releaseBitcoinNetworkFee: 200n,
        releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
        releaseCosignHeight: 456,
        releaseTxid: 'b'.repeat(64),
        releaseFirstSeenBitcoinHeight: 789,
      }),
    ]);
  });
});
