import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { getWalletOverlayFundingNeeded, sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import { parseDecimalToUnits } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type IFundVaultingWalletUiState = {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
  fundOverlayVisible: boolean;
};

interface IFundVaultingWalletState
  extends IE2EOperationInspectState<Record<string, never>, IFundVaultingWalletUiState> {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
  fundOverlayVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IVaultingFlowContext, IFundVaultingWalletState>(import.meta, {
  async inspect({ flow }) {
    const lockOverlayEntry = await flow.isVisible('PersonalBitcoin.showLockingOverlay()');
    const dashboard = await flow.isVisible('VaultingDashboard');
    const fundOverlayEntry = await flow.isVisible('SetupChecklist.openFundVaultingAccountOverlay()');
    const runnable = fundOverlayEntry.visible && !lockOverlayEntry.visible && !dashboard.visible;
    const isComplete = lockOverlayEntry.visible || dashboard.visible;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !fundOverlayEntry.visible) blockers.push('Vaulting fund-wallet step is not visible.');
    return {
      chainState: {},
      uiState: {
        lockOverlayVisible: lockOverlayEntry.visible,
        dashboardVisible: dashboard.visible,
        fundOverlayVisible: fundOverlayEntry.visible,
      },
      isRunnable,
      isComplete,
      lockOverlayVisible: lockOverlayEntry.visible,
      dashboardVisible: dashboard.visible,
      fundOverlayVisible: fundOverlayEntry.visible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName, input }, state) {
    if (state.lockOverlayVisible || state.dashboardVisible || !state.fundOverlayVisible) {
      return;
    }

    await flow.click('SetupChecklist.openFundVaultingAccountOverlay()');
    const { address, microgons, micronots } = await getWalletOverlayFundingNeeded(flow);
    const extraMicrogons = parseDecimalToUnits(
      input.extraFundingArgons ?? '1000',
      BigInt(MICROGONS_PER_ARGON),
      `${flowName}.extraFundingArgons`,
    );

    await flow.click('WalletOverlay.closeOverlay()', { timeoutMs: 8_000 });
    await sudoFundWallet({
      address,
      microgons: microgons + extraMicrogons,
      micronots,
    });
  },
});
