import { clickIfVisible } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import type { Config } from '../types/srcVue.ts';

type ICompleteChecklistUiState = {
  checklistVisible: boolean;
  fundStepVisible: boolean;
  dashboardVisible: boolean;
};

type IVaultingChecklistState = Pick<Config, 'hasSavedVaultingRules'>;

type ICompleteChecklistState = IE2EOperationInspectState<IVaultingChecklistState, ICompleteChecklistUiState>;

export default new Operation<IVaultingFlowContext, ICompleteChecklistState>(import.meta, {
  async inspect({ flow }) {
    const [setupState, checklistEntry, fundStepEntry, dashboard] = await Promise.all([
      flow.queryApp<IVaultingChecklistState>(VAULTING_CHECKLIST_STATE_FN, { timeoutMs: 10_000 }),
      flow.isVisible('SetupChecklist.openVaultCreateOverlay()'),
      flow.isVisible('SetupChecklist.openFundVaultingAccountOverlay()'),
      flow.isVisible('VaultingDashboard'),
    ]);
    const hasSavedVaultingRules = setupState?.hasSavedVaultingRules ?? false;
    const isComplete = hasSavedVaultingRules || dashboard.visible;
    const canRun = checklistEntry.visible && !isComplete;
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !checklistEntry.visible) blockers.push('Vaulting checklist is not visible.');
    return {
      chainState: {
        hasSavedVaultingRules,
      },
      uiState: {
        checklistVisible: checklistEntry.visible,
        fundStepVisible: fundStepEntry.visible,
        dashboardVisible: dashboard.visible,
      },
      state: operationState,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow }, state) {
    if (state.uiState.dashboardVisible) {
      return;
    }

    if (!state.uiState.checklistVisible) {
      return;
    }

    if (!state.chainState.hasSavedVaultingRules) {
      await flow.click('SetupChecklist.openVaultCreateOverlay()');
      await clickIfVisible(flow, 'VaultCreatePanel.stopSuggestingTour()');
      await flow.click('VaultCreatePanel.saveRules()');
      await flow.waitFor('SetupChecklist.openFundVaultingAccountOverlay()', { timeoutMs: 15_000 });
    }
  },
});

const VAULTING_CHECKLIST_STATE_FN = ((refs: { config: IVaultingChecklistState }) => {
  return {
    hasSavedVaultingRules: refs.config.hasSavedVaultingRules,
  };
}).toString();
