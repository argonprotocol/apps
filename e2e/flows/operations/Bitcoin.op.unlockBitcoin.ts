import assert from 'node:assert/strict';
import { createBitcoinAddress, mineBitcoinSingleBlock, waitForBitcoinAddressSatoshis } from '../helpers/bitcoinNode.ts';
import { clickIfVisible, parseOptionalPositiveInteger, pollEvery, sleep } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { E2ETarget, IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

type IUnlockBitcoinUiState = {
  personalVisible: boolean;
  lockState: string | null;
  isLocked: boolean | null;
  lockUtxoId: number | null;
  lockingEntryVisible: boolean;
  releaseEntryVisible: boolean;
};

interface IUnlockBitcoinState extends IE2EOperationInspectState<IUnlockBackendReleaseState, IUnlockBitcoinUiState> {
  personalVisible: boolean;
  lockState: string | null;
  isLocked: boolean | null;
  lockUtxoId: number | null;
  lockingEntryVisible: boolean;
  releaseEntryVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

interface IUnlockProgress {
  personalReleaseProcessingArgonSeen: boolean;
  personalReleaseWaitingForVaultSeen: boolean;
  personalReleaseSignedSeen: boolean;
  personalReleaseProcessingBitcoinSeen: boolean;
  overlayUnlockCompleteSeen: boolean;
  personalReleaseCompleteSeen: boolean;
}

export interface IUnlockBackendReleaseState {
  hasActiveLock: boolean;
  lockStatus: string | null;
  hasFundingRecord: boolean;
  fundingStatus: string | null;
  hasReleaseSignal: boolean;
  isArgonSubmitting: boolean;
  isWaitingForVaultCosign: boolean;
  isBitcoinReleaseProcessing: boolean;
  hasRequestDetails: boolean;
  hasCosign: boolean;
  hasReleaseTxid: boolean;
  isReleaseComplete: boolean;
}

interface IInspectCommandResult {
  ok?: boolean;
  value?: IUnlockBackendReleaseState;
}

const UNLOCK_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_UNLOCK_BACKEND_STATE: IUnlockBackendReleaseState = {
  hasActiveLock: false,
  lockStatus: null,
  hasFundingRecord: false,
  fundingStatus: null,
  hasReleaseSignal: false,
  isArgonSubmitting: false,
  isWaitingForVaultCosign: false,
  isBitcoinReleaseProcessing: false,
  hasRequestDetails: false,
  hasCosign: false,
  hasReleaseTxid: false,
  isReleaseComplete: false,
};

const LOCKED_UNLOCK_BUTTON = {
  selector: '[data-testid="PersonalBitcoin"][data-is-locked="true"] button',
} as const;

export default new Operation<IBitcoinFlowContext, IUnlockBitcoinState>(import.meta, {
  async inspect({ flow }) {
    const ui = await readUnlockUiState(flow);
    const chainState = await inspectUnlockBackendReleaseState(flow, ui.lockUtxoId ?? undefined);
    const alreadyUnlocked =
      ui.lockState === 'None' || (ui.isLocked === false && ui.lockingEntryVisible && !ui.releaseEntryVisible);
    const backendUnlockReady =
      chainState.hasActiveLock && ['LockedAndIsMinting', 'LockedAndMinted'].includes(chainState.lockStatus ?? '');
    const releaseInProgress = chainState.hasReleaseSignal && !chainState.isReleaseComplete;
    const runnable =
      !alreadyUnlocked && (releaseInProgress || ui.releaseEntryVisible || ui.isLocked === true || backendUnlockReady);
    const isComplete = alreadyUnlocked || chainState.isReleaseComplete;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !releaseInProgress && !ui.releaseEntryVisible && ui.isLocked !== true) {
      blockers.push('Unlock entry point is not visible yet.');
    }
    return {
      chainState,
      uiState: {
        personalVisible: ui.personalVisible,
        lockState: ui.lockState,
        isLocked: ui.isLocked,
        lockUtxoId: ui.lockUtxoId,
        lockingEntryVisible: ui.lockingEntryVisible,
        releaseEntryVisible: ui.releaseEntryVisible,
      },
      isRunnable,
      isComplete,
      personalVisible: ui.personalVisible,
      lockState: ui.lockState,
      isLocked: ui.isLocked,
      lockUtxoId: ui.lockUtxoId,
      lockingEntryVisible: ui.lockingEntryVisible,
      releaseEntryVisible: ui.releaseEntryVisible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state, api) {
    if (
      state.lockState === 'None' ||
      (state.isLocked === false && state.lockingEntryVisible && !state.releaseEntryVisible)
    ) {
      return;
    }
    const latestState = await api.inspect(this);
    const releaseInProgress = latestState.chainState.hasReleaseSignal && !latestState.chainState.isReleaseComplete;
    if (releaseInProgress) {
      const releaseProgress = await advanceUnlockUntilComplete(flow, async () => await api.inspect(this));
      assert.ok(
        releaseProgress.overlayUnlockCompleteSeen || releaseProgress.personalReleaseCompleteSeen,
        `${flowName}: Missing unlock completion state while resuming release`,
      );
      if (releaseProgress.overlayUnlockCompleteSeen) {
        await flow.click('UnlockComplete.closeOverlay()', { timeoutMs: 180_000 });
      }
      if (releaseProgress.personalReleaseCompleteSeen || releaseProgress.overlayUnlockCompleteSeen) {
        await flow.waitFor(personalLockStatus('None'), { timeoutMs: 120_000 });
      }
      return;
    }

    const unlockOverlayMinerAddress = createBitcoinAddress();
    await pollEvery(
      4_000,
      async () => {
        const unlockStartVisible = await flow.isVisible('UnlockStart.destinationAddress');
        if (unlockStartVisible.visible) {
          return true;
        }

        await api.run(appDismissBlockingOverlays);
        if (await dismissOpenLockingOverlay(flow)) {
          return false;
        }

        const activeTab = await flow.isVisible('VaultingScreen');
        if (!activeTab.visible) {
          await api.run(vaultingActivateTab).catch(() => undefined);
        }

        const ui = await readUnlockUiState(flow);
        if (ui.personalVisible && ui.releaseEntryVisible) {
          await flow.click('PersonalBitcoin.showReleaseOverlay()', { timeoutMs: 1_000 });
          return true;
        }

        if (ui.personalVisible && ui.isLocked === true && (await clickIfVisible(flow, LOCKED_UNLOCK_BUTTON))) {
          const unlockStartAfterClick = await flow.isVisible('UnlockStart.destinationAddress');
          if (unlockStartAfterClick.visible) {
            return true;
          }
        }

        mineBitcoinSingleBlock(unlockOverlayMinerAddress);
        return false;
      },
      {
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: unlock entry did not become available in time.`,
      },
    );

    const releaseAddress = createBitcoinAddress();
    await flow.type('UnlockStart.destinationAddress', releaseAddress);

    await flow.click('UnlockStart.submitRelease()');
    const releaseProgress = await advanceUnlockUntilComplete(flow, async () => await api.inspect(this));
    assert.ok(
      releaseProgress.overlayUnlockCompleteSeen || releaseProgress.personalReleaseCompleteSeen,
      `${flowName}: Missing unlock completion state (overlay or lock-state None)`,
    );
    if (!releaseProgress.personalReleaseCompleteSeen) {
      console.warn(`[E2E] ${flowName}: unlock completed without observing release completion state`);
    }

    if (releaseProgress.overlayUnlockCompleteSeen) {
      await flow.click('UnlockComplete.closeOverlay()', { timeoutMs: 180_000 });
    }
    if (releaseProgress.personalReleaseCompleteSeen || releaseProgress.overlayUnlockCompleteSeen) {
      await flow.waitFor(personalLockStatus('None'), { timeoutMs: 120_000 });
    }

    const releaseMinerAddress = createBitcoinAddress();
    await waitForBitcoinAddressSatoshis({
      flowName,
      address: releaseAddress,
      minimumSatoshis: 1n,
      minerAddress: releaseMinerAddress,
    });
  },
  async diagnose({ flow, flowName }, state, error) {
    const ui = await readUnlockUiState(flow).catch(() => null);
    const [
      welcomeOverlay,
      walletFundingOverlay,
      vaultingDashboard,
      unlockingOverlay,
      unlockStartErrorText,
      personalReleaseErrorText,
      openDialog,
      openDialogTestId,
      openDialogClass,
      openDialogText,
      ariaHiddenPersonalCount,
      inertPersonalCount,
    ] = await Promise.all([
      flow.isVisible('WelcomeOverlay.closeOverlay()').catch(() => ({ visible: false, exists: false })),
      flow.isVisible('WalletFundingReceivedOverlay.closeOverlay()').catch(() => ({ visible: false, exists: false })),
      flow.isVisible('VaultingDashboard').catch(() => ({ visible: false, exists: false })),
      flow.isVisible('BitcoinUnlockingOverlay').catch(() => ({ visible: false, exists: false })),
      flow.getText('UnlockStart.error', { timeoutMs: 1_000 }).catch(() => null),
      flow.getText('PersonalBitcoin.releaseError', { timeoutMs: 1_000 }).catch(() => null),
      flow
        .isVisible({ selector: '[role="dialog"][data-state="open"]' })
        .catch(() => ({ visible: false, exists: false })),
      flow
        .getAttribute({ selector: '[role="dialog"][data-state="open"]' }, 'data-testid', { timeoutMs: 1_000 })
        .catch(() => null),
      flow
        .getAttribute({ selector: '[role="dialog"][data-state="open"]' }, 'class', { timeoutMs: 1_000 })
        .catch(() => null),
      flow
        .getText({ selector: '[role="dialog"][data-state="open"]' }, { timeoutMs: 1_000 })
        .then(text => text.slice(0, 240))
        .catch(() => null),
      flow.count({ selector: '[aria-hidden="true"] [data-testid="PersonalBitcoin"]' }).catch(() => -1),
      flow.count({ selector: '[inert] [data-testid="PersonalBitcoin"]' }).catch(() => -1),
    ]);

    console.error(
      `[E2E] ${flowName}: unlock diagnostics`,
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        inspect: state,
        ui,
        vaultingDashboardVisible: vaultingDashboard.visible,
        unlockingOverlayVisible: unlockingOverlay.visible,
        welcomeOverlayVisible: welcomeOverlay.visible,
        walletFundingOverlayVisible: walletFundingOverlay.visible,
        openDialogVisible: openDialog.visible,
        unlockStartErrorText,
        personalReleaseErrorText,
        openDialogTestId,
        openDialogClass,
        openDialogText,
        ariaHiddenPersonalCount,
        inertPersonalCount,
      }),
    );
  },
});

async function readUnlockUiState(flow: IE2EFlowRuntime): Promise<IUnlockBitcoinUiState> {
  const [personal, lockingEntry, releaseEntry] = await Promise.all([
    flow.isVisible('PersonalBitcoin'),
    flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
    flow.isVisible('PersonalBitcoin.showReleaseOverlay()'),
  ]);

  const [lockState, isLockedRaw, lockUtxoIdRaw] = personal.exists
    ? await Promise.all([
        flow.getAttribute('PersonalBitcoin', 'data-lock-state', { timeoutMs: 1_000 }).catch(() => null),
        flow.getAttribute('PersonalBitcoin', 'data-is-locked', { timeoutMs: 1_000 }).catch(() => null),
        flow.getAttribute('PersonalBitcoin', 'data-lock-utxo-id', { timeoutMs: 1_000 }).catch(() => null),
      ])
    : [null, null, null];

  return {
    personalVisible: personal.visible,
    lockState: lockState?.trim() || null,
    isLocked: parseBooleanAttribute(isLockedRaw),
    lockUtxoId: parseOptionalPositiveInteger(lockUtxoIdRaw),
    lockingEntryVisible: lockingEntry.visible,
    releaseEntryVisible: releaseEntry.visible,
  };
}

async function dismissOpenLockingOverlay(flow: IE2EFlowRuntime): Promise<boolean> {
  const openDialogs = await flow.count({ selector: '[role="dialog"][data-state="open"].BitcoinLockingOverlay' });
  if (openDialogs === 0) return false;

  if (await clickIfVisible(flow, 'LockStart.closeOverlay()')) {
    await flow.waitFor('BitcoinLockingOverlay', { state: 'missing', timeoutMs: 10_000 }).catch(() => null);
    return true;
  }

  const closeIconSelector =
    '[role="dialog"][data-state="open"].BitcoinLockingOverlay button[class*="border-slate-400"]';
  for (let index = 0; index < openDialogs; index += 1) {
    if (await clickIfVisible(flow, { selector: closeIconSelector, index })) {
      await flow.waitFor('BitcoinLockingOverlay', { state: 'missing', timeoutMs: 10_000 }).catch(() => null);
      const remaining = await flow.count({ selector: '[role="dialog"][data-state="open"].BitcoinLockingOverlay' });
      if (remaining < openDialogs) {
        return true;
      }
    }
  }
  return (await flow.count({ selector: '[role="dialog"][data-state="open"].BitcoinLockingOverlay' })) === 0;
}

function parseBooleanAttribute(raw: string | null): boolean | null {
  if (!raw) return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

async function advanceUnlockUntilComplete(
  flow: IBitcoinFlowContext['flow'],
  refreshState: () => Promise<IUnlockBitcoinState>,
): Promise<IUnlockProgress> {
  const personalReleaseCompleteTarget = personalLockStatus('None');

  const progress: IUnlockProgress = {
    personalReleaseProcessingArgonSeen: false,
    personalReleaseWaitingForVaultSeen: false,
    personalReleaseSignedSeen: false,
    personalReleaseProcessingBitcoinSeen: false,
    overlayUnlockCompleteSeen: false,
    personalReleaseCompleteSeen: false,
  };
  const minerAddress = createBitcoinAddress();

  for (let i = 0; i < 180; i += 1) {
    const unlockStartError = await flow.isVisible('UnlockStart.error');
    if (unlockStartError.visible) {
      const message = await flow
        .getText('UnlockStart.error', { timeoutMs: 1_000 })
        .catch(() => 'Failed to send release request.');
      throw new Error(`Unlock request failed: ${message}`);
    }

    const releaseError = await flow.isVisible('PersonalBitcoin.releaseError');
    if (releaseError.visible) {
      const message = await flow
        .getText('PersonalBitcoin.releaseError', { timeoutMs: 1_000 })
        .catch(() => 'Unknown release error.');
      throw new Error(`Unlock release failed: ${message}`);
    }

    const backendRelease = (await refreshState()).chainState;
    if (backendRelease.isArgonSubmitting) {
      progress.personalReleaseProcessingArgonSeen = true;
    }
    if (backendRelease.isWaitingForVaultCosign) {
      progress.personalReleaseWaitingForVaultSeen = true;
    }
    if (
      backendRelease.hasRequestDetails &&
      backendRelease.hasCosign &&
      !backendRelease.hasReleaseTxid &&
      !backendRelease.isReleaseComplete
    ) {
      progress.personalReleaseSignedSeen = true;
    }
    if (backendRelease.isBitcoinReleaseProcessing) {
      progress.personalReleaseProcessingBitcoinSeen = true;
    }
    const personalReleaseCompleteCount = await flow.count(personalReleaseCompleteTarget);
    if (backendRelease.isReleaseComplete || personalReleaseCompleteCount > 0) {
      progress.personalReleaseCompleteSeen = true;
      return progress;
    }

    const unlockComplete = await flow.isVisible('UnlockComplete.closeOverlay()');
    if (unlockComplete.visible) {
      progress.overlayUnlockCompleteSeen = true;
      return progress;
    }

    mineBitcoinSingleBlock(minerAddress);
    await sleep(3_000);
  }

  return progress;
}

function personalLockStatus(name: string): E2ETarget {
  return {
    selector: `[data-testid="PersonalBitcoin"][data-lock-state="${name}"]`,
  };
}

async function inspectUnlockBackendReleaseState(
  flow: IE2EFlowRuntime,
  expectedUtxoId?: number,
): Promise<IUnlockBackendReleaseState> {
  const result = await flow
    .run<IInspectCommandResult>('command.inspect', {
      fn: UNLOCK_BACKEND_RELEASE_FN,
      timeoutMs: UNLOCK_INSPECT_TIMEOUT_MS,
      args: {
        expectedUtxoId,
      },
    })
    .catch(() => undefined);

  if (!result || result.ok !== true || !result.value || typeof result.value !== 'object') {
    return { ...DEFAULT_UNLOCK_BACKEND_STATE };
  }
  const value = result.value as Partial<IUnlockBackendReleaseState>;
  return {
    hasActiveLock: value.hasActiveLock === true,
    lockStatus: typeof value.lockStatus === 'string' ? value.lockStatus : null,
    hasFundingRecord: value.hasFundingRecord === true,
    fundingStatus: typeof value.fundingStatus === 'string' ? value.fundingStatus : null,
    hasReleaseSignal: value.hasReleaseSignal === true,
    isArgonSubmitting: value.isArgonSubmitting === true,
    isWaitingForVaultCosign: value.isWaitingForVaultCosign === true,
    isBitcoinReleaseProcessing: value.isBitcoinReleaseProcessing === true,
    hasRequestDetails: value.hasRequestDetails === true,
    hasCosign: value.hasCosign === true,
    hasReleaseTxid: value.hasReleaseTxid === true,
    isReleaseComplete: value.isReleaseComplete === true,
  };
}

async function unlockBackendReleaseInspect(
  refs: IInspectRefs,
  args: IInspectArgs = {},
): Promise<IUnlockBackendReleaseState> {
  const defaultState: IUnlockBackendReleaseState = {
    hasActiveLock: false,
    lockStatus: null,
    hasFundingRecord: false,
    fundingStatus: null,
    hasReleaseSignal: false,
    isArgonSubmitting: false,
    isWaitingForVaultCosign: false,
    isBitcoinReleaseProcessing: false,
    hasRequestDetails: false,
    hasCosign: false,
    hasReleaseTxid: false,
    isReleaseComplete: false,
  };
  await refs.myVault.load().catch(() => undefined);
  await refs.bitcoinLocks.load().catch(() => undefined);

  const vaultId = refs.myVault.vaultId ?? null;
  if (vaultId == null) return defaultState;

  const activeLocks = refs.bitcoinLocks.getActiveLocksForVault(vaultId);
  const expectedUtxoId =
    Number.isInteger(args.expectedUtxoId) && (args.expectedUtxoId ?? 0) > 0 ? args.expectedUtxoId : undefined;
  const lock =
    expectedUtxoId != null
      ? (refs.bitcoinLocks.getLockByUtxoId(expectedUtxoId) ??
        activeLocks.find(candidate => Number(candidate.utxoId) === expectedUtxoId) ??
        null)
      : (activeLocks.find(candidate => ['Releasing'].includes(String(candidate.status ?? ''))) ??
        activeLocks.find(candidate =>
          ['LockedAndIsMinting', 'LockedAndMinted'].includes(String(candidate.status ?? '')),
        ) ??
        activeLocks[0] ??
        null);
  if (!lock) return defaultState;

  const fundingRecord = refs.bitcoinLocks.getAcceptedFundingRecord(lock);
  const fundingStatus = typeof fundingRecord?.status === 'string' ? fundingRecord.status : null;
  const hasFundingRecord = !!fundingRecord;
  const hasRequestDetails =
    !!fundingRecord?.releaseToDestinationAddress && fundingRecord.releaseBitcoinNetworkFee != null;
  const hasCosign = !!fundingRecord?.releaseCosignVaultSignature;
  const hasReleaseTxid = typeof fundingRecord?.releaseTxid === 'string' && fundingRecord.releaseTxid.length > 0;

  const phaseIsArgonSubmitting = fundingStatus === 'ReleaseIsProcessingOnArgon';
  const phaseIsBitcoinReleaseProcessing = fundingStatus === 'ReleaseIsProcessingOnBitcoin';
  const hasReleaseError = typeof fundingRecord?.statusError === 'string' && fundingRecord.statusError.length > 0;
  const phaseIsReleaseComplete =
    fundingStatus === 'ReleaseComplete' || fundingRecord?.releasedAtBitcoinHeight != null || lock.status === 'Released';

  const hasReleaseSignal =
    lock.status === 'Releasing' ||
    lock.status === 'Released' ||
    phaseIsArgonSubmitting ||
    phaseIsBitcoinReleaseProcessing ||
    phaseIsReleaseComplete ||
    hasReleaseError ||
    (hasFundingRecord &&
      (fundingRecord.requestedReleaseAtTick != null || hasRequestDetails || hasCosign || hasReleaseTxid));

  const isReleaseComplete = phaseIsReleaseComplete;
  const isBitcoinReleaseProcessing = phaseIsBitcoinReleaseProcessing || (hasReleaseTxid && !isReleaseComplete);
  const isWaitingForVaultCosign =
    hasReleaseSignal && hasRequestDetails && !hasCosign && !isBitcoinReleaseProcessing && !isReleaseComplete;
  const isArgonSubmitting =
    hasReleaseSignal &&
    !isWaitingForVaultCosign &&
    !isBitcoinReleaseProcessing &&
    !isReleaseComplete &&
    !hasReleaseError;

  return {
    hasActiveLock: true,
    lockStatus: typeof lock.status === 'string' ? lock.status : null,
    hasFundingRecord,
    fundingStatus,
    hasReleaseSignal,
    isArgonSubmitting,
    isWaitingForVaultCosign,
    isBitcoinReleaseProcessing,
    hasRequestDetails,
    hasCosign,
    hasReleaseTxid,
    isReleaseComplete,
  };
}

const UNLOCK_BACKEND_RELEASE_FN = unlockBackendReleaseInspect.toString();

interface IInspectArgs {
  expectedUtxoId?: number;
}

interface IInspectLockRecord {
  utxoId?: number;
  status?: string;
}

interface IInspectFundingRecord {
  status?: string;
  statusError?: string;
  requestedReleaseAtTick?: number;
  releaseToDestinationAddress?: string;
  releaseBitcoinNetworkFee?: bigint | number;
  releaseCosignVaultSignature?: Uint8Array | string;
  releaseTxid?: string;
  releasedAtBitcoinHeight?: number;
}

interface IInspectRefs {
  myVault: {
    vaultId?: number;
    load: () => Promise<void>;
  };
  bitcoinLocks: {
    load: () => Promise<void>;
    getActiveLocksForVault: (vaultId: number) => IInspectLockRecord[];
    getLockByUtxoId: (utxoId: number) => IInspectLockRecord | undefined;
    getAcceptedFundingRecord: (lock: IInspectLockRecord) => IInspectFundingRecord | undefined;
  };
}
