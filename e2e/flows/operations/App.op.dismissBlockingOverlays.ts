import { clickIfVisible } from '../helpers/utils.ts';
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

interface IDismissBlockingOverlaysState
  extends IE2EOperationInspectState<Record<string, never>, IDismissBlockingOverlaysUiState> {
  welcomeOverlayVisible: boolean;
  walletFundingOverlayVisible: boolean;
  walletFundingDialogVisible: boolean;
  bitcoinLockingDialogVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"]';
const OPEN_DIALOG_PRIMARY_BUTTON_SELECTOR = `${OPEN_DIALOG_SELECTOR} button`;
const OPEN_LOCKING_DIALOG_SELECTOR = '[role="dialog"][data-state="open"].BitcoinLockingOverlay';
const LOCKING_DIALOG_CLOSE_ICON_SELECTOR = `${OPEN_LOCKING_DIALOG_SELECTOR} button[class*="border-slate-400"]`;

export default new Operation<IAppFlowContext, IDismissBlockingOverlaysState>(import.meta, {
  async inspect({ flow }) {
    const [welcomeOverlay, walletFundingOverlay, openDialog, openBitcoinLockingDialogs] = await Promise.all([
      flow.isVisible('WelcomeOverlay.closeOverlay()'),
      flow.isVisible('WalletFundingReceivedOverlay.closeOverlay()'),
      flow.isVisible({ selector: OPEN_DIALOG_SELECTOR }),
      countOpenLockingDialogs(flow).catch(() => 0),
    ]);

    let walletFundingDialogVisible = false;
    if (openDialog.visible) {
      const dialogText = await flow.getText({ selector: OPEN_DIALOG_SELECTOR }, { timeoutMs: 1_000 }).catch(() => '');
      walletFundingDialogVisible = dialogText.includes('Wallet Funds Have Been Received');
    }
    const bitcoinLockingDialogVisible = openBitcoinLockingDialogs > 0;

    const runnable =
      welcomeOverlay.visible ||
      walletFundingOverlay.visible ||
      walletFundingDialogVisible ||
      bitcoinLockingDialogVisible;
    const isComplete = !runnable;
    return {
      chainState: {},
      uiState: {
        welcomeOverlayVisible: welcomeOverlay.visible,
        walletFundingOverlayVisible: walletFundingOverlay.visible,
        walletFundingDialogVisible,
        bitcoinLockingDialogVisible,
      },
      isRunnable: runnable,
      isComplete,
      welcomeOverlayVisible: welcomeOverlay.visible,
      walletFundingOverlayVisible: walletFundingOverlay.visible,
      walletFundingDialogVisible,
      bitcoinLockingDialogVisible,
      runnable,
      blockers: runnable ? [] : ['ALREADY_COMPLETE'],
    };
  },
  async run({ flow }, state) {
    if (state.welcomeOverlayVisible) {
      await clickIfVisible(flow, 'WelcomeOverlay.closeOverlay()');
    }
    if (state.walletFundingOverlayVisible) {
      await clickIfVisible(flow, 'WalletFundingReceivedOverlay.closeOverlay()');
    }
    if (!state.walletFundingDialogVisible && !state.bitcoinLockingDialogVisible) {
      return;
    }

    if (state.walletFundingDialogVisible) {
      const primaryButton = { selector: OPEN_DIALOG_PRIMARY_BUTTON_SELECTOR };
      if (!(await clickIfVisible(flow, primaryButton))) {
        await clickIfVisible(flow, 'WalletFundingReceivedOverlay.closeOverlay()');
      }
    }
    if (state.bitcoinLockingDialogVisible) {
      await dismissOpenLockingDialog(flow);
    }
  },
});

async function countOpenLockingDialogs(flow: IE2EFlowRuntime): Promise<number> {
  return flow.count({ selector: OPEN_LOCKING_DIALOG_SELECTOR });
}

async function dismissOpenLockingDialog(flow: IE2EFlowRuntime): Promise<boolean> {
  const openDialogs = await countOpenLockingDialogs(flow);
  if (openDialogs === 0) return false;

  if (await clickIfVisible(flow, 'LockStart.closeOverlay()')) {
    await flow.waitFor('BitcoinLockingOverlay', { state: 'missing', timeoutMs: 10_000 }).catch(() => null);
    return true;
  }

  for (let index = 0; index < openDialogs; index += 1) {
    if (await clickIfVisible(flow, { selector: LOCKING_DIALOG_CLOSE_ICON_SELECTOR, index })) {
      await flow.waitFor('BitcoinLockingOverlay', { state: 'missing', timeoutMs: 10_000 }).catch(() => null);
      if ((await countOpenLockingDialogs(flow)) < openDialogs) {
        return true;
      }
    }
  }

  return (await countOpenLockingDialogs(flow)) === 0;
}
