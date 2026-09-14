import { describe, expect, it, vi } from 'vitest';
import { createBitcoinLockProgressStore } from '../stores/bitcoinLockProgress.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type { MiningFrames } from '@argonprotocol/apps-core';
import { BitcoinReleaseStatus, type IBitcoinReleaseRecord } from '../interfaces/IBitcoinReleaseRecord.ts';

function releaseState(
  overrides: Partial<ReturnType<BitcoinLocks['getLockUnlockReleaseState']>> = {},
): ReturnType<BitcoinLocks['getLockUnlockReleaseState']> {
  return {
    hasActiveLock: true,
    isPendingFunding: false,
    isLockReadyForUnlock: false,
    hasFundingUtxos: true,
    isReleaseStatus: false,
    isArgonSubmitting: false,
    isWaitingForVaultCosign: false,
    isBitcoinReleaseProcessing: false,
    hasRequestDetails: false,
    hasCosign: false,
    hasReleaseTxid: false,
    isReleaseComplete: false,
    ...overrides,
  };
}

function createStoreWithReleaseState(
  state: ReturnType<BitcoinLocks['getLockUnlockReleaseState']> = releaseState(),
  activeRelease?: IBitcoinReleaseRecord,
) {
  const bitcoinLocks = {
    releases: { getActiveForLock: () => activeRelease } as unknown as BitcoinLocks['releases'],
    getLockUnlockReleaseState: () => state,
  } as Pick<BitcoinLocks, 'releases' | 'getLockUnlockReleaseState'> as BitcoinLocks;
  return createBitcoinLockProgressStore({
    myVault: {} as MyVault,
    bitcoinLocks,
    miningFrames: {} as MiningFrames,
  });
}

function createLock(status: BitcoinLockStatus): IBitcoinLockRecord {
  return { status, fundedSatoshis: 0n } as IBitcoinLockRecord;
}

