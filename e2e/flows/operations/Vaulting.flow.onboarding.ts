import { createVaultingFlowContext, type IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import vaultingCompleteChecklist from './Vaulting.op.completeChecklist.ts';
import vaultingConnectServer from './Vaulting.op.connectServer.ts';
import vaultingFinalizeSetup from './Vaulting.op.finalizeSetup.ts';
import vaultingFundWallet from './Vaulting.op.fundWallet.ts';
import vaultingStartRegistration from './Vaulting.op.startRegistration.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IOnboardingUiState = {
  dashboardVisible: boolean;
};

type IOnboardingState = IE2EOperationInspectState<
  { hasVault: boolean; hasTreasuryAccess: boolean },
  IOnboardingUiState
>;

export default new OperationalFlow<IVaultingFlowContext, IOnboardingState>(import.meta, {
  description: 'Complete vaulting onboarding so bitcoin lock workflows can run.',
  defaultTimeoutMs: 20_000,
  createContext: createVaultingFlowContext,
  async inspect({ flow }) {
    const [dashboard, readiness] = await Promise.all([
      flow.isVisible('VaultingDashboard'),
      flow.queryApp(refs => ({
        hasVault: Boolean(refs.myVault.createdVault),
        hasTreasuryAccess: refs.config.hasExtensionTreasury,
      })),
    ]);
    const dashboardVisible = dashboard.visible;
    const hasVault = readiness?.hasVault ?? false;
    const hasTreasuryAccess = readiness?.hasTreasuryAccess ?? false;
    const isComplete = hasVault && hasTreasuryAccess;
    let operationState: 'complete' | 'runnable' = 'runnable';
    if (isComplete) {
      operationState = 'complete';
    }
    return {
      chainState: { hasVault, hasTreasuryAccess },
      uiState: {
        dashboardVisible,
      },
      state: operationState,
      blockers: [],
    };
  },
  async run({ flow }, state) {
    if (state.chainState.hasVault && state.chainState.hasTreasuryAccess) {
      return;
    }

    await flow.run(vaultingActivateTab);
    await flow.run(vaultingStartRegistration);
    await flow.run(vaultingConnectServer);
    await flow.run(vaultingCompleteChecklist);
    await flow.run(vaultingFundWallet);
    await flow.run(vaultingFinalizeSetup);
  },
});
