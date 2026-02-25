import { createBitcoinAddress, mineBitcoinSingleBlock } from '../helpers/bitcoinNode.ts';
import { clickIfVisible, pollEvery } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';
import { Operation } from './index.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import bitcoinUnlockBitcoin, { type IUnlockBackendReleaseState } from './Bitcoin.op.unlockBitcoin.ts';

type IWaitUnlockReadyUiState = {
  personalVisible: boolean;
  isLocked: boolean | null;
  lockUtxoId: number | null;
};

interface IWaitUnlockReadyState extends IE2EOperationInspectState<IUnlockBackendReleaseState, IWaitUnlockReadyUiState> {
  personalVisible: boolean;
  isLocked: boolean | null;
  lockUtxoId: number | null;
  runnable: boolean;
  blockers: string[];
}

export default new Operation<IBitcoinFlowContext, IWaitUnlockReadyState>(import.meta, {
  async inspect(_context, api) {
    const unlockState = await api.inspect(bitcoinUnlockBitcoin);
    const uiState = {
      personalVisible: unlockState.personalVisible,
      isLocked: unlockState.isLocked,
      lockUtxoId: unlockState.lockUtxoId,
    };
    const chainState = unlockState.chainState;
    const releaseAlreadyInFlight = chainState.hasReleaseSignal && !chainState.isReleaseComplete;
    const isComplete = uiState.isLocked === true || isLockReadyForUnlock(chainState) || releaseAlreadyInFlight;
    const isRunnable = !isComplete && (chainState.hasActiveLock || uiState.personalVisible);
    const blockers: string[] = [];
    if (isComplete) blockers.push('ALREADY_COMPLETE');
    if (!isComplete && !chainState.hasActiveLock && !uiState.personalVisible) blockers.push('NO_ACTIVE_LOCK');
    return {
      chainState,
      uiState,
      isRunnable,
      isComplete,
      ...uiState,
      runnable: isRunnable,
      blockers: isRunnable ? [] : blockers,
    };
  },
  async run({ flow, flowName }, state, api) {
    if (state.isComplete) {
      return;
    }

    const minerAddress = createBitcoinAddress();
    await pollEvery(
      4_000,
      async () => {
        await api.run(appDismissBlockingOverlays);
        if (await dismissOpenLockingOverlay(flow)) {
          return false;
        }

        const activeTab = await flow.isVisible('VaultingScreen');
        if (!activeTab.visible) {
          await api.run(vaultingActivateTab).catch(() => undefined);
        }

        const unlockState = await api.inspect(bitcoinUnlockBitcoin);
        const ui = {
          personalVisible: unlockState.personalVisible,
          isLocked: unlockState.isLocked,
        };
        const chainState = unlockState.chainState;

        if (ui.isLocked === true || isLockReadyForUnlock(chainState)) {
          return true;
        }

        if (shouldMineForUnlockReadiness(chainState)) {
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
});

async function dismissOpenLockingOverlay(flow: IE2EFlowRuntime): Promise<boolean> {
  const openDialogs = await flow.count({ selector: '[role="dialog"][data-state="open"].BitcoinLockingOverlay' });
  if (openDialogs === 0) return false;

  const closeIconSelector =
    '[role="dialog"][data-state="open"].BitcoinLockingOverlay button[class*="border-slate-400"]';
  for (let index = 0; index < openDialogs; index += 1) {
    if (await clickIfVisible(flow, { selector: closeIconSelector, index })) {
      await flow.waitFor('BitcoinLockingOverlay', { state: 'missing', timeoutMs: 10_000 }).catch(() => null);
      return true;
    }
  }
  return (await flow.count({ selector: '[role="dialog"][data-state="open"].BitcoinLockingOverlay' })) === 0;
}

function isLockReadyForUnlock(chainState: IUnlockBackendReleaseState): boolean {
  if (!chainState.hasActiveLock) return false;
  return ['LockedAndIsMinting', 'LockedAndMinted'].includes(chainState.lockStatus ?? '');
}

function shouldMineForUnlockReadiness(chainState: IUnlockBackendReleaseState): boolean {
  if (!chainState.hasActiveLock) return false;
  if (chainState.hasReleaseSignal) return false;
  return ['LockIsProcessingOnArgon', 'LockPendingFunding'].includes(chainState.lockStatus ?? '');
}
