import { pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

const VAULT_CREATE_TRANSITION_TIMEOUT_MS = 20_000;

type IFinalizeSetupUiState = {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
  createVaultVisible: boolean;
  installingVisible: boolean;
};

interface IFinalizeSetupState extends IE2EOperationInspectState<Record<string, never>, IFinalizeSetupUiState> {
  lockOverlayVisible: boolean;
  dashboardVisible: boolean;
  createVaultVisible: boolean;
  installingVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IVaultingFlowContext, IFinalizeSetupState>(import.meta, {
  async inspect({ flow }) {
    const [lockOverlayEntry, dashboard, createVaultEntry, installingState] = await Promise.all([
      flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
      flow.isVisible('VaultingDashboard'),
      flow.isVisible('SetupChecklist.createVault()'),
      flow.isVisible({ selector: '.VaultIsInstalling' }),
    ]);
    const hasFinalizeEntryPoint = createVaultEntry.visible || installingState.visible;
    const runnable = !lockOverlayEntry.visible && !dashboard.visible && hasFinalizeEntryPoint;
    const isComplete = lockOverlayEntry.visible || dashboard.visible;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !hasFinalizeEntryPoint) {
      blockers.push('Vaulting is not at the finalize step yet.');
    }
    return {
      chainState: {},
      uiState: {
        lockOverlayVisible: lockOverlayEntry.visible,
        dashboardVisible: dashboard.visible,
        createVaultVisible: createVaultEntry.visible,
        installingVisible: installingState.visible,
      },
      isRunnable,
      isComplete,
      lockOverlayVisible: lockOverlayEntry.visible,
      dashboardVisible: dashboard.visible,
      createVaultVisible: createVaultEntry.visible,
      installingVisible: installingState.visible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state) {
    if (state.lockOverlayVisible || state.dashboardVisible) {
      return;
    }
    if (!state.createVaultVisible && !state.installingVisible) {
      return;
    }

    if (state.createVaultVisible) {
      await flow.click('SetupChecklist.createVault()', { timeoutMs: 8_000 });
      await waitForVaultCreateTransition(flow, flowName);
    }

    await pollEvery(
      5_000,
      async () => {
        const vaultInstallError = await getVaultInstallError(flow);
        if (vaultInstallError) {
          throw new Error(`${flowName}: vault creation failed: ${vaultInstallError}`);
        }

        const lockOverlayEntry = await flow.isVisible('PersonalBitcoin.showLockingOverlay()');
        if (lockOverlayEntry.visible) return true;

        const dashboard = await flow.isVisible('VaultingDashboard');
        if (dashboard.visible) return true;

        const [createVaultVisible, installingVisible] = await Promise.all([
          flow.isVisible('SetupChecklist.createVault()'),
          flow.isVisible({ selector: '.VaultIsInstalling' }),
        ]);
        if (createVaultVisible.visible && !installingVisible.visible) {
          throw new Error(`${flowName}: vault create button remained visible and setup never entered installing.`);
        }

        return false;
      },
      {
        timeoutMs: 10 * 60_000,
        timeoutMessage: `${flowName}: vault creation did not reach a ready vaulting state within 10 minutes.`,
      },
    );
  },
});

async function getVaultInstallError(flow: IVaultingFlowContext['flow']): Promise<string | null> {
  const errorTarget = 'VaultIsInstalling.errorMessage';
  const errorState = await flow.isVisible(errorTarget);
  if (!errorState.visible) return null;

  const message = (await flow.getText(errorTarget, { timeoutMs: 1_000 })).trim();
  return message.length > 0 ? message : 'Unknown vault setup error';
}

async function waitForVaultCreateTransition(flow: IVaultingFlowContext['flow'], flowName: string): Promise<void> {
  await pollEvery(
    1_000,
    async () => {
      const [lockOverlayEntry, dashboard, installingVisible, createVaultVisible] = await Promise.all([
        flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
        flow.isVisible('VaultingDashboard'),
        flow.isVisible({ selector: '.VaultIsInstalling' }),
        flow.isVisible('SetupChecklist.createVault()'),
      ]);
      if (lockOverlayEntry.visible || dashboard.visible || installingVisible.visible) {
        return true;
      }
      return !createVaultVisible.visible;
    },
    {
      timeoutMs: VAULT_CREATE_TRANSITION_TIMEOUT_MS,
      timeoutMessage: `${flowName}: vault setup did not transition after clicking launch.`,
    },
  );
}
