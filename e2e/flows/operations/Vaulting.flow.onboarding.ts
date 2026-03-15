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

type IOnboardingState = IE2EOperationInspectState<Record<string, never>, IOnboardingUiState>;

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
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }
    return {
      chainState: {},
      uiState: {
        lockOverlayVisible,
        dashboardVisible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run({ flow }, state) {
    if (state.uiState.lockOverlayVisible || state.uiState.dashboardVisible) {
      return;
    }

    await flow.run(vaultingActivateTab);
    await flow.run(vaultingStartRegistration);
    await flow.run(vaultingCompleteChecklist);
    await flow.run(vaultingFundWallet);
    await flow.run(vaultingFinalizeSetup);
  },
});
