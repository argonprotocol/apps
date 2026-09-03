import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';

type IActivateTabUiState = {
  activeTabVisible: boolean;
  welcomeOverlayVisible: boolean;
};

type IActivateTabState = IE2EOperationInspectState<Record<string, never>, IActivateTabUiState>;

export default new Operation<IMiningFlowContext, IActivateTabState>(import.meta, {
  async inspect({ flow }) {
    const [activeTabContent, prepareAccessState] = await Promise.all([
      flow.isVisible('MiningScreen'),
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

    const activeTabContent = await flow.isVisible('MiningScreen');
    if (activeTabContent.visible) {
      return;
    }
    await flow.click('LeftBar.goto(TopTab.Mining)', { timeoutMs: 10_000 });
    await flow.waitFor('MiningScreen', { timeoutMs: 10_000 });
  },
});
