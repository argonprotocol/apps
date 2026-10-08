import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { parseDecimalToUnits } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import type { IAppQueryRefs } from '../types/srcVue.ts';

type ICompleteChecklistUiState = {
  checklistVisible: boolean;
  fundStepVisible: boolean;
  dashboardVisible: boolean;
};

type IVaultingChecklistState = Pick<IAppQueryRefs['config'], 'hasSavedVaultSetup'> & {
  matchesRequestedCapital: boolean;
};

type ICompleteChecklistState = IE2EOperationInspectState<IVaultingChecklistState, ICompleteChecklistUiState>;

export default new Operation<IVaultingFlowContext, ICompleteChecklistState>(import.meta, {
  async inspect({ flow, input }) {
    const [setupState, checklistEntry, fundStepEntry, dashboard] = await Promise.all([
      flow.queryApp(
        refs => ({
          hasSavedVaultSetup: refs.config.hasSavedVaultSetup,
          microgons: refs.config.vaultSetup.securitizationMicrogons.toString(),
          micronots: refs.config.vaultSetup.committedMicronots.toString(),
        }),
        { timeoutMs: 10_000 },
      ),
      flow.isVisible('SetupChecklist.openVaultCreateOverlay()'),
      flow.isVisible('SetupChecklist.openFundVaultingAccountOverlay()'),
      flow.isVisible('VaultingDashboard'),
    ]);
    const hasSavedVaultSetup = setupState?.hasSavedVaultSetup ?? false;
    const requestedMicrogons =
      input.securitizationArgons === null
        ? undefined
        : parseDecimalToUnits(input.securitizationArgons, BigInt(MICROGONS_PER_ARGON), 'vault ARGN').toString();
    const requestedMicronots =
      input.securitizationArgonots === null
        ? undefined
        : parseDecimalToUnits(input.securitizationArgonots, BigInt(MICROGONS_PER_ARGON), 'vault ARGNOT').toString();
    const matchesRequestedCapital =
      (requestedMicrogons === undefined || requestedMicrogons === setupState?.microgons) &&
      (requestedMicronots === undefined || requestedMicronots === setupState?.micronots);
    const isComplete = (hasSavedVaultSetup && matchesRequestedCapital) || dashboard.visible;
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
        hasSavedVaultSetup,
        matchesRequestedCapital,
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
  async run({ flow, input }, state) {
    if (state.uiState.dashboardVisible) {
      return;
    }

    if (!state.uiState.checklistVisible) {
      return;
    }

    if (!state.chainState.hasSavedVaultSetup || !state.chainState.matchesRequestedCapital) {
      await flow.click('SetupChecklist.openVaultCreateOverlay()');
      if (input.securitizationArgons !== null) {
        await flow.type(
          { selector: '[data-testid="vault-create-argn"] [data-testid="input-number"]' },
          input.securitizationArgons,
          { clear: true },
        );
      }
      if (input.securitizationArgonots !== null) {
        await flow.type(
          { selector: '[data-testid="vault-create-argnot"] [data-testid="input-number"]' },
          input.securitizationArgonots,
          { clear: true },
        );
      }
      await flow.click('VaultCreatePanel.saveSettings()');
      await flow.waitFor('SetupChecklist.openFundVaultingAccountOverlay()', { timeoutMs: 15_000 });
    }
  },
});
