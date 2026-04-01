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
  firstAuctionVisible: boolean;
  startingBotVisible: boolean;
  setupInstallingVisible: boolean;
};

interface IOnboardingState extends IE2EOperationInspectState<Record<string, never>, IOnboardingUiState> {
  dashboardVisible: boolean;
  firstAuctionVisible: boolean;
  startingBotVisible: boolean;
  setupInstallingVisible: boolean;
}

export default new OperationalFlow<IMiningFlowContext, IOnboardingState>(import.meta, {
  description: 'Complete mining onboarding with server connection and bot launch.',
  defaultTimeoutMs: 15_000,
  createContext: createMiningFlowContext,
  async inspect({ flow }) {
    const [dashboard, firstAuction, startingBot, setupInstalling] = await Promise.all([
      flow.isVisible('MiningDashboard'),
      flow.isVisible('FirstAuction'),
      flow.isVisible('MiningStartingBot'),
      flow.isVisible('MiningIsInstalling'),
    ]);
    const dashboardVisible = dashboard.visible;
    const firstAuctionVisible = firstAuction.visible;
    const startingBotVisible = startingBot.visible;
    const setupInstallingVisible = setupInstalling.visible;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (dashboardVisible || firstAuctionVisible || startingBotVisible || setupInstallingVisible) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        dashboardVisible,
        firstAuctionVisible,
        startingBotVisible,
        setupInstallingVisible,
      },
      state: operationState,
      blockers:
        dashboardVisible || firstAuctionVisible || startingBotVisible || setupInstallingVisible
          ? ['ALREADY_COMPLETE']
          : [],
      dashboardVisible,
      firstAuctionVisible,
      startingBotVisible,
      setupInstallingVisible,
    };
  },
  async run({ flow, input }, state) {
    if (
      state.dashboardVisible ||
      state.firstAuctionVisible ||
      state.startingBotVisible ||
      state.setupInstallingVisible
    ) {
      return;
    }

    await flow.run(miningActivateTab);
    await flow.run(miningStartRegistration);
    await flow.run(miningCompleteChecklist);
    input.fundingArgons ??= '500';
    await flow.run(miningFundWallet);
    await flow.run(miningConnectServer);
    await flow.run(miningFinalizeSetup, {
      timeoutMs: 15 * 60_000,
      pollMs: 1_000,
      onNotReadyPoll: async () => {
        const closeOverlay = await flow.isVisible('OverlayBase.closeOverlay()');
        if (closeOverlay.clickable) {
          await flow.click('OverlayBase.closeOverlay()').catch(() => undefined);
        }
      },
    });
  },
});
