import { createVaultingFlowContext, type IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { readDevEthereumRuntimeState } from '../../devEthereum.ts';
import { fundDevEthereumAccount } from '../../scripts/fundDevEthereumAccount.ts';
import { clickIfVisible } from '../helpers/utils.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import vaultingTransferOutToEthereum from './Vaulting.op.transferOutToEthereum.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type ITransferOutToEthereumUiState = {
  transferComplete: boolean;
};

const DEV_ETHEREUM_TRANSFER_GAS_BUFFER_WEI = 1_000_000_000_000_000_000n;
const DEV_ETHEREUM_BACKEND_MINTING_AUTHORITY_READY_TIMEOUT_MS = 6 * 60_000;

type ITransferOutToEthereumState = IE2EOperationInspectState<Record<string, never>, ITransferOutToEthereumUiState>;

export default new OperationalFlow<IVaultingFlowContext, ITransferOutToEthereumState>(import.meta, {
  description: 'Wait for the backend minting authority, then transfer ARGN to Ethereum from the wallet overlay.',
  defaultTimeoutMs: 20_000,
  createContext: createVaultingFlowContext,
  async inspect({ flow }) {
    const transferState = await flow.inspect(vaultingTransferOutToEthereum);
    const transferComplete = transferState.state === 'complete';

    return {
      chainState: {},
      uiState: {
        transferComplete,
      },
      state: transferComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run(context, state) {
    const { flow } = context;
    if (state.uiState.transferComplete) {
      return;
    }

    await flow.run(vaultingOnboarding);
    const { ethereumAddress, executionRpcUrl } = (await flow.queryApp(
      async refs => {
        await refs.wallets.load().catch(() => undefined);
        const tracker = refs.getEthereumOutboundTransferTracker() as any;

        return {
          ethereumAddress: refs.wallets.ethereumWallet.address,
          executionRpcUrl: tracker.ethereumClient.executionRpcUrl,
        };
      },
      {
        timeoutMs: 15_000,
      },
    )) as { ethereumAddress: string; executionRpcUrl: string };

    await waitFor(
      DEV_ETHEREUM_BACKEND_MINTING_AUTHORITY_READY_TIMEOUT_MS,
      `${context.flowName}: backend minting authority readiness`,
      async () => {
        const runtimeState = await readDevEthereumRuntimeState(executionRpcUrl);
        if (runtimeState?.executionRpcUrl !== executionRpcUrl) {
          return;
        }
        if (runtimeState.setupStatus !== 'ready' || runtimeState.mintingAuthorityStatus !== 'ready') {
          return;
        }

        return runtimeState;
      },
      {
        pollMs: 1_000,
        timeoutMessage: `${context.flowName}: backend minting authority never became ready.`,
      },
    );

    await fundDevEthereumAccount({
      to: ethereumAddress,
      rpcUrl: executionRpcUrl,
      amountBaseUnits: DEV_ETHEREUM_TRANSFER_GAS_BUFFER_WEI,
    });

    await clickIfVisible(flow, 'WalletFundingReceivedOverlay.closeOverlay()', { timeoutMs: 5_000 });

    if (!(await flow.isVisible('VaultingScreen')).visible) {
      await flow.run(vaultingActivateTab);
    }
    await flow.run(vaultingTransferOutToEthereum);
  },
});
