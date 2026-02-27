import { describe, expect, it } from 'vitest';
import { createBitcoinLockProgressStore } from '../stores/bitcoinLockProgress.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type { MiningFrames } from '@argonprotocol/apps-core';

function createStoreWithFundingRecord(fundingRecord?: { status: BitcoinUtxoStatus }) {
  const bitcoinLocks = {
    getAcceptedFundingRecord: () => fundingRecord,
  } as unknown as BitcoinLocks;
  return createBitcoinLockProgressStore({
    myVault: {} as MyVault,
    bitcoinLocks,
    miningFrames: {} as MiningFrames,
  });
}

describe('bitcoinLockProgress', () => {
  it('does not render unlock progress as 0% once argon confirmation tracking is active', () => {
    const store = createStoreWithFundingRecord({ status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon });

    const lock = { status: BitcoinLockStatus.Releasing } as unknown as IBitcoinLockRecord;
    store.lock.value = lock;
    store.argonRelease.value = {
      progressPct: 0,
      confirmations: 0,
      expectedConfirmations: 5,
      error: '',
    };

    expect(store.getUnlockProgressPct(lock.status)).toBe(1);
  });

  it('uses bitcoin release progress when funding status shows bitcoin processing even if lock status is stale', () => {
    const store = createStoreWithFundingRecord({ status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin });

    const lock = { status: BitcoinLockStatus.LockedAndMinted } as unknown as IBitcoinLockRecord;
    store.lock.value = lock;
    store.bitcoinRelease.value = {
      progressPct: 80,
      confirmations: 4,
      expectedConfirmations: 6,
      error: '',
    };

    expect(store.getStatusProgress(lock.status).progressPct).toBe(80);
    expect(store.getUnlockProgressPct(lock.status)).toBeCloseTo(93.2);
  });

  it('returns lock-processing step while pending funding', () => {
    const store = createStoreWithFundingRecord();

    const lock = { status: BitcoinLockStatus.LockPendingFunding } as unknown as IBitcoinLockRecord;
    store.lock.value = lock;
    store.lockProcessing.value = {
      progressPct: 25,
      confirmations: 1,
      expectedConfirmations: 6,
      error: '',
    };

    const step = store.getStatusProgress(lock.status);
    expect(step.progressPct).toBe(25);
    expect(step.confirmations).toBe(1);
  });
});
