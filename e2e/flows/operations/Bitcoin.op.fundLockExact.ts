import {
  createBitcoinAddress,
  sendBitcoinToAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { readBitcoinLockState, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import type { IBitcoinUnlockReleaseState } from '../types/srcVue.ts';
import bitcoinActivateWallet from './Bitcoin.op.activateWallet.ts';
import { Operation } from './index.ts';

type IFundLockExactState = IE2EOperationInspectState<IBitcoinUnlockReleaseState, { channelState: string | null }>;

export default new Operation<IBitcoinFlowContext, IFundLockExactState>(import.meta, {
  async inspect({ flow, state }) {
    const [chainState, channel] = await Promise.all([
      readBitcoinLockState(flow, state.lockFundingDetails?.lockUuid),
      flow.isVisible('ConnectorChannel'),
    ]);
    const channelState = channel.visible
      ? await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const isComplete =
      chainState.isLockReadyForUnlock || channelState === 'ProcessingOnBitcoin' || channelState === 'Funded';
    const canRun = !isComplete && chainState.isPendingFunding && !!state.lockFundingDetails;

    return {
      chainState,
      uiState: { channelState },
      state: isComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      phase: channelState ? `channel:${channelState}` : undefined,
      blockers: canRun || isComplete ? [] : ['Bitcoin channel funding details are unavailable.'],
    };
  },

  async run({ flow, flowName, state }) {
    const funding = state.lockFundingDetails;
    if (!funding) throw new Error(`${flowName}: Bitcoin channel funding details are missing.`);

    await flow.run(bitcoinActivateWallet);
    const minerAddress = createBitcoinAddress();
    const txid = sendBitcoinToAddress(funding.address, funding.amountSatoshis);
    await waitForBitcoinTransactionOutputSatoshis({
      flowName,
      txid,
      address: funding.address,
      minimumSatoshis: funding.amountSatoshis,
      minerAddress,
    });
    await waitForBitcoinTransactionConfirmations({
      flowName,
      txid,
      minimumConfirmations: 8,
      minerAddress,
      mineMode: 'missing',
    });

    await flow.poll<IFundLockExactState>(latest => latest.state === 'complete', {
      pollMs: 1_000,
      timeoutMs: 180_000,
      timeoutMessage: `${flowName}: exact funding did not advance the Bitcoin channel.`,
    });
  },
});
