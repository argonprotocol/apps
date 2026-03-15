import {
  createBitcoinAddress,
  mineBitcoinSingleBlock,
  sendBitcoinToAddress,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import type { IBitcoinLocksVarianceInspect, IBitcoinVaultMismatchState } from '../types/srcVue.ts';
import { Operation } from './index.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { runInspect, sleep } from '../helpers/utils.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';

const DEFAULT_MISMATCH_OFFSET_SATOSHIS = 25_000n;
const LOCK_VARIANCE_INSPECT_TIMEOUT_MS = 20_000;

type IFundLockMismatchChainState = IBitcoinVaultMismatchState & {
  lockSatoshiAllowedVariance?: string;
};

type IFundLockMismatchUiState = {
  fundingEntryVisible: boolean;
  mismatchPanelVisible: boolean;
};

interface IFundLockMismatchState
  extends IE2EOperationInspectState<IFundLockMismatchChainState, IFundLockMismatchUiState> {
  lockSatoshiAllowedVariance: bigint | null;
}

export default createBitcoinFundLockMismatchOperation();

function createBitcoinFundLockMismatchOperation(): Operation<IBitcoinFlowContext, IFundLockMismatchState> {
  const operation = new Operation<IBitcoinFlowContext, IFundLockMismatchState>(import.meta, {
    async inspect({ flow }) {
      const [ui, lockSatoshiAllowedVariance, panelState] = await Promise.all([
        readFundLockMismatchUiState(flow),
        readLockSatoshiAllowedVariance(flow),
        flow.inspect(bitcoinEnsureMismatchActionPanel),
      ]);
      const mismatchPending =
        panelState.chainState.mismatchRequired || ui.mismatchPanelVisible || panelState.returnPanelVisible;
      const isComplete = mismatchPending;
      const canRun = !isComplete && panelState.chainState.isPendingFunding && ui.fundingEntryVisible;
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
      if (!isComplete && !panelState.chainState.isPendingFunding) {
        blockers.push('Lock is not ready for bitcoin funding.');
      }
      if (!isComplete && panelState.chainState.isPendingFunding && !ui.fundingEntryVisible) {
        blockers.push('Lock funding UI entry point is not visible.');
      }
      return {
        chainState: {
          ...panelState.chainState,
          lockSatoshiAllowedVariance:
            lockSatoshiAllowedVariance == null ? undefined : lockSatoshiAllowedVariance.toString(),
        },
        uiState: {
          fundingEntryVisible: ui.fundingEntryVisible,
          mismatchPanelVisible: ui.mismatchPanelVisible,
        },
        state: operationState,
        lockSatoshiAllowedVariance,
        blockers: canRun ? [] : blockers,
      };
    },

    async run({ flow, flowName, input, state: flowState }) {
      const state = await flow.inspect<IFundLockMismatchState>();
      if (state.state !== 'runnable') return;

      if (!flowState.lockFundingDetails) {
        throw new Error(`${flowName}: lock funding details are missing. Read them before funding the mismatch.`);
      }

      const mismatchOffsetSatoshis = input.mismatchOffsetSatoshis ?? DEFAULT_MISMATCH_OFFSET_SATOSHIS;
      if (
        input.enforceOutsideAutoAccept &&
        state.lockSatoshiAllowedVariance != null &&
        mismatchOffsetSatoshis <= state.lockSatoshiAllowedVariance
      ) {
        throw new Error(
          `${flowName}: mismatchOffsetSatoshis=${mismatchOffsetSatoshis.toString()} must be greater than ` +
            `lockSatoshiAllowedVariance=${state.lockSatoshiAllowedVariance.toString()}`,
        );
      }

      const amountSatoshis = calculateMismatchedAmount(
        flowState.lockFundingDetails.amountSatoshis,
        mismatchOffsetSatoshis,
        input.mismatchDirection,
      );
      const txid = sendBitcoinToAddress(flowState.lockFundingDetails.address, amountSatoshis);
      const minerAddress = createBitcoinAddress();
      await waitForBitcoinTransactionOutputSatoshis({
        flowName,
        txid,
        address: flowState.lockFundingDetails.address,
        minimumSatoshis: amountSatoshis,
        minerAddress,
      });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const latest = await flow.inspect<IFundLockMismatchState>();
        if (latest.state === 'uiStateMismatch') {
          const blockerMessage = latest.blockers.join(', ') || 'backend/ui state mismatch';
          throw new Error(`${flowName}: ${blockerMessage}`);
        }
        if (latest.state === 'complete') {
          flowState.mismatchAmountSatoshis = amountSatoshis;
          return;
        }
        mineBitcoinSingleBlock(minerAddress);
        await sleep(1_000);
      }

      throw new Error(`${flowName}: mismatch funding did not advance into the mismatch phase.`);
    },
  });

  return operation;
}

async function readFundLockMismatchUiState(flow: IE2EFlowRuntime): Promise<{
  fundingEntryVisible: boolean;
  mismatchPanelVisible: boolean;
}> {
  const [lockingEntry, lockOverlay, fundingBip21, mismatchPanel] = await Promise.all([
    flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
    flow.isVisible('BitcoinLockingOverlay'),
    flow.isVisible('fundingBip21.copyContent()'),
    flow.isVisible('LockFundingMismatch'),
  ]);
  const lockingOverlayState = lockOverlay.visible
    ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
    : null;
  return {
    fundingEntryVisible:
      lockingEntry.visible ||
      fundingBip21.visible ||
      (lockOverlay.visible && lockingOverlayState === 'ReadyForBitcoin'),
    mismatchPanelVisible: mismatchPanel.visible || (lockOverlay.visible && lockingOverlayState === 'FundingMismatch'),
  };
}

async function readLockSatoshiAllowedVariance(flow: IE2EFlowRuntime): Promise<bigint | null> {
  const rawVariance = (
    await runInspect<{ lockSatoshiAllowedVariance: string | null }>(
      flow,
      LOCK_VARIANCE_INSPECT_FN,
      LOCK_VARIANCE_INSPECT_TIMEOUT_MS,
    )
  )?.lockSatoshiAllowedVariance;
  return rawVariance == null ? null : BigInt(rawVariance);
}

async function inspectLockVariance(refs: {
  bitcoinLocks: IBitcoinLocksVarianceInspect;
}): Promise<{ lockSatoshiAllowedVariance: string | null }> {
  await refs.bitcoinLocks.load().catch(() => undefined);
  const variance = refs.bitcoinLocks.getLockSatoshiAllowedVariance();
  return { lockSatoshiAllowedVariance: variance == null ? null : variance.toString() };
}

const LOCK_VARIANCE_INSPECT_FN = inspectLockVariance.toString();

function calculateMismatchedAmount(
  expectedAmountSatoshis: bigint,
  mismatchOffsetSatoshis: bigint,
  direction: IBitcoinFlowContext['input']['mismatchDirection'],
): bigint {
  if (direction === 'above') {
    return expectedAmountSatoshis + mismatchOffsetSatoshis;
  }
  const lowerAmount = expectedAmountSatoshis - mismatchOffsetSatoshis;
  return lowerAmount > 0n ? lowerAmount : expectedAmountSatoshis + mismatchOffsetSatoshis;
}
