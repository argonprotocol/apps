import {
  createBitcoinAddress,
  waitForBitcoinTransactionConfirmations,
  waitForBitcoinTransactionOutputSatoshis,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import {
  readBitcoinLockState,
  readBitcoinOrphanReturnState,
  type IBitcoinFlowContext,
} from '../contexts/bitcoinContext.ts';
import { pollEvery } from '../helpers/utils.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { WalletType } from '../types/srcVue.ts';
import bitcoinActivateWallet from './Bitcoin.op.activateWallet.ts';
import { Operation } from './index.ts';

type IClaimOrphanState = IE2EOperationInspectState<
  { orphanExists: boolean; returnTxid?: string; returnComplete: boolean },
  { orphanRecordVisible: boolean; returnViewVisible: boolean }
>;

export default new Operation<IBitcoinFlowContext, IClaimOrphanState>(import.meta, {
  async inspect({ flow, state }) {
    const [durableState, orphanRecord, returnView] = await Promise.all([
      readBitcoinOrphanReturnState(flow, state.orphanDepositTxid),
      flow.isVisible('WalletViewMain.unattachedBitcoinDeposit'),
      flow.isVisible('WalletViewUnattachedBitcoin'),
    ]);
    const canRun = !!state.lockFundingDetails && !!state.orphanDepositTxid && !durableState.returnComplete;

    return {
      chainState: durableState,
      uiState: {
        orphanRecordVisible: orphanRecord.visible,
        returnViewVisible: returnView.visible,
      },
      state: durableState.returnComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      blockers:
        canRun || durableState.returnComplete
          ? []
          : ['The completed channel or its additional Bitcoin deposit is unavailable.'],
    };
  },

  async run({ flow, flowName, state }) {
    const funding = state.lockFundingDetails;
    if (!funding) throw new Error(`${flowName}: the completed channel receive address is unavailable.`);
    if (!state.orphanDepositTxid) throw new Error(`${flowName}: the additional Bitcoin deposit is unavailable.`);

    const releasedLock = await readBitcoinLockState(flow, funding.lockUuid);
    if (!releasedLock.isReleaseComplete || releasedLock.isSelectedLockActive) {
      throw new Error(`${flowName}: the original Bitcoin channel has not completed its return.`);
    }

    await pollEvery(
      1_000,
      async () => (await readBitcoinOrphanReturnState(flow, state.orphanDepositTxid)).orphanExists,
      { timeoutMs: 180_000, timeoutMessage: `${flowName}: late deposit was not classified as an orphan.` },
    );

    await flow.run(bitcoinActivateWallet);
    await flow.queryApp((refs, args: { walletType: WalletType.argon }) => refs.openWalletOverlay(args.walletType), {
      args: { walletType: WalletType.argon },
      timeoutMs: 10_000,
    });
    await flow.waitFor('WalletViewMain.unattachedBitcoinDeposit', { timeoutMs: 20_000 });
    await flow.click('WalletViewMain.unattachedBitcoinDeposit');
    await flow.waitFor('WalletViewUnattachedBitcoin.returnDestination', { timeoutMs: 5_000 });
    const minerAddress = createBitcoinAddress();
    const returnDestination = createBitcoinAddress();
    await flow.type('WalletViewUnattachedBitcoin.returnDestination', returnDestination, { clear: true });
    await flow.waitFor('WalletViewUnattachedBitcoin.requestReturn()', { state: 'enabled', timeoutMs: 20_000 });
    await flow.click('WalletViewUnattachedBitcoin.requestReturn()', { timeoutMs: 60_000 });

    let returnTxid: string | undefined;
    await pollEvery(
      1_000,
      async () => {
        returnTxid = (await readBitcoinOrphanReturnState(flow, state.orphanDepositTxid)).returnTxid;
        return !!returnTxid;
      },
      { timeoutMs: 180_000, timeoutMessage: `${flowName}: orphan return was not broadcast.` },
    );
    await waitForBitcoinTransactionOutputSatoshis({
      flowName,
      txid: returnTxid!,
      address: returnDestination,
      minimumSatoshis: 1n,
      minerAddress,
    });
    await waitForBitcoinTransactionConfirmations({
      flowName,
      txid: returnTxid!,
      minimumConfirmations: 8,
      minerAddress,
      mineMode: 'missing',
    });
    await pollEvery(
      1_000,
      async () => (await readBitcoinOrphanReturnState(flow, state.orphanDepositTxid)).returnComplete,
      {
        timeoutMs: 180_000,
        timeoutMessage: `${flowName}: orphan return did not complete.`,
      },
    );
  },
});
