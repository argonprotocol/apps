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

  const requestReleaseByVaultProgress = Vue.ref(0);

  let argonProgressUnsub: (() => void) | undefined;
  let vaultCosignUnsub: (() => void) | undefined;
  let miningFramesUnsub: (() => void) | undefined;
  let argonTxId: number | undefined;
  let vaultCosignTxId: number | undefined;
  let lockProcessingInterval: ReturnType<typeof setInterval> | undefined;
  let bitcoinReleaseInterval: ReturnType<typeof setInterval> | undefined;

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
    if (lockProcessingInterval) {
      clearInterval(lockProcessingInterval);
      lockProcessingInterval = undefined;
    }
    resetStep(lockProcessingProgress);
  }

  function clearBitcoinReleaseProgress() {
    if (bitcoinReleaseInterval) {
      clearInterval(bitcoinReleaseInterval);
      bitcoinReleaseInterval = undefined;
    }
    resetStep(bitcoinReleaseProgress);
  }

  function updateLockProcessingProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      resetStep(lockProcessingProgress);
      return;
    }

    const details = bitcoinLocks.getLockProcessingDetails(currentLock);
    updateStepProgress(lockProcessingProgress, {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
    });

    if (currentLock.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      const txInfo = myVault.getTxInfoByType(ExtrinsicType.BitcoinRequestLock);
      const status = txInfo?.getStatus();
      updateStepProgress(lockProcessingProgress, { error: status?.error });
      return;
    }

    updateStepProgress(lockProcessingProgress, { error: '' });
  }

  function ensureLockProcessingInterval() {
    if (lockProcessingInterval) return;
    updateLockProcessingProgress();
    lockProcessingInterval = setInterval(updateLockProcessingProgress, 1e3);
  }

  function updateBitcoinReleaseProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      resetStep(bitcoinReleaseProgress);
      return;
    }

    const details = bitcoinLocks.getReleaseProcessingDetails(currentLock);
    updateStepProgress(bitcoinReleaseProgress, {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
      error: details.releaseError ?? '',
    });
  }

  function ensureBitcoinReleaseInterval() {
    if (bitcoinReleaseInterval) return;
    updateBitcoinReleaseProgress();
    bitcoinReleaseInterval = setInterval(updateBitcoinReleaseProgress, 1e3);
  }

  function attachArgonProgress() {
    const personalLockUtxoId = lock.value?.utxoId;
    if (!personalLockUtxoId) {
      clearArgonProgress();
      return;
    }

    const txInfo = myVault.getTxInfo((extrinsicType, metadata) => {
      return extrinsicType === ExtrinsicType.BitcoinRequestRelease && metadata?.utxoId === personalLockUtxoId;
    });
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
      return;
    }

    const fundingRecord = bitcoinLocks.getAcceptedFundingRecord(currentLock);
    const releaseStatus = fundingRecord?.status;
    const isReleasingOnArgon = isReleaseArgonPhase(currentLock);
    const isReleasingOnBitcoin = releaseStatus === BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin;

    if (isReleasingOnArgon) {
      attachArgonProgress();
      void ensureMiningFramesSubscription();
      updateVaultWaitProgress();
      attachVaultCosignProgress();
    } else {
      clearArgonProgress();
      clearVaultCosignProgress();
      clearVaultWaitProgress();
    }

    if (bitcoinLocks.isLockProcessingStatus(currentLock)) {
      ensureLockProcessingInterval();
    } else {
      clearLockProcessingProgress();
    }

    if (isReleasingOnBitcoin) {
      ensureBitcoinReleaseInterval();
    } else {
      clearBitcoinReleaseProgress();
    }
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
    if (status === BitcoinLockStatus.LockIsProcessingOnArgon || status === BitcoinLockStatus.LockPendingFunding) {
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
    if (fundingRecord?.status === BitcoinUtxoStatus.ReleaseIsProcessingOnArgon) {
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
      return generateProgressLabel(step.confirmations, step.expectedConfirmations, { blockType: 'Bitcoin' });
    }
    if (requestReleaseByVaultProgress.value > 0) {
      return 'Waiting for Vault to Cosign';
    }
    return generateProgressLabel(step.confirmations, step.expectedConfirmations, { blockType: 'Argon' });
  }

  function getUnlockErrorLabel(lockRecord: IBitcoinLockRecord): string {
    const fundingRecord = bitcoinLocks.getAcceptedFundingRecord(lockRecord);
    if (fundingRecord?.statusError) {
      return `An unexpected error has occurred unlocking your Bitcoin: ${fundingRecord.statusError}`;
    }
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
        lock.value = null;
        syncWithStatus();
        miningFramesUnsub?.();
        miningFramesUnsub = undefined;
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
