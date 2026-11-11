import { hydrateCrosschainTransferProgress } from '../../lib/CrosschainTransferProgress.ts';
import type { IEthereumInboundTransferState } from '../../interfaces/IEthereumInboundTransferTracker.ts';
import type { IEthereumOutboundTransferState } from '../../lib/EthereumOutboundTransferTracker.ts';

export type IWalletCrosschainTransferState = IEthereumOutboundTransferState | IEthereumInboundTransferState;
export type ICrosschainTransferDirection = 'inbound' | 'outbound';

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

export function isCrosschainTransferActive(transferState: IWalletCrosschainTransferState | undefined) {
  return (
    isCrosschainTransferVisible(transferState) &&
    isCrosschainTransferUnresolved(transferState) &&
    !transferState?.needsAttention
  );
}

export function isCrosschainTransferUnresolved(transferState: IWalletCrosschainTransferState | undefined) {
  if (!transferState || transferState.isComplete) return false;
  return isCrosschainTransferPending(transferState) || transferState.needsAttention;
}

export function isCrosschainTransferComplete(transferState: IWalletCrosschainTransferState | undefined) {
  return !!transferState?.isComplete;
}

export function isCrosschainTransferVisible(transferState: IWalletCrosschainTransferState | undefined) {
  if (transferState && 'isFailureAcknowledged' in transferState && transferState.isFailureAcknowledged) return false;
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
