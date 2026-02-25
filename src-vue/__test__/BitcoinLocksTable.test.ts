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
  it('setLockPendingFunding updates lock status', async () => {
    const { table, lock } = await createPendingLock({ uuid: 'pending-funding' });

    await table.setLockPendingFunding(lock);

    const updated = (await table.fetchAll()).find(x => x.uuid === lock.uuid)!;
    expect(updated.status).toBe(BitcoinLockStatus.LockPendingFunding);
  });

  it('updateMintState transitions pending funding to minting and minted', async () => {
    const { table, lock } = await createPendingLock({
      uuid: 'mint-state',
      status: BitcoinLockStatus.LockPendingFunding,
    });

    lock.ratchets = [
      {
        mintAmount: 10n,
        mintPending: 5n,
        lockedMarketRate: 1n,
        securityFee: 0n,
        txFee: 0n,
        burned: 0n,
        blockHeight: 1,
        oracleBitcoinBlockHeight: 1,
      },
    ];

    await table.updateMintState(lock);
    expect(lock.status).toBe(BitcoinLockStatus.LockedAndIsMinting);

    lock.ratchets[0].mintPending = 0n;
    await table.updateMintState(lock);

    const updated = (await table.fetchAll()).find(x => x.uuid === lock.uuid)!;
    expect(updated.status).toBe(BitcoinLockStatus.LockedAndMinted);
  });

  it('can mark locks as released or expired waiting for funding', async () => {
    const { table, lock } = await createPendingLock({
      uuid: 'release-expire',
      status: BitcoinLockStatus.LockPendingFunding,
    });

    await table.setLockExpiredWaitingForFunding(lock);
    expect(lock.status).toBe(BitcoinLockStatus.LockExpiredWaitingForFunding);

    await table.setReleased(lock);
    const updated = (await table.fetchAll()).find(x => x.uuid === lock.uuid)!;
    expect(updated.status).toBe(BitcoinLockStatus.Released);
  });
});
