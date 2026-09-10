import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { Operation } from './index.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  walletOverlayMounted: boolean;
  welcomeOverlayVisible: boolean;
};

type IActivateTabState = IE2EOperationInspectState<Record<string, never>, IActivateTabUiState>;

export default new Operation<IBitcoinFlowContext, IActivateTabState>(import.meta, {
  async inspect({ flow }) {
    const [activeTab, walletOverlay, prepareAccessState] = await Promise.all([
      flow.isVisible('BitcoinScreen'),
      flow.isVisible('WalletOverlay'),
      flow.inspect(appPrepareAccess),
    ]);
    const activeTabVisible = activeTab.visible;
    const walletOverlayMounted = walletOverlay.exists;
    const welcomeOverlayVisible = prepareAccessState.state === 'runnable';
    const isComplete = activeTabVisible && !walletOverlayMounted && !welcomeOverlayVisible;

    return {
      chainState: {},
      uiState: {
        activeTabVisible,
        walletOverlayMounted,
        welcomeOverlayVisible,
      },
      state: isComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow }) {
    await flow.run(appPrepareAccess);

    const connectorClose = {
      selector: '[data-testid="ConnectorChannel"] [data-testid="WalletOverlay.closeRight()"]',
    };
    if ((await flow.isVisible(connectorClose)).clickable) {
      await flow.click(connectorClose, { timeoutMs: 10_000 });
    }

    const walletClose = await flow.isVisible('WalletOverlay.closeRight()');
    if (walletClose.clickable) {
      await flow.click('WalletOverlay.closeRight()', { timeoutMs: 10_000 });
      await flow.waitFor('WalletOverlay', { state: 'missing', timeoutMs: 10_000 });
    }

    const activeTab = await flow.isVisible('BitcoinScreen');
    if (activeTab.visible) {
      return;
    }

    await flow.click('LeftBar.goto(TopTab.BitcoinLocks)', { timeoutMs: 10_000 });
    await flow.waitFor('BitcoinScreen', { timeoutMs: 10_000 });
  },
});
