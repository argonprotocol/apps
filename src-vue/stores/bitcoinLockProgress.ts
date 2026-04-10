import * as Vue from 'vue';
import { defineStore } from 'pinia';
import { getMyVault } from './vaults.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getMiningFrames } from './mainchain.ts';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus } from '../lib/db/BitcoinUtxosTable.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type BitcoinLocks from '../lib/BitcoinLocks.ts';
import type { MiningFrames } from '@argonprotocol/apps-core';

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
  const orphanedReturnArgonProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const orphanedReturnBitcoinProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const mismatchAcceptArgonProgress = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });

  const requestReleaseByVaultProgress = Vue.ref(0);

  let argonProgressUnsub: (() => void) | undefined;
  let vaultCosignUnsub: (() => void) | undefined;
  let miningFramesUnsub: (() => void) | undefined;
  let argonTxId: number | undefined;
  let vaultCosignTxId: number | undefined;
  let orphanedReturnArgonTxId: number | undefined;
  let orphanedReturnArgonUnsub: (() => void) | undefined;
  let mismatchAcceptTxId: number | undefined;
  let mismatchAcceptUnsub: (() => void) | undefined;
  let statusRefreshInterval: ReturnType<typeof setInterval> | undefined;
  let lockProcessingUtxoId: number | undefined;
  let bitcoinReleaseUtxoId: number | undefined;
  let orphanedReturnBitcoinUtxoId: number | undefined;

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
    lockProcessingUtxoId = undefined;
    resetStep(lockProcessingProgress);
  }

  function clearBitcoinReleaseProgress() {
    bitcoinReleaseUtxoId = undefined;
    resetStep(bitcoinReleaseProgress);
  }

  function clearOrphanedReturnArgonProgress() {
    orphanedReturnArgonUnsub?.();
    orphanedReturnArgonUnsub = undefined;
    orphanedReturnArgonTxId = undefined;
    resetStep(orphanedReturnArgonProgress);
  }

  function clearOrphanedReturnBitcoinProgress() {
    orphanedReturnBitcoinUtxoId = undefined;
    resetStep(orphanedReturnBitcoinProgress);
  }

  function clearMismatchAcceptProgress() {
    mismatchAcceptUnsub?.();
    mismatchAcceptUnsub = undefined;
    mismatchAcceptTxId = undefined;
    resetStep(mismatchAcceptArgonProgress);
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

    if (shouldKeepKnownProgress(currentLock.utxoId, lockProcessingUtxoId, lockProcessingProgress.value, nextProgress)) {
      updateStepProgress(lockProcessingProgress, { error });
      return;
    }

    lockProcessingUtxoId = currentLock.utxoId;
    updateStepProgress(lockProcessingProgress, { ...nextProgress, error });
  }

  function updateBitcoinReleaseProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      clearBitcoinReleaseProgress();
      return;
    }
    const details = bitcoinLocks.getReleaseProcessingDetails(currentLock);
    if (shouldKeepKnownProgress(currentLock.utxoId, bitcoinReleaseUtxoId, bitcoinReleaseProgress.value, details)) {
      updateStepProgress(bitcoinReleaseProgress, { error: details.releaseError ?? '' });
      return;
    }

    bitcoinReleaseUtxoId = currentLock.utxoId;
    updateStepProgress(bitcoinReleaseProgress, {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
      error: details.releaseError ?? '',
    });
  }

  function updateOrphanedReturnBitcoinProgress() {
    const currentLock = lock.value;
    if (!currentLock?.utxoId) {
      clearOrphanedReturnBitcoinProgress();
      return;
    }
    const record = bitcoinLocks.getMismatchViewState(currentLock).nextCandidate?.returnRecord;
    if (!record) {
      clearOrphanedReturnBitcoinProgress();
      return;
    }
    const details = bitcoinLocks.getReleaseLifecycleProgress(record);
    if (
      shouldKeepKnownProgress(
        currentLock.utxoId,
        orphanedReturnBitcoinUtxoId,
        orphanedReturnBitcoinProgress.value,
        details,
      )
    ) {
      updateStepProgress(orphanedReturnBitcoinProgress, { error: details.error ?? '' });
      return;
    }

    orphanedReturnBitcoinUtxoId = currentLock.utxoId;
    updateStepProgress(orphanedReturnBitcoinProgress, {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
      error: details.error ?? '',
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

    orphanedReturnArgonUnsub?.();
    orphanedReturnArgonUnsub = undefined;

    mismatchAcceptUnsub?.();
    mismatchAcceptUnsub = undefined;

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

    if (bitcoinLocks.getAcceptedFundingRecord(currentLock)?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      updateBitcoinReleaseProgress();
    }

    if (
      bitcoinLocks.getMismatchViewState(currentLock).nextCandidate?.returnRecord?.status ===
      BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin
    ) {
      updateOrphanedReturnBitcoinProgress();
    }
  }

  function shouldKeepKnownProgress(
    utxoId: number | undefined,
    trackedUtxoId: number | undefined,
    currentProgress: IStepProgress,
    nextProgress: Pick<IStepProgress, 'progressPct' | 'confirmations'>,
  ): boolean {
    if (utxoId == null) return false;
    if (trackedUtxoId !== utxoId) return false;
    if (nextProgress.progressPct !== 0 || nextProgress.confirmations > 0) return false;
    return currentProgress.progressPct > 0 || currentProgress.confirmations > 0;
  }

  function syncStatusRefreshInterval() {
    const currentLock = lock.value;
    if (!currentLock) {
      stopStatusRefreshInterval();
      return;
    }

    const fundingStatus = bitcoinLocks.getAcceptedFundingRecord(currentLock)?.status;
    const orphanedReturnStatus = bitcoinLocks.getMismatchViewState(currentLock).nextCandidate?.returnRecord?.status;
    const needsStatusRefresh =
      bitcoinLocks.isLockProcessingStatus(currentLock) ||
      fundingStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin ||
      orphanedReturnStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;

    if (!needsStatusRefresh) {
      stopStatusRefreshInterval();
      return;
    }

    refreshPolledProgress();
    if (statusRefreshInterval) return;

    statusRefreshInterval = setInterval(refreshPolledProgress, 1e3);
  }

  function attachArgonProgress() {
    const personalLockUtxoId = lock.value?.utxoId;
    if (!personalLockUtxoId) {
      clearArgonProgress();
      return;
    }
    const txInfo = myVault.getBitcoinReleaseRequestTxInfo(personalLockUtxoId);
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

  function attachOrphanedReturnArgonProgress() {
    const utxoId = lock.value?.utxoId;
    if (!utxoId) {
      clearOrphanedReturnArgonProgress();
      return;
    }
    const currentLock = lock.value;
    if (!currentLock) {
      clearOrphanedReturnArgonProgress();
      return;
    }
    const record = bitcoinLocks.getMismatchViewState(currentLock).nextCandidate?.returnRecord;
    if (!record || record.status !== BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
      clearOrphanedReturnArgonProgress();
      return;
    }
    const txInfo = bitcoinLocks.getOrphanedReturnTxInfoForRecord(utxoId, record);
    if (!txInfo) {
      clearOrphanedReturnArgonProgress();
      return;
    }
    if (orphanedReturnArgonTxId === txInfo.tx.id && orphanedReturnArgonUnsub) return;
    clearOrphanedReturnArgonProgress();
    orphanedReturnArgonTxId = txInfo.tx.id;
    orphanedReturnArgonUnsub = txInfo.subscribeToProgress((args, error) => {
      updateStepProgress(orphanedReturnArgonProgress, {
        progressPct: args.progressPct,
        confirmations: args.confirmations,
        expectedConfirmations: args.expectedConfirmations,
        error: error?.message ?? '',
      });
    });
  }

  function attachMismatchAcceptProgress() {
    const currentLock = lock.value;
    if (!currentLock?.utxoId) {
      clearMismatchAcceptProgress();
      return;
    }
    const txInfo = bitcoinLocks.getLatestMismatchAcceptTxInfo(currentLock.utxoId);
    if (!txInfo) {
      clearMismatchAcceptProgress();
      return;
    }
    if (mismatchAcceptTxId === txInfo.tx.id && mismatchAcceptUnsub) return;
    clearMismatchAcceptProgress();
    mismatchAcceptTxId = txInfo.tx.id;
    mismatchAcceptUnsub = txInfo.subscribeToProgress((args, error) => {
      updateStepProgress(mismatchAcceptArgonProgress, {
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
    miningFramesUnsub = miningFrames.onTick(() => {
      if (isReleaseArgonPhase(lock.value)) {
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
      clearOrphanedReturnArgonProgress();
      clearOrphanedReturnBitcoinProgress();
      clearMismatchAcceptProgress();
      stopStatusRefreshInterval();
      return;
    }

    const fundingRecord = bitcoinLocks.getAcceptedFundingRecord(currentLock);
    const releaseStatus = fundingRecord?.status;
    const isReleasingOnArgon = isReleaseArgonPhase(currentLock);
    const isReleasingOnBitcoin = releaseStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;

    if (isReleasingOnArgon) {
      attachArgonProgress();
    } else {
      clearArgonProgress();
    }

    if (isReleasingOnArgon) {
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

    const mismatchView = bitcoinLocks.getMismatchViewState(currentLock);
    const orphanedRecord = mismatchView.nextCandidate?.returnRecord;
    if (orphanedRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
      attachOrphanedReturnArgonProgress();
    } else {
      clearOrphanedReturnArgonProgress();
    }

    if (orphanedRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      updateOrphanedReturnBitcoinProgress();
    } else {
      clearOrphanedReturnBitcoinProgress();
    }

    if (mismatchView.phase === 'accepting') {
      attachMismatchAcceptProgress();
    } else {
      clearMismatchAcceptProgress();
    }

    syncStatusRefreshInterval();
  }

  function getStatusProgress(status: BitcoinLockStatus | null | undefined): IStepProgress {
    const fundingRecord = lock.value ? bitcoinLocks.getAcceptedFundingRecord(lock.value) : undefined;
    if (
      status === BitcoinLockStatus.Releasing ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin
    ) {
      if (fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
        return bitcoinReleaseProgress.value;
      }
      if (requestReleaseByVaultProgress.value > 0) {
        return vaultCosignProgress.value;
      }
      return argonReleaseProgress.value;
    }
    if (!status) return DEFAULT_PROGRESS;
    if (
      status === BitcoinLockStatus.LockIsProcessingOnArgon ||
      status === BitcoinLockStatus.LockPendingFunding ||
      status === BitcoinLockStatus.LockExpiredWaitingForFunding ||
      status === BitcoinLockStatus.LockExpiredWaitingForFundingAcknowledged
    ) {
      return lockProcessingProgress.value;
    }
    return DEFAULT_PROGRESS;
  }

  function getUnlockProgressPct(status: BitcoinLockStatus | null | undefined): number {
    const fundingRecord = lock.value ? bitcoinLocks.getAcceptedFundingRecord(lock.value) : undefined;
    const inReleasePhase =
      status === BitcoinLockStatus.Releasing ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    if (!inReleasePhase) return 0;
    if (fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      return 66 + bitcoinReleaseProgress.value.progressPct * 0.34;
    }
    if (requestReleaseByVaultProgress.value > 0) {
      return 33 + requestReleaseByVaultProgress.value * 0.33;
    }
    if (
      status === BitcoinLockStatus.Releasing ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon
    ) {
      const argonPct = argonReleaseProgress.value.progressPct * 0.33;
      if (argonReleaseProgress.value.confirmations >= 0 && argonReleaseProgress.value.expectedConfirmations > 0) {
        return Math.max(1, argonPct);
      }
      return argonPct;
    }
    return 0;
  }

  function getUnlockProgressLabel(status: BitcoinLockStatus | null | undefined): string {
    const fundingRecord = lock.value ? bitcoinLocks.getAcceptedFundingRecord(lock.value) : undefined;
    const inReleasePhase =
      status === BitcoinLockStatus.Releasing ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon ||
      fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;
    if (!inReleasePhase) return 'Analyzing Network State...';
    const step = getStatusProgress(status);
    if (fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) {
      return generateProgressLabel(step?.confirmations ?? -1, step?.expectedConfirmations ?? 0, {
        blockType: 'Bitcoin',
      });
    }
    if (requestReleaseByVaultProgress.value > 0) {
      return 'Waiting for Vault to Cosign';
    }
    return generateProgressLabel(step?.confirmations ?? -1, step?.expectedConfirmations ?? 0, {
      blockType: 'Argon',
    });
  }

  function getUnlockErrorLabel(lockRecord: IBitcoinLockRecord): string {
    const fundingRecord = bitcoinLocks.getAcceptedFundingRecord(lockRecord);
    if (fundingRecord?.statusError)
      return `An unexpected error has occurred unlocking your Bitcoin: ${fundingRecord.statusError}`;
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

  function isReleaseArgonPhase(lockRecord: IBitcoinLockRecord | null): boolean {
    if (!lockRecord) return false;
    const releaseStatus = bitcoinLocks.getAcceptedFundingRecord(lockRecord)?.status;
    if (releaseStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) return true;
    if (releaseStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin) return false;
    return lockRecord.status === BitcoinLockStatus.Releasing;
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
    orphanedReturnArgon: orphanedReturnArgonProgress,
    orphanedReturnBitcoin: orphanedReturnBitcoinProgress,
    mismatchAcceptArgon: mismatchAcceptArgonProgress,
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
