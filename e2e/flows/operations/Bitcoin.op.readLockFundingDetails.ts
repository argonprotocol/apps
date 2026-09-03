import { readBitcoinLockState, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { readClipboardWithRetries } from '../helpers/readClipboardWithRetries.ts';
import { pollEvery } from '../helpers/utils.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import type { IBitcoinUnlockReleaseState } from '../types/srcVue.ts';
import bitcoinActivateWallet from './Bitcoin.op.activateWallet.ts';
import { Operation } from './index.ts';

type IReadLockFundingDetailsState = IE2EOperationInspectState<
  IBitcoinUnlockReleaseState & { hasLockFundingDetails: boolean },
  { channelState: string | null }
>;

export default new Operation<IBitcoinFlowContext, IReadLockFundingDetailsState>(import.meta, {
  async inspect({ flow, state }) {
    const channel = await flow.isVisible('ConnectorChannel');
    const channelState = channel.visible
      ? await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const chainState = await readBitcoinLockState(flow);
    const hasLockFundingDetails = !!state.lockFundingDetails;
    const canRun = !hasLockFundingDetails && chainState.isPendingFunding;

    return {
      chainState: { ...chainState, hasLockFundingDetails },
      uiState: { channelState },
      state: hasLockFundingDetails ? 'complete' : canRun ? 'runnable' : 'processing',
      phase: channelState ? `channel:${channelState}` : undefined,
      blockers: canRun || hasLockFundingDetails ? [] : ['Bitcoin channel is not awaiting funding.'],
    };
  },

  async run({ flow, flowName, state }) {
    await flow.run(bitcoinActivateWallet);
    await pollEvery(
      100,
      async () => {
        const channelState = await flow
          .getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 })
          .catch(() => null);
        if (channelState === 'Error') {
          throw new Error(`${flowName}: Bitcoin wallet entered an error state before showing funding details.`);
        }
        return channelState === 'ReadyForBitcoin';
      },
      {
        timeoutMs: 20_000,
        timeoutMessage: `${flowName}: Bitcoin wallet did not become ready for funding.`,
      },
    );

    const displayedUuid = await flow.getAttribute('ConnectorChannel', 'data-channel-uuid', { timeoutMs: 1_000 });
    if (!displayedUuid) throw new Error(`${flowName}: Bitcoin wallet is not displaying a channel.`);
    await flow.waitFor('ConnectorChannel.fundingAddress', { timeoutMs: 20_000 });

    const visibleAddress = (await flow.getText('ConnectorChannel.fundingAddress')).trim();
    if (!visibleAddress) throw new Error(`${flowName}: Bitcoin channel funding address is missing.`);
    const copiedAddress = await readClipboardWithRetries(
      flow,
      () =>
        flow.click({
          selector: '[data-testid="ConnectorChannel"] [data-testid="ButtonCopy.copyContent()"]',
        }),
      value => value === visibleAddress,
    );

    const funding = await flow.queryApp(
      async (refs, args: { lockUuid: string }) => {
        await refs.bitcoinLocks.load();
        const lock = refs.bitcoinLocks.getLockByUuid(args.lockUuid);
        return lock
          ? {
              uuid: lock.uuid,
              amountSatoshis: lock.securitizedSatoshis.toString(),
            }
          : undefined;
      },
      { args: { lockUuid: displayedUuid }, timeoutMs: 3_000 },
    );
    if (!funding) throw new Error(`${flowName}: displayed Bitcoin channel ${displayedUuid} is unavailable.`);

    const amountSatoshis = BigInt(funding.amountSatoshis);
    state.lockFundingDetails = {
      lockUuid: funding.uuid,
      address: copiedAddress,
      amountSatoshis,
    };
  },
});
