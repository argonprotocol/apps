import { describe, expect, it, vi } from 'vitest';
import { createBitcoinLockProgressStore } from '../stores/bitcoinLockProgress.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type { MiningFrames } from '@argonprotocol/apps-core';

function createStoreWithFundingStatus(fundingStatus?: BitcoinUtxoStatus) {
  const fundingRecord =
    fundingStatus == null
      ? undefined
      : ({ status: fundingStatus } as ReturnType<BitcoinLocks['getAcceptedFundingRecord']>);
  const bitcoinLocks = {
    getAcceptedFundingRecord: () => fundingRecord,
  } as Pick<BitcoinLocks, 'getAcceptedFundingRecord'> as BitcoinLocks;
  return createBitcoinLockProgressStore({
    myVault: {} as MyVault,
    bitcoinLocks,
    miningFrames: {} as MiningFrames,
  });
}

function createLock(status: BitcoinLockStatus): IBitcoinLockRecord {
  return { status } as IBitcoinLockRecord;
}

describe('bitcoinLockProgress', () => {
  it('does not render unlock progress as 0% once argon confirmation tracking is active', () => {
    const store = createStoreWithFundingStatus(BitcoinUtxoStatus.ReleaseIsProcessingOnArgon);

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

  it('uses bitcoin release progress when funding status shows bitcoin processing even if lock status is stale', () => {
    const store = createStoreWithFundingStatus(BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin);

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
    const store = createStoreWithFundingStatus();

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
    let fundingStatus: BitcoinUtxoStatus | undefined;
    let isLockProcessing = true;

    const bitcoinLocks = {
      isLockProcessingStatus: () => isLockProcessing,
      getAcceptedFundingRecord: () =>
        fundingStatus == null
          ? undefined
          : ({ status: fundingStatus } as ReturnType<BitcoinLocks['getAcceptedFundingRecord']>),
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
      'isLockProcessingStatus' | 'getAcceptedFundingRecord' | 'getLockProcessingDetails' | 'getReleaseProcessingDetails'
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
    fundingStatus = BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    store.updateLock(lock);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    fundingStatus = undefined;
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
        getAcceptedFundingRecord: () => undefined,
      } as Pick<BitcoinLocks, 'isLockProcessingStatus' | 'getAcceptedFundingRecord'> as BitcoinLocks,
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
        getAcceptedFundingRecord: () =>
          ({ status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon }) as ReturnType<
            BitcoinLocks['getAcceptedFundingRecord']
          >,
        getRequestReleaseByVaultProgress: () => 0,
        isLockProcessingStatus: () => false,
      } as Pick<
        BitcoinLocks,
        'getAcceptedFundingRecord' | 'getRequestReleaseByVaultProgress' | 'isLockProcessingStatus'
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
    const lock = { ...createLock(BitcoinLockStatus.LockPendingFunding), utxoId: 18 } as IBitcoinLockRecord;
    const store = createBitcoinLockProgressStore({
      myVault: {} as MyVault,
      bitcoinLocks: {
        isLockProcessingStatus: () => true,
        getAcceptedFundingRecord: () => undefined,
        getLockProcessingDetails: () => ({
          progressPct: 0,
          confirmations: -1,
          expectedConfirmations: 6,
        }),
      } as Pick<
        BitcoinLocks,
        'isLockProcessingStatus' | 'getAcceptedFundingRecord' | 'getLockProcessingDetails'
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
    const lock = { ...createLock(BitcoinLockStatus.LockPendingFunding), utxoId: 18 } as IBitcoinLockRecord;
    const store = createBitcoinLockProgressStore({
      myVault: {} as MyVault,
      bitcoinLocks: {
        isLockProcessingStatus: () => true,
        getAcceptedFundingRecord: () => undefined,
        getLockProcessingDetails: () => ({
          progressPct: 0,
          confirmations: 0,
          expectedConfirmations: 6,
        }),
      } as Pick<
        BitcoinLocks,
        'isLockProcessingStatus' | 'getAcceptedFundingRecord' | 'getLockProcessingDetails'
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
