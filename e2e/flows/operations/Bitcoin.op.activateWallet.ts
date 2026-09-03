import { WalletType } from '../types/srcVue.ts';
import type { IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import { Operation } from './index.ts';

type IActivateBitcoinWalletState = IE2EOperationInspectState<
  Record<string, never>,
  { walletMounted: boolean; channelVisible: boolean }
>;

export default new Operation<IBitcoinFlowContext, IActivateBitcoinWalletState>(import.meta, {
  async inspect({ flow }) {
    const [wallet, channel] = await Promise.all([flow.isVisible('WalletOverlay'), flow.isVisible('ConnectorChannel')]);
    const isComplete = wallet.exists && channel.visible;
    return {
      chainState: {},
      uiState: {
        walletMounted: wallet.exists,
        channelVisible: channel.visible,
      },
      state: isComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },

  async run({ flow }) {
    await flow.run(appPrepareAccess);
    await flow.queryApp((refs, args: { walletType: WalletType.bitcoin }) => refs.openWalletOverlay(args.walletType), {
      args: { walletType: WalletType.bitcoin },
      timeoutMs: 10_000,
    });
    await flow.waitFor('WalletOverlay', { state: 'exists', timeoutMs: 10_000 });
    await flow.waitFor('ConnectorChannel', { timeoutMs: 10_000 });
  },
});
