import { readBitcoinLockState, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import { WalletType, type IBitcoinUnlockReleaseState, type IBitcoinVaultUnlockStateDetails } from '../types/srcVue.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import { Operation } from './index.ts';

type IWaitUnlockReadyState = IE2EOperationInspectState<IBitcoinUnlockReleaseState, { fundedChannelVisible: boolean }>;

export default new Operation<IBitcoinFlowContext, IWaitUnlockReadyState>(import.meta, {
  async inspect({ flow, state }) {
    const lockUuid = state.lockFundingDetails?.lockUuid;
    const [chainState, fundedChannel] = await Promise.all([
      readBitcoinLockState(flow, lockUuid),
      flow.isVisible({
        selector: `[data-testid="WalletViewMain.bitcoinChannel"][data-channel-uuid="${lockUuid ?? ''}"]`,
      }),
    ]);
    const releaseInFlight = chainState.isReleaseStatus && !chainState.isReleaseComplete;
    const isComplete = releaseInFlight || fundedChannel.visible;
    const canRun = !isComplete && chainState.hasActiveLock;

    return {
      chainState,
      uiState: { fundedChannelVisible: fundedChannel.visible },
      state: isComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      phase: fundedChannel.visible ? 'wallet:funded' : undefined,
      blockers: canRun || isComplete ? [] : ['NO_ACTIVE_LOCK'],
    };
  },

  async run({ flow, flowName, state }) {
    const lockUuid = state.lockFundingDetails?.lockUuid;
    if (!lockUuid) throw new Error(`${flowName}: active Bitcoin channel is unavailable.`);

    await flow.run(appPrepareAccess);
    await flow.queryApp((refs, args: { walletType: WalletType.argon }) => refs.openWalletOverlay(args.walletType), {
      args: { walletType: WalletType.argon },
      timeoutMs: 10_000,
    });
    await flow.waitFor('WalletOverlay', { timeoutMs: 10_000 });
    await flow.waitFor('WalletViewMain.toggleBitcoinDetails()', { timeoutMs: 240_000 });
    const fundedChannel = await flow.isVisible({
      selector: `[data-testid="WalletViewMain.bitcoinChannel"][data-channel-uuid="${lockUuid}"]`,
    });
    if (!fundedChannel.visible) await flow.click('WalletViewMain.toggleBitcoinDetails()');

    await flow.poll<IWaitUnlockReadyState>(latest => latest.state === 'complete', {
      pollMs: 1_000,
      timeoutMs: 240_000,
      timeoutMessage: `${flowName}: funded Bitcoin did not appear in the wallet in time.`,
    });
  },

  async diagnose({ flow, flowName }, state, error) {
    const debug = await flow
      .queryApp(async refs => {
        await refs.myVault.load().catch(() => undefined);
        await refs.bitcoinLocks.load().catch(() => undefined);
        const vaultId = refs.myVault.vaultId;
        return vaultId == null
          ? ({ activeLocks: [] } satisfies IBitcoinVaultUnlockStateDetails)
          : refs.bitcoinLocks.getVaultUnlockStateDetails(vaultId);
      })
      .catch(() => null);
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
