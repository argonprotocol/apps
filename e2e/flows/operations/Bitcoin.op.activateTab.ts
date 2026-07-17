import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { Operation } from './index.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { dismissOpenLockingOverlay } from '../helpers/utils.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  welcomeOverlayVisible: boolean;
  bitcoinLockingDialogVisible: boolean;
};

type IActivateTabState = IE2EOperationInspectState<Record<string, never>, IActivateTabUiState>;

const OPEN_LOCKING_DIALOG_SELECTOR = '[role="dialog"][data-state="open"].BitcoinLockingOverlay';
export const BITCOIN_LOCK_ENTRY_SELECTOR = '[data-testid^="BitcoinLocks.lockEntry."]';

export default new Operation<IBitcoinFlowContext, IActivateTabState>(import.meta, {
  async inspect({ flow }) {
    const [activeTab, prepareAccessState, openBitcoinLockingDialogs] = await Promise.all([
      flow.isVisible('BitcoinLocksScreen'),
      flow.inspect(appPrepareAccess),
      flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR }).catch(() => 0),
    ]);
    const activeTabVisible = activeTab.visible;
    const welcomeOverlayVisible = prepareAccessState.state === 'runnable';
    const bitcoinLockingDialogVisible = openBitcoinLockingDialogs > 0;
    const hasBlockingOverlays = welcomeOverlayVisible || bitcoinLockingDialogVisible;
    const isComplete = activeTabVisible && !hasBlockingOverlays;

    return {
      chainState: {},
      uiState: {
        activeTabVisible,
        welcomeOverlayVisible,
        bitcoinLockingDialogVisible,
      },
      state: isComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow, flowName }) {
    await flow.run(appPrepareAccess);

    if ((await flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR }).catch(() => 0)) > 0) {
      let dismissed = await dismissOpenLockingOverlay(flow, 'LockMinting.closeOverlay()');
      if (!dismissed) {
        dismissed = await dismissOpenLockingOverlay(flow, 'LockStart.closeOverlay()');
      }
      if (!dismissed) {
        throw new Error(`${flowName}: blocking bitcoin locking dialog is still open.`);
      }
    }

    if ((await flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR }).catch(() => 0)) > 0) {
      throw new Error(`${flowName}: blocking bitcoin locking dialog is still open.`);
    }

    const activeTab = await flow.isVisible('BitcoinLocksScreen');
    if (activeTab.visible) {
      return;
    }

    await flow.click('LeftBar.goto(TopTab.BitcoinLocks)', { timeoutMs: 10_000 });
    await flow.waitFor('BitcoinLocksScreen', { timeoutMs: 10_000 });
  },
});
