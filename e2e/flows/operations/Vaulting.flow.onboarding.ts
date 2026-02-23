import { createVaultingFlowContext, type IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import vaultingCompleteChecklist from './Vaulting.op.completeChecklist.ts';
import vaultingFinalizeSetup from './Vaulting.op.finalizeSetup.ts';
import vaultingFundWallet from './Vaulting.op.fundWallet.ts';
import vaultingStartRegistration from './Vaulting.op.startRegistration.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IOnboardingUiState = {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
};

interface IOnboardingState extends IE2EOperationInspectState<Record<string, never>, IOnboardingUiState> {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
}

export default new OperationalFlow<IVaultingFlowContext, IOnboardingState>(import.meta, {
  description: 'Complete vaulting onboarding so bitcoin lock workflows can run.',
  defaultTimeoutMs: 20_000,
  createContext: createVaultingFlowContext,
  async inspect({ flow }) {
    const lockOverlay = await flow.isVisible('PersonalBitcoin.showLockingOverlay()');
    const dashboard = await flow.isVisible('VaultingDashboard');
    const lockOverlayVisible = lockOverlay.visible;
    const dashboardVisible = dashboard.visible;
    const isComplete = lockOverlayVisible || dashboardVisible;
    return {
      chainState: {},
      uiState: {
        lockOverlayVisible,
        dashboardVisible,
      },
      isRunnable: !isComplete,
      isComplete,
      blockers: isComplete ? ['ALREADY_COMPLETE'] : [],
      lockOverlayVisible,
      dashboardVisible,
    };
  },
  async run(_context, state, api) {
    if (state.lockOverlayVisible || state.dashboardVisible) {
      return;
    }

    await api.run(vaultingActivateTab);
    await api.run(vaultingStartRegistration);
    await api.run(vaultingCompleteChecklist);
    await api.run(vaultingFundWallet);
    await api.run(vaultingFinalizeSetup);
  },
});
