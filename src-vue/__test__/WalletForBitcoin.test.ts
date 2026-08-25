import { describe, expect, test, vi } from 'vitest';
import { Vault } from '@argonprotocol/mainchain';
import { BitcoinLockStatus } from '../interfaces/IBitcoinLockRecord.ts';
import { WalletForBitcoin } from '../lib/WalletForBitcoin.ts';
import { createLock, createStore } from './helpers/bitcoin.ts';

describe('WalletForBitcoin channel selection', () => {
  test('restores the newest channel that is still being created or waiting for funding', () => {
    const bitcoinLocks = createStore();
    const olderUnfunded = createLock({
      uuid: 'older-unfunded',
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-08-20T10:00:00.000Z',
    });
    const newerFunded = createLock({
      uuid: 'newer-funded',
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-08-20T12:00:00.000Z',
    });
    const newestProcessing = createLock({
      uuid: 'newest-processing',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-08-20T14:00:00.000Z',
    });
    bitcoinLocks.data.pendingLocks.push(olderUnfunded, newerFunded, newestProcessing);
    vi.spyOn(bitcoinLocks, 'hasObservedFundingSignal').mockImplementation(lock => lock.uuid === newerFunded.uuid);
    const isFundingWindowExpired = vi.spyOn(bitcoinLocks, 'isFundingWindowExpired').mockReturnValue(false);

    const wallet = new WalletForBitcoin(
      () => bitcoinLocks,
      () => olderUnfunded.lockDetails.ownerAccount,
    );

    expect(wallet.getLatestActiveChannel(1)).toBe(newestProcessing);

    newestProcessing.status = BitcoinLockStatus.LockFailed;
    expect(wallet.getLatestActiveChannel(1)).toBe(olderUnfunded);

    isFundingWindowExpired.mockReturnValue(true);
    expect(wallet.getLatestActiveChannel(1)).toBeUndefined();
  });

  test('offers the newest funded channel only while its funding window remains open', () => {
    const bitcoinLocks = createStore();
    const expired = createLock({
      uuid: 'newer-expired',
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-08-20T14:00:00.000Z',
    });
    const available = createLock({
      uuid: 'older-available',
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-08-20T12:00:00.000Z',
    });
    const otherVault = createLock({
      uuid: 'other-vault',
      status: BitcoinLockStatus.LockPendingFunding,
      createdAt: '2026-08-20T16:00:00.000Z',
    });
    otherVault.vaultId = 2;
    bitcoinLocks.data.pendingLocks.push(available, expired, otherVault);
    vi.spyOn(bitcoinLocks, 'hasObservedFundingSignal').mockReturnValue(true);
    const isFundingWindowExpired = vi
      .spyOn(bitcoinLocks, 'isFundingWindowExpired')
      .mockImplementation(lock => lock.uuid === expired.uuid);

    const wallet = new WalletForBitcoin(
      () => bitcoinLocks,
      () => available.lockDetails.ownerAccount,
    );

    expect(wallet.getLatestFundedUnexpiredChannel(1)).toBe(available);

    isFundingWindowExpired.mockReturnValue(true);
    expect(wallet.getLatestFundedUnexpiredChannel(1)).toBeUndefined();
  });

  test('keeps one in-flight channel creation per vault until the durable lock is available', async () => {
    const bitcoinLocks = createStore();
    const pendingLock = createLock({
      uuid: 'pending-creation',
      status: BitcoinLockStatus.LockIsProcessingOnArgon,
      createdAt: '2026-08-20T14:00:00.000Z',
    });
    let finishCreation!: () => void;
    const creationGate = new Promise<void>(resolve => {
      finishCreation = resolve;
    });
    vi.spyOn(bitcoinLocks, 'getLockableBitcoinCapacity').mockResolvedValue({
      availableLiquidityMicrogons: 100_000_000n,
      availableSatoshis: 1_000_000n,
      vaultCapacityLiquidityMicrogons: 100_000_000n,
      vaultCapacitySatoshis: 1_000_000n,
    });
    vi.spyOn(bitcoinLocks, 'satoshisForArgonLiquidity').mockResolvedValue(1_000_000n);
    const initializeLock = vi.spyOn(bitcoinLocks, 'initializeLock').mockImplementation(async () => {
      await creationGate;
      bitcoinLocks.data.pendingLocks.push(pendingLock);
      return { pendingLock };
    });
    const wallet = new WalletForBitcoin(
      () => bitcoinLocks,
      () => pendingLock.lockDetails.ownerAccount,
    );
    const vault = Object.assign(Object.create(Vault.prototype) as Vault, { vaultId: 1 });

    const firstCreation = wallet.createChannel({ vault, liquidityMicrogons: 50_000_000n });
    const restoredCreation = wallet.createChannel({ vault, liquidityMicrogons: 50_000_000n });

    expect(wallet.isCreatingChannel(vault.vaultId)).toBe(true);
    await vi.waitFor(() => expect(initializeLock).toHaveBeenCalledTimes(1));

    finishCreation();
    await expect(Promise.all([firstCreation, restoredCreation])).resolves.toEqual([pendingLock, pendingLock]);
    expect(wallet.isCreatingChannel(vault.vaultId)).toBe(false);
  });
});
