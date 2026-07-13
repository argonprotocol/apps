import { createBitcoinAddress, mineBitcoinSingleBlock } from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import type { IBitcoinUnlockReleaseState, IBitcoinVaultUnlockStateDetails } from '../types/srcVue.ts';
import { pollEvery } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import { Operation } from './index.ts';
import bitcoinActivateTab, { BITCOIN_LOCK_ENTRY_SELECTOR } from './Bitcoin.op.activateTab.ts';
import { readUnlockBackendReleaseState } from './Bitcoin.op.unlockBitcoin.ts';

type IWaitUnlockReadyUiState = {
  lockEntryVisible: boolean;
  lockingOverlayState?: string | null;
};

type IWaitUnlockReadyState = IE2EOperationInspectState<IBitcoinUnlockReleaseState, IWaitUnlockReadyUiState>;

export default new Operation<IBitcoinFlowContext, IWaitUnlockReadyState>(import.meta, {
  async inspect({ flow }) {
    const [lockEntryVisible, chainState, lockingOverlay] = await Promise.all([
      hasBitcoinLockEntry(flow),
      readUnlockBackendReleaseState(flow),
      flow.isVisible('BitcoinLockingOverlay'),
    ]);
    const lockingOverlayState = lockingOverlay.visible
      ? await flow.getAttribute('BitcoinLockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const releaseAlreadyInFlight = chainState.isReleaseStatus && !chainState.isReleaseComplete;
    const unlockEntryVisible = chainState.isLockReadyForUnlock && lockEntryVisible;
    const isComplete = unlockEntryVisible || releaseAlreadyInFlight;
    const canRun = !isComplete && (chainState.hasActiveLock || lockingOverlay.visible || lockEntryVisible);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && !chainState.hasActiveLock && !lockEntryVisible && !lockingOverlay.visible) {
      blockers.push('NO_ACTIVE_LOCK');
    }
    return {
      chainState,
      uiState: {
        lockEntryVisible,
        lockingOverlayState,
      },
      state: operationState,
      phase:
        lockingOverlay.visible && lockingOverlayState
          ? `locking:${lockingOverlayState}`
          : unlockEntryVisible
            ? 'dashboard:locked'
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
        const activeTab = await flow.isVisible('BitcoinLocksScreen');
        if (!activeTab.visible) {
          await flow.run(bitcoinActivateTab).catch(() => undefined);
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
    const debug = await readWaitUnlockDebugState(flow).catch(() => null);
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

async function readWaitUnlockDebugState(flow: IE2EFlowRuntime): Promise<IBitcoinVaultUnlockStateDetails | null> {
  return (
    (await flow.queryApp(
      async refs => {
        await refs.myVault.load().catch(() => undefined);
        await refs.bitcoinLocks.load().catch(() => undefined);
        const vaultId = refs.myVault.vaultId ?? null;
        if (vaultId == null) {
          return { activeLocks: [] };
        }
        return refs.bitcoinLocks.getVaultUnlockStateDetails(vaultId);
      },
      {
        timeoutMs: 20_000,
      },
    )) ?? null
  );
}

async function hasBitcoinLockEntry(flow: IBitcoinFlowContext['flow']): Promise<boolean> {
  return (await flow.isVisible({ selector: BITCOIN_LOCK_ENTRY_SELECTOR, index: 0 })).visible;
}
