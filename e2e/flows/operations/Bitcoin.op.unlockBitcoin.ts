import assert from 'node:assert/strict';
import {
  createBitcoinAddress,
  mineBitcoinSingleBlock,
  waitForBitcoinAddressSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import type {
  IBitcoinLocksUnlockReleaseInspect,
  IBitcoinUnlockReleaseState,
  IMyVaultInspect,
} from '../types/srcVue.ts';
import { clickIfVisible, pollEvery, sleep } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

type IUnlockBitcoinUiState = {
  personalVisible: boolean;
  isLocked: boolean | null;
  lockingEntryVisible: boolean;
  releaseEntryVisible: boolean;
  lockingOverlayState?: string | null;
  unlockingOverlayState?: string | null;
};

type IUnlockBitcoinState = IE2EOperationInspectState<IUnlockBackendReleaseState, IUnlockBitcoinUiState>;

interface IUnlockProgress {
  overlayUnlockCompleteSeen: boolean;
  personalReleaseCompleteSeen: boolean;
}

export type IUnlockBackendReleaseState = IBitcoinUnlockReleaseState;

const UNLOCK_INSPECT_TIMEOUT_MS = 20_000;
const DEFAULT_UNLOCK_BACKEND_STATE: IUnlockBackendReleaseState = {
  hasActiveLock: false,
  isPendingFunding: false,
  isLockReadyForUnlock: false,
  hasFundingRecord: false,
  isReleaseStatus: false,
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
  async inspect({ flow, flowName }) {
    const [ui, lockingOverlay, unlockingOverlay] = await Promise.all([
      readUnlockUiState(flow),
      flow.isVisible('BitcoinLockingOverlay'),
      flow.isVisible('BitcoinUnlockingOverlay'),
    ]);
    const chainState = await readUnlockBackendReleaseState(flow, flowName);
    const lockingOverlayState = lockingOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const unlockingOverlayState = unlockingOverlay.visible
      ? await flow.getAttribute('BitcoinUnlockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const alreadyUnlocked = ui.isLocked === false && ui.lockingEntryVisible && !ui.releaseEntryVisible;
    const backendUnlockReady = chainState.isLockReadyForUnlock;
    const releaseInProgress = chainState.isReleaseStatus && !chainState.isReleaseComplete;
    const canRun =
      !alreadyUnlocked && (releaseInProgress || ui.releaseEntryVisible || ui.isLocked === true || backendUnlockReady);
    const isComplete = alreadyUnlocked || chainState.isReleaseComplete;
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !releaseInProgress && !ui.releaseEntryVisible && ui.isLocked !== true) {
      blockers.push('Unlock entry point is not visible yet.');
    }
    return {
      chainState,
      uiState: {
        personalVisible: ui.personalVisible,
        isLocked: ui.isLocked,
        lockingEntryVisible: ui.lockingEntryVisible,
        releaseEntryVisible: ui.releaseEntryVisible,
        lockingOverlayState,
        unlockingOverlayState,
      },
      state: operationState,
      phase:
        lockingOverlay.visible && lockingOverlayState
          ? `locking:${lockingOverlayState}`
          : unlockingOverlay.visible && unlockingOverlayState
            ? `unlock:${unlockingOverlayState}`
            : ui.releaseEntryVisible
              ? 'dashboard:releaseEntry'
              : ui.isLocked === true
                ? 'dashboard:locked'
                : ui.isLocked === false
                  ? 'dashboard:unlocked'
                  : undefined,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state) {
    const latestChainState = await readUnlockBackendReleaseState(flow, flowName).catch(() => state.chainState);
    const releaseInProgress = latestChainState.isReleaseStatus && !latestChainState.isReleaseComplete;

    if (state.uiState.isLocked === false && state.uiState.lockingEntryVisible && !state.uiState.releaseEntryVisible) {
      return;
    }
    if (releaseInProgress) {
      const releaseProgress = await advanceUnlockUntilComplete(flow, flowName);
      assert.ok(
        releaseProgress.overlayUnlockCompleteSeen || releaseProgress.personalReleaseCompleteSeen,
        `${flowName}: Missing unlock completion state while resuming release`,
      );
      if (releaseProgress.overlayUnlockCompleteSeen) {
        await flow.click('UnlockComplete.closeOverlay()', { timeoutMs: 180_000 });
      }
      if (releaseProgress.personalReleaseCompleteSeen || releaseProgress.overlayUnlockCompleteSeen) {
        await flow.waitFor(
          { selector: '[data-testid="PersonalBitcoin"][data-lock-state="None"]' },
          { timeoutMs: 120_000 },
        );
      }
      return;
    }

    const unlockOverlayMinerAddress = createBitcoinAddress();
    await pollEvery(
      1_000,
      async () => {
        const latest = await flow.inspect<IUnlockBitcoinState>();
        if (latest.uiState.unlockingOverlayState === 'Start') {
          return true;
        }

        if (
          (await clickIfVisible(flow, 'LockMinting.closeOverlay()')) ||
          (await clickIfVisible(flow, 'LockStart.closeOverlay()'))
        ) {
          return false;
        }
        await flow.run(appDismissBlockingOverlays);

        const activeTab = await flow.isVisible('VaultingScreen');
        if (!activeTab.visible) {
          await flow.run(vaultingActivateTab).catch(() => undefined);
        }

        if (latest.uiState.personalVisible && latest.uiState.releaseEntryVisible) {
          await flow.click('PersonalBitcoin.showReleaseOverlay()', { timeoutMs: 1_000 });
          const afterClick = await flow.inspect<IUnlockBitcoinState>();
          if (afterClick.uiState.unlockingOverlayState === 'Start') {
            return true;
          }
          return false;
        }

        if (
          latest.uiState.personalVisible &&
          latest.uiState.isLocked === true &&
          (await clickIfVisible(flow, LOCKED_UNLOCK_BUTTON))
        ) {
          const afterClick = await flow.inspect<IUnlockBitcoinState>();
          if (afterClick.uiState.unlockingOverlayState === 'Start') {
            return true;
          }
          return false;
        }

        mineBitcoinSingleBlock(unlockOverlayMinerAddress);
        return false;
      },
      {
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: unlock entry did not become available in time.`,
      },
    );

    await flow.inspect<IUnlockBitcoinState>();

    const releaseAddress = createBitcoinAddress();
    await flow.type('UnlockStart.destinationAddress', releaseAddress);

    await flow.click('UnlockStart.submitRelease()');
    const releaseProgress = await advanceUnlockUntilComplete(flow, flowName);
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
      await flow.waitFor(
        { selector: '[data-testid="PersonalBitcoin"][data-lock-state="None"]' },
        { timeoutMs: 120_000 },
      );
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
      flow.isVisible({ selector: '[data-testid="WelcomeOverlay"]' }).catch(() => ({ visible: false, exists: false })),
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

  const isLockedRaw = personal.exists
    ? await flow.getAttribute('PersonalBitcoin', 'data-is-locked', { timeoutMs: 1_000 }).catch(() => null)
    : null;

  let isLocked: boolean | null = null;
  if (isLockedRaw === 'true') isLocked = true;
  if (isLockedRaw === 'false') isLocked = false;

  return {
    personalVisible: personal.visible,
    isLocked,
    lockingEntryVisible: lockingEntry.visible,
    releaseEntryVisible: releaseEntry.visible,
  };
}

async function advanceUnlockUntilComplete(
  flow: IBitcoinFlowContext['flow'],
  flowName: string,
): Promise<IUnlockProgress> {
  const personalReleaseCompleteTarget = {
    selector: '[data-testid="PersonalBitcoin"][data-lock-state="None"]' as const,
  };

  const progress: IUnlockProgress = {
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

    const unlockState = await flow.inspect<IUnlockBitcoinState>();
    const backendRelease = await readUnlockBackendReleaseState(flow, flowName);
    const personalReleaseCompleteCount = await flow.count(personalReleaseCompleteTarget);
    if (backendRelease.isReleaseComplete || personalReleaseCompleteCount > 0) {
      progress.personalReleaseCompleteSeen = true;
      return progress;
    }

    if (unlockState.uiState.unlockingOverlayState === 'Complete') {
      progress.overlayUnlockCompleteSeen = true;
      return progress;
    }

    mineBitcoinSingleBlock(minerAddress);
    await sleep(3_000);
  }

  return progress;
}

export async function readUnlockBackendReleaseState(
  flow: IE2EFlowRuntime,
  flowName: string,
): Promise<IUnlockBackendReleaseState> {
  const value: Partial<IUnlockBackendReleaseState> =
    (await flow.queryApp<IUnlockBackendReleaseState>(UNLOCK_BACKEND_RELEASE_FN, {
      timeoutMs: UNLOCK_INSPECT_TIMEOUT_MS,
      args: { flowName },
    })) ?? {};
  return {
    ...DEFAULT_UNLOCK_BACKEND_STATE,
    ...value,
  };
}

async function unlockBackendReleaseInspect(refs: IInspectRefs): Promise<IUnlockBackendReleaseState> {
  await refs.myVault.load().catch(() => undefined);
  await refs.bitcoinLocks.load().catch(() => undefined);

  const vaultId = refs.myVault.vaultId;
  if (vaultId == null) return DEFAULT_UNLOCK_BACKEND_STATE;
  const locks = refs.bitcoinLocks.getActiveLocks();
  return refs.bitcoinLocks.getLockUnlockReleaseState(locks[0]);
}

const UNLOCK_BACKEND_RELEASE_FN = unlockBackendReleaseInspect.toString();

type IInspectRefs = {
  myVault: IMyVaultInspect;
  bitcoinLocks: IBitcoinLocksUnlockReleaseInspect;
};
