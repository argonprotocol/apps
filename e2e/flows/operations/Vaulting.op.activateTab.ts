import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';

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

interface IActivateVaultingTabContext {
  flow: IE2EFlowRuntime;
  flowName: string;
}

const OPEN_LOCKING_DIALOG_SELECTOR = '[role="dialog"][data-state="open"].BitcoinLockingOverlay';

export default new Operation<IActivateVaultingTabContext, IActivateTabState>(import.meta, {
  async inspect({ flow }, api) {
    const [activeTabContent, dismissBlockingOverlaysState] = await Promise.all([
      flow.isVisible('VaultingScreen'),
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

    const activeTabContent = await flow.isVisible('VaultingScreen');
    if (activeTabContent.visible) {
      return;
    }

    await flow.click('TabSwitcher.goto(OperationsTab.Vaulting)', { timeoutMs: 10_000 });
    await flow.waitFor('VaultingScreen', {
      timeoutMs: 10_000,
    });
  },
});

async function countOpenLockingDialogs(flow: IE2EFlowRuntime): Promise<number> {
  return flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR });
}
