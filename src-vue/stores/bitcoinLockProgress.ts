import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getMyVault } from './vaults.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getMiningFrames } from './mainchain.ts';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { MiningFrames } from '@argonprotocol/apps-core';
import { BitcoinReleaseStatus } from '../interfaces/IBitcoinReleaseRecord.ts';

export interface IStepProgress {
  progressPct: number;
  confirmations: number;
  expectedConfirmations: number;
  error: string;
}

export type BitcoinLockProgressDeps = {
  myVault: MyVault;
  bitcoinLocks: BitcoinLocks;
  miningFrames: MiningFrames;
};

const DEFAULT_PROGRESS: IStepProgress = {
  progressPct: 0,
  confirmations: -1,
  expectedConfirmations: 0,
  error: '',
};

export function createBitcoinLockProgressStore(deps: BitcoinLockProgressDeps) {
  const { myVault, bitcoinLocks, miningFrames } = deps;

  const lock = Vue.ref<IBitcoinLockRecord | null>(null);
  const activeConsumers = Vue.ref(0);

  const argonReleaseProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const vaultCosignProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const lockProcessingProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const bitcoinReleaseProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });

  const requestReleaseByVaultProgress = Vue.ref(0);

  let argonProgressUnsub: (() => void) | undefined;
  let vaultCosignUnsub: (() => void) | undefined;
  let miningFramesUnsub: (() => void) | undefined;
  let argonTxId: number | undefined;
  let vaultCosignTxId: number | undefined;
  let statusRefreshInterval: ReturnType<typeof setInterval> | undefined;
  let lockProcessingLockId: number | undefined;
  let bitcoinReleaseLockId: number | undefined;

  function updateStepProgress(
    step: Vue.Ref<IStepProgress>,
    next: Partial<Omit<IStepProgress, 'error'>> & { error?: Error | string },
  ) {
    step.value = {
      ...step.value,
      ...next,
      error: next.error && next.error instanceof Error ? next.error.message || String(next.error) : (next.error ?? ''),
    };
  }

  function resetStep(step: Vue.Ref<IStepProgress>) {
    step.value = { ...DEFAULT_PROGRESS };
  }

  function clearArgonProgress() {
    argonProgressUnsub?.();
    argonProgressUnsub = undefined;
    argonTxId = undefined;
    resetStep(argonReleaseProgress);
  }

  function clearVaultCosignProgress() {
    vaultCosignUnsub?.();
    vaultCosignUnsub = undefined;
    vaultCosignTxId = undefined;
    resetStep(vaultCosignProgress);
  }

  function clearVaultWaitProgress() {
    requestReleaseByVaultProgress.value = 0;
  }

  function clearLockProcessingProgress() {
    lockProcessingLockId = undefined;
    resetStep(lockProcessingProgress);
  }

  function clearBitcoinReleaseProgress() {
    bitcoinReleaseLockId = undefined;
    resetStep(bitcoinReleaseProgress);
  }

  function updateLockProcessingProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      clearLockProcessingProgress();
      return;
    }
    const details = bitcoinLocks.getLockProcessingDetails(currentLock);
    const nextProgress = {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
    };
    const error =
      currentLock.status === BitcoinLockStatus.LockIsProcessingOnArgon
        ? bitcoinLocks.getLockProcessingError(currentLock)
        : '';

    if (shouldKeepKnownProgress(currentLock.lockId, lockProcessingLockId, lockProcessingProgress.value, nextProgress)) {
      updateStepProgress(lockProcessingProgress, { error });
      return;
    }

    lockProcessingLockId = currentLock.lockId;
    updateStepProgress(lockProcessingProgress, { ...nextProgress, error });
  }

  function updateBitcoinReleaseProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      clearBitcoinReleaseProgress();
      return;
    }
    const details = bitcoinLocks.getReleaseProcessingDetails(bitcoinLocks.releases.getActiveForLock(currentLock));
    if (shouldKeepKnownProgress(currentLock.lockId, bitcoinReleaseLockId, bitcoinReleaseProgress.value, details)) {
      updateStepProgress(bitcoinReleaseProgress, { error: details.releaseError ?? '' });
      return;
    }

    bitcoinReleaseLockId = currentLock.lockId;
    updateStepProgress(bitcoinReleaseProgress, {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
      error: details.releaseError ?? '',
    });
  }

  function stopStatusRefreshInterval() {
    if (!statusRefreshInterval) return;

    clearInterval(statusRefreshInterval);
    statusRefreshInterval = undefined;
  }

  function pauseLiveTracking() {
    argonProgressUnsub?.();
    argonProgressUnsub = undefined;

    vaultCosignUnsub?.();
    vaultCosignUnsub = undefined;

    miningFramesUnsub?.();
    miningFramesUnsub = undefined;

    stopStatusRefreshInterval();
  }

  function refreshPolledProgress() {
    const currentLock = lock.value;
    if (!currentLock) return;

    if (bitcoinLocks.isLockProcessingStatus(currentLock)) {
      updateLockProcessingProgress();
    }

    if (bitcoinLocks.getLockUnlockReleaseState(currentLock).isBitcoinReleaseProcessing) {
      updateBitcoinReleaseProgress();
    }
  }

  function shouldKeepKnownProgress(
    lockId: number | undefined,
    trackedLockId: number | undefined,
    currentProgress: IStepProgress,
    nextProgress: Pick<IStepProgress, 'progressPct' | 'confirmations'>,
  ): boolean {
    if (lockId == null) return false;
    if (trackedLockId !== lockId) return false;
    if (nextProgress.progressPct !== 0 || nextProgress.confirmations > 0) return false;
    return currentProgress.progressPct > 0 || currentProgress.confirmations > 0;
  }

  function syncStatusRefreshInterval() {
    const currentLock = lock.value;
    if (!currentLock) {
      stopStatusRefreshInterval();
      return;
    }

    const needsStatusRefresh =
      bitcoinLocks.isLockProcessingStatus(currentLock) ||
      bitcoinLocks.getLockUnlockReleaseState(currentLock).isBitcoinReleaseProcessing;

    if (!needsStatusRefresh) {
      stopStatusRefreshInterval();
      return;
    }

    refreshPolledProgress();
    if (statusRefreshInterval) return;

    statusRefreshInterval = setInterval(refreshPolledProgress, 1e3);
  }

  function attachArgonProgress() {
    const personalLockLockId = lock.value?.lockId;
    if (!personalLockLockId) {
      clearArgonProgress();
      return;
    }
    const txInfo = myVault.getBitcoinReleaseRequestTxInfo(personalLockLockId);
    if (!txInfo) {
      clearArgonProgress();
      return;
    }
    if (argonTxId === txInfo.tx.id && argonProgressUnsub) return;
    clearArgonProgress();
    argonTxId = txInfo.tx.id;
    argonProgressUnsub = txInfo.subscribeToProgress((args, error) => {
      updateStepProgress(argonReleaseProgress, {
        progressPct: args.progressPct,
        confirmations: args.confirmations,
        expectedConfirmations: args.expectedConfirmations,
        error: error?.message ?? '',
      });
    });
  }

  function attachVaultCosignProgress() {
    const txInfo = myVault.getTxInfoByType(ExtrinsicType.VaultCosignBitcoinRelease);
    if (!txInfo) {
      clearVaultCosignProgress();
      return;
    }
    if (vaultCosignTxId === txInfo.tx.id && vaultCosignUnsub) return;
    clearVaultCosignProgress();
    vaultCosignTxId = txInfo.tx.id;
    vaultCosignUnsub = txInfo.subscribeToProgress((args, error) => {
      updateStepProgress(vaultCosignProgress, {
        progressPct: args.progressPct,
        confirmations: args.confirmations,
        expectedConfirmations: args.expectedConfirmations,
        error: error?.message ?? '',
      });
    });
  }

  function updateVaultWaitProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      requestReleaseByVaultProgress.value = 0;
      return;
    }
    requestReleaseByVaultProgress.value = bitcoinLocks.getRequestReleaseByVaultProgress(currentLock, miningFrames);
  }

  async function ensureMiningFramesSubscription() {
    if (miningFramesUnsub) return;
    await miningFrames.load();
    // The final consumer can stop while loading; do not subscribe after its disposer has already run.
    if (activeConsumers.value === 0 || miningFramesUnsub || !isWaitingForVaultCosign(lock.value)) return;
    updateVaultWaitProgress();
    miningFramesUnsub = miningFrames.onTick(() => {
      if (isWaitingForVaultCosign(lock.value)) {
        updateVaultWaitProgress();
      }
    }).unsubscribe;
  }

  function syncWithStatus() {
    const currentLock = lock.value;
    if (!currentLock) {
      clearArgonProgress();
      clearVaultCosignProgress();
      clearVaultWaitProgress();
      clearLockProcessingProgress();
      clearBitcoinReleaseProgress();
      stopStatusRefreshInterval();
      return;
    }

    const releaseState = bitcoinLocks.getLockUnlockReleaseState(currentLock);
    const isReleasingOnBitcoin = releaseState.isBitcoinReleaseProcessing;

    if (releaseState.isArgonSubmitting) {
      attachArgonProgress();
    } else {
      clearArgonProgress();
    }

    if (releaseState.isWaitingForVaultCosign) {
      void ensureMiningFramesSubscription();
      updateVaultWaitProgress();
      attachVaultCosignProgress();
    } else {
      clearVaultCosignProgress();
      clearVaultWaitProgress();
    }

    if (bitcoinLocks.isLockProcessingStatus(currentLock)) {
      updateLockProcessingProgress();
    } else {
      clearLockProcessingProgress();
    }

    if (isReleasingOnBitcoin) {
      updateBitcoinReleaseProgress();
    } else {
      clearBitcoinReleaseProgress();
    }

    syncStatusRefreshInterval();
  }

  function getStatusProgress(status: BitcoinLockStatus | null | undefined): IStepProgress {
    const releaseState = bitcoinLocks.getLockUnlockReleaseState(lock.value ?? undefined);
    if (status === BitcoinLockStatus.Releasing || releaseState.isReleaseStatus) {
      if (releaseState.isBitcoinReleaseProcessing) {
        return bitcoinReleaseProgress.value;
      }
      if (releaseState.isWaitingForVaultCosign) {
        return vaultCosignProgress.value;
      }
      return argonReleaseProgress.value;
    }
    if (!status) return DEFAULT_PROGRESS;
    if (status === BitcoinLockStatus.LockIsProcessingOnArgon || status === BitcoinLockStatus.LockPendingFunding) {
      return lockProcessingProgress.value;
    }
    return DEFAULT_PROGRESS;
  }

  function getUnlockProgressPct(status: BitcoinLockStatus | null | undefined): number {
    const releaseState = bitcoinLocks.getLockUnlockReleaseState(lock.value ?? undefined);
    const inReleasePhase = status === BitcoinLockStatus.Releasing || releaseState.isReleaseStatus;
    if (!inReleasePhase) return 0;
    if (releaseState.isBitcoinReleaseProcessing) {
      return 66 + bitcoinReleaseProgress.value.progressPct * 0.34;
    }
    if (releaseState.isWaitingForVaultCosign) {
      return 33 + requestReleaseByVaultProgress.value * 0.33;
    }
    const release = lock.value ? bitcoinLocks.releases.getActiveForLock(lock.value) : undefined;
    if (release?.status === BitcoinReleaseStatus.ReadyForBitcoinBroadcast) return 66;
    if (releaseState.isArgonSubmitting) {
      const argonPct = argonReleaseProgress.value.progressPct * 0.33;
      if (argonReleaseProgress.value.confirmations >= 0 && argonReleaseProgress.value.expectedConfirmations > 0) {
        return Math.max(1, argonPct);
      }
      return argonPct;
    }
    return 0;
  }

  function getUnlockProgressLabel(status: BitcoinLockStatus | null | undefined): string {
    const releaseState = bitcoinLocks.getLockUnlockReleaseState(lock.value ?? undefined);
    const inReleasePhase = status === BitcoinLockStatus.Releasing || releaseState.isReleaseStatus;
    if (!inReleasePhase) return 'Analyzing Network State...';
    const step = getStatusProgress(status);
    if (releaseState.isBitcoinReleaseProcessing) {
      return generateProgressLabel(step?.confirmations ?? -1, step?.expectedConfirmations ?? 0, {
        blockType: 'Bitcoin',
      });
    }
    if (releaseState.isWaitingForVaultCosign) {
      return 'Waiting for Vault to Cosign';
    }
    const release = lock.value ? bitcoinLocks.releases.getActiveForLock(lock.value) : undefined;
    if (release?.status === BitcoinReleaseStatus.ReadyForBitcoinBroadcast) return 'Preparing Bitcoin transaction';
    return generateProgressLabel(step?.confirmations ?? -1, step?.expectedConfirmations ?? 0, {
      blockType: 'Argon',
    });
  }

  function getUnlockErrorLabel(lockRecord: IBitcoinLockRecord): string {
    const release = bitcoinLocks.releases.getActiveForLock(lockRecord);
    const statusError = release?.statusError;
    if (statusError) return `An unexpected error has occurred unlocking your Bitcoin: ${statusError}`;
    if (argonReleaseProgress.value.error) {
      return `Error submitting to argon: ${argonReleaseProgress.value.error}`;
    }
    if (vaultCosignProgress.value.error) {
      return `Error co-signing this bitcoin utxo: ${vaultCosignProgress.value.error}`;
    }
    return '';
  }

  function trackLock(initialLock: IBitcoinLockRecord | null): () => void {
    activeConsumers.value += 1;
    lock.value = initialLock;
    syncWithStatus();
    return () => {
      activeConsumers.value = Math.max(0, activeConsumers.value - 1);
      if (activeConsumers.value === 0) {
        pauseLiveTracking();
      }
    };
  }

  function updateLock(nextLock: IBitcoinLockRecord | null) {
    if (activeConsumers.value === 0) return;
    lock.value = nextLock;
    syncWithStatus();
  }

  function isWaitingForVaultCosign(lockRecord: IBitcoinLockRecord | null): boolean {
    if (!lockRecord) return false;
    return bitcoinLocks.getLockUnlockReleaseState(lockRecord).isWaitingForVaultCosign;
  }

  return {
    lock,
    trackLock,
    updateLock,
    argonRelease: argonReleaseProgress,
    vaultCosign: vaultCosignProgress,
    requestReleaseByVaultProgress,
    lockProcessing: lockProcessingProgress,
    bitcoinRelease: bitcoinReleaseProgress,
    getStatusProgress,
    getUnlockProgressPct,
    getUnlockProgressLabel,
    getUnlockErrorLabel,
  };
}

export const useBitcoinLockProgress = defineStore('bitcoinLockProgress', () =>
  createBitcoinLockProgressStore({
    myVault: getMyVault(),
    bitcoinLocks: getBitcoinLocks(),
    miningFrames: getMiningFrames(),
  }),
);
