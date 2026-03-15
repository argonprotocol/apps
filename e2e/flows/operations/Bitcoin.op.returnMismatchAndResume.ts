import { createBitcoinAddress, mineBitcoinSingleBlock } from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { clickIfVisible } from '../helpers/utils.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import bitcoinEnsureMismatchActionPanel, {
  type IEnsureMismatchActionPanelState,
} from './Bitcoin.op.ensureMismatchActionPanel.ts';
import { Operation } from './index.ts';

type IReturnMismatchAndResumeChainState = IEnsureMismatchActionPanelState['chainState'];

type IReturnMismatchAndResumeUiState = {
  returnDestinationVisible: boolean;
  returnVisible: boolean;
  returnEnabled: boolean;
  resumeVisible: boolean;
  resumeEnabled: boolean;
};

type IReturnMismatchAndResumeState = IE2EOperationInspectState<
  IReturnMismatchAndResumeChainState,
  IReturnMismatchAndResumeUiState
>;

export default new Operation<IBitcoinFlowContext, IReturnMismatchAndResumeState>(import.meta, {
  async inspect({ flow, state: flowState }) {
    const panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    const hasMismatchFundingInFlowState = flowState.mismatchAmountSatoshis != null;
    const returnInProgress = ['returningOnArgon', 'returningOnBitcoin'].includes(panelState.chainState.phase);
    const mismatchResolvedInBackend =
      panelState.chainState.hasActiveLock && panelState.chainState.phase === 'none' && !panelState.returnPanelVisible;
    const isComplete = hasMismatchFundingInFlowState && mismatchResolvedInBackend;
    const canRun =
      !isComplete &&
      !panelState.actionErrorText &&
      panelState.chainState.hasActiveLock &&
      (panelState.returnPanelVisible || panelState.resumeVisible || returnInProgress);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) {
      operationState = 'complete';
    } else if (panelState.state === 'uiStateMismatch') {
      operationState = 'uiStateMismatch';
    } else if (panelState.actionErrorText) {
      operationState = 'uiStateMismatch';
    } else if (canRun) {
      operationState = 'runnable';
    }

    const blockers: string[] = [];
    if (!isComplete && panelState.actionErrorText)
      blockers.push(`Mismatch action error: ${panelState.actionErrorText}`);
    if (!isComplete && !panelState.chainState.hasActiveLock) {
      blockers.push('No active lock found for current vault.');
    }
    if (!isComplete && !returnInProgress && panelState.chainState.phase === 'none') {
      blockers.push('Mismatch candidate not available yet.');
    }
    if (!isComplete && panelState.state === 'uiStateMismatch') {
      blockers.push(...panelState.blockers);
    }
    if (!isComplete && !returnInProgress && !panelState.returnPanelVisible && !panelState.resumeVisible) {
      blockers.push('Mismatch return controls are not visible yet.');
    }
    return {
      chainState: panelState.chainState,
      uiState: {
        returnDestinationVisible: panelState.returnDestinationVisible,
        returnVisible: panelState.returnVisible,
        returnEnabled: panelState.returnEnabled,
        resumeVisible: panelState.resumeVisible,
        resumeEnabled: panelState.resumeEnabled,
      },
      state: operationState,
      blockers: canRun ? [] : blockers,
    };
  },

  async run({ flow, flowName }, state) {
    if (state.state === 'complete') return;

    const minerAddress = createBitcoinAddress();
    let panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    if (!panelState.resumeReady) {
      if (!panelState.mismatchPanelVisible) {
        await flow.run(bitcoinEnsureMismatchActionPanel);
        panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
      }
      if (panelState.returnPanelVisible) {
        await flow.waitFor('LockFundingMismatch.returnDestination', { timeoutMs: 5_000 });
      }
      panelState = await flow.inspect(bitcoinEnsureMismatchActionPanel);
      if (!panelState.resumeReady) {
        const returnDestination = createBitcoinAddress();
        if (!panelState.returnPanelVisible) {
          await flow.poll(
            bitcoinEnsureMismatchActionPanel,
            async latest => {
              if (latest.actionErrorText) {
                throw new Error(`${flowName}: ${latest.actionErrorText}`);
              }
              if (latest.returnPanelVisible || latest.resumeReady) {
                if (latest.returnPanelVisible) {
                  await flow.waitFor('LockFundingMismatch.returnDestination', { timeoutMs: 5_000 });
                }
                return true;
              }
              await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
              mineBitcoinSingleBlock(minerAddress);
              return false;
            },
            {
              pollMs: 1_000,
              timeoutMs: 180_000,
              timeoutMessage: `${flowName}: mismatch return panel did not appear in time.`,
            },
          );
        }

        await flow.type('LockFundingMismatch.returnDestination', returnDestination, { clear: true });

        await flow.poll(
          bitcoinEnsureMismatchActionPanel,
          async latest => {
            if (latest.actionErrorText) {
              throw new Error(`${flowName}: ${latest.actionErrorText}`);
            }
            if (latest.resumeReady || latest.returnEnabled) {
              return true;
            }
            if (!latest.returnPanelVisible) {
              await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
            }
            mineBitcoinSingleBlock(minerAddress);
            return false;
          },
          {
            pollMs: 1_000,
            timeoutMs: 180_000,
            timeoutMessage: `${flowName}: mismatch return action did not become enabled in time.`,
          },
        );

        const latest = await flow.inspect(bitcoinEnsureMismatchActionPanel);
        if (!latest.resumeReady && latest.returnEnabled) {
          await flow.click('LockFundingMismatch.returnMismatch()', { timeoutMs: 60_000 });
          await flow.waitFor('LockFundingMismatch', { timeoutMs: 5_000 });
        }
      }
    }

    await flow.poll(
      bitcoinEnsureMismatchActionPanel,
      async latest => {
        if (latest.actionErrorText) {
          throw new Error(`${flowName}: ${latest.actionErrorText}`);
        }
        if (latest.resumeReady) {
          if (!latest.resumeVisible) {
            await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
            await flow.waitFor('LockFundingMismatch.resumeFunding()', { timeoutMs: 5_000 });
          }
          return true;
        }
        if (['returningOnArgon', 'returningOnBitcoin', 'returned'].includes(latest.chainState.phase)) {
          if (!latest.mismatchPanelVisible) {
            await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
            await flow.waitFor('LockFundingMismatch', { timeoutMs: 5_000 });
          }
        }
        mineBitcoinSingleBlock(minerAddress);
        return false;
      },
      {
        pollMs: 1_000,
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: mismatch return did not reach resume-ready state in time.`,
      },
    );

    const latest = await flow.inspect(bitcoinEnsureMismatchActionPanel);
    if (!latest.resumeVisible) {
      await clickIfVisible(flow, 'PersonalBitcoin.showLockingOverlay()');
      await flow.waitFor('LockFundingMismatch.resumeFunding()', { timeoutMs: 5_000 });
    }
    await flow.click('LockFundingMismatch.resumeFunding()', { timeoutMs: 60_000 });
    await flow.poll(
      bitcoinEnsureMismatchActionPanel,
      latest => {
        if (latest.actionErrorText) {
          throw new Error(`${flowName}: ${latest.actionErrorText}`);
        }
        return latest.chainState.hasActiveLock && latest.chainState.phase === 'none' && !latest.returnPanelVisible;
      },
      {
        pollMs: 1_000,
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: mismatch return did not resolve after resume.`,
      },
    );
  },
});
