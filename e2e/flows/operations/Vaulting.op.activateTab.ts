import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  welcomeOverlayVisible: boolean;
};

type IActivateTabState = IE2EOperationInspectState<Record<string, never>, IActivateTabUiState>;

interface IActivateVaultingTabContext {
  flow: IE2EFlowRuntime;
  flowName: string;
}

export default new Operation<IActivateVaultingTabContext, IActivateTabState>(import.meta, {
  async inspect({ flow }) {
    const [activeTabContent, prepareAccessState] = await Promise.all([
      flow.isVisible('VaultingScreen'),
      flow.inspect(appPrepareAccess),
    ]);
    const activeTabVisible = activeTabContent.visible;
    const welcomeOverlayVisible = prepareAccessState.state === 'runnable';
    const isComplete = activeTabVisible && !welcomeOverlayVisible;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }

    return {
      chainState: {},
      uiState: {
        activeTabVisible,
        welcomeOverlayVisible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run(context) {
    const { flow } = context;

    await flow.run(appPrepareAccess);

    const activeTabContent = await flow.isVisible('VaultingScreen');
    if (activeTabContent.visible) {
      return;
    }

    await flow.click('LeftBar.goto(TopTab.Vaulting)', { timeoutMs: 10_000 });
    await flow.waitFor('VaultingScreen', {
      timeoutMs: 10_000,
    });
  },
});
