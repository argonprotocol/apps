import { createMiningFlowContext, type IMiningFlowContext } from '../contexts/miningContext.ts';
import miningActivateTab from './Mining.op.activateTab.ts';
import miningCompleteChecklist from './Mining.op.completeChecklist.ts';
import miningConnectServer from './Mining.op.connectServer.ts';
import miningFinalizeSetup from './Mining.op.finalizeSetup.ts';
import miningFundWallet from './Mining.op.fundWallet.ts';
import miningStartRegistration from './Mining.op.startRegistration.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IOnboardingUiState = {
  dashboardVisible: boolean;
};

interface IOnboardingState extends IE2EOperationInspectState<Record<string, never>, IOnboardingUiState> {
  dashboardVisible: boolean;
}

export default new OperationalFlow<IMiningFlowContext, IOnboardingState>(import.meta, {
  description: 'Complete mining onboarding with server connection and bot launch.',
  defaultTimeoutMs: 15_000,
  createContext: createMiningFlowContext,
  async inspect({ flow }) {
    const dashboard = await flow.isVisible('MiningDashboard');
    const dashboardVisible = dashboard.visible;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (dashboardVisible) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        dashboardVisible,
      },
      state: operationState,
      blockers: dashboardVisible ? ['ALREADY_COMPLETE'] : [],
      dashboardVisible,
    };
  },
  async run({ flow }, state) {
    if (state.dashboardVisible) {
      return;
    }

    await flow.run(miningActivateTab);
    await flow.run(miningStartRegistration);
    await flow.run(miningCompleteChecklist);
    await flow.run(miningFundWallet);
    await flow.run(miningConnectServer);
    await flow.run(miningFinalizeSetup);
  },
});
