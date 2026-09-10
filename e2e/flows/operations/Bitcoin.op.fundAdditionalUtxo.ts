import {
  createBitcoinAddress,
  sendBitcoinToAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import {
  readBitcoinLockState,
  readBitcoinOrphanReturnState,
  type IBitcoinFlowContext,
} from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { Operation } from './index.ts';

const ADDITIONAL_UTXO_SATOSHIS = 25_000n;

type IFundAdditionalUtxoState = IE2EOperationInspectState<
  { lockIsReady: boolean; orphanExists: boolean },
  Record<string, never>
>;

export default new Operation<IBitcoinFlowContext, IFundAdditionalUtxoState>(import.meta, {
  async inspect({ flow, state }) {
    const [lock, orphan] = await Promise.all([
      readBitcoinLockState(flow, state.lockFundingDetails?.lockUuid),
      readBitcoinOrphanReturnState(flow, state.orphanDepositTxid),
    ]);
    const lockIsReady = lock.isLockReadyForUnlock && lock.isSelectedLockActive;
    const canRun = !!state.lockFundingDetails && lockIsReady;

    return {
      chainState: { lockIsReady, orphanExists: orphan.orphanExists },
      uiState: {},
      state: orphan.orphanExists ? 'complete' : canRun ? 'runnable' : 'processing',
      blockers: canRun || orphan.orphanExists ? [] : ['Bitcoin channel is not ready for an additional deposit.'],
    };
  },

  async run({ flow, flowName, state }) {
    const funding = state.lockFundingDetails;
    if (!funding) throw new Error(`${flowName}: Bitcoin channel funding details are missing.`);

    if (!state.orphanDepositTxid) {
      const minerAddress = createBitcoinAddress();
      state.orphanDepositTxid = sendBitcoinToAddress(funding.address, ADDITIONAL_UTXO_SATOSHIS);
      await waitForBitcoinTransactionOutputSatoshis({
        flowName,
        txid: state.orphanDepositTxid,
        address: funding.address,
        minimumSatoshis: ADDITIONAL_UTXO_SATOSHIS,
        minerAddress,
      });
      await waitForBitcoinTransactionConfirmations({
        flowName,
        txid: state.orphanDepositTxid,
        minimumConfirmations: 8,
        minerAddress,
        mineMode: 'missing',
      });
    }

    await flow.poll<IFundAdditionalUtxoState>(latest => latest.chainState.orphanExists, {
      pollMs: 1_000,
      timeoutMs: 180_000,
      timeoutMessage: `${flowName}: additional deposit was not classified as an orphan.`,
    });
  },
});
