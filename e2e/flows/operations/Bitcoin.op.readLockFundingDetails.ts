import type { IBitcoinVaultMismatchState } from '../types/srcVue.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { readClipboardWithRetries } from '../helpers/readClipboardWithRetries.ts';
import { formatUnitsToDecimal, parseDecimalToUnits } from '../helpers/utils.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';
import { Operation } from './index.ts';

const SATOSHIS_PER_BTC = 100_000_000n;

type IReadLockFundingDetailsChainState = IBitcoinVaultMismatchState & {
  hasLockFundingDetails: boolean;
};

type IReadLockFundingDetailsUiState = {
  fundingAddressVisible: boolean;
  fundingAmountVisible: boolean;
  lockOverlayState: string | null;
};

type IReadLockFundingDetailsState = IE2EOperationInspectState<
  IReadLockFundingDetailsChainState,
  IReadLockFundingDetailsUiState
>;

export default new Operation<IBitcoinFlowContext, IReadLockFundingDetailsState>(import.meta, {
  async inspect({ flow, state: flowState }) {
    const hasLockFundingDetails = !!flowState.lockFundingDetails;
    const [panelState, lockOverlay, fundingAddress, fundingAmount] = await Promise.all([
      flow.inspect(bitcoinEnsureMismatchActionPanel),
      flow.isVisible('BitcoinLockingOverlay'),
      flow.isVisible('LockReadyForBitcoin.address'),
      flow.isVisible('LockReadyForBitcoin.amount'),
    ]);
    const lockOverlayState = lockOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const readyForBitcoinVisible = lockOverlayState === 'ReadyForBitcoin';
    const fundingDetailsVisible = fundingAddress.visible && fundingAmount.visible;
    const wrongLockingPhaseVisible =
      lockOverlay.visible && !!lockOverlayState && lockOverlayState !== 'ReadyForBitcoin';
    const isComplete = hasLockFundingDetails;
    const canRun =
      !isComplete && panelState.chainState.isPendingFunding && readyForBitcoinVisible && fundingDetailsVisible;
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (wrongLockingPhaseVisible) {
      operationState = 'uiStateMismatch';
    } else if (panelState.chainState.isPendingFunding && !readyForBitcoinVisible) {
      operationState = 'uiStateMismatch';
    } else if (readyForBitcoinVisible && !fundingDetailsVisible) {
      operationState = 'uiStateMismatch';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !panelState.chainState.isPendingFunding) {
      blockers.push('Lock is not in pending funding.');
    }
    if (!isComplete && wrongLockingPhaseVisible) {
      blockers.push(`Funding overlay is open in the wrong state: ${lockOverlayState}.`);
    }
    if (panelState.chainState.isPendingFunding && !isComplete && !readyForBitcoinVisible) {
      blockers.push('Backend is in pending funding, but the ReadyForBitcoin funding details UI is not visible.');
    }
    if (!isComplete && !readyForBitcoinVisible) {
      blockers.push('ReadyForBitcoin funding details are not visible.');
    }
    if (!isComplete && readyForBitcoinVisible && !fundingDetailsVisible) {
      blockers.push('ReadyForBitcoin funding address or amount is not visible.');
    }
    return {
      chainState: {
        hasLockFundingDetails,
        ...panelState.chainState,
      },
      uiState: {
        fundingAddressVisible: fundingAddress.visible,
        fundingAmountVisible: fundingAmount.visible,
        lockOverlayState,
      },
      state: operationState,
      phase: lockOverlay.visible && lockOverlayState ? `locking:${lockOverlayState}` : undefined,
      blockers: canRun ? [] : blockers,
    };
  },

  async run({ flow, flowName, state: flowState }, state) {
    if (state.state === 'complete') return;

    const visibleLockAddress = (await flow.getText('LockReadyForBitcoin.address')).trim();
    if (!visibleLockAddress) {
      throw new Error(`${flowName}: missing lock address`);
    }

    const lockAddress = await readClipboardWithRetries(
      flow,
      () => flow.click('LockReadyForBitcoin.copyAddress()'),
      value => value === visibleLockAddress,
    );
    const lockAmount = (await flow.getText('LockReadyForBitcoin.amount')).trim().replaceAll(',', '');
    if (!lockAmount) {
      throw new Error(`${flowName}: missing lock amount`);
    }
    const lockAmountSatoshis = parseDecimalToUnits(lockAmount, SATOSHIS_PER_BTC, `${flowName}.lockAmount`);
    flowState.lockFundingDetails = {
      address: lockAddress,
      amountBtc: formatUnitsToDecimal(lockAmountSatoshis, SATOSHIS_PER_BTC, `${flowName}.lockAmountSatoshis`),
      amountSatoshis: lockAmountSatoshis,
    };
  },
});
