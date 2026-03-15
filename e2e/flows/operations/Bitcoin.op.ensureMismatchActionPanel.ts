import type { IBitcoinLocksMismatchInspect, IBitcoinVaultMismatchState, IMyVaultInspect } from '../types/srcVue.ts';
import { runInspect } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';

const MISMATCH_INSPECT_TIMEOUT_MS = 20_000;

type IMismatchUiState = {
  personalVisible: boolean;
  lockingEntryVisible: boolean;
};

export interface IEnsureMismatchActionPanelState
  extends IE2EOperationInspectState<IBitcoinVaultMismatchState, IMismatchUiState> {
  personalVisible: boolean;
  lockingEntryVisible: boolean;
}

export default new Operation<IBitcoinFlowContext, IEnsureMismatchActionPanelState>(import.meta, {
  async inspect({ flow, flowName }) {
    const [chainStateValue, personal, lockingEntry] = await Promise.all([
      runInspect<IBitcoinVaultMismatchState>(flow, MISMATCH_BACKEND_STATE_FN, MISMATCH_INSPECT_TIMEOUT_MS, {
        flowName,
      }),
      flow.isVisible('PersonalBitcoin'),
      flow.isVisible('PersonalBitcoin.showLockingOverlay()'),
    ]);
    const chainState = {
      hasActiveLock: false,
      isPendingFunding: false,
      isFundingReadyToResume: false,
      isPostFundingLock: false,
      mismatchRequired: false,
      canActOnMismatch: false,
      hasMismatchAcceptInProgress: false,
      hasOrphanedReturnInProgress: false,
      candidateCount: 0,
      ...chainStateValue,
    };
    const personalVisible = personal.visible;
    const lockingEntryVisible = lockingEntry.visible;
    const isComplete = personalVisible || lockingEntryVisible;
    const canRun = !isComplete;

    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!personalVisible && !lockingEntryVisible) {
      blockers.push('Vaulting bitcoin dashboard entry point is not visible.');
    }

    return {
      chainState,
      uiState: {
        personalVisible,
        lockingEntryVisible,
      },
      state: operationState,
      phase: lockingEntryVisible ? 'dashboard' : undefined,
      personalVisible,
      lockingEntryVisible,
      blockers: canRun ? [] : blockers,
    };
  },

  async run({ flow }) {
    await flow.run(vaultingActivateTab);
  },
});

async function mismatchBackendStateInspect(refs: IInspectRefs): Promise<IBitcoinVaultMismatchState> {
  await refs.myVault.load().catch(() => undefined);
  await refs.bitcoinLocks.load().catch(() => undefined);

  const vaultId = refs.myVault.vaultId;
  if (vaultId == null) {
    return {
      hasActiveLock: false,
      isPendingFunding: false,
      isFundingReadyToResume: false,
      isPostFundingLock: false,
      mismatchRequired: false,
      canActOnMismatch: false,
      hasMismatchAcceptInProgress: false,
      hasOrphanedReturnInProgress: false,
      candidateCount: 0,
    };
  }

  return refs.bitcoinLocks.getVaultMismatchState(vaultId);
}

const MISMATCH_BACKEND_STATE_FN = mismatchBackendStateInspect.toString();

interface IInspectRefs {
  myVault: IMyVaultInspect;
  bitcoinLocks: IBitcoinLocksMismatchInspect;
}
