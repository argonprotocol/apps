import { createVaultingFlowContext, type IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import appFundWalletFromEthereum from './App.op.fundWalletFromEthereum.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import vaultingCompleteChecklist from './Vaulting.op.completeChecklist.ts';
import vaultingFundWallet from './Vaulting.op.fundWallet.ts';
import vaultingStartRegistration from './Vaulting.op.startRegistration.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { WalletType } from '../types/srcVue.ts';

type IFundingUiState = {
  dashboardVisible: boolean;
  fundStepVisible: boolean;
  installingVisible: boolean;
};

type IFundingChainState = {
  walletIsFullyFunded: boolean;
};

type IFundingState = IE2EOperationInspectState<IFundingChainState, IFundingUiState>;

export default new OperationalFlow<IVaultingFlowContext, IFundingState>(import.meta, {
  description: 'Reach the vault funding step and fund the vaulting wallet through Ethereum.',
  defaultTimeoutMs: 20_000,
  createContext: createVaultingFlowContext,
  async inspect({ flow }) {
    const fundingState = await flow.inspect(vaultingFundWallet);
    const dashboardVisible = fundingState.uiState.dashboardVisible;
    const fundStepVisible = fundingState.uiState.fundOverlayVisible;
    const installingVisible = fundingState.uiState.installingVisible;
    const walletIsFullyFunded = fundingState.chainState.walletIsFullyFunded;
    const enteredPostFundingSetup = dashboardVisible || installingVisible;

    let operationState: 'complete' | 'runnable' | 'uiStateMismatch' = 'runnable';
    if (walletIsFullyFunded) {
      operationState = 'complete';
    } else if (enteredPostFundingSetup) {
      operationState = 'uiStateMismatch';
    }

    const blockers: string[] = [];
    if (dashboardVisible) {
      blockers.push('Vaulting dashboard should not be visible in the Ethereum funding flow.');
    }
    if (installingVisible) {
      blockers.push('Vault installation should not have started in the Ethereum funding flow.');
    }

    return {
      chainState: {
        walletIsFullyFunded,
      },
      uiState: {
        dashboardVisible,
        fundStepVisible,
        installingVisible,
      },
      state: operationState,
      blockers,
    };
  },
  async run({ flow, flowName, input }, state) {
    if (state.chainState.walletIsFullyFunded) {
      return;
    }

    await flow.run(vaultingActivateTab);
    await flow.run(vaultingStartRegistration);
    await flow.run(vaultingCompleteChecklist);

    await flow.waitFor('SetupChecklist.openFundVaultingAccountOverlay()', { timeoutMs: 15_000 });
    await flow.click('SetupChecklist.openFundVaultingAccountOverlay()', { timeoutMs: 15_000 });

    await flow.run(
      {
        flow,
        flowName,
        input: {
          targetWalletType: WalletType.defaultArgon,
          extraMicrogons: input.extraFundingArgons ?? undefined,
        },
      },
      appFundWalletFromEthereum,
      {
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: Ethereum funding did not become ready on Argon in time.`,
      },
    );

    await flow.poll(this, nextState => nextState.chainState.walletIsFullyFunded, {
      timeoutMs: 120_000,
      timeoutMessage: `${flowName}: vaulting wallet did not become funded after Ethereum funding.`,
    });
  },
});
