import { hydrateCrosschainTransferProgress } from '../../lib/CrosschainTransferProgress.ts';
import type { IEthereumInboundTransferState } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import type { IEthereumOutboundTransferState } from '../../lib/EthereumOutboundTransferTracker.ts';

export type IWalletCrosschainTransferState = IEthereumOutboundTransferState | IEthereumInboundTransferState;

export type ITransferProgressView = {
  progressPct: number;
  stepLabel: string;
  detail: string;
  hint?: string;
  error: string;
  remainingMintingAuthorizationMicrogons?: bigint;
};

export function isCrosschainTransferPending(transferState: IWalletCrosschainTransferState | undefined) {
  if (!transferState) {
    return false;
  }

  return transferState.isSubmitting || transferState.hasPersistedTransfer;
}

export function isCrosschainTransferComplete(transferState: IWalletCrosschainTransferState | undefined) {
  return !!transferState?.isComplete;
}

export function isCrosschainTransferVisible(transferState: IWalletCrosschainTransferState | undefined) {
  return (
    !!transferState &&
    (isCrosschainTransferPending(transferState) || transferState.needsAttention || transferState.isComplete)
  );
}

export function getCrosschainTransferProgressView(
  transferState: IWalletCrosschainTransferState | undefined,
  nowMs: number,
): ITransferProgressView {
  if (!transferState) {
    return { progressPct: 0, stepLabel: '', detail: '', error: '' };
  }

  const displayProgress = hydrateCrosschainTransferProgress(transferState.progress.steps, nowMs);
  return {
    progressPct: displayProgress.overallProgressPct,
    stepLabel: displayProgress.currentStepLabel,
    detail: displayProgress.currentStepDetail ?? '',
    hint: displayProgress.currentStepHint,
    remainingMintingAuthorizationMicrogons: displayProgress.currentStepRemainingMintingAuthorizationMicrogons,
    error: transferState.error,
  };
}
