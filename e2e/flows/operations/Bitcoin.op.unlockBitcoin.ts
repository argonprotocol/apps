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
import { WalletType } from '../types/srcVue.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import { Operation } from './index.ts';

type IUnlockBitcoinState = IE2EOperationInspectState<IBitcoinFlowLockState, { walletSendVisible: boolean }>;

export default new Operation<IBitcoinFlowContext, IUnlockBitcoinState>(import.meta, {
  async inspect({ flow, state }) {
    const [chainState, walletSend] = await Promise.all([
      readBitcoinLockState(flow, state.lockFundingDetails?.lockUuid),
      flow.isVisible('WalletViewSend.destination'),
    ]);
    const isComplete = chainState.isReleaseComplete && !chainState.isSelectedLockActive;
    const canRun = !isComplete && chainState.isLockReadyForUnlock;

    return {
      chainState,
      uiState: { walletSendVisible: walletSend.visible },
      state: isComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      phase: walletSend.visible ? 'wallet:send' : undefined,
      blockers: canRun || isComplete ? [] : ['Bitcoin channel is not ready to return.'],
    };
  },

  async run({ flow, flowName, state }) {
    const funding = state.lockFundingDetails;
    if (!funding) throw new Error(`${flowName}: Bitcoin channel funding details are missing.`);

    await flow.run(appPrepareAccess);
    await flow.queryApp((refs, args: { walletType: WalletType.argon }) => refs.openWalletOverlay(args.walletType), {
      args: { walletType: WalletType.argon },
      timeoutMs: 10_000,
    });
    await flow.waitFor('WalletOverlay', { timeoutMs: 10_000 });
    await flow.click('WalletViewMain.openSend()', { timeoutMs: 10_000 });
    await flow.waitFor('WalletViewSend.destination', { timeoutMs: 10_000 });
    await flow.click('WalletViewSend.token');
    await flow.click('BTC');
    const releaseAddress = createBitcoinAddress();
    await flow.type('WalletTransferForm.destinationAddress', releaseAddress, { clear: true });
    await flow.waitFor('WalletViewSend.initiateTransfer()', { state: 'enabled', timeoutMs: 20_000 });
    await flow.click('WalletViewSend.initiateTransfer()', { timeoutMs: 60_000 });

    const error = await flow.getText('WalletTransferForm.error', { timeoutMs: 300 }).catch(() => '');
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
  },
});
