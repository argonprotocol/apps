import { clickIfVisible, dismissOpenLockingOverlay } from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';

interface IAppFlowContext {
  flow: IE2EFlowRuntime;
}

type IDismissBlockingOverlaysUiState = {
  welcomeOverlayVisible: boolean;
  walletFundingOverlayVisible: boolean;
  walletFundingDialogVisible: boolean;
  bitcoinLockingDialogVisible: boolean;
};

type IDismissBlockingOverlaysState = IE2EOperationInspectState<Record<string, never>, IDismissBlockingOverlaysUiState>;

export default new Operation<IAppFlowContext, IDismissBlockingOverlaysState>(import.meta, {
  async inspect({ flow }) {
    const [welcomeOverlay, walletFundingOverlay, openDialog, openBitcoinLockingDialogs] = await Promise.all([
      flow.isVisible({ selector: '[data-testid="WelcomeOverlay"]' }),
      flow.isVisible('WalletFundingReceivedOverlay.closeOverlay()'),
      flow.isVisible({ selector: '[role="dialog"][data-state="open"]' }),
      flow.count({ selector: '[role="dialog"][data-state="open"].BitcoinLockingOverlay' }).catch(() => 0),
    ]);

    let walletFundingDialogVisible = false;
    if (openDialog.visible) {
      const dialogText = await flow
        .getText({ selector: '[role="dialog"][data-state="open"]' }, { timeoutMs: 1_000 })
        .catch(() => '');
      walletFundingDialogVisible = dialogText.includes('Wallet Funds Have Been Received');
    }
    const bitcoinLockingDialogVisible = openBitcoinLockingDialogs > 0;

    const runnable = walletFundingOverlay.visible || walletFundingDialogVisible || bitcoinLockingDialogVisible;
    const isComplete = !runnable;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        welcomeOverlayVisible: welcomeOverlay.visible,
        walletFundingOverlayVisible: walletFundingOverlay.visible,
        walletFundingDialogVisible,
        bitcoinLockingDialogVisible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run({ flow }, state) {
    if (state.uiState.walletFundingOverlayVisible) {
      await flow.click('WalletFundingReceivedOverlay.closeOverlay()', { waitForDisappearMs: 5_000 });
    }
    if (!state.uiState.walletFundingDialogVisible && !state.uiState.bitcoinLockingDialogVisible) {
      return;
    }

    if (state.uiState.walletFundingDialogVisible) {
      if (!(await clickIfVisible(flow, { selector: '[role="dialog"][data-state="open"] button' }))) {
        await flow.click('WalletFundingReceivedOverlay.closeOverlay()');
      }
      await flow.waitFor({ selector: '[role="dialog"][data-state="open"]' }, { state: 'missing', timeoutMs: 5_000 });
    }
    if (state.uiState.bitcoinLockingDialogVisible) {
      let dismissed = await dismissOpenLockingOverlay(flow, 'LockMinting.closeOverlay()');
      if (!dismissed) {
        dismissed = await dismissOpenLockingOverlay(flow, 'LockStart.closeOverlay()');
      }
      if (!dismissed) {
        throw new Error('Bitcoin locking dialog is still open.');
      }
    }
  },
});
