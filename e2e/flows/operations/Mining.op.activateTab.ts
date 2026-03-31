import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { clickIfVisible, dismissOpenLockingOverlay } from '../helpers/utils.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  welcomeOverlayVisible: boolean;
  walletFundingOverlayVisible: boolean;
  bitcoinLockingDialogVisible: boolean;
};

type IActivateTabState = IE2EOperationInspectState<Record<string, never>, IActivateTabUiState>;

const OPEN_LOCKING_DIALOG_SELECTOR = '[role="dialog"][data-state="open"].BitcoinLockingOverlay';

export default new Operation<IMiningFlowContext, IActivateTabState>(import.meta, {
  async inspect({ flow }) {
    const [activeTabContent, prepareAccessState, walletFundingOverlay, openBitcoinLockingDialogs] = await Promise.all([
      flow.isVisible('MiningScreen'),
      flow.inspect(appPrepareAccess),
      flow.isVisible('WalletFundingReceivedOverlay.closeOverlay()'),
      flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR }).catch(() => 0),
    ]);
    const activeTabVisible = activeTabContent.visible;
    const welcomeOverlayVisible = prepareAccessState.state === 'runnable';
    const walletFundingOverlayVisible = walletFundingOverlay.visible;
    const bitcoinLockingDialogVisible = openBitcoinLockingDialogs > 0;
    const hasBlockingOverlays = welcomeOverlayVisible || walletFundingOverlayVisible || bitcoinLockingDialogVisible;
    const isComplete = activeTabVisible && !hasBlockingOverlays;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }

    return {
      chainState: {},
      uiState: {
        activeTabVisible,
        welcomeOverlayVisible,
        walletFundingOverlayVisible,
        bitcoinLockingDialogVisible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run(context) {
    const { flow, flowName } = context;

    await flow.run(appPrepareAccess);
    await clickIfVisible(flow, 'WalletFundingReceivedOverlay.closeOverlay()', { timeoutMs: 5_000 });

    if ((await countOpenLockingDialogs(flow).catch(() => 0)) > 0) {
      let dismissed = await dismissOpenLockingOverlay(flow, 'LockMinting.closeOverlay()');
      if (!dismissed) {
        dismissed = await dismissOpenLockingOverlay(flow, 'LockStart.closeOverlay()');
      }
      if (!dismissed) {
        throw new Error(`${flowName}: blocking bitcoin locking dialog is still open.`);
      }
    }

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
