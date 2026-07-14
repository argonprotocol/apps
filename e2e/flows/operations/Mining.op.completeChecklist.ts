import { clickIfVisible } from '../helpers/utils.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';

type ICompleteChecklistUiState = {
  checklistVisible: boolean;
  checklistClickable: boolean;
  botConfigured: boolean;
};

interface ICompleteChecklistState extends IE2EOperationInspectState<Record<string, never>, ICompleteChecklistUiState> {
  checklistVisible: boolean;
  botConfigured: boolean;
}

export default new Operation<IMiningFlowContext, ICompleteChecklistState>(import.meta, {
  async inspect({ flow }) {
    const [checklistEntry, botConfigState] = await Promise.all([
      flow.isVisible('SetupChecklist.openBotCreateOverlay()'),
      readBotConfigState(flow),
    ]);
    const botConfigured = botConfigState?.hasSavedBiddingRules ?? false;
    const isComplete = botConfigured;
    const canRun = checklistEntry.clickable && !botConfigured;
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !checklistEntry.visible) blockers.push('Mining checklist is not visible.');
    if (!isComplete && checklistEntry.visible && !checklistEntry.clickable) {
      blockers.push('Mining checklist is still loading.');
    }
    return {
      chainState: {},
      uiState: {
        checklistVisible: checklistEntry.visible,
        checklistClickable: checklistEntry.clickable,
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
  const formulaState = await flow.isVisible(formulaTestId);
  if (!formulaState.clickable) {
    throw new Error(
      `${bidType} formula type is not clickable (visible=${formulaState.visible}, enabled=${formulaState.enabled}, clickable=${formulaState.clickable}, pointerReason=${formulaState.pointerReason ?? 'none'}, pointerBlocker=${formulaState.pointerBlocker ?? 'none'}).`,
    );
  }
  await flow.click(formulaTestId);
  await flow.click('Custom Amount');

  const inputId = bidType === 'startingBid' ? 'startingBidCustomAmount' : 'maximumBidCustomAmount';
  await flow.type({ selector: `[data-testid="${inputId}"] [data-testid="input-number"]` }, amountArgons, {
    clear: true,
  });
  await flow.click('EditBoxOverlay.saveOverlay()');
}

async function readBotConfigState(flow: IE2EFlowRuntime): Promise<{ hasSavedBiddingRules: boolean } | undefined> {
  return await flow.queryApp(
    refs => ({
      hasSavedBiddingRules: refs.config.hasSavedBiddingRules,
    }),
    { timeoutMs: 10_000 },
  );
}
