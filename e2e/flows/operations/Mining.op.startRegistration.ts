import { clickIfVisible } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IMiningFlowContext } from '../contexts/miningContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IStartRegistrationUiState = {
  blankSlateVisible: boolean;
  postStartReadyVisible: boolean;
};

interface IStartRegistrationState extends IE2EOperationInspectState<Record<string, never>, IStartRegistrationUiState> {
  blankSlateVisible: boolean;
  postStartReadyVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IMiningFlowContext, IStartRegistrationState>(import.meta, {
  async inspect({ flow }) {
    const [blankSlateVisible, postStartReadyVisible] = await Promise.all([
      flow.isVisible('BlankSlate.startSettingUpMiner()').then(state => state.visible),
      flow.isVisible('FinalSetupChecklist.openHowMiningWorksOverlay()').then(state => state.visible),
    ]);

    const hasEntrypoint = blankSlateVisible || postStartReadyVisible;
    const isComplete = postStartReadyVisible;
    const runnable = !isComplete && hasEntrypoint;
    const isRunnable = runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !hasEntrypoint) {
      blockers.push('Mining setup entry is not visible (neither blank-slate nor checklist).');
    }
    return {
      chainState: {},
      uiState: {
        blankSlateVisible,
        postStartReadyVisible,
      },
      isRunnable,
      isComplete,
      blankSlateVisible,
      postStartReadyVisible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow }, state) {
    if (state.postStartReadyVisible) {
      return;
    }

    if (state.blankSlateVisible && (await clickIfVisible(flow, 'BlankSlate.startSettingUpMiner()'))) {
      await flow.waitFor('FinalSetupChecklist.openHowMiningWorksOverlay()', { timeoutMs: 30_000 });
      return;
    }

    const checklistVisible = await flow
      .waitFor('FinalSetupChecklist.openHowMiningWorksOverlay()', { timeoutMs: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (checklistVisible) {
      return;
    }

    const blankSlate = await flow.isVisible('BlankSlate.startSettingUpMiner()');
    if (blankSlate.visible && (await clickIfVisible(flow, 'BlankSlate.startSettingUpMiner()'))) {
      await flow.waitFor('FinalSetupChecklist.openHowMiningWorksOverlay()', { timeoutMs: 30_000 });
      return;
    }

    throw new Error('Mining setup entry is not visible (neither blank-slate nor checklist).');
  },
});
