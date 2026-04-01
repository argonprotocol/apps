import assert from 'node:assert/strict';
import { createBitcoinAddress, mineBitcoinSingleBlock } from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import type {
  IBitcoinLocksUnlockReleaseInspect,
  IBitcoinUnlockReleaseState,
  IMyVaultInspect,
} from '../types/srcVue.ts';
import { clickIfVisible, pollEvery, sleep } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

type IUnlockBitcoinUiState = {
  detailOverlayVisible: boolean;
  lockEntryVisible: boolean;
  lockingOverlayState?: string | null;
  unlockingOverlayState?: string | null;
};

type IUnlockBitcoinState = IE2EOperationInspectState<IUnlockBackendReleaseState, IUnlockBitcoinUiState>;

interface IUnlockProgress {
  requestAcceptedSeen: boolean;
  overlayUnlockCompleteSeen: boolean;
  lockEntryClearedSeen: boolean;
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
    const alreadyUnlocked =
      !chainState.hasActiveLock && !ui.lockEntryVisible && !ui.detailOverlayVisible && !unlockingOverlay.visible;
    const unlockRequestAccepted =
      chainState.isReleaseStatus || unlockingOverlayState === 'IsProcessing' || unlockingOverlayState === 'Complete';
    const canRun =
      !alreadyUnlocked &&
      !unlockRequestAccepted &&
      (chainState.isLockReadyForUnlock || ui.detailOverlayVisible || ui.lockEntryVisible || unlockingOverlay.visible);
    const isComplete = alreadyUnlocked || unlockRequestAccepted;
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !ui.detailOverlayVisible && !ui.lockEntryVisible) {
      blockers.push('Unlock entry point is not visible yet.');
    }
    return {
      chainState,
      uiState: {
        detailOverlayVisible: ui.detailOverlayVisible,
        lockEntryVisible: ui.lockEntryVisible,
        lockingOverlayState,
        unlockingOverlayState,
      },
      state: operationState,
      phase:
        lockingOverlay.visible && lockingOverlayState
          ? `locking:${lockingOverlayState}`
          : unlockingOverlay.visible && unlockingOverlayState
            ? `unlock:${unlockingOverlayState}`
            : ui.detailOverlayVisible
              ? 'dashboard:detail'
              : ui.lockEntryVisible
                ? 'dashboard:lock'
                : undefined,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state) {
    const latestChainState = await readUnlockBackendReleaseState(flow, flowName).catch(() => state.chainState);
    if (
      !latestChainState.hasActiveLock &&
      !(await hasDashboardLockEntry(flow)) &&
      !state.uiState.detailOverlayVisible
    ) {
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
        await flow.run(appPrepareAccess);
        await clickIfVisible(flow, 'WalletFundingReceivedOverlay.closeOverlay()', { timeoutMs: 1_000 });

        const activeTab = await flow.isVisible('VaultingScreen');
        if (!activeTab.visible && !latest.uiState.detailOverlayVisible && !latest.uiState.lockEntryVisible) {
          await flow.run(vaultingActivateTab).catch(() => undefined);
        }

        if (latest.uiState.detailOverlayVisible) {
          await flow.click('LockDetail.unlock()', { timeoutMs: 1_000 });
          const afterClick = await flow.inspect<IUnlockBitcoinState>();
          if (afterClick.uiState.unlockingOverlayState === 'Start') {
            return true;
          }
          return false;
        }

        if (latest.uiState.lockEntryVisible && (await clickDashboardLockEntry(flow, { timeoutMs: 1_000 }))) {
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
    const releaseProgress = await waitForUnlockRequestAccepted(flow, flowName);
    assert.ok(
      releaseProgress.requestAcceptedSeen,
      `${flowName}: Missing unlock request acceptance state (processing overlay or backend release status)`,
    );
  },
  async diagnose({ flow, flowName }, state, error) {
    const ui = await readUnlockUiState(flow).catch(() => null);
    const [
      welcomeOverlay,
      walletFundingOverlay,
      vaultingDashboard,
      bitcoinLockDetailOverlay,
      unlockingOverlay,
      unlockStartErrorText,
      openDialog,
      openDialogTestId,
      openDialogClass,
      openDialogText,
      lockEntryCount,
    ] = await Promise.all([
      flow.isVisible({ selector: '[data-testid="WelcomeOverlay"]' }).catch(() => ({ visible: false, exists: false })),
      flow.isVisible('WalletFundingReceivedOverlay.closeOverlay()').catch(() => ({ visible: false, exists: false })),
      flow.isVisible('VaultingDashboard').catch(() => ({ visible: false, exists: false })),
      flow.isVisible('BitcoinLockDetailOverlay').catch(() => ({ visible: false, exists: false })),
      flow.isVisible('BitcoinUnlockingOverlay').catch(() => ({ visible: false, exists: false })),
      flow.getText('UnlockStart.error', { timeoutMs: 1_000 }).catch(() => null),
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
      countDashboardLockEntries(flow).catch(() => -1),
    ]);

    console.error(
      `[E2E] ${flowName}: unlock diagnostics`,
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        inspect: state,
        ui,
        vaultingDashboardVisible: vaultingDashboard.visible,
        bitcoinLockDetailOverlayVisible: bitcoinLockDetailOverlay.visible,
        unlockingOverlayVisible: unlockingOverlay.visible,
        welcomeOverlayVisible: welcomeOverlay.visible,
        walletFundingOverlayVisible: walletFundingOverlay.visible,
        openDialogVisible: openDialog.visible,
        unlockStartErrorText,
        openDialogTestId,
        openDialogClass,
        openDialogText,
        lockEntryCount,
      }),
    );
  },
});

