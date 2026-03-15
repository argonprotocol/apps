import { clickIfVisible, pollEvery } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel, {
  type IEnsureMismatchActionPanelState,
} from './Bitcoin.op.ensureMismatchActionPanel.ts';
import { Operation } from './index.ts';

type IAcceptMismatchChainState = IEnsureMismatchActionPanelState['chainState'];

type IAcceptMismatchUiState = {
  acceptVisible: boolean;
  acceptEnabled: boolean;
};

type IAcceptMismatchState = IE2EOperationInspectState<IAcceptMismatchChainState, IAcceptMismatchUiState>;

export default new Operation<IBitcoinFlowContext, IAcceptMismatchState>(import.meta, {
  async inspect({ flow }) {
    const panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    const isComplete = panelState.chainState.isPostFundingLock;
    const canRun = !isComplete && !panelState.actionErrorText && panelState.acceptReady;
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (panelState.state === 'uiStateMismatch') {
      operationState = 'uiStateMismatch';
    } else if (panelState.actionErrorText) {
      operationState = 'uiStateMismatch';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && panelState.actionErrorText)
      blockers.push(`Mismatch action error: ${panelState.actionErrorText}`);
    if (!isComplete && !panelState.chainState.hasActiveLock) {
      blockers.push('No active lock found for current vault.');
    }
    if (
      !isComplete &&
      panelState.chainState.mismatchRequired &&
      !panelState.chainState.canActOnMismatch &&
      panelState.chainState.candidateCount > 0
    ) {
      blockers.push('Mismatch accept is currently processing or waiting for chain readiness.');
    }
    if (!isComplete && panelState.chainState.mismatchRequired && panelState.chainState.candidateCount === 0) {
      blockers.push('No mismatch funding candidate is available yet.');
    }
    if (!isComplete && panelState.state === 'uiStateMismatch') {
      blockers.push(...panelState.blockers);
    }
    if (!isComplete && !panelState.chainState.mismatchRequired) {
      blockers.push('Waiting for mismatch funding to be recognized.');
    }
    if (!isComplete && !panelState.acceptVisible) blockers.push('Mismatch accept action is not visible.');
    if (!isComplete && panelState.acceptVisible && !panelState.acceptEnabled) {
      blockers.push('Mismatch accept action is not enabled.');
    }
    return {
      chainState: panelState.chainState,
      uiState: {
        acceptVisible: panelState.acceptVisible,
        acceptEnabled: panelState.acceptEnabled,
      },
      state: operationState,
      blockers: canRun ? [] : blockers,
    };
  },

  async run(context, state) {
    const { flow, flowName } = context;
    if (state.state === 'complete') return;

    const panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    if (!panelState.acceptReady) {
      throw new Error(`${flowName}: mismatch accept action remained disabled after readiness polling.`);
    }
    if (!panelState.mismatchPanelVisible) {
      await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
    }
    await flow.click('LockFundingMismatch.acceptMismatch()', { timeoutMs: 60_000 });
    await pollEvery(
      1_000,
      async () => {
        const latest = await flow.inspect(bitcoinEnsureMismatchActionPanel);
        if (latest.actionErrorText) {
          throw new Error(`${flowName}: ${latest.actionErrorText}`);
        }
        return latest.chainState.isPostFundingLock;
      },
      {
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: mismatch accept did not resolve to the funded state in time.`,
      },
    );
  },
});
