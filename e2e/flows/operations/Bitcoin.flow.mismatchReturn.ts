import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import { createBitcoinAddress, mineBitcoinSingleBlock } from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import bitcoinEnsureMismatchActionPanel from './Bitcoin.op.ensureMismatchActionPanel.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinFundLockMismatch from './Bitcoin.op.fundLockMismatch.ts';
import bitcoinOpenLockFundingOverlay from './Bitcoin.op.openLockFundingOverlay.ts';
import bitcoinReadLockFundingDetails from './Bitcoin.op.readLockFundingDetails.ts';
import bitcoinReturnMismatchAndResume from './Bitcoin.op.returnMismatchAndResume.ts';
import bitcoinStartBitcoinLock from './Bitcoin.op.startBitcoinLock.ts';
import bitcoinUnlockBitcoin, { readUnlockBackendReleaseState } from './Bitcoin.op.unlockBitcoin.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import bitcoinLockUnlock from './Bitcoin.flow.lockUnlock.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';

type IMismatchReturnState = IE2EOperationInspectState<Record<string, never>, Record<string, never>>;

export default new OperationalFlow<IBitcoinFlowContext, IMismatchReturnState>(import.meta, {
  description: 'Fund a lock with mismatch amount, return it, resume funding, then unlock.',
  defaultTimeoutMs: 20_000,
  createContext: (flow, flowName) =>
    createBitcoinFlowContext(flow, flowName, {
      mismatchDirectionDefault: 'above',
      ensurePostFirstUnlockDefault: false,
    }),
  async inspect({ state }) {
    return {
      chainState: {},
      uiState: {},
      state: state.isCompleted ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow, flowName, input, state }) {
    const vaultingContext = createVaultingFlowContext(flow, flowName);
    await flow.run(vaultingContext, vaultingOnboarding);

    if (input.ensurePostFirstUnlock) {
      await flow.run(bitcoinLockUnlock);
      const postFirstUnlockState = await readUnlockBackendReleaseState(flow, flowName);
      if (postFirstUnlockState.hasActiveLock) {
        throw new Error(
          `${flowName}: first lock/unlock cycle left an active lock, so mismatch return cannot start a new lock.`,
        );
      }
    }

    state.lockFundingDetails = undefined;
    state.mismatchAmountSatoshis = undefined;
    await flow.run(bitcoinStartBitcoinLock);
    await flow.run(bitcoinOpenLockFundingOverlay);
    await flow.run(bitcoinReadLockFundingDetails);
    await flow.run(bitcoinFundLockMismatch);
    const minerAddress = createBitcoinAddress();
    await flow.run({ flow, flowName, input, state }, bitcoinReturnMismatchAndResume, {
      timeoutMs: 180_000,
      timeoutMessage: `${flowName}: mismatch panel did not reach return/resume state in time.`,
      onNotReadyPoll: async () => {
        const panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
        if (!panelState.mismatchPanelVisible && !panelState.returnPanelVisible && !panelState.resumeVisible) {
          await flow.run(bitcoinEnsureMismatchActionPanel, { throwIfNotReady: true });
        }
        mineBitcoinSingleBlock(minerAddress);
      },
    });
    await flow.run(bitcoinFundLockExact);
    await flow.run(bitcoinWaitUnlockReady);
    await flow.run(bitcoinUnlockBitcoin);
    state.isCompleted = true;
  },
});
