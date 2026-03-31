import type { IBitcoinVaultMismatchState } from '../types/srcVue.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import { clickIfVisible, sleep } from '../helpers/utils.ts';

type IOpenLockFundingOverlayUiState = {
  lockingEntryVisible: boolean;
  lockOverlayVisible: boolean;
  lockOverlayState: string | null;
  fundingBip21Visible: boolean;
};

type IOpenLockFundingOverlayState = IE2EOperationInspectState<
  IBitcoinVaultMismatchState,
  IOpenLockFundingOverlayUiState
>;

export default new Operation<IBitcoinFlowContext, IOpenLockFundingOverlayState>(import.meta, {
  async inspect({ flow }) {
    const panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    const [lockOverlay, fundingBip21] = await Promise.all([
      flow.isVisible('BitcoinLockingOverlay'),
      flow.isVisible('fundingBip21.copyContent()'),
    ]);
    const lockingEntryVisible = panelState.lockingEntryVisible;
    const lockOverlayVisible = lockOverlay.visible;
    const lockOverlayState = lockOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const fundingBip21Visible = fundingBip21.visible;
    const readyForBitcoinVisible = lockOverlayState === 'ReadyForBitcoin' && fundingBip21Visible;
    const wrongLockingPhaseVisible = lockOverlayVisible && !!lockOverlayState && lockOverlayState !== 'ReadyForBitcoin';
    const isComplete = readyForBitcoinVisible;
    const canRun = !isComplete && panelState.chainState.isPendingFunding && (lockingEntryVisible || lockOverlayVisible);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (wrongLockingPhaseVisible) {
      operationState = 'uiStateMismatch';
    } else if (panelState.chainState.isPendingFunding && !lockingEntryVisible && !lockOverlayVisible) {
      operationState = 'uiStateMismatch';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !panelState.chainState.isPendingFunding) {
      blockers.push('Lock is not in pending funding.');
    }
    if (!isComplete && wrongLockingPhaseVisible) {
      blockers.push(`Pending funding overlay is open in the wrong state: ${lockOverlayState}.`);
    }
    if (panelState.chainState.isPendingFunding && !isComplete && !lockingEntryVisible && !lockOverlayVisible) {
      blockers.push('Backend is in pending funding, but no pending funding entry or overlay is visible.');
    }
    if (!isComplete && !lockingEntryVisible && !lockOverlayVisible) {
      blockers.push('Pending funding overlay entry point is not visible.');
    }
    return {
      chainState: panelState.chainState,
      uiState: {
        lockingEntryVisible,
        lockOverlayVisible,
        lockOverlayState,
        fundingBip21Visible,
      },
      state: operationState,
      phase:
        lockOverlay.visible && lockOverlayState
          ? `locking:${lockOverlayState}`
          : lockingEntryVisible
            ? 'dashboard'
            : undefined,
      blockers: canRun ? [] : blockers,
    };
  },

  async run({ flow }, state) {
    if (state.state === 'complete') return;

    if (!state.uiState.lockOverlayVisible && !state.uiState.lockingEntryVisible) {
      await flow.run(vaultingActivateTab);
    }
    if (!state.uiState.lockOverlayVisible) {
      const opened = await clickDashboardLockEntry(flow, { timeoutMs: 15_000 });
      if (!opened) {
        throw new Error('Lock funding overlay entry point is not clickable.');
      }
    }

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const latest = await flow.inspect<IOpenLockFundingOverlayState>();
      if (latest.state === 'complete') {
        return;
      }
      if (latest.state === 'uiStateMismatch') {
        const blockerMessage = latest.blockers.join(', ') || 'backend/ui state mismatch';
        throw new Error(`Lock funding overlay did not match backend state: ${blockerMessage}`);
      }
      await sleep(250);
    }

    throw new Error('Lock funding overlay did not advance to the funding details state.');
  },
});

async function clickDashboardLockEntry(
  flow: IBitcoinFlowContext['flow'],
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  return await clickIfVisible(
    flow,
    { selector: '[bitcoinmap] .treemap__tile:not(.treemap__tile--remainder)', index: 0 },
    options,
  );
}