async function readUnlockUiState(flow: IE2EFlowRuntime): Promise<IUnlockBitcoinUiState> {
  const [lockEntryVisible, detailOverlay] = await Promise.all([
    hasDashboardLockEntry(flow),
    flow.isVisible('BitcoinLockDetailOverlay'),
  ]);

  return {
    detailOverlayVisible: detailOverlay.visible,
    lockEntryVisible,
  };
}

async function waitForUnlockRequestAccepted(
  flow: IBitcoinFlowContext['flow'],
  flowName: string,
): Promise<IUnlockProgress> {
  const progress: IUnlockProgress = {
    requestAcceptedSeen: false,
    overlayUnlockCompleteSeen: false,
    lockEntryClearedSeen: false,
  };

  for (let i = 0; i < 60; i += 1) {
    const unlockStartError = await flow.isVisible('UnlockStart.error');
    if (unlockStartError.visible) {
      const message = await flow
        .getText('UnlockStart.error', { timeoutMs: 1_000 })
        .catch(() => 'Failed to send release request.');
      throw new Error(`Unlock request failed: ${message}`);
    }

    const unlockState = await flow.inspect<IUnlockBitcoinState>();
    const backendRelease = await readUnlockBackendReleaseState(flow, flowName);
    const lockEntryCount = await countDashboardLockEntries(flow);

    if (
      unlockState.uiState.unlockingOverlayState === 'IsProcessing' ||
      unlockState.uiState.unlockingOverlayState === 'Complete' ||
      backendRelease.isReleaseStatus
    ) {
      progress.requestAcceptedSeen = true;
    }

    if ((backendRelease.isReleaseComplete || !backendRelease.hasActiveLock) && lockEntryCount === 0) {
      progress.lockEntryClearedSeen = true;
      return progress;
    }

    if (unlockState.uiState.unlockingOverlayState === 'Complete') {
      progress.overlayUnlockCompleteSeen = true;
      if (lockEntryCount === 0) {
        progress.lockEntryClearedSeen = true;
      }
      return progress;
    }

    if (progress.requestAcceptedSeen) {
      return progress;
    }

    await sleep(1_000);
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

async function hasDashboardLockEntry(flow: IE2EFlowRuntime): Promise<boolean> {
  return (await flow.isVisible({ selector: '[bitcoinmap] .treemap__tile:not(.treemap__tile--remainder)', index: 0 }))
    .visible;
}

async function countDashboardLockEntries(flow: IE2EFlowRuntime): Promise<number> {
  return await flow.count({ selector: '[bitcoinmap] .treemap__tile:not(.treemap__tile--remainder)' });
}

async function clickDashboardLockEntry(flow: IE2EFlowRuntime, options: { timeoutMs?: number } = {}): Promise<boolean> {
  return await clickIfVisible(
    flow,
    { selector: '[bitcoinmap] .treemap__tile:not(.treemap__tile--remainder)', index: 0 },
    options,
  );
}
