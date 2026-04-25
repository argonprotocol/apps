import { pollEvery } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';

const VAULT_CREATE_TRANSITION_TIMEOUT_MS = 20_000;

type IVaultingFundingInspect = {
  walletIsFullyFunded: boolean;
  walletsLoaded: boolean;
  hasMiningMachine: boolean;
  canStartVault: boolean;
  overlayIsOpen: boolean;
  availableMicrogons: string;
  availableMicronots: string;
  requiredMicrogons: string;
  requiredMicronots: string;
};

type IFinalizeSetupUiState = {
  dashboardVisible: boolean;
  createVaultVisible: boolean;
  createVaultClickable: boolean;
  installingVisible: boolean;
};

type IFinalizeSetupState = IE2EOperationInspectState<IVaultingFundingInspect, IFinalizeSetupUiState>;

export default new Operation<IVaultingFlowContext, IFinalizeSetupState>(import.meta, {
  async inspect({ flow }) {
    const [fundingState, dashboard, createVaultEntry, installingState] = await Promise.all([
      flow.queryApp<IVaultingFundingInspect>(
        ((refs: {
          config: {
            vaultingRules?: {
              baseMicrogonCommitment?: bigint;
              baseMicronotCommitment?: bigint;
            } | null;
            serverAdd?: {
              localComputer?: unknown;
              customServer?: unknown;
              digitalOcean?: unknown;
            } | null;
          };
          wallets: {
            isLoaded: boolean;
            vaultingWallet: {
              availableMicrogons: bigint;
              availableMicronots: bigint;
            };
          };
          controller: {
            overlayIsOpen: boolean;
          };
        }) => {
          const requiredMicrogons = refs.config.vaultingRules?.baseMicrogonCommitment ?? 0n;
          const requiredMicronots = refs.config.vaultingRules?.baseMicronotCommitment ?? 0n;
          const availableMicrogons = refs.wallets.vaultingWallet.availableMicrogons ?? 0n;
          const availableMicronots = refs.wallets.vaultingWallet.availableMicronots ?? 0n;
          const hasMiningMachine =
            !!refs.config.serverAdd?.customServer ||
            !!refs.config.serverAdd?.localComputer ||
            !!refs.config.serverAdd?.digitalOcean;
          const walletsLoaded = refs.wallets.isLoaded;
          const walletIsFullyFunded =
            availableMicrogons >= requiredMicrogons && availableMicronots >= requiredMicronots;

          return {
            walletIsFullyFunded,
            walletsLoaded,
            hasMiningMachine,
            canStartVault: walletIsFullyFunded && walletsLoaded && hasMiningMachine && !refs.controller.overlayIsOpen,
            overlayIsOpen: refs.controller.overlayIsOpen,
            availableMicrogons: availableMicrogons.toString(),
            availableMicronots: availableMicronots.toString(),
            requiredMicrogons: requiredMicrogons.toString(),
            requiredMicronots: requiredMicronots.toString(),
          };
        }).toString(),
        { timeoutMs: 10_000 },
      ),
      flow.isVisible('VaultingDashboard'),
      flow.isVisible('SetupChecklist.startCreateVault()'),
      flow.isVisible({ selector: '.VaultIsInstalling' }),
    ]);
    const createVaultVisible = createVaultEntry.visible;
    const createVaultClickable = createVaultEntry.clickable;
    const canStartVault = fundingState?.canStartVault ?? false;
    const hasFinalizeEntryPoint = createVaultVisible || installingState.visible;
    const isComplete = dashboard.visible;
    const canRun = !dashboard.visible && (installingState.visible || (createVaultVisible && canStartVault));
    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !(fundingState?.walletIsFullyFunded ?? false)) {
      blockers.push('Vaulting wallet is not fully funded yet.');
    } else if (!isComplete && !(fundingState?.walletsLoaded ?? false)) {
      blockers.push('Vaulting wallet state is still loading.');
    } else if (!isComplete && !(fundingState?.hasMiningMachine ?? false)) {
      blockers.push('Vaulting server connection is not ready yet.');
    } else if (!isComplete && (fundingState?.overlayIsOpen ?? false)) {
      blockers.push('A vaulting overlay is still open.');
    } else if (!isComplete && !hasFinalizeEntryPoint) {
      blockers.push('Vaulting is not at the finalize step yet.');
    }
    return {
      chainState: fundingState ?? {
        walletIsFullyFunded: false,
        walletsLoaded: false,
        hasMiningMachine: false,
        canStartVault: false,
        overlayIsOpen: false,
        availableMicrogons: '0',
        availableMicronots: '0',
        requiredMicrogons: '0',
        requiredMicronots: '0',
      },
      uiState: {
        dashboardVisible: dashboard.visible,
        createVaultVisible,
        createVaultClickable,
        installingVisible: installingState.visible,
      },
      state: operationState,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state) {
    if (state.uiState.dashboardVisible) {
      return;
    }
    if (!state.uiState.createVaultVisible && !state.uiState.installingVisible) {
      return;
    }

    if (state.uiState.createVaultVisible) {
      if (!state.chainState.canStartVault) {
        return;
      }
      await flow.click('SetupChecklist.startCreateVault()', { timeoutMs: 30_000 });
      await waitForVaultCreateTransition(flow, flowName);
    }

    await pollEvery(
      5_000,
      async () => {
        const vaultInstallError = await getVaultInstallError(flow);
        if (vaultInstallError) {
          throw new Error(`${flowName}: vault creation failed: ${vaultInstallError}`);
        }

        const dashboard = await flow.isVisible('VaultingDashboard');
        if (dashboard.visible) return true;

        const [createVaultVisible, installingVisible] = await Promise.all([
          flow.isVisible('SetupChecklist.startCreateVault()'),
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
      const [dashboard, installingVisible, createVaultVisible] = await Promise.all([
        flow.isVisible('VaultingDashboard'),
        flow.isVisible({ selector: '.VaultIsInstalling' }),
        flow.isVisible('SetupChecklist.startCreateVault()'),
      ]);
      if (dashboard.visible || installingVisible.visible) {
        return true;
      }
      if (!createVaultVisible.visible) {
        return true;
      }

      await flow.click('SetupChecklist.startCreateVault()', { timeoutMs: 10_000 }).catch(() => undefined);
      return false;
    },
    {
      timeoutMs: VAULT_CREATE_TRANSITION_TIMEOUT_MS,
      timeoutMessage: `${flowName}: vault setup did not transition after clicking launch.`,
    },
  );
}
