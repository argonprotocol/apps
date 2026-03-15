import { createBitcoinAddress, mineBitcoinSingleBlock } from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import type {
  IBitcoinLocksUnlockDetailsInspect,
  IBitcoinUnlockReleaseState,
  IBitcoinVaultUnlockStateDetails,
  IMyVaultInspect,
} from '../types/srcVue.ts';
import { pollEvery } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import { readUnlockBackendReleaseState } from './Bitcoin.op.unlockBitcoin.ts';

type IWaitUnlockReadyUiState = {
  personalVisible: boolean;
  isLocked: boolean | null;
  lockingOverlayState?: string | null;
};

type IWaitUnlockReadyState = IE2EOperationInspectState<IBitcoinUnlockReleaseState, IWaitUnlockReadyUiState>;

export default new Operation<IBitcoinFlowContext, IWaitUnlockReadyState>(import.meta, {
  async inspect({ flow, flowName }) {
    const [ui, chainState, lockingOverlay] = await Promise.all([
      readWaitUnlockUiState(flow),
      readUnlockBackendReleaseState(flow, flowName),
      flow.isVisible('BitcoinLockingOverlay'),
    ]);
    const lockingOverlayState = lockingOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const releaseAlreadyInFlight = chainState.isReleaseStatus && !chainState.isReleaseComplete;
    const unlockEntryVisible = ui.personalVisible && (ui.isLocked === true || chainState.isLockReadyForUnlock);
    const isComplete = unlockEntryVisible || releaseAlreadyInFlight;
    const canRun = !isComplete && (chainState.hasActiveLock || lockingOverlay.visible || ui.personalVisible);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !chainState.hasActiveLock && !ui.personalVisible) blockers.push('NO_ACTIVE_LOCK');
    return {
      chainState,
      uiState: {
        personalVisible: ui.personalVisible,
        isLocked: ui.isLocked,
        lockingOverlayState,
      },
      state: operationState,
      phase:
        lockingOverlay.visible && lockingOverlayState
          ? `locking:${lockingOverlayState}`
          : ui.isLocked === true
            ? 'dashboard:locked'
            : ui.isLocked === false
              ? 'dashboard:unlocked'
              : undefined,
      blockers: canRun ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state) {
    if (state.state === 'complete') {
      return;
    }

    const minerAddress = createBitcoinAddress();
    await pollEvery(
      1_000,
      async () => {
        const activeTab = await flow.isVisible('VaultingScreen');
        if (!activeTab.visible) {
          await flow.run(vaultingActivateTab).catch(() => undefined);
        }

        const latest = await flow.inspect<IWaitUnlockReadyState>();
        if (latest.state === 'complete') {
          return true;
        }

        if (
          latest.chainState.hasActiveLock &&
          !latest.chainState.isReleaseStatus &&
          latest.chainState.isPendingFunding
        ) {
          mineBitcoinSingleBlock(minerAddress);
        }
        return false;
      },
      {
        timeoutMs: 240_000,
        timeoutMessage: `${flowName}: lock did not become ready for unlock in time.`,
      },
    );
  },
  async diagnose({ flow, flowName }, state, error) {
    const debug = await readWaitUnlockDebugState(flow, flowName).catch(() => null);
    console.error(
      `[E2E] ${flowName}: waitUnlockReady diagnostics`,
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          inspect: state,
          debug,
        },
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      ),
    );
  },
});

async function readWaitUnlockUiState(flow: IE2EFlowRuntime): Promise<IWaitUnlockReadyUiState> {
  const personal = await flow.isVisible('PersonalBitcoin');
  const isLockedRaw = personal.exists
    ? await flow.getAttribute('PersonalBitcoin', 'data-is-locked', { timeoutMs: 1_000 }).catch(() => null)
    : null;
  let isLocked: boolean | null = null;
  if (isLockedRaw === 'true') isLocked = true;
  if (isLockedRaw === 'false') isLocked = false;
  return {
    personalVisible: personal.visible,
    isLocked,
  };
}

async function readWaitUnlockDebugState(
  flow: IE2EFlowRuntime,
  flowName: string,
): Promise<IBitcoinVaultUnlockStateDetails | null> {
  return (await flow.queryApp<IBitcoinVaultUnlockStateDetails>(WAIT_UNLOCK_DEBUG_FN, {
    timeoutMs: 20_000,
    args: { flowName },
  })) ?? null;
}

async function waitUnlockDebugInspect(refs: {
  myVault: IMyVaultInspect;
  bitcoinLocks: IBitcoinLocksUnlockDetailsInspect;
}): Promise<IBitcoinVaultUnlockStateDetails> {
  await refs.myVault.load().catch(() => undefined);
  await refs.bitcoinLocks.load().catch(() => undefined);
  const vaultId = refs.myVault.vaultId ?? null;
  if (vaultId == null) {
    return { activeLocks: [] };
  }
  return refs.bitcoinLocks.getVaultUnlockStateDetails(vaultId);
}

const WAIT_UNLOCK_DEBUG_FN = waitUnlockDebugInspect.toString();
