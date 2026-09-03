import { readBitcoinLockState, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import type { IBitcoinUnlockReleaseState, IBitcoinVaultUnlockStateDetails } from '../types/srcVue.ts';
import bitcoinActivateWallet from './Bitcoin.op.activateWallet.ts';
import { Operation } from './index.ts';

type IWaitUnlockReadyState = IE2EOperationInspectState<IBitcoinUnlockReleaseState, { channelState: string | null }>;

export default new Operation<IBitcoinFlowContext, IWaitUnlockReadyState>(import.meta, {
  async inspect({ flow, state }) {
    const [chainState, channel] = await Promise.all([
      readBitcoinLockState(flow, state.lockFundingDetails?.lockUuid),
      flow.isVisible('ConnectorChannel'),
    ]);
    const channelState = channel.visible
      ? await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const releaseInFlight = chainState.isReleaseStatus && !chainState.isReleaseComplete;
    const isComplete = releaseInFlight || (chainState.isLockReadyForUnlock && channelState === 'Funded');
    const canRun = !isComplete && chainState.hasActiveLock;

    return {
      chainState,
      uiState: { channelState },
      state: isComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      phase: channelState ? `channel:${channelState}` : undefined,
      blockers: canRun || isComplete ? [] : ['NO_ACTIVE_LOCK'],
    };
  },

  async run({ flow, flowName, state }) {
    const lockUuid = state.lockFundingDetails?.lockUuid;
    if (!lockUuid) throw new Error(`${flowName}: active Bitcoin channel is unavailable.`);

    await flow.run(bitcoinActivateWallet);
    const channelState = await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 5_000 });
    if (channelState === 'Overview') {
      await flow.click({ selector: `[data-channel-uuid="${lockUuid}"]` });
    }

    await flow.poll<IWaitUnlockReadyState>(latest => latest.state === 'complete', {
      pollMs: 1_000,
      timeoutMs: 240_000,
      timeoutMessage: `${flowName}: Bitcoin channel did not become ready for return in time.`,
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
