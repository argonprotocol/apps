import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import { Operation } from './index.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IEnsureOperationalUiState = {
  isVaultOperational: boolean;
};

interface IEnsureOperationalState extends IE2EOperationInspectState<Record<string, never>, IEnsureOperationalUiState> {
  isVaultOperational: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IVaultingFlowContext, IEnsureOperationalState>(import.meta, {
  async inspect({ flow }) {
    const [lockOverlay, dashboard] = await Promise.all([
      flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
      flow.isVisible('VaultingDashboard'),
    ]);
    const isVaultOperational = lockOverlay.visible || dashboard.visible;
    return {
      chainState: {},
      uiState: {
        isVaultOperational,
      },
      isRunnable: !isVaultOperational,
      isComplete: isVaultOperational,
      isVaultOperational,
      runnable: !isVaultOperational,
      blockers: isVaultOperational ? ['ALREADY_COMPLETE'] : [],
    };
  },
  async run(_context, state, api) {
    if (state.isVaultOperational) {
      return;
    }

    await api.run(vaultingOnboarding);
  },
});
