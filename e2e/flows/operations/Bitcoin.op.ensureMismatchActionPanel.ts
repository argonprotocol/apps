import type { IBitcoinLocksMismatchInspect, IBitcoinVaultMismatchState, IMyVaultInspect } from '../types/srcVue.ts';
import { clickIfVisible, runInspect } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

const MISMATCH_INSPECT_TIMEOUT_MS = 20_000;
type IMismatchChainState = IBitcoinVaultMismatchState;

type IMismatchUiState = {
  actionErrorText: string | null;
  personalVisible: boolean;
  mismatchPanelVisible: boolean;
  lockingEntryVisible: boolean;
  acceptVisible: boolean;
  acceptEnabled: boolean;
  returnDestinationVisible: boolean;
  returnVisible: boolean;
  returnEnabled: boolean;
  resumeVisible: boolean;
  resumeEnabled: boolean;
};

export interface IEnsureMismatchActionPanelState
  extends IE2EOperationInspectState<IMismatchChainState, IMismatchUiState> {
  actionErrorText: string | null;
  personalVisible: boolean;
  mismatchPanelVisible: boolean;
  lockingEntryVisible: boolean;
  acceptVisible: boolean;
  acceptEnabled: boolean;
  returnDestinationVisible: boolean;
  returnVisible: boolean;
  returnEnabled: boolean;
  resumeVisible: boolean;
  resumeEnabled: boolean;
  acceptReady: boolean;
  returnPanelVisible: boolean;
  returnReady: boolean;
  resumeReady: boolean;
}

