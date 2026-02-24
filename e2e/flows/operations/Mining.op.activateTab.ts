import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  hasBlockingOverlays: boolean;
  bitcoinLockingDialogVisible: boolean;
};

interface IActivateTabState extends IE2EOperationInspectState<Record<string, never>, IActivateTabUiState> {
  activeTabVisible: boolean;
  hasBlockingOverlays: boolean;
  bitcoinLockingDialogVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

const OPEN_LOCKING_DIALOG_SELECTOR = '[role="dialog"][data-state="open"].BitcoinLockingOverlay';

export default new Operation<IMiningFlowContext, IActivateTabState>(import.meta, {
  async inspect({ flow }, api) {
    const [activeTabContent, dismissBlockingOverlaysState] = await Promise.all([
      flow.isVisible('MiningScreen'),
      appDismissBlockingOverlays.inspect({ flow }, api as never),
    ]);
    const activeTabVisible = activeTabContent.visible;
    const hasBlockingOverlays = dismissBlockingOverlaysState.runnable;
    const bitcoinLockingDialogVisible = dismissBlockingOverlaysState.bitcoinLockingDialogVisible;
    const isComplete = activeTabVisible && !hasBlockingOverlays;
    const isRunnable = !isComplete;

    return {
      chainState: {},
      uiState: {
        activeTabVisible,
        hasBlockingOverlays,
        bitcoinLockingDialogVisible,
      },
      isRunnable,
      isComplete,
      activeTabVisible,
      hasBlockingOverlays,
      bitcoinLockingDialogVisible,
      runnable: isRunnable,
      blockers: isRunnable ? [] : ['ALREADY_COMPLETE'],
    };
  },
  async run(context, _state, api) {
    const { flow, flowName } = context;

    await api.run(appDismissBlockingOverlays);
    const remainingDialogs = await countOpenLockingDialogs(flow).catch(() => 0);
    if (remainingDialogs > 0) {
      throw new Error(`${flowName}: blocking bitcoin locking dialog is still open.`);
    }

    const activeTabContent = await flow.isVisible('MiningScreen');
    if (activeTabContent.visible) {
      return;
    }
    await flow.click('TabSwitcher.goto(OperationsTab.Mining)', { timeoutMs: 10_000 });
    await flow.waitFor('MiningScreen', { timeoutMs: 10_000 });
  },
});

async function countOpenLockingDialogs(flow: IE2EFlowRuntime): Promise<number> {
  return flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR });
}
