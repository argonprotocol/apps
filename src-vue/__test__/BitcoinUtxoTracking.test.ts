import { describe, expect, it, vi } from 'vitest';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { createTestDb } from './helpers/db.ts';
import BitcoinUtxoTracking, { type IUtxoTrackingDeps } from '../lib/BitcoinUtxoTracking.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type { ArgonClient } from '@argonprotocol/mainchain';
import type { MiningFrames } from '@argonprotocol/apps-core';
import { createBitcoinLockConfig } from './helpers/bitcoin.ts';

type IMempoolTestDeps = Pick<IUtxoTrackingDeps['mempool'], 'getAddressUtxos' | 'getTipHeight' | 'getTxStatus'>;

function createLock(overrides: Partial<IBitcoinLockRecord> = {}): IBitcoinLockRecord {
  return {
    uuid: overrides.uuid ?? 'lock-1',
    utxoId: overrides.utxoId ?? 1,
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
    getMainchainClient: async () => ({}) as ArgonClient,
    mempool: mempool as IUtxoTrackingDeps['mempool'],
  });
}

function createLockDetails(): IBitcoinLockRecord['lockDetails'] {
  return {
    p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
    ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    createdAtHeight: 100,
    vaultClaimHeight: 200,
  } as IBitcoinLockRecord['lockDetails'];
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
  });

  it('prefers argon candidates and chooses closest satoshi match', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ satoshis: 10_000n });

    await tracking.upsertUtxoRecord(
      lock,
      { txid: 'a'.repeat(64), vout: 0, satoshis: 8_000n },
      { markArgonCandidate: true },
    );
    await tracking.upsertUtxoRecord(
      lock,
      { txid: 'b'.repeat(64), vout: 1, satoshis: 10_200n },
      { markArgonCandidate: true },
    );
    await tracking.upsertUtxoRecord(
      lock,
      { txid: 'c'.repeat(64), vout: 2, satoshis: 14_000n },
      { markArgonCandidate: true },
    );

    const candidates = tracking.getFundingCandidateRecords(lock);
    expect(candidates).toHaveLength(3);

    const preferred = tracking.getPreferredFundingCandidateRecord(lock);
    expect(preferred?.txid).toBe('b'.repeat(64));
    expect(tracking.getReceivedFundingSatoshis(lock)).toBe(10_200n);
  });

  it('tracks release lifecycle on the funding record', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockedAndMinted });

    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'f'.repeat(64), vout: 0, satoshis: lock.satoshis },
      { markFundingUtxo: true },
    );

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
  });

  it('stamps firstSeenOnArgonAt when a funding UTXO is accepted directly', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding });

    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'd'.repeat(64), vout: 4, satoshis: lock.satoshis },
      { markFundingUtxo: true },
    );

    expect(fundingRecord.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(fundingRecord.firstSeenOnArgonAt).toBeInstanceOf(Date);

    const reloaded = tracking.getUtxoRecord(lock.utxoId!, fundingRecord.txid, fundingRecord.vout)!;
    expect(reloaded.firstSeenOnArgonAt).toBeInstanceOf(Date);
  });

  it('hydrates on-chain candidates into the local table from the provided client', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, satoshis: 10_000n });
    const chainTxid = 'f'.repeat(64);
    const chainEntries = [
      [
        {
          txid: { toHex: () => chainTxid },
          outputIndex: { toNumber: () => 2 },
        },
        { toBigInt: () => 10_200n },
      ],
    ];
    const candidateQuery = vi.fn().mockResolvedValue({
      entries: () => chainEntries[Symbol.iterator](),
    });
    const preferredClient = Object.assign(Object.create(null), {
      query: Object.assign(Object.create(null), {
        bitcoinUtxos: Object.assign(Object.create(null), {
          candidateUtxoRefsByUtxoId: candidateQuery,
        }),
      }),
    }) as ArgonClient;

    await tracking.syncPendingFundingSignals(lock, preferredClient);

    expect(candidateQuery).toHaveBeenCalledWith(lock.utxoId);
    const candidates = tracking.getFundingCandidateRecords(lock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].txid).toBe(chainTxid);
    expect(candidates[0].vout).toBe(2);
    expect(candidates[0].satoshis).toBe(10_200n);
    expect(candidates[0].firstSeenOnArgonAt).toBeInstanceOf(Date);
    expect(candidates[0].status).toBe(BitcoinUtxoStatus.FundingCandidate);
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
      { txid: 'e'.repeat(64), vout: 5, satoshis: lock.satoshis },
      { markFundingUtxo: true },
    );
    lock.fundingUtxoRecord = fundingRecord;

    expect(tracking.getRequestReleaseByVaultProgress(lock, miningFrames as MiningFrames, 4)).toBe(0);
  });

  it('keeps failed release candidates actionable while lock is pending funding', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, satoshis: 10_000n });

    const candidate = await tracking.upsertUtxoRecord(
      lock,
      { txid: '9'.repeat(64), vout: 0, satoshis: 9_900n },
      { markArgonCandidate: true },
    );
    await tracking.setReleaseError(candidate, 'temporary failure');

    const candidates = tracking.getFundingCandidateRecords(lock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe(candidate.id);
    expect(candidates[0].status).toBe(BitcoinUtxoStatus.FundingCandidate);
    expect(candidates[0].statusError).toBe('temporary failure');
  });

  it('ignores a stale funding pointer that belongs to a different lock', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const firstLock = createLock({ utxoId: 1, uuid: 'lock-1' });
    const secondLock = createLock({ utxoId: 2, uuid: 'lock-2' });

    const firstFundingRecord = await tracking.upsertUtxoRecord(
      firstLock,
      { txid: '1'.repeat(64), vout: 0, satoshis: firstLock.satoshis },
      { markFundingUtxo: true },
    );
    const secondFundingRecord = await tracking.upsertUtxoRecord(
      secondLock,
      { txid: '2'.repeat(64), vout: 1, satoshis: secondLock.satoshis },
      { markFundingUtxo: true },
    );

    firstLock.fundingUtxoRecord = undefined;
    firstLock.fundingUtxoRecordId = secondFundingRecord.id;

    const resolved = tracking.getAcceptedFundingRecordForLock(firstLock);

    expect(resolved?.id).toBe(firstFundingRecord.id);
    expect(resolved?.lockUtxoId).toBe(firstLock.utxoId);
  });

  it('uses the newest accepted funding record when the pointer is missing', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ utxoId: 3, uuid: 'lock-3' });

    const olderFundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '3'.repeat(64), vout: 0, satoshis: lock.satoshis },
      { markFundingUtxo: true },
    );
    olderFundingRecord.updatedAt = new Date('2026-03-09T10:00:00.000Z');

    const newerFundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '4'.repeat(64), vout: 1, satoshis: lock.satoshis + 100n },
      { markFundingUtxo: true },
    );
    newerFundingRecord.updatedAt = new Date('2026-03-09T10:05:00.000Z');

    lock.fundingUtxoRecord = undefined;
    lock.fundingUtxoRecordId = null;

    const resolved = tracking.getAcceptedFundingRecordForLock(lock);

    expect(resolved?.id).toBe(newerFundingRecord.id);
  });

  it('does not reuse an old release record as active funding progress', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, satoshis: 10_000n });

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
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, satoshis: 10_000n });

    const oldRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '7'.repeat(64), vout: 0, satoshis: 10_000n },
      { markArgonCandidate: true },
    );
    await tracking.setReleaseComplete(oldRecord, 105);

    const observation = await tracking.observeMempoolFunding(lock);

    expect(observation?.txid).toBe('6'.repeat(64));
    expect(observation?.vout).toBe(1);
  });

  it('marks sibling funding candidates orphaned when a funding utxo is accepted', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.LockPendingFunding, satoshis: 10_000n });

    const acceptedRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: '8'.repeat(64), vout: 0, satoshis: lock.satoshis },
      { markArgonCandidate: true },
    );
    const siblingCandidate = await tracking.upsertUtxoRecord(
      lock,
      { txid: '9'.repeat(64), vout: 1, satoshis: lock.satoshis + 200n },
      { markArgonCandidate: true },
    );

    await tracking.setAcceptedFundingRecordForLock(lock, acceptedRecord);

    expect(acceptedRecord.status).toBe(BitcoinUtxoStatus.FundingUtxo);
    expect(siblingCandidate.status).toBe(BitcoinUtxoStatus.Orphaned);
    expect(tracking.getFundingCandidateRecords(lock)).toEqual([]);

    const history = await db.bitcoinUtxosTable.fetchStatusHistory(siblingCandidate.id);
    expect(history.at(-1)?.newStatus).toBe(BitcoinUtxoStatus.Orphaned);
  });
});