export default new Operation<IBitcoinFlowContext, IEnsureMismatchActionPanelState>(import.meta, {
  async inspect({ flow, flowName }) {
    const [
      chainStateValue,
      actionError,
      personal,
      mismatchPanel,
      lockingEntry,
      mismatchAccept,
      mismatchReturnDestination,
      mismatchReturn,
      mismatchResume,
    ] = await Promise.all([
      runInspect<IMismatchChainState>(flow, MISMATCH_BACKEND_STATE_FN, MISMATCH_INSPECT_TIMEOUT_MS, {
        flowName,
      }),
      flow.isVisible('LockFundingMismatch.actionError'),
      flow.isVisible('PersonalBitcoin'),
      flow.isVisible('LockFundingMismatch'),
      flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
      flow.isVisible('LockFundingMismatch.acceptMismatch()'),
      flow.isVisible('LockFundingMismatch.returnDestination'),
      flow.isVisible('LockFundingMismatch.returnMismatch()'),
      flow.isVisible('LockFundingMismatch.resumeFunding()'),
    ]);
    const actionErrorText = actionError.visible
      ? (await flow.getText('LockFundingMismatch.actionError', { timeoutMs: 1_000 }).catch(() => null))?.trim() || null
      : null;
    const chainState = {
      hasActiveLock: false,
      isPendingFunding: false,
      isFundingReadyToResume: false,
      isPostFundingLock: false,
      mismatchRequired: false,
      canActOnMismatch: false,
      hasMismatchAcceptInProgress: false,
      hasOrphanedReturnInProgress: false,
      candidateCount: 0,
      ...chainStateValue,
    };
    const ui = {
      actionErrorText,
      personalVisible: personal.visible,
      mismatchPanelVisible: mismatchPanel.visible,
      lockingEntryVisible: lockingEntry.visible,
      acceptVisible: mismatchAccept.visible,
      acceptEnabled: mismatchAccept.enabled,
      returnDestinationVisible: mismatchReturnDestination.visible,
      returnVisible: mismatchReturn.visible,
      returnEnabled: mismatchReturn.enabled,
      resumeVisible: mismatchResume.visible,
      resumeEnabled: mismatchResume.enabled,
    };
    const acceptReady = ui.acceptVisible && ui.acceptEnabled;
    const mismatchActionVisible =
      ui.acceptVisible || ui.returnDestinationVisible || ui.returnVisible || ui.resumeVisible;
    const returnPanelVisible = ui.returnDestinationVisible || ui.returnVisible || ui.resumeVisible;
    const mismatchPanelReady = ui.mismatchPanelVisible || returnPanelVisible;
    const returnReady = ui.returnDestinationVisible && ui.returnVisible && ui.returnEnabled;
    const resumeReady = ui.resumeVisible && ui.resumeEnabled;
    const noMismatchActionNeeded =
      chainState.hasActiveLock &&
      !chainState.mismatchRequired &&
      !chainState.hasMismatchAcceptInProgress &&
      !chainState.hasOrphanedReturnInProgress &&
      !mismatchActionVisible;
    const isComplete = mismatchPanelReady || noMismatchActionNeeded;
    const hasActionError = !!ui.actionErrorText;
    const backendNeedsMismatchUi =
      chainState.hasActiveLock &&
      (chainState.mismatchRequired || chainState.hasMismatchAcceptInProgress || chainState.hasOrphanedReturnInProgress);
    const canRun =
      !hasActionError &&
      !isComplete &&
      (ui.lockingEntryVisible || ui.mismatchPanelVisible || ui.personalVisible || returnPanelVisible);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (hasActionError) {
      operationState = 'uiStateMismatch';
    } else if (backendNeedsMismatchUi && !ui.lockingEntryVisible && !ui.mismatchPanelVisible && !returnPanelVisible) {
      operationState = 'uiStateMismatch';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (ui.actionErrorText) blockers.push(`Mismatch action error: ${ui.actionErrorText}`);
    if (!chainState.hasActiveLock) blockers.push('No active lock found for current vault.');
    if (
      chainState.hasActiveLock &&
      (chainState.mismatchRequired ||
        chainState.hasMismatchAcceptInProgress ||
        chainState.hasOrphanedReturnInProgress) &&
      !ui.lockingEntryVisible &&
      !ui.mismatchPanelVisible &&
      !returnPanelVisible
    ) {
      blockers.push('Backend requires mismatch UI, but no mismatch entry point or panel is visible.');
    }
    if (!isComplete && !canRun) blockers.push('Mismatch overlay entry point is not visible.');
    return {
      chainState,
      uiState: ui,
      state: operationState,
      phase: mismatchPanelReady ? 'locking:FundingMismatch' : ui.lockingEntryVisible ? 'dashboard' : undefined,
      ...ui,
      acceptReady,
      returnPanelVisible,
      returnReady,
      resumeReady,
      blockers: [...new Set(blockers.filter(Boolean))],
    };
  },

  async run({ flow }, state) {
    if (state.state === 'complete') return;

    const onVaultingScreen = await flow.isVisible('VaultingScreen');
    const hasVisibleMismatchUi =
      state.mismatchPanelVisible || state.lockingEntryVisible || state.personalVisible || state.returnPanelVisible;
    if (!onVaultingScreen.visible && !hasVisibleMismatchUi) {
      await flow.run(vaultingActivateTab).catch(() => undefined);
    }
    if (!state.mismatchPanelVisible && !state.returnPanelVisible) {
      await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
    }
  },
});

async function mismatchBackendStateInspect(refs: IInspectRefs): Promise<IMismatchChainState> {
  await refs.myVault.load().catch(() => undefined);
  await refs.bitcoinLocks.load().catch(() => undefined);

  const vaultId = refs.myVault.vaultId;
  if (vaultId == null) {
    return {
      hasActiveLock: false,
      isPendingFunding: false,
      isFundingReadyToResume: false,
      isPostFundingLock: false,
      mismatchRequired: false,
      canActOnMismatch: false,
      hasMismatchAcceptInProgress: false,
      hasOrphanedReturnInProgress: false,
      candidateCount: 0,
    };
  }
  return refs.bitcoinLocks.getVaultMismatchState(vaultId);
}

const MISMATCH_BACKEND_STATE_FN = mismatchBackendStateInspect.toString();

interface IInspectRefs {
  myVault: IMyVaultInspect;
  bitcoinLocks: IBitcoinLocksMismatchInspect;
}
