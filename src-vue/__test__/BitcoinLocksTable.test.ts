import type { IBitcoinLock } from '@argonprotocol/mainchain';
import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';

async function createPendingLock(overrides: Partial<IBitcoinLockRecord> = {}) {
  const db = await createTestDb();
  const table = db.bitcoinLocksTable;
  const lock = await table.insertPending({
    uuid: overrides.uuid ?? 'lock-1',
    status: overrides.status ?? BitcoinLockStatus.LockIsProcessingOnArgon,
    satoshis: overrides.satoshis ?? 1_000n,
    cosignVersion: overrides.cosignVersion ?? 'v1',
    network: overrides.network ?? 'testnet',
    hdPath: overrides.hdPath ?? "m/84'/0'/0'",
    vaultId: overrides.vaultId ?? 1,
  });
  return { db, table, lock };
}

describe('BitcoinLocksTable', () => {
  it('finalizes idempotently and finds a new pending lock that reuses the owner key', async () => {
    const { table, lock } = await createPendingLock({ uuid: 'finalize-idempotent' });

    const bitcoinLock = {
      utxoId: 7,
      liquidityPromised: 25n,
      lockedTargetPrice: 3n,
      securityFees: 1n,
      createdAtHeight: 9,
    } as IBitcoinLock;

    const first = await table.finalizePending({
      uuid: lock.uuid,
      lock: bitcoinLock,
      createdAtArgonBlockHeight: 12,
      finalFee: 2n,
    });
    const second = await table.finalizePending({
      uuid: lock.uuid,
      lock: bitcoinLock,
      createdAtArgonBlockHeight: 12,
      finalFee: 2n,
    });
    const next = await table.insertPending({
      uuid: 'same-owner-next-lock',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      satoshis: lock.satoshis,
      cosignVersion: lock.cosignVersion,
      network: lock.network,
      hdPath: lock.hdPath,
      vaultId: lock.vaultId,
    });

    expect(first.utxoId).toBe(7);
    expect(second.utxoId).toBe(7);
    expect(second.status).toBe(BitcoinLockStatus.LockPendingFunding);
    expect(second.ratchets[0]).toEqual(expect.objectContaining({ blockHeight: 12 }));
    expect(await table.findPendingByHdPath(lock.hdPath)).toMatchObject({ uuid: next.uuid, utxoId: null });
  });

  it('persists release economics separately from the terminal removal mark', async () => {
    const { table, lock } = await createPendingLock({
      uuid: 'release-financials',
      status: BitcoinLockStatus.LockedAndMinted,
    });

    await table.recordReleaseRequest(lock, {
      releaseRedemptionMicrogons: 500n,
      releaseArgonTxFeeMicrogons: undefined,
    });
    await table.recordReleaseRequest(lock, {
      releaseRedemptionMicrogons: 600n,
      releaseArgonTxFeeMicrogons: 7n,
    });
    await table.recordReleaseCompensation(lock, 11n);
    await table.recordRemoval(lock, BitcoinLockStatus.Released, {
      removalBlockNumber: 120,
      removalBlockHash: undefined,
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
    await table.recordReleaseRequest(lock, {
      releaseRedemptionMicrogons: 700n,
      releaseArgonTxFeeMicrogons: 8n,
    });
    await table.recordReleaseCompensation(lock, 12n);
    await table.recordRemoval(lock, BitcoinLockStatus.Released, {
      removalBlockNumber: 121,
      removalBlockHash: '0x120',
      removalBlockTime: new Date('2026-07-16T12:01:00Z'),
      removalExtrinsicIndex: 4,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 5_000_000n,
    });
    await table.recordRemoval(lock, BitcoinLockStatus.Releasing, {
      removalBlockNumber: 122,
      removalBlockHash: '0x121',
      removalBlockTime: new Date('2026-07-16T12:02:00Z'),
      removalExtrinsicIndex: 5,
      removalReason: 'expired',
      btcPriceAtRemovalMicrogons: 5_000_000n,
    });

    const updated = (await table.fetchAll()).find(record => record.uuid === lock.uuid)!;
    expect(updated).toMatchObject({
      status: BitcoinLockStatus.Released,
      releaseRedemptionMicrogons: 500n,
      releaseArgonTxFeeMicrogons: 7n,
      releaseCompensationMicrogons: 11n,
      removalBlockNumber: 120,
      removalBlockHash: '0x120',
      removalBlockTime: new Date('2026-07-16T12:00:00Z'),
      removalExtrinsicIndex: 3,
      removalReason: 'released',
      btcPriceAtRemovalMicrogons: 4_000_000n,
    });
  });
});
