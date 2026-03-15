import {
  createBitcoinAddress,
  mineBitcoinSingleBlock,
  sendBitcoinToAddress,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import type { IBitcoinVaultMismatchState } from '../types/srcVue.ts';
import { Operation } from './index.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';

type IFundLockExactChainState = IBitcoinVaultMismatchState;

type IFundLockExactUiState = {
  lockState?: string;
  lockingOverlayState: string | null;
  fundingEntryVisible: boolean;
};

type IFundLockExactState = IE2EOperationInspectState<IFundLockExactChainState, IFundLockExactUiState>;

export default createBitcoinFundLockExactOperation();

function createBitcoinFundLockExactOperation(): Operation<IBitcoinFlowContext, IFundLockExactState> {
  const operation = new Operation<IBitcoinFlowContext, IFundLockExactState>(import.meta, {
    async inspect({ flow }) {
      const [panelState, personal, lockOverlay, lockingEntry, fundingBip21] = await Promise.all([
        flow.inspect(bitcoinEnsureMismatchActionPanel),
        flow.isVisible('PersonalBitcoin'),
        flow.isVisible('BitcoinLockingOverlay'),
        flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
        flow.isVisible('fundingBip21.copyContent()'),
      ]);
      const lockState = personal.exists
        ? await flow.getAttribute('PersonalBitcoin', 'data-lock-state', { timeoutMs: 1_000 }).catch(() => null)
        : null;
      const lockingOverlayState = lockOverlay.visible
        ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
        : null;
      const lockStatus = panelState.chainState.lockStatus ?? lockState?.trim();
      const inFundingState = panelState.chainState.isPendingFunding;
      const fundingReadyToResume = panelState.chainState.isFundingReadyToResume;
      const fundingEntryVisible =
        fundingBip21.visible ||
        lockingEntry.visible ||
        (lockOverlay.visible && lockingOverlayState === 'ReadyForBitcoin');
      const processingOnBitcoinVisible = lockingOverlayState === 'ProcessingOnBitcoin';
      const isComplete = panelState.chainState.isPostFundingLock || processingOnBitcoinVisible;
      const canRun =
        !isComplete &&
        panelState.chainState.phase === 'none' &&
        ((inFundingState && fundingEntryVisible) || fundingReadyToResume);
      let operationState: IE2EOperationState = 'processing';
      if (isComplete) {
        operationState = 'complete';
      } else if (canRun) {
        operationState = 'runnable';
      }

      const blockers: string[] = [];
      if (!isComplete && !panelState.chainState.hasActiveLock) {
        blockers.push('No active lock found for current vault.');
      }
      if (!isComplete && !inFundingState && !fundingReadyToResume) {
        blockers.push('Lock is not ready for bitcoin funding.');
      }
      if (!isComplete && panelState.chainState.phase !== 'none') {
        blockers.push('Mismatch flow is active; exact funding should not be resent.');
      }
      if (!isComplete && inFundingState && !fundingEntryVisible && !processingOnBitcoinVisible) {
        blockers.push('Lock funding UI entry point is not visible.');
      }
      return {
        chainState: panelState.chainState,
        uiState: {
          lockState: lockStatus,
          lockingOverlayState,
          fundingEntryVisible,
        },
        state: operationState,
        phase: lockOverlay.visible && lockingOverlayState ? `locking:${lockingOverlayState}` : undefined,
        blockers: canRun ? [] : blockers,
      };
    },
    async run({ flow, flowName, state: flowState }) {
      const state = await flow.inspect<IFundLockExactState>();
      if (state.state !== 'runnable') {
        return;
      }

      if (!flowState.lockFundingDetails) {
        throw new Error(`${flowName}: lock funding details are missing. Read them before funding the lock.`);
      }

      const txid = sendBitcoinToAddress(
        flowState.lockFundingDetails.address,
        flowState.lockFundingDetails.amountSatoshis,
      );
      const minerAddress = createBitcoinAddress();
      await waitForBitcoinTransactionOutputSatoshis({
        flowName,
        txid,
        address: flowState.lockFundingDetails.address,
        minimumSatoshis: flowState.lockFundingDetails.amountSatoshis,
        minerAddress,
      });
      await flow.poll<IFundLockExactState>(
        latest => {
          if (latest.state === 'uiStateMismatch') {
            const blockerMessage = latest.blockers.join(', ') || 'backend/ui state mismatch';
            throw new Error(`${flowName}: ${blockerMessage}`);
          }
          if (latest.state === 'complete') {
            return true;
          }
          mineBitcoinSingleBlock(minerAddress);
          return false;
        },
        {
          pollMs: 1_000,
          timeoutMs: 180_000,
          timeoutMessage: `${flowName}: exact funding did not advance beyond the funding entry state.`,
        },
      );
    },
  });

  return operation;
}
