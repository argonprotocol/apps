import { clickIfVisible } from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';

type ICompleteChecklistUiState = {
  checklistVisible: boolean;
  botConfigured: boolean;
};

type IMiningChecklistQueryRefs = {
  config: {
    hasSavedBiddingRules: boolean;
  };
};

interface ICompleteChecklistState extends IE2EOperationInspectState<Record<string, never>, ICompleteChecklistUiState> {
  checklistVisible: boolean;
  botConfigured: boolean;
}

export default new Operation<IMiningFlowContext, ICompleteChecklistState>(import.meta, {
  async inspect({ flow }) {
    const [checklistEntry, botConfigState] = await Promise.all([
      flow.isVisible('SetupChecklist.openHowMiningWorksOverlay()'),
      readBotConfigState(flow),
    ]);
    const botConfigured = botConfigState?.hasSavedBiddingRules ?? false;
    const isComplete = botConfigured;
    const canRun = checklistEntry.visible && !botConfigured;
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !checklistEntry.visible) blockers.push('Mining checklist is not visible.');
    return {
      chainState: {},
      uiState: {
        checklistVisible: checklistEntry.visible,
        botConfigured,
      },
      state: operationState,
      checklistVisible: checklistEntry.visible,
      botConfigured,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, input }, state) {
    if (state.botConfigured) {
      return;
    }

    await flow.click('SetupChecklist.openHowMiningWorksOverlay()');
    await flow.click('HowMiningWorks.closeOverlay()');

    await flow.click('SetupChecklist.openBotCreateOverlay()');
    await clickIfVisible(flow, 'BotCreatePanel.stopSuggestingTour()');

    if (input.startingBidArgons) {
      await applyCustomBid(flow, 'startingBid', input.startingBidArgons);
    }
    if (input.maximumBidArgons) {
      await applyCustomBid(flow, 'maximumBid', input.maximumBidArgons);
    }

    await flow.click('BotCreatePanel.saveRules()');
    await flow.waitFor('SetupChecklist.openFundMiningAccountOverlay()', { timeoutMs: 30_000 });
  },
});

async function applyCustomBid(
  flow: IE2EFlowRuntime,
  bidType: 'startingBid' | 'maximumBid',
  amountArgons: string,
): Promise<void> {
  await flow.click(`BotSettings.openEditBoxOverlay('${bidType}')`);
  const formulaTestId = bidType === 'startingBid' ? 'startingBidFormulaType' : 'maximumBidFormulaType';
  await flow.click(formulaTestId);
  await flow.click('Custom Amount');

  const inputId = bidType === 'startingBid' ? 'startingBidCustomAmount' : 'maximumBidCustomAmount';
  await flow.type({ selector: `[data-testid="${inputId}"] [data-testid="input-number"]` }, amountArgons, {
    clear: true,
  });
  await flow.click('EditBoxOverlay.saveOverlay()');
}

async function readBotConfigState(flow: IE2EFlowRuntime): Promise<{ hasSavedBiddingRules: boolean } | undefined> {
  return await flow.queryApp<{ hasSavedBiddingRules: boolean }>(
    (({ config }: IMiningChecklistQueryRefs): { hasSavedBiddingRules: boolean } => ({
      hasSavedBiddingRules: config.hasSavedBiddingRules,
    })).toString(),
    { timeoutMs: 10_000 },
  );
}
