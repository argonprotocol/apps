import { createVaultingFlowContext, type IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import { startDevEthereumMintingAuthority } from '../../helpers/startDevEthereumMintingAuthority.ts';
import { fundDevEthereumAccount } from '../../scripts/fundDevEthereumAccount.ts';
import { clickIfVisible } from '../helpers/utils.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import vaultingTransferOutThroughEthereum from './Vaulting.op.transferOutThroughEthereum.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';

type ITransferOutThroughEthereumUiState = {
  transferComplete: boolean;
};

const DEV_ETHEREUM_TRANSFER_GAS_BUFFER_WEI = 1_000_000_000_000_000_000n;

type ITransferOutThroughEthereumState = IE2EOperationInspectState<
  Record<string, never>,
  ITransferOutThroughEthereumUiState
>;

export default new OperationalFlow<IVaultingFlowContext, ITransferOutThroughEthereumState>(import.meta, {
  description: 'Preseed a same-user minting authority, then transfer ARGN to Ethereum through the wallet overlay.',
  defaultTimeoutMs: 20_000,
  createContext: createVaultingFlowContext,
  async inspect({ flow }) {
    const transferState = await flow.inspect(vaultingTransferOutThroughEthereum);
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
    const archiveUrl = flow.getData<string>('sessionArchiveUrl') as string;

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

    const mintingAuthorityRuntime = await startDevEthereumMintingAuthority({
      archiveUrl,
      executionRpcUrl,
      logPrefix: context.flowName,
    });

    try {
      await fundDevEthereumAccount({
        to: ethereumAddress,
        rpcUrl: executionRpcUrl,
        amountBaseUnits: DEV_ETHEREUM_TRANSFER_GAS_BUFFER_WEI,
      });

      await clickIfVisible(flow, 'WalletFundingReceivedOverlay.closeOverlay()', { timeoutMs: 5_000 });

      if (!(await flow.isVisible('VaultingScreen')).visible) {
        await flow.run(vaultingActivateTab);
      }
      await flow.run(vaultingTransferOutThroughEthereum);
    } finally {
      await mintingAuthorityRuntime.shutdown();
    }
  },
});
