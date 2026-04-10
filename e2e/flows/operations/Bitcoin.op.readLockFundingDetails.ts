import type { IBitcoinVaultMismatchState } from '../types/srcVue.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { readClipboardWithRetries } from '../helpers/readClipboardWithRetries.ts';
import { formatUnitsToDecimal, parseBip21, parseDecimalToUnits } from '../helpers/utils.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';
import { Operation } from './index.ts';

const SATOSHIS_PER_BTC = 100_000_000n;

type IReadLockFundingDetailsChainState = IBitcoinVaultMismatchState & {
  hasLockFundingDetails: boolean;
};

type IReadLockFundingDetailsUiState = {
  fundingBip21Visible: boolean;
  lockOverlayState: string | null;
};

type IReadLockFundingDetailsState = IE2EOperationInspectState<
  IReadLockFundingDetailsChainState,
  IReadLockFundingDetailsUiState
>;

export default new Operation<IBitcoinFlowContext, IReadLockFundingDetailsState>(import.meta, {
  async inspect({ flow, state: flowState }) {
    const hasLockFundingDetails = !!flowState.lockFundingDetails;
    const [panelState, lockOverlay, fundingBip21] = await Promise.all([
      flow.inspect(bitcoinEnsureMismatchActionPanel),
      flow.isVisible('BitcoinLockingOverlay'),
      flow.isVisible('fundingBip21.copyContent()'),
    ]);
    const lockOverlayState = lockOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const readyForBitcoinVisible = lockOverlayState === 'ReadyForBitcoin';
    const wrongLockingPhaseVisible =
      lockOverlay.visible && !!lockOverlayState && lockOverlayState !== 'ReadyForBitcoin';
    const isComplete = hasLockFundingDetails;
    const canRun = !isComplete && panelState.chainState.isPendingFunding && readyForBitcoinVisible;
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (wrongLockingPhaseVisible) {
      operationState = 'uiStateMismatch';
    } else if (panelState.chainState.isPendingFunding && !readyForBitcoinVisible) {
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
    return {
      chainState: {
        hasLockFundingDetails,
        ...panelState.chainState,
      },
      uiState: {
        fundingBip21Visible: fundingBip21.visible,
        lockOverlayState,
      },
      state: operationState,
      phase: lockOverlay.visible && lockOverlayState ? `locking:${lockOverlayState}` : undefined,
      blockers: canRun ? [] : blockers,
    };
  },

  async run({ flow, flowName, state: flowState }, state) {
    if (state.state === 'complete') return;

    if (!state.uiState.fundingBip21Visible) {
      await flow.click({ selector: '.BitcoinLockingOverlay .text-argon-600.cursor-pointer' }, { timeoutMs: 5_000 });
      await flow.waitFor('fundingBip21.copyContent()', { timeoutMs: 5_000 });
    }

    const bip21 = await readClipboardWithRetries(
      flow,
      () => flow.click('fundingBip21.copyContent()'),
      value => value.startsWith('bitcoin:'),
    );
    const { address: lockAddress, amount: lockAmount } = parseBip21(bip21);
    if (!lockAddress) {
      throw new Error(`${flowName}: missing lock address`);
    }
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
