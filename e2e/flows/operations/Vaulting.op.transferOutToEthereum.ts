import { MoveToken } from '@argonprotocol/apps-core';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { WalletType } from '../types/srcVue.ts';
import { clickIfVisible, pollEvery } from '../helpers/utils.ts';

const TRANSFER_OUT_MICROGONS = 10n * BigInt(MICROGONS_PER_ARGON);
const ETHEREUM_TRANSFER_TIMEOUT_MS = 12 * 60_000;
const UI_TRANSITION_TIMEOUT_MS = 30_000;
const FIRST_ETHEREUM_CONNECTOR_SELECTOR =
  '[data-wallet-connector-id]:not([data-wallet-connector-id="bitcoin"]) [data-testid="Connector.openConnector()"]';

type ITransferOutToEthereumChainState = {
  availableMicrogons: bigint;
  amount: bigint;
  progressPct: number;
  currentStepLabel: string;
  currentStepDetail: string;
  error: string;
  ethereumFeeEstimateWei?: bigint;
  hasPersistedTransfer: boolean;
  isSubmitting: boolean;
  remainingMintingAuthorizationMicrogons?: bigint;
};

type ITransferOutToEthereumUiState = {
  dashboardVisible: boolean;
  walletOverlayVisible: boolean;
};

type ITransferOutToEthereumState = IE2EOperationInspectState<
  ITransferOutToEthereumChainState,
  ITransferOutToEthereumUiState
>;

export default new Operation<IVaultingFlowContext, ITransferOutToEthereumState>(import.meta, {
  async inspect({ flow }) {
    const [dashboard, walletOverlay, transferState] = await Promise.all([
      flow.isVisible('VaultingDashboard'),
      flow.isVisible('WalletOverlay'),
      readOutboundTransferState(flow),
    ]);
    const transferCompleted = flow.getData<boolean>('Vaulting.op.transferOutToEthereum.completed') ?? false;

    const isComplete =
      transferCompleted ||
      (transferState.progressPct === 100 &&
        !transferState.isSubmitting &&
        !transferState.hasPersistedTransfer &&
        !transferState.error);

    let operationState: 'complete' | 'runnable' | 'processing' = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (dashboard.visible) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!dashboard.visible) {
      blockers.push('Vaulting dashboard is not visible.');
    }
    if (!isComplete && transferState.availableMicrogons < TRANSFER_OUT_MICROGONS) {
      blockers.push('Vaulting wallet does not have enough ARGN for the transfer-out test amount.');
    }

    return {
      chainState: transferState,
      uiState: {
        dashboardVisible: dashboard.visible,
        walletOverlayVisible: walletOverlay.visible,
      },
      phase: transferState.currentStepLabel || undefined,
      state: operationState,
      blockers: isComplete || dashboard.visible ? [] : blockers,
    };
  },

  async run({ flow, flowName }, state) {
    flow.setData('Vaulting.op.transferOutToEthereum.completed', false);

    if (state.chainState.error) {
      throw new Error(state.chainState.error);
    }

    if (
      state.chainState.progressPct !== 100 &&
      !state.chainState.isSubmitting &&
      !state.chainState.hasPersistedTransfer
    ) {
      if (state.chainState.availableMicrogons < TRANSFER_OUT_MICROGONS) {
        throw new Error(
          `${flowName}: vaulting wallet only has ${state.chainState.availableMicrogons.toString()} microgons available for transfer-out.`,
        );
      }

      if (!state.uiState.walletOverlayVisible) {
        await openVaultingWalletOverlay(flow);
        await flow.waitFor('WalletOverlay', { timeoutMs: 30_000 });
      }

      await flow.click({ selector: FIRST_ETHEREUM_CONNECTOR_SELECTOR, index: 0 }, { timeoutMs: 30_000 });
      await flow.waitFor('ConnectorTransfer.close()', { timeoutMs: 30_000 });
      await ensureTransferDirection(flow, 'outbound');
      await flow.type({ selector: '[data-testid="ConnectorTransfer.amount"] [data-testid="input-number"]' }, '10', {
        clear: true,
        timeoutMs: 15_000,
      });
      await pollEvery(
        1_000,
        async () => {
          const nextState = await flow.inspect(this);
          if (
            nextState.chainState.progressPct > 0 ||
            nextState.chainState.isSubmitting ||
            nextState.chainState.hasPersistedTransfer
          ) {
            return true;
          }

          await clickIfVisible(flow, 'ConnectorTransfer.initiateTransfer()', { timeoutMs: 1_500 });
          return false;
        },
        {
          timeoutMs: UI_TRANSITION_TIMEOUT_MS,
          timeoutMessage: `${flowName}: Ethereum transfer submission did not start.`,
        },
      );
    }

    await flow.poll(
      this,
      nextState => {
        if (nextState.chainState.error) {
          throw new Error(nextState.chainState.error);
        }

        return (
          nextState.chainState.progressPct === 100 &&
          !nextState.chainState.isSubmitting &&
          !nextState.chainState.hasPersistedTransfer
        );
      },
      {
        timeoutMs: ETHEREUM_TRANSFER_TIMEOUT_MS,
        timeoutMessage: `${flowName}: Argon-to-Ethereum transfer did not settle in time.`,
      },
    );

    if ((await flow.isVisible('ConnectorTransfer.close()')).clickable) {
      await flow.click('ConnectorTransfer.close()', { timeoutMs: 15_000 });
    }

    const overlayCloseButton = await flow.isVisible('WalletOverlay.closeRight()');
    if (overlayCloseButton.clickable) {
      await flow.click('WalletOverlay.closeRight()', { timeoutMs: 8_000 });
    }

    flow.setData('Vaulting.op.transferOutToEthereum.completed', true);
  },
});

