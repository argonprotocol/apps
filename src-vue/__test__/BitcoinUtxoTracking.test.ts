import { describe, expect, it, vi } from 'vitest';
import { BitcoinNetwork } from '@argonprotocol/bitcoin';
import { createTestDb } from './helpers/db.ts';
import BitcoinUtxoTracking from '../lib/BitcoinUtxoTracking.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type { ArgonClient } from '@argonprotocol/mainchain';
import type { MiningFrames } from '@argonprotocol/apps-core';
import { createBitcoinLockConfig } from './helpers/bitcoin.ts';

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
    lockDetails: overrides.lockDetails ?? ({ p2wshScriptHashHex: `0020${'00'.repeat(32)}` } as any),
    fundingUtxoRecordId: overrides.fundingUtxoRecordId ?? null,
    fundingUtxoRecord: overrides.fundingUtxoRecord,
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

function createTracking(db: Awaited<ReturnType<typeof createTestDb>>) {
  return new BitcoinUtxoTracking({
    dbPromise: Promise.resolve(db),
    getBitcoinNetwork: () => BitcoinNetwork.Bitcoin,
    getOracleBitcoinBlockHeight: () => 110,
    getConfig: () => createBitcoinLockConfig(),
    getMainchainClient: async () => ({}) as ArgonClient,
    mempool: {
      getAddressUtxos: vi.fn().mockResolvedValue([]),
      getTipHeight: vi.fn().mockResolvedValue(125),
      getTxStatus: vi.fn(),
    } as any,
  });
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
    expect(tracking.isFundingRecordReleaseComplete(fundingRecord)).toBe(true);
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

  it('getRequestReleaseByVaultProgress starts at 0 when release metadata is not ready', async () => {
    const db = await createTestDb();
    const tracking = createTracking(db);
    const lock = createLock({ status: BitcoinLockStatus.Releasing });
    const miningFrames = {
      currentTick: 1_000,
      getForTick: (tick: number) => Math.floor(tick / 10),
      estimateTickStart: (frame: number) => frame * 10,
    } as unknown as MiningFrames;

    expect(tracking.getRequestReleaseByVaultProgress(lock, miningFrames, 4)).toBe(0);

    const fundingRecord = await tracking.upsertUtxoRecord(
      lock,
      { txid: 'e'.repeat(64), vout: 5, satoshis: lock.satoshis },
      { markFundingUtxo: true },
    );
    lock.fundingUtxoRecord = fundingRecord;

    expect(tracking.getRequestReleaseByVaultProgress(lock, miningFrames, 4)).toBe(0);
  });
});
