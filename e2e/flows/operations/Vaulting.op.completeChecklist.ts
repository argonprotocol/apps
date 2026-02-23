import { clickIfVisible } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type ICompleteChecklistUiState = {
  checklistVisible: boolean;
  fundOverlayVisible: boolean;
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
};

interface ICompleteChecklistState extends IE2EOperationInspectState<Record<string, never>, ICompleteChecklistUiState> {
  checklistVisible: boolean;
  fundOverlayVisible: boolean;
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IVaultingFlowContext, ICompleteChecklistState>(import.meta, {
  async inspect({ flow }) {
    const [checklistEntry, fundOverlayEntry, lockOverlayEntry, dashboard] = await Promise.all([
      flow.isVisible('FinalSetupChecklist.openHowVaultingWorksOverlay()'),
      flow.isVisible('FinalSetupChecklist.openFundVaultingAccountOverlay()'),
      flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
      flow.isVisible('VaultingDashboard'),
    ]);
    const runnable = checklistEntry.visible && !lockOverlayEntry.visible && !dashboard.visible;
    const isComplete = lockOverlayEntry.visible || dashboard.visible;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !checklistEntry.visible) blockers.push('Vaulting checklist is not visible.');
    return {
      chainState: {},
      uiState: {
        checklistVisible: checklistEntry.visible,
        fundOverlayVisible: fundOverlayEntry.visible,
        lockOverlayVisible: lockOverlayEntry.visible,
        dashboardVisible: dashboard.visible,
      },
      isRunnable,
      isComplete,
      checklistVisible: checklistEntry.visible,
      fundOverlayVisible: fundOverlayEntry.visible,
      lockOverlayVisible: lockOverlayEntry.visible,
      dashboardVisible: dashboard.visible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow }, state) {
    if (state.lockOverlayVisible || state.dashboardVisible) {
      return;
    }

    const checklist = await flow.isVisible('FinalSetupChecklist.openHowVaultingWorksOverlay()');
    if (!checklist.visible) {
      return;
    }

    await flow.click('FinalSetupChecklist.openHowVaultingWorksOverlay()');
    await flow.click('HowVaultingWorks.closeOverlay()', { timeoutMs: 30_000 });
    await flow.waitFor('HowVaultingWorks.closeOverlay()', { state: 'missing', timeoutMs: 30_000 });

    await flow.click('FinalSetupChecklist.openVaultCreateOverlay()');
    await clickIfVisible(flow, 'VaultCreatePanel.stopSuggestingTour()');
    await flow.click('VaultCreatePanel.saveRules()');
    await flow.waitFor('FinalSetupChecklist.openFundVaultingAccountOverlay()', { timeoutMs: 15_000 });
  },
});
