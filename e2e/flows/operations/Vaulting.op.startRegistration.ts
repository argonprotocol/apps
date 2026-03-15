import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IStartRegistrationUiState = {
  blankSlateVisible: boolean;
  postStartReadyVisible: boolean;
};

interface IStartRegistrationState extends IE2EOperationInspectState<Record<string, never>, IStartRegistrationUiState> {
  blankSlateVisible: boolean;
  postStartReadyVisible: boolean;
}

export default new Operation<IVaultingFlowContext, IStartRegistrationState>(import.meta, {
  async inspect({ flow }) {
    const [blankSlateVisible, postStartReadyVisible] = await Promise.all([
      flow.isVisible('BlankSlate.startSettingUpVault()').then(state => state.visible),
      flow.isVisible('SetupChecklist.openHowVaultingWorksOverlay()').then(state => state.visible),
    ]);

    const hasEntrypoint = blankSlateVisible || postStartReadyVisible;
    const isComplete = postStartReadyVisible;
    const canRun = !isComplete && hasEntrypoint;
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !hasEntrypoint) {
      blockers.push('Vaulting setup entry is not visible (neither blank-slate nor checklist).');
    }
    return {
      chainState: {},
      uiState: {
        blankSlateVisible,
        postStartReadyVisible,
      },
      state: operationState,
      blankSlateVisible,
      postStartReadyVisible,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow }, state) {
    if (state.postStartReadyVisible) {
      return;
    }

    if (state.blankSlateVisible) {
      await flow.click('BlankSlate.startSettingUpVault()', { timeoutMs: 10_000 });
      await flow.waitFor('SetupChecklist.openHowVaultingWorksOverlay()', { timeoutMs: 30_000 });
      return;
    }

    throw new Error('Vaulting setup entry is not visible (neither blank-slate nor checklist).');
  },
});
