import { MoveToken } from '@argonprotocol/apps-core';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { Operation } from './index.ts';
import type { IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { WalletType } from '../types/srcVue.ts';

const TRANSFER_OUT_MICROGONS = 10n * BigInt(MICROGONS_PER_ARGON);
const ETHEREUM_TRANSFER_TIMEOUT_MS = 12 * 60_000;

type ITransferOutThroughEthereumChainState = {
  availableMicrogons: bigint;
  amount: bigint;
  awaitingCollateralizationLabel: string;
  error: string;
  ethereumFeeEstimateWei?: bigint;
  hasPersistedTransfer: boolean;
  isCollateralizingOnArgon: boolean;
  isSubmitting: boolean;
  phase: string;
  remainingCollateralMicrogons?: bigint;
};

type ITransferOutThroughEthereumUiState = {
  dashboardVisible: boolean;
  walletOverlayVisible: boolean;
};

type ITransferOutThroughEthereumState = IE2EOperationInspectState<
  ITransferOutThroughEthereumChainState,
  ITransferOutThroughEthereumUiState
>;

export default new Operation<IVaultingFlowContext, ITransferOutThroughEthereumState>(import.meta, {
  async inspect({ flow }) {
    const [dashboard, walletOverlay, transferState] = await Promise.all([
      flow.isVisible('VaultingDashboard'),
      flow.isVisible('WalletOverlay'),
      readOutboundTransferState(flow),
    ]);
    const transferCompleted = flow.getData<boolean>('Vaulting.op.transferOutThroughEthereum.completed') ?? false;

    const isComplete =
      transferCompleted ||
      (transferState.phase === 'confirmedOnEthereum' &&
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
      phase: transferState.phase,
      state: operationState,
      blockers: isComplete || dashboard.visible ? [] : blockers,
    };
  },

  async run({ flow, flowName }, state) {
    flow.setData('Vaulting.op.transferOutThroughEthereum.completed', false);

    if (state.chainState.error) {
      throw new Error(state.chainState.error);
    }

    if (
      state.chainState.phase !== 'confirmedOnEthereum' &&
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

      await flow.click('NavHeader.triggerSyncMode()', { timeoutMs: 15_000 });
      try {
        await flow.waitFor(`ArgonTop.startMoveToEthereum(${MoveToken.ARGN})`, { timeoutMs: 10_000 });
      } catch {
        await flow.click('WalletOverlay.toggleSyncDirection()', { timeoutMs: 15_000 });
        await flow.waitFor(`ArgonTop.startMoveToEthereum(${MoveToken.ARGN})`, { timeoutMs: 30_000 });
      }
      await flow.click(`ArgonTop.startMoveToEthereum(${MoveToken.ARGN})`, { timeoutMs: 30_000 });
      await flow.waitFor('WalletTransferOverlay.submitTransfer()', { timeoutMs: 30_000 });
      await flow.type({ selector: '[data-testid="WalletTransferOverlay.amount"] [data-testid="input-number"]' }, '10', {
        clear: true,
        timeoutMs: 15_000,
      });
      await flow.click('WalletTransferOverlay.submitTransfer()', { timeoutMs: 30_000 });
    }

    await flow.poll(
      this,
      nextState => {
        if (nextState.chainState.error) {
          throw new Error(nextState.chainState.error);
        }

        return (
          nextState.chainState.phase === 'confirmedOnEthereum' &&
          !nextState.chainState.isSubmitting &&
          !nextState.chainState.hasPersistedTransfer
        );
      },
      {
        timeoutMs: ETHEREUM_TRANSFER_TIMEOUT_MS,
        timeoutMessage: `${flowName}: Argon-to-Ethereum transfer did not settle in time.`,
      },
    );

    if ((await flow.isVisible('WalletTransferOverlay.close()')).clickable) {
      await flow.click('WalletTransferOverlay.close()', { timeoutMs: 15_000 });
    }

    const overlayCloseButton = await flow.isVisible('OverlayBase.clickClose()');
    if (overlayCloseButton.clickable) {
      await flow.click('OverlayBase.clickClose()', { timeoutMs: 8_000 });
    }

    flow.setData('Vaulting.op.transferOutThroughEthereum.completed', true);
  },
});

async function readOutboundTransferState(flow: IVaultingFlowContext['flow']) {
  const state = (await flow.queryApp(
    async (refs, args: { moveToken: MoveToken }) => {
      await refs.wallets.load().catch(() => undefined);

      const tracker = refs.getEthereumOutboundTransferTracker();
      await tracker.load();
      const transferState = tracker.getTransferStateForToken(args.moveToken);

      return {
        availableMicrogons: refs.wallets.vaultingWallet.availableMicrogons.toString(),
        amount: transferState.amount?.toString() ?? '0',
        awaitingCollateralizationLabel: transferState.awaitingCollateralizationLabel ?? '',
        error: transferState.error,
        ethereumFeeEstimateWei: transferState.ethereumFeeEstimateWei?.toString(),
        hasPersistedTransfer: transferState.hasPersistedTransfer,
        isCollateralizingOnArgon: transferState.isCollateralizingOnArgon,
        isSubmitting: transferState.isSubmitting,
        phase: transferState.phase,
        remainingCollateralMicrogons: transferState.remainingCollateralMicrogons?.toString(),
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
        awaitingCollateralizationLabel: string;
        error: string;
        ethereumFeeEstimateWei?: string;
        hasPersistedTransfer: boolean;
        isCollateralizingOnArgon: boolean;
        isSubmitting: boolean;
        phase: string;
        remainingCollateralMicrogons?: string;
      }
    | undefined;

  return {
    availableMicrogons: state ? BigInt(state.availableMicrogons) : 0n,
    amount: state ? BigInt(state.amount) : 0n,
    awaitingCollateralizationLabel: state?.awaitingCollateralizationLabel ?? '',
    error: state?.error ?? '',
    ethereumFeeEstimateWei: state?.ethereumFeeEstimateWei ? BigInt(state.ethereumFeeEstimateWei) : undefined,
    hasPersistedTransfer: state?.hasPersistedTransfer ?? false,
    isCollateralizingOnArgon: state?.isCollateralizingOnArgon ?? false,
    isSubmitting: state?.isSubmitting ?? false,
    phase: state?.phase ?? 'idle',
    remainingCollateralMicrogons: state?.remainingCollateralMicrogons
      ? BigInt(state.remainingCollateralMicrogons)
      : undefined,
  };
}

async function openVaultingWalletOverlay(flow: IVaultingFlowContext['flow']) {
  await flow.queryApp(
    (refs, args: { walletType: WalletType.vaulting }) => {
      refs.openWalletOverlay(args.walletType);
      return true;
    },
    {
      args: {
        walletType: WalletType.vaulting,
      },
      timeoutMs: 15_000,
    },
  );
}
