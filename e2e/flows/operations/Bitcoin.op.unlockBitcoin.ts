import {
  createBitcoinAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import {
  readBitcoinLockState,
  type IBitcoinFlowContext,
  type IBitcoinFlowLockState,
} from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import bitcoinActivateWallet from './Bitcoin.op.activateWallet.ts';
import { Operation } from './index.ts';

type IUnlockBitcoinState = IE2EOperationInspectState<
  IBitcoinFlowLockState,
  { channelState: string | null; unlockingState: string | null }
>;

export default new Operation<IBitcoinFlowContext, IUnlockBitcoinState>(import.meta, {
  async inspect({ flow, state }) {
    const [chainState, channel, unlocking] = await Promise.all([
      readBitcoinLockState(flow, state.lockFundingDetails?.lockUuid),
      flow.isVisible('ConnectorChannel'),
      flow.isVisible('BitcoinUnlockingOverlay'),
    ]);
    const channelState = channel.visible
      ? await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const unlockingState = unlocking.visible
      ? await flow.getAttribute('BitcoinUnlockingOverlay', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const isComplete = chainState.isReleaseComplete && !chainState.isSelectedLockActive;
    const canRun = !isComplete && chainState.isLockReadyForUnlock;

    return {
      chainState,
      uiState: { channelState, unlockingState },
      state: isComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      phase: unlockingState ? `unlock:${unlockingState}` : channelState ? `channel:${channelState}` : undefined,
      blockers: canRun || isComplete ? [] : ['Bitcoin channel is not ready to return.'],
    };
  },

  async run({ flow, flowName, state }) {
    const funding = state.lockFundingDetails;
    if (!funding) throw new Error(`${flowName}: Bitcoin channel funding details are missing.`);

    await flow.run(bitcoinActivateWallet);
    let channelState = await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 5_000 });
    if (channelState === 'Overview') {
      await flow.click({ selector: `[data-channel-uuid="${funding.lockUuid}"]` });
      channelState = await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 5_000 });
    }
    if (channelState !== 'Funded') {
      throw new Error(`${flowName}: Bitcoin wallet cannot return a channel from state ${channelState ?? 'unknown'}.`);
    }

    await flow.click('ConnectorChannel.beginSendBitcoin()');
    await flow.waitFor('BitcoinUnlockingOverlay', { timeoutMs: 10_000 });
    await flow.waitFor('BitcoinSend.destinationAddress', { timeoutMs: 10_000 });
    const releaseAddress = createBitcoinAddress();
    await flow.type('BitcoinSend.destinationAddress', releaseAddress, { clear: true });
    await flow.waitFor('BitcoinSend.submit()', { state: 'enabled', timeoutMs: 20_000 });
    await flow.click('BitcoinSend.submit()', { timeoutMs: 60_000 });

    const error = await flow.getText('BitcoinSend.error', { timeoutMs: 300 }).catch(() => '');
    if (error.trim()) throw new Error(`${flowName}: Bitcoin return request failed: ${error.trim()}`);
    await flow.poll<IUnlockBitcoinState>(latest => latest.chainState.isReleaseStatus, {
      pollMs: 1_000,
      timeoutMs: 60_000,
      timeoutMessage: `${flowName}: Bitcoin return request was not accepted.`,
    });

    let releaseTxid: string | undefined;
    await flow.poll<IUnlockBitcoinState>(
      latest => {
        releaseTxid = latest.chainState.releaseTxid;
        return !!releaseTxid;
      },
      {
        pollMs: 1_000,
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: Bitcoin return was not broadcast.`,
      },
    );

    const minerAddress = createBitcoinAddress();
    await waitForBitcoinTransactionOutputSatoshis({
      flowName,
      txid: releaseTxid!,
      address: releaseAddress,
      minimumSatoshis: 1n,
      minerAddress,
    });
    await waitForBitcoinTransactionConfirmations({
      flowName,
      txid: releaseTxid!,
      minimumConfirmations: 8,
      minerAddress,
      mineMode: 'missing',
    });
    await flow.poll<IUnlockBitcoinState>(latest => latest.state === 'complete', {
      pollMs: 1_000,
      timeoutMs: 180_000,
      timeoutMessage: `${flowName}: confirmed Bitcoin return did not complete the channel.`,
    });
    await flow.waitFor('BitcoinSend.done()', { timeoutMs: 20_000 });
  },
});
