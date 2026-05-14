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
  totalBlocksMined: number | null;
};

interface IOnboardingState extends IE2EOperationInspectState<Record<string, never>, IOnboardingUiState> {
  dashboardVisible: boolean;
  firstAuctionVisible: boolean;
  startingBotVisible: boolean;
  setupInstallingVisible: boolean;
  totalBlocksMined: number | null;
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
    const totalBlocksMined = dashboardVisible ? await readTotalBlocksMined(flow) : null;
    const isComplete = dashboardVisible && totalBlocksMined != null && totalBlocksMined > 0;

    return {
      chainState: {},
      uiState: {
        dashboardVisible,
        firstAuctionVisible,
        startingBotVisible,
        setupInstallingVisible,
        totalBlocksMined,
      },
      state: isComplete ? 'complete' : 'runnable',
      blockers: isComplete ? ['ALREADY_COMPLETE'] : [],
      dashboardVisible,
      firstAuctionVisible,
      startingBotVisible,
      setupInstallingVisible,
      totalBlocksMined,
    };
  },
  async run({ flow, input }, state) {
    if (state.dashboardVisible && state.totalBlocksMined != null && state.totalBlocksMined > 0) {
      return;
    }

    if (
      state.dashboardVisible ||
      state.firstAuctionVisible ||
      state.startingBotVisible ||
      state.setupInstallingVisible
    ) {
      await flow.run(miningFinalizeSetup, {
        timeoutMs: 15 * 60_000,
        pollMs: 1_000,
        onNotReadyPoll: async () => {
          const closeOverlay = await flow.isVisible('OverlayBase.clickClose()');
          if (closeOverlay.clickable) {
            await flow.click('OverlayBase.clickClose()').catch(() => undefined);
          }
        },
      });
      return;
    }

    await flow.run(miningActivateTab);
    await flow.run(miningStartRegistration);
    input.maximumBidArgons ??= '5';
    await flow.run(miningCompleteChecklist);
    input.fundingArgons ??= '500';
    await flow.run(miningFundWallet);
    await flow.run(miningConnectServer);
    await flow.run(miningFinalizeSetup, {
      timeoutMs: 15 * 60_000,
      pollMs: 1_000,
      onNotReadyPoll: async () => {
        const closeOverlay = await flow.isVisible('OverlayBase.clickClose()');
        if (closeOverlay.clickable) {
          await flow.click('OverlayBase.clickClose()').catch(() => undefined);
        }
      },
    });
  },
});

async function readTotalBlocksMined(flow: IMiningFlowContext['flow']): Promise<number | null> {
  const value = await flow.getAttribute('TotalBlocksMined', 'data-value', { timeoutMs: 2_000 }).catch(() => null);
  if (!value) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
