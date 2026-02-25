import * as Vue from 'vue';
import { defineStore } from 'pinia';
import type { MiningFrames } from '@argonprotocol/apps-core';
import { getMyVault } from './vaults.ts';
import { getBitcoinLocks } from './bitcoin.ts';
import { getMiningFrames } from './mainchain.ts';
import { BitcoinLockStatus, IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { ExtrinsicType } from '../lib/db/TransactionsTable.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import type { MyVault } from '../lib/MyVault.ts';
import type BitcoinLocksStore from '../lib/BitcoinLocksStore.ts';

type UnlockPhase = 'none' | 'argon' | 'vault' | 'signed' | 'bitcoin';
type PollingState = { interval?: ReturnType<typeof setInterval> };
type TxProgressArgs = {
  progressPct: number;
  confirmations: number;
  expectedConfirmations: number;
};
type TxProgressInfo = {
  tx: { id: number };
  subscribeToProgress: (callback: (args: TxProgressArgs, error?: Error) => void) => () => void;
};
type TxProgressSubscription = {
  txId?: number;
  unsubscribe?: () => void;
};

export interface IStepProgress {
  progressPct: number;
  confirmations: number;
  expectedConfirmations: number;
  error: string;
}

const DEFAULT_PROGRESS: IStepProgress = {
  progressPct: 0,
  confirmations: -1,
  expectedConfirmations: 0,
  error: '',
};

export const useBitcoinLockProgress = defineStore('bitcoinLockProgress', () => {
  const myVault: MyVault = getMyVault();
  const bitcoinLocks: BitcoinLocksStore = getBitcoinLocks();
  const miningFrames: MiningFrames = getMiningFrames();

  const lock = Vue.ref<IBitcoinLockRecord | null>(null);
  const activeConsumers = Vue.ref(0);

  const lockProcessing = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const argonRelease = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const vaultCosign = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const bitcoinRelease = Vue.ref<IStepProgress>({ ...DEFAULT_PROGRESS });
  const requestReleaseByVaultProgress = Vue.ref(0);

  const lockProcessingPolling: PollingState = {};
  const bitcoinReleasePolling: PollingState = {};
  const argonReleaseSubscription: TxProgressSubscription = {};
  const vaultCosignSubscription: TxProgressSubscription = {};
  let miningFramesUnsub: (() => void) | undefined;

  function trackLock(initialLock: IBitcoinLockRecord | null): () => void {
    activeConsumers.value += 1;
    lock.value = initialLock;
    syncWithStatus();
    return () => {
      activeConsumers.value = Math.max(0, activeConsumers.value - 1);
      if (activeConsumers.value === 0) {
        lock.value = null;
        clearAllProgress();
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

  function getUnlockPhase(status: BitcoinLockStatus | null | undefined): UnlockPhase {
    if (!status) return 'none';
    if (status === BitcoinLockStatus.ReleaseIsProcessingOnBitcoin) return 'bitcoin';
    if (status === BitcoinLockStatus.ReleaseIsWaitingForVault) return 'vault';
    if (status === BitcoinLockStatus.ReleaseSigned) return 'signed';
    if (status === BitcoinLockStatus.ReleaseIsProcessingOnArgon) return 'argon';
    return 'none';
  }

  function getUnlockProgressPct(status: BitcoinLockStatus | null | undefined): number {
    const phase = getUnlockPhase(status);
    if (phase === 'bitcoin') return 66 + bitcoinRelease.value.progressPct * 0.34;
    if (phase === 'vault') return 33 + requestReleaseByVaultProgress.value * 0.33;
    if (phase === 'signed') return 66;
    if (phase === 'argon') return argonRelease.value.progressPct * 0.33;
    return 0;
  }

  function getUnlockProgressLabel(status: BitcoinLockStatus | null | undefined): string {
    const phase = getUnlockPhase(status);
    if (phase === 'bitcoin') {
      return generateProgressLabel(bitcoinRelease.value.confirmations, bitcoinRelease.value.expectedConfirmations, {
        blockType: 'Bitcoin',
      });
    }
    if (phase === 'vault') return 'Waiting for Vault to Cosign';
    if (phase === 'signed') return 'Submitting transfer to Bitcoin network';
    if (phase === 'argon') {
      return generateProgressLabel(argonRelease.value.confirmations, argonRelease.value.expectedConfirmations, {
        blockType: 'Argon',
      });
    }
    return 'Analyzing Network State...';
  }

  function getUnlockErrorLabel(lockRecord: IBitcoinLockRecord): string {
    if (lockRecord.releaseError) {
      return `An unexpected error has occurred unlocking your Bitcoin: ${lockRecord.releaseError}`;
    }
    if (argonRelease.value.error) {
      return `Error submitting to argon: ${argonRelease.value.error}`;
    }
    if (vaultCosign.value.error) {
      return `Error co-signing this bitcoin utxo: ${vaultCosign.value.error}`;
    }
    if (bitcoinRelease.value.error) {
      return `Error finalizing on bitcoin: ${bitcoinRelease.value.error}`;
    }
    return '';
  }

  function syncWithStatus() {
    const currentLock = lock.value;
    if (!currentLock) {
      clearAllProgress();
      return;
    }

    const status = currentLock.status;

    const isLockProcessing =
      status === BitcoinLockStatus.LockIsProcessingOnArgon || status === BitcoinLockStatus.LockIsProcessingOnBitcoin;
    if (isLockProcessing) {
      ensureLockProcessingInterval();
    } else {
      clearLockProcessing();
    }

    const releasePhase = getUnlockPhase(status);

    if (releasePhase === 'argon') {
      attachArgonRelease();
    } else {
      clearArgonRelease();
    }

    if (releasePhase === 'vault') {
      attachVaultCosign();
      void ensureMiningFramesSubscription();
      updateVaultWaitProgress();
    } else {
      clearVaultCosign();
      requestReleaseByVaultProgress.value = 0;
    }

    if (releasePhase === 'bitcoin') {
      ensureBitcoinReleaseInterval();
    } else {
      clearBitcoinRelease();
    }
  }

  function ensureLockProcessingInterval() {
    ensurePolling(lockProcessingPolling, updateLockProcessing);
  }

  function updateLockProcessing() {
    const currentLock = lock.value;
    if (!currentLock) {
      resetStep(lockProcessing);
      return;
    }

    const details = bitcoinLocks.getLockProcessingDetails(currentLock);
    lockProcessing.value = {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
      error: '',
    };

    if (currentLock.status === BitcoinLockStatus.LockIsProcessingOnArgon) {
      const txInfo = myVault.getTxInfoByType(ExtrinsicType.BitcoinRequestLock);
      const error = txInfo?.getStatus()?.error;
      if (error) {
        lockProcessing.value.error = error.message || String(error);
      }
    }
  }

  function ensureBitcoinReleaseInterval() {
    ensurePolling(bitcoinReleasePolling, updateBitcoinRelease);
  }

  function updateBitcoinRelease() {
    const currentLock = lock.value;
    if (!currentLock) {
      resetStep(bitcoinRelease);
      return;
    }
    const details = bitcoinLocks.getReleaseProcessingDetails(currentLock);
    bitcoinRelease.value = {
      progressPct: details.progressPct,
      confirmations: details.confirmations,
      expectedConfirmations: details.expectedConfirmations,
      error: details.releaseError ?? '',
    };
  }

  function attachArgonRelease() {
    const utxoId = lock.value?.utxoId;
    if (!utxoId) {
      clearArgonRelease();
      return;
    }

    const txInfo = myVault.getTxInfo((extrinsicType, metadata) => {
      return extrinsicType === ExtrinsicType.BitcoinRequestRelease && metadata?.utxoId === utxoId;
    }) as TxProgressInfo | undefined;

    attachTxProgressSubscription(argonReleaseSubscription, argonRelease, txInfo);
  }

  function attachVaultCosign() {
    const txInfo = myVault.getTxInfoByType(ExtrinsicType.VaultCosignBitcoinRelease) as TxProgressInfo | undefined;
    attachTxProgressSubscription(vaultCosignSubscription, vaultCosign, txInfo);
  }

  async function ensureMiningFramesSubscription() {
    if (miningFramesUnsub) return;
    await miningFrames.load();
    miningFramesUnsub = miningFrames.onTick(() => {
      if (lock.value?.status === BitcoinLockStatus.ReleaseIsWaitingForVault) {
        updateVaultWaitProgress();
      }
    }).unsubscribe;
  }

  function updateVaultWaitProgress() {
    const currentLock = lock.value;
    if (!currentLock) {
      requestReleaseByVaultProgress.value = 0;
      return;
    }
    requestReleaseByVaultProgress.value = bitcoinLocks.getRequestReleaseByVaultProgress(currentLock, miningFrames);
  }

  function clearAllProgress() {
    clearLockProcessing();
    clearArgonRelease();
    clearVaultCosign();
    clearBitcoinRelease();
    requestReleaseByVaultProgress.value = 0;
  }

  function clearLockProcessing() {
    clearPolling(lockProcessingPolling, lockProcessing);
  }

  function clearArgonRelease() {
    clearTxProgressSubscription(argonReleaseSubscription, argonRelease);
  }

  function clearVaultCosign() {
    clearTxProgressSubscription(vaultCosignSubscription, vaultCosign);
  }

  function clearBitcoinRelease() {
    clearPolling(bitcoinReleasePolling, bitcoinRelease);
  }

  function resetStep(step: Vue.Ref<IStepProgress>) {
    step.value = { ...DEFAULT_PROGRESS };
  }

  function ensurePolling(state: PollingState, tick: () => void) {
    if (state.interval) return;
    tick();
    state.interval = setInterval(tick, 1e3);
  }

  function clearPolling(state: PollingState, step: Vue.Ref<IStepProgress>) {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    resetStep(step);
  }

  function attachTxProgressSubscription(
    state: TxProgressSubscription,
    step: Vue.Ref<IStepProgress>,
    txInfo: TxProgressInfo | undefined,
  ) {
    if (!txInfo) {
      clearTxProgressSubscription(state, step);
      return;
    }
    if (state.txId === txInfo.tx.id && state.unsubscribe) return;
    clearTxProgressSubscription(state, step);
    state.txId = txInfo.tx.id;
    state.unsubscribe = txInfo.subscribeToProgress((args, error) => {
      step.value = {
        progressPct: args.progressPct,
        confirmations: args.confirmations,
        expectedConfirmations: args.expectedConfirmations,
        error: error?.message ?? '',
      };
    });
  }

  function clearTxProgressSubscription(state: TxProgressSubscription, step: Vue.Ref<IStepProgress>) {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.txId = undefined;
    resetStep(step);
  }

  return {
    lock,
    trackLock,
    updateLock,
    lockProcessing,
    argonRelease,
    vaultCosign,
    bitcoinRelease,
    requestReleaseByVaultProgress,
    getUnlockProgressPct,
    getUnlockProgressLabel,
    getUnlockErrorLabel,
  };
});