describe('bitcoinLockProgress', () => {
  it('does not render unlock progress as 0% once argon confirmation tracking is active', () => {
    const store = createStoreWithReleaseState(releaseState({ isReleaseStatus: true, isArgonSubmitting: true }));

    const lock = createLock(BitcoinLockStatus.Releasing);
    store.lock.value = lock;
    store.argonRelease.value = {
      progressPct: 0,
      confirmations: 0,
      expectedConfirmations: 5,
      error: '',
    };

    expect(store.getUnlockProgressPct(lock.status)).toBe(1);
  });

  it('starts the vault cosign phase at one third even before its deadline progress advances', () => {
    const activeRelease = {
      status: BitcoinReleaseStatus.WaitingForVaultCosign,
    } as IBitcoinReleaseRecord;
    const store = createStoreWithReleaseState(
      releaseState({ isReleaseStatus: true, isWaitingForVaultCosign: true }),
      activeRelease,
    );
    const lock = createLock(BitcoinLockStatus.Releasing);
    store.lock.value = lock;
    store.requestReleaseByVaultProgress.value = 0;

    expect(store.getUnlockProgressPct(lock.status)).toBe(33);
    expect(store.getUnlockProgressLabel(lock.status)).toBe('Waiting for Vault to Cosign');
  });

  it('holds release progress at two thirds while the Bitcoin transaction is prepared', () => {
    const activeRelease = {
      status: BitcoinReleaseStatus.ReadyForBitcoinBroadcast,
    } as IBitcoinReleaseRecord;
    const store = createStoreWithReleaseState(releaseState({ isReleaseStatus: true }), activeRelease);
    const lock = createLock(BitcoinLockStatus.Releasing);
    store.lock.value = lock;

    expect(store.getUnlockProgressPct(lock.status)).toBe(66);
    expect(store.getUnlockProgressLabel(lock.status)).toBe('Preparing Bitcoin transaction');
  });

  it('uses explicit release progress even if the Lock status is stale', () => {
    const store = createStoreWithReleaseState(
      releaseState({ isReleaseStatus: true, isBitcoinReleaseProcessing: true }),
    );

    const lock = createLock(BitcoinLockStatus.LockFunded);
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
    const store = createStoreWithReleaseState();

    const lock = createLock(BitcoinLockStatus.LockPendingFunding);
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

  it('reuses a single polling interval across progress phases', () => {
    vi.useFakeTimers();

    const lock = createLock(BitcoinLockStatus.LockPendingFunding);
    let isBitcoinReleaseProcessing = false;
    let isLockProcessing = true;

    const bitcoinLocks = {
      releases: { getActiveForLock: () => undefined } as unknown as BitcoinLocks['releases'],
      isLockProcessingStatus: () => isLockProcessing,
      getLockUnlockReleaseState: () =>
        releaseState({ isReleaseStatus: isBitcoinReleaseProcessing, isBitcoinReleaseProcessing }),
      getLockProcessingDetails: () => ({
        progressPct: 25,
        confirmations: 1,
        expectedConfirmations: 6,
      }),
      getReleaseProcessingDetails: () => ({
        progressPct: 50,
        confirmations: 2,
        expectedConfirmations: 6,
        releaseError: '',
      }),
    } as Pick<
      BitcoinLocks,
      | 'releases'
      | 'isLockProcessingStatus'
      | 'getLockUnlockReleaseState'
      | 'getLockProcessingDetails'
      | 'getReleaseProcessingDetails'
    > as BitcoinLocks;

    const store = createBitcoinLockProgressStore({
      myVault: {} as MyVault,
      bitcoinLocks,
      miningFrames: {} as MiningFrames,
    });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const stopTracking = store.trackLock(lock);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    isLockProcessing = false;
    isBitcoinReleaseProcessing = true;
    store.updateLock(lock);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    isBitcoinReleaseProcessing = false;
    store.updateLock(lock);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    stopTracking();
    vi.useRealTimers();
  });

  it('keeps the last tracked lock progress after the final consumer stops', () => {
    const lock = createLock(BitcoinLockStatus.LockPendingFunding);
    const store = createBitcoinLockProgressStore({
      myVault: {} as MyVault,
      bitcoinLocks: {
        isLockProcessingStatus: () => false,
        getLockUnlockReleaseState: () => releaseState(),
      } as Pick<BitcoinLocks, 'isLockProcessingStatus' | 'getLockUnlockReleaseState'> as BitcoinLocks,
      miningFrames: {} as MiningFrames,
    });

    const stopTracking = store.trackLock(lock);

    store.lockProcessing.value = {
      progressPct: 25,
      confirmations: 1,
      expectedConfirmations: 6,
      error: '',
    };

    stopTracking();

    expect(store.lock.value).toStrictEqual(lock);
    expect(store.lockProcessing.value.progressPct).toBe(25);
    expect(store.lockProcessing.value.confirmations).toBe(1);
  });

  it('does not subscribe to mining frames after the final consumer stops during load', async () => {
    let finishLoading!: () => void;
    const loading = new Promise<void>(resolve => {
      finishLoading = resolve;
    });
    const onTick = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const lock = createLock(BitcoinLockStatus.Releasing);
    const store = createBitcoinLockProgressStore({
      myVault: {
        getBitcoinReleaseRequestTxInfo: () => undefined,
        getTxInfoByType: () => undefined,
      } as Pick<MyVault, 'getBitcoinReleaseRequestTxInfo' | 'getTxInfoByType'> as MyVault,
      bitcoinLocks: {
        getLockUnlockReleaseState: () => releaseState({ isReleaseStatus: true, isArgonSubmitting: true }),
        getRequestReleaseByVaultProgress: () => 0,
        isLockProcessingStatus: () => false,
      } as Pick<
        BitcoinLocks,
        'getLockUnlockReleaseState' | 'getRequestReleaseByVaultProgress' | 'isLockProcessingStatus'
      > as BitcoinLocks,
      miningFrames: {
        load: () => loading,
        onTick,
      } as Pick<MiningFrames, 'load' | 'onTick'> as MiningFrames,
    });

    const stopTracking = store.trackLock(lock);
    stopTracking();
    finishLoading();
    await loading;
    await Promise.resolve();

    expect(onTick).not.toHaveBeenCalled();
  });

  it('keeps the last known funding progress when the same lock recomputes as unknown', () => {
    const lock = { ...createLock(BitcoinLockStatus.LockPendingFunding), lockId: 18 };
    const store = createBitcoinLockProgressStore({
      myVault: {} as MyVault,
      bitcoinLocks: {
        isLockProcessingStatus: () => true,
        getLockUnlockReleaseState: () => releaseState(),
        getLockProcessingDetails: () => ({
          progressPct: 0,
          confirmations: -1,
          expectedConfirmations: 6,
        }),
      } as Pick<
        BitcoinLocks,
        'isLockProcessingStatus' | 'getLockUnlockReleaseState' | 'getLockProcessingDetails'
      > as BitcoinLocks,
      miningFrames: {} as MiningFrames,
    });

    store.trackLock(lock);
    store.lockProcessing.value = {
      progressPct: 25,
      confirmations: 1,
      expectedConfirmations: 6,
      error: '',
    };

    store.updateLock(lock);

    expect(store.lockProcessing.value.progressPct).toBe(25);
    expect(store.lockProcessing.value.confirmations).toBe(1);
  });

  it('keeps the last known funding progress when the same lock recomputes to zero confirmations', () => {
    const lock = { ...createLock(BitcoinLockStatus.LockPendingFunding), lockId: 18 };
    const store = createBitcoinLockProgressStore({
      myVault: {} as MyVault,
      bitcoinLocks: {
        isLockProcessingStatus: () => true,
        getLockUnlockReleaseState: () => releaseState(),
        getLockProcessingDetails: () => ({
          progressPct: 0,
          confirmations: 0,
          expectedConfirmations: 6,
        }),
      } as Pick<
        BitcoinLocks,
        'isLockProcessingStatus' | 'getLockUnlockReleaseState' | 'getLockProcessingDetails'
      > as BitcoinLocks,
      miningFrames: {} as MiningFrames,
    });

    store.trackLock(lock);
    store.lockProcessing.value = {
      progressPct: 25,
      confirmations: 1,
      expectedConfirmations: 6,
      error: '',
    };

    store.updateLock(lock);

    expect(store.lockProcessing.value.progressPct).toBe(25);
    expect(store.lockProcessing.value.confirmations).toBe(1);
  });
});
