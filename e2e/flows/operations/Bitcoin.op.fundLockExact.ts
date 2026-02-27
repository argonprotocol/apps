import {
  createBitcoinAddress,
  sendBitcoinToAddress,
  waitForBitcoinTransactionOutputSatoshis,
} from '../helpers/bitcoinNode.ts';
import { Operation } from './index.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { parseOptionalPositiveInteger } from '../helpers/utils.ts';
import bitcoinEnsureLockFundingDetails from './Bitcoin.op.ensureLockFundingDetails.ts';
import bitcoinUnlockBitcoin, { type IUnlockBackendReleaseState } from './Bitcoin.op.unlockBitcoin.ts';

type IFundLockExactUiState = {
  lockState: string | null;
  lockUtxoId: number | null;
  fundingEntryVisible: boolean;
};

type IFundLockExactChainState = Pick<
  IUnlockBackendReleaseState,
  'hasFundingRecord' | 'hasReleaseSignal' | 'isReleaseComplete'
>;

interface IFundLockExactState extends IE2EOperationInspectState<IFundLockExactChainState, IFundLockExactUiState> {
  lockState: string | null;
  lockUtxoId: number | null;
  fundingEntryVisible: boolean;
  hasFundingRecord: boolean;
  hasReleaseSignal: boolean;
  isReleaseComplete: boolean;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IBitcoinFlowContext, IFundLockExactState>(import.meta, {
  async inspect({ flow }, api) {
    const [ui, unlockState] = await Promise.all([readFundLockUiState(flow), api.inspect(bitcoinUnlockBitcoin)]);
    const chainState = unlockState.chainState;
    const { hasFundingRecord, hasReleaseSignal, isReleaseComplete } = chainState;
    const fundingEntryVisible = ui.fundingBip21Visible || ui.lockOverlayVisible || ui.lockingEntryVisible;
    const isComplete =
      hasFundingRecord ||
      hasReleaseSignal ||
      isReleaseComplete ||
      ui.lockState === 'LockedAndIsMinting' ||
      ui.lockState === 'LockedAndMinted' ||
      ui.lockState === 'Releasing' ||
      ui.lockState === 'Released';
    const inFundingState = ui.lockState === 'LockPendingFunding' && !isComplete;
    const runnable = inFundingState && fundingEntryVisible;
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !inFundingState) {
      blockers.push('Lock is not ready for bitcoin funding.');
    }
    if (!isComplete && inFundingState && !fundingEntryVisible) {
      blockers.push('Lock funding UI entry point is not visible.');
    }
    const chain = { hasFundingRecord, hasReleaseSignal, isReleaseComplete };
    const uiState = {
      lockState: ui.lockState,
      lockUtxoId: ui.lockUtxoId ?? unlockState.lockUtxoId,
      fundingEntryVisible,
    };
    return {
      chainState: chain,
      uiState,
      isRunnable,
      isComplete,
      ...uiState,
      ...chain,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flowName, state: flowState }, state, api) {
    if (state.hasFundingRecord || state.hasReleaseSignal || state.isReleaseComplete) {
      return;
    }
    if (state.lockState !== 'LockPendingFunding' || !state.fundingEntryVisible) {
      return;
    }

    if (!flowState.lockFundingDetails) {
      await api.run(bitcoinEnsureLockFundingDetails);
    }
    if (!flowState.lockFundingDetails) {
      throw new Error(`${flowName}: lock funding details are missing after ${bitcoinEnsureLockFundingDetails.name}`);
    }

    await waitForBitcoinTransactionOutputSatoshis({
      flowName,
      txid: sendBitcoinToAddress(flowState.lockFundingDetails.address, flowState.lockFundingDetails.amountSatoshis),
      address: flowState.lockFundingDetails.address,
      minimumSatoshis: flowState.lockFundingDetails.amountSatoshis,
      minerAddress: createBitcoinAddress(),
    });
  },
});

async function readFundLockUiState(flow: IE2EFlowRuntime): Promise<{
  lockState: string | null;
  lockUtxoId: number | null;
  fundingBip21Visible: boolean;
  lockOverlayVisible: boolean;
  lockingEntryVisible: boolean;
}> {
  const [personal, lockOverlay, lockingEntry, fundingBip21] = await Promise.all([
    flow.isVisible('PersonalBitcoin'),
    flow.isVisible('BitcoinLockingOverlay'),
    flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
    flow.isVisible('fundingBip21.copyContent()'),
  ]);
  return {
    lockState: personal.exists
      ? (
          await flow.getAttribute('PersonalBitcoin', 'data-lock-state', { timeoutMs: 1_000 }).catch(() => null)
        )?.trim() || null
      : null,
    lockUtxoId: personal.exists
      ? parseOptionalPositiveInteger(
          await flow.getAttribute('PersonalBitcoin', 'data-lock-utxo-id', { timeoutMs: 1_000 }).catch(() => null),
        )
      : null,
    fundingBip21Visible: fundingBip21.visible,
    lockOverlayVisible: lockOverlay.visible,
    lockingEntryVisible: lockingEntry.visible,
  };
}
