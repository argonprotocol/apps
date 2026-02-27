import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';

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
    isFundingRecordReleaseComplete?: boolean;
    hasFundingRecordReleaseSignal?: boolean;
  },
) {
  const utxoTracking = {
    isFundingRecordReleaseComplete: vi
      .fn<(record: IBitcoinUtxoRecord) => boolean>()
      .mockReturnValue(overrides?.isFundingRecordReleaseComplete ?? false),
    hasFundingRecordReleaseSignal: vi
      .fn<(record: IBitcoinUtxoRecord) => boolean>()
      .mockReturnValue(overrides?.hasFundingRecordReleaseSignal ?? false),
  } as any;

  const store = Object.assign(Object.create(BitcoinLocks.prototype), {
    // inject only the members used by syncLockReleaseStatusFromFundingRecord
    utxoTracking,
    getTable: async () => db.bitcoinLocksTable,
  });

  return store as BitcoinLocks;
}

describe('BitcoinLocks release status sync', () => {
  it('syncLockReleaseStatusFromFundingRecord marks lock as Releasing when release has started', async () => {
    const db = await createTestDb();
    const lock = await createLock(db, BitcoinLockStatus.LockedAndMinted);
    const store = createStore(db, {
      isFundingRecordReleaseComplete: false,
      hasFundingRecordReleaseSignal: true,
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
      isFundingRecordReleaseComplete: true,
      hasFundingRecordReleaseSignal: true,
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
    const fundingRecord = {
      id: 11,
      lockUtxoId: lock.utxoId ?? 0,
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      requestedReleaseAtTick: 123,
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseTxid: undefined,
      releasedAtBitcoinHeight: undefined,
    } as IBitcoinUtxoRecord;
    lock.fundingUtxoRecord = fundingRecord;

    const store = new BitcoinLocks(
      Promise.resolve(db as any),
      {} as any,
      {} as any,
      { priceIndex: 0n } as any,
      {} as any,
    );

    const setStatusError = vi.spyOn(store.utxoTracking, 'setStatusError').mockResolvedValue();
    vi.spyOn(store.utxoTracking, 'clearStatusError').mockResolvedValue();
    vi.spyOn(store.utxoTracking, 'canSubmitFundingRecordReleaseToBitcoin').mockReturnValue(true);
    vi.spyOn(store as any, 'ownerCosignAndGenerateTxBytes').mockRejectedValue(new Error('signing failed'));

    // @ts-expect-error - private access
    await expect(store.ownerCosignAndSendToBitcoin(lock)).rejects.toThrow('signing failed');
    expect(setStatusError).toHaveBeenCalledTimes(1);
    expect(setStatusError).toHaveBeenCalledWith(fundingRecord, 'Error: signing failed');
  });

  it('reconcileLockReleasePhasesOnBlock stores statusError when bitcoin completion sync throws', async () => {
    const lock = { uuid: 'lock-1' } as IBitcoinLockRecord;
    const fundingRecord = {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      releaseCosignVaultSignature: new Uint8Array([1]),
      releaseTxid: 'txid',
      releaseToDestinationAddress: '0014abc123',
      releaseBitcoinNetworkFee: 10n,
      requestedReleaseAtTick: 123,
    } as IBitcoinUtxoRecord;
    const setStatusError = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue();

    const store = Object.assign(Object.create(BitcoinLocks.prototype), {
      utxoTracking: {
        hasFundingRecordReleaseSignal: vi.fn().mockReturnValue(true),
        isFundingRecordReleaseComplete: vi.fn().mockReturnValue(false),
        isFundingRecordReleaseProcessingOnBitcoin: vi.fn().mockReturnValue(true),
        hasFundingRecordReleaseRequestDetails: vi.fn().mockReturnValue(true),
        canSubmitFundingRecordReleaseToBitcoin: vi.fn().mockReturnValue(false),
        updateReleaseLastConfirmationCheck: vi.fn().mockResolvedValue(undefined),
        clearStatusError: vi.fn().mockResolvedValue(undefined),
        setStatusError,
      },
      getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
      syncLockReleaseStatusFromFundingRecord: vi.fn().mockResolvedValue(undefined),
      syncLockReleaseBitcoinComplete: vi.fn().mockRejectedValue(new Error('sync failed')),
      syncLockReleaseArgonRequest: vi.fn().mockResolvedValue(undefined),
      syncLockReleaseArgonCosign: vi.fn().mockResolvedValue(undefined),
      ownerCosignAndSendToBitcoin: vi.fn().mockResolvedValue(undefined),
    }) as BitcoinLocks;

    // @ts-expect-error - private access
    await store.reconcileLockReleasePhasesOnBlock(lock, false);
    expect(setStatusError).toHaveBeenCalledTimes(1);
    expect(setStatusError).toHaveBeenCalledWith(fundingRecord, 'Error: sync failed');
  });
});
