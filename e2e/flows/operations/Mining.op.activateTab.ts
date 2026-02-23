import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  openBitcoinLockingDialogs: number;
};

interface IActivateTabState extends IE2EOperationInspectState<Record<string, never>, IActivateTabUiState> {
  activeTabVisible: boolean;
  openBitcoinLockingDialogs: number;
  runnable: boolean;
  blockers: string[];
}

const OPEN_LOCKING_DIALOG_SELECTOR = '[role="dialog"][data-state="open"].BitcoinLockingOverlay';

export default new Operation<IMiningFlowContext, IActivateTabState>(import.meta, {
  async inspect({ flow }) {
    const [activeTabContent, openBitcoinLockingDialogs] = await Promise.all([
      flow.isVisible('MiningScreen'),
      countOpenLockingDialogs(flow).catch(() => 0),
    ]);
    const activeTabVisible = activeTabContent.visible;
    const runnable = !activeTabVisible && openBitcoinLockingDialogs === 0;
    const isComplete = activeTabVisible;
    const isRunnable = !isComplete && runnable;

    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && openBitcoinLockingDialogs > 0) {
      blockers.push('Bitcoin locking dialog is still open and can block tab switching.');
    }

    return {
      chainState: {},
      uiState: {
        activeTabVisible,
        openBitcoinLockingDialogs,
      },
      isRunnable,
      isComplete,
      activeTabVisible,
      openBitcoinLockingDialogs,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run(context, state, api) {
    const { flow, flowName } = context;
    if (state.activeTabVisible) {
      return;
    }

    await api.run(appDismissBlockingOverlays);
    const remainingDialogs = await countOpenLockingDialogs(flow).catch(() => 0);
    if (remainingDialogs > 0) {
      throw new Error(`${flowName}: blocking bitcoin locking dialog is still open.`);
    }

    const activeTabContent = await flow.isVisible('MiningScreen');
    if (activeTabContent.visible) {
      return;
    }
    await flow.click('TabSwitcher.goto(ScreenKey.Mining)', { timeoutMs: 5_000 });
    await flow.waitFor('MiningScreen', { timeoutMs: 10_000 });
  },
});

async function countOpenLockingDialogs(flow: IE2EFlowRuntime): Promise<number> {
  return flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR });
}