async function ensureTransferDirection(
  flow: IVaultingFlowContext['flow'],
  direction: 'inbound' | 'outbound',
): Promise<void> {
  const currentDirection = await flow.getAttribute('ConnectorTransfer.direction', 'data-direction', {
    timeoutMs: 15_000,
  });
  if (currentDirection === direction) return;

  await flow.click('ConnectorTransfer.toggleTransferDirection()', { timeoutMs: 15_000 });
  await flow.waitFor(
    { selector: `[data-testid="ConnectorTransfer.direction"][data-direction="${direction}"]` },
    {
      timeoutMs: 15_000,
    },
  );
}

async function readOutboundTransferState(flow: IVaultingFlowContext['flow']) {
  const state = (await flow.queryApp(
    async (refs, args: { moveToken: MoveToken }) => {
      await refs.wallets.load().catch(() => undefined);

      const tracker = refs.getEthereumOutboundTransferTracker();
      await tracker.load();
      const transferState = tracker.getTransferStateForToken(args.moveToken);

      return {
        availableMicrogons: refs.wallets.defaultArgonWallet.availableMicrogons.toString(),
        amount: transferState.amount?.toString() ?? '0',
        progressPct: transferState.progress.overallProgressPct,
        currentStepLabel: transferState.progress.currentStepLabel,
        currentStepDetail: transferState.progress.currentStepDetail ?? '',
        error: transferState.error,
        ethereumFeeEstimateWei: transferState.ethereumFeeEstimateWei?.toString(),
        hasPersistedTransfer: transferState.hasPersistedTransfer,
        isSubmitting: transferState.isSubmitting,
        remainingMintingAuthorizationMicrogons:
          transferState.progress.currentStepRemainingMintingAuthorizationMicrogons?.toString(),
      };
    },
    {
      args: {
        moveToken: MoveToken.ARGN,
      },
      timeoutMs: 60_000,
    },
  )) as
    | {
        availableMicrogons: string;
        amount: string;
        progressPct: number;
        currentStepLabel: string;
        currentStepDetail: string;
        error: string;
        ethereumFeeEstimateWei?: string;
        hasPersistedTransfer: boolean;
        isSubmitting: boolean;
        remainingMintingAuthorizationMicrogons?: string;
      }
    | undefined;

  return {
    availableMicrogons: state ? BigInt(state.availableMicrogons) : 0n,
    amount: state ? BigInt(state.amount) : 0n,
    progressPct: state?.progressPct ?? 0,
    currentStepLabel: state?.currentStepLabel ?? '',
    currentStepDetail: state?.currentStepDetail ?? '',
    error: state?.error ?? '',
    ethereumFeeEstimateWei: state?.ethereumFeeEstimateWei ? BigInt(state.ethereumFeeEstimateWei) : undefined,
    hasPersistedTransfer: state?.hasPersistedTransfer ?? false,
    isSubmitting: state?.isSubmitting ?? false,
    remainingMintingAuthorizationMicrogons: state?.remainingMintingAuthorizationMicrogons
      ? BigInt(state.remainingMintingAuthorizationMicrogons)
      : undefined,
  };
}

export async function openVaultingWalletOverlay(flow: IVaultingFlowContext['flow']) {
  await flow.queryApp(
    (refs, args: { walletType: WalletType.argon }) => {
      refs.openWalletOverlay(args.walletType);
      return true;
    },
    {
      args: {
        walletType: WalletType.argon,
      },
      timeoutMs: 15_000,
    },
  );
}
