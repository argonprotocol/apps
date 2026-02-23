import {
  createBitcoinAddress,
  sendBitcoinToAddress,
  waitForBitcoinTransactionOutputSatoshis,
} from '../helpers/bitcoinNode.ts';
import { Operation } from './index.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import bitcoinEnsureLockFundingDetails from './Bitcoin.op.ensureLockFundingDetails.ts';

type IFundLockExactUiState = {
  lockState: string | null;
  fundingEntryVisible: boolean;
};

interface IFundLockExactState extends IE2EOperationInspectState<Record<string, never>, IFundLockExactUiState> {
  lockState: string | null;
  fundingEntryVisible: boolean;
  runnable: boolean;
  blockers: string[];
}

const POST_FUNDING_LOCK_STATES = new Set([
  'LockIsProcessingOnBitcoin',
  'LockedAndIsMinting',
  'LockedAndMinted',
  'ReleaseIsProcessingOnArgon',
  'ReleaseIsWaitingForVault',
  'ReleaseSigned',
  'ReleaseIsProcessingOnBitcoin',
  'ReleaseComplete',
]);

export default new Operation<IBitcoinFlowContext, IFundLockExactState>(import.meta, {
  async inspect({ flow }) {
    const ui = await readFundLockUiState(flow);
    const inFundingState = ui.lockState === 'LockReadyForBitcoin';
    const fundingEntryVisible = ui.fundingBip21Visible || ui.lockOverlayVisible || ui.lockingEntryVisible;
    const runnable = inFundingState && fundingEntryVisible;
    const isComplete = ui.lockState != null && POST_FUNDING_LOCK_STATES.has(ui.lockState);
    const isRunnable = !isComplete && runnable;
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !inFundingState) {
      blockers.push('Lock is not ready for bitcoin funding.');
    }
    if (!isComplete && inFundingState && !fundingEntryVisible) {
      blockers.push('Lock funding UI entry point is not visible.');
    }
    return {
      chainState: {},
      uiState: {
        lockState: ui.lockState,
        fundingEntryVisible,
      },
      isRunnable,
      isComplete,
      lockState: ui.lockState,
      fundingEntryVisible,
      runnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flowName, state: flowState }, state, api) {
    if (state.lockState !== 'LockReadyForBitcoin' || !state.fundingEntryVisible) {
      return;
    }

    if (!flowState.lockFundingDetails) {
      await api.run(bitcoinEnsureLockFundingDetails);
    }
    if (!flowState.lockFundingDetails) {
      throw new Error(`${flowName}: lock funding details are missing after ${bitcoinEnsureLockFundingDetails.name}`);
    }

    const txid = sendBitcoinToAddress(
      flowState.lockFundingDetails.address,
      flowState.lockFundingDetails.amountSatoshis,
    );
    await waitForBitcoinTransactionOutputSatoshis({
      flowName,
      txid,
      address: flowState.lockFundingDetails.address,
      minimumSatoshis: flowState.lockFundingDetails.amountSatoshis,
      minerAddress: createBitcoinAddress(),
    });
  },
});

async function readFundLockUiState(flow: IE2EFlowRuntime): Promise<{
  lockState: string | null;
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
  const lockState = personal.exists
    ? await flow.getAttribute('PersonalBitcoin', 'data-lock-state', { timeoutMs: 1_000 }).catch(() => null)
    : null;
  return {
    lockState: lockState?.trim() || null,
    fundingBip21Visible: fundingBip21.visible,
    lockOverlayVisible: lockOverlay.visible,
    lockingEntryVisible: lockingEntry.visible,
  };
}
