import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { BitcoinLockStatus } from 'src-vue/interfaces/IBitcoinLockRecord.ts';
import { readBitcoinLockState, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { formatUnitsToDecimal, pollEvery } from '../helpers/utils.ts';
import type { IE2EOperationInspectState, IE2EOperationState } from '../types.ts';
import type { IBitcoinUnlockReleaseState } from '../types/srcVue.ts';
import bitcoinActivateWallet from './Bitcoin.op.activateWallet.ts';
import { Operation } from './index.ts';

type IStartBitcoinLockUiState = {
  channelVisible: boolean;
  channelState: string | null;
};

type IStartBitcoinLockState = IE2EOperationInspectState<IBitcoinUnlockReleaseState, IStartBitcoinLockUiState>;

export default new Operation<IBitcoinFlowContext, IStartBitcoinLockState>(import.meta, {
  async inspect({ flow }) {
    const [chainState, channel] = await Promise.all([readBitcoinLockState(flow), flow.isVisible('ConnectorChannel')]);
    const channelState = channel.visible
      ? await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null)
      : null;
    const isProcessingOnArgon =
      chainState.lockStatus === BitcoinLockStatus.LockIsProcessingOnArgon || channelState === 'ProcessingOnArgon';
    const isComplete = chainState.isPendingFunding || channelState === 'ReadyForBitcoin';
    const canRun = isProcessingOnArgon || (!isComplete && !chainState.hasActiveLock);
    let operationState: IE2EOperationState = 'processing';
    if (isComplete) operationState = 'complete';
    else if (chainState.hasActiveLock && !isProcessingOnArgon) operationState = 'uiStateMismatch';
    else if (canRun) operationState = 'runnable';

    return {
      chainState,
      uiState: { channelVisible: channel.visible, channelState },
      state: operationState,
      phase: channelState ? `channel:${channelState}` : undefined,
      blockers:
        chainState.hasActiveLock && !isComplete && !isProcessingOnArgon
          ? ['Another Bitcoin channel is already active.']
          : [],
    };
  },

  async run({ flow, flowName, input }) {
    await flow.run(bitcoinActivateWallet);

    let channelState = await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 5_000 });
    if (channelState === 'Overview') {
      await flow.click('ConnectorChannel.showChannelForm()');
      channelState = await waitForChannelState(flow, 'Create');
    }
    if (channelState === 'ProcessingOnArgon') {
      await waitForChannelState(flow, 'ReadyForBitcoin', 60_000);
      return;
    }
    if (channelState === 'ReadyForBitcoin') return;
    if (channelState !== 'Create') {
      throw new Error(`${flowName}: Bitcoin wallet cannot create a channel from state ${channelState ?? 'unknown'}.`);
    }

    const calculatedMicrogons = input.minimumLockSatoshis
      ? await flow.queryApp(
          (refs, args: { satoshis: string }) =>
            refs.bitcoinLocks.argonLiquidityForSatoshis(BigInt(args.satoshis)).toString(),
          {
            args: { satoshis: input.minimumLockSatoshis.toString() },
            timeoutMs: 3_000,
          },
        )
      : undefined;
    const expectedMicrogons = input.minimumLockMicrogons ?? (calculatedMicrogons ? BigInt(calculatedMicrogons) : 0n);
    if (expectedMicrogons <= 0n) {
      throw new Error(`${flowName}: Bitcoin channel insurance amount could not be calculated.`);
    }

    await flow.type(
      { selector: '[data-testid="ConnectorChannel.insuranceAmount"] [data-testid="input-number"]' },
      formatUnitsToDecimal(expectedMicrogons, BigInt(MICROGONS_PER_ARGON), `${flowName}.minimumLockMicrogons`),
      { clear: true, timeoutMs: 3_000 },
    );
    await pollEvery(
      50,
      async () =>
        (await flow
          .getAttribute('ConnectorChannel.insuranceAmount', 'data-microgons', { timeoutMs: 1_000 })
          .catch(() => null)) === expectedMicrogons.toString(),
      {
        timeoutMs: 3_000,
        timeoutMessage: `${flowName}: Bitcoin channel insurance did not synchronize to ${expectedMicrogons}.`,
      },
    );

    await flow.waitFor('ConnectorChannel.createChannel()', { state: 'enabled', timeoutMs: 10_000 });
    await flow.click('ConnectorChannel.createChannel()');
    const error = await flow.getText('ConnectorChannel.error', { timeoutMs: 300 }).catch(() => '');
    if (error.trim()) throw new Error(`${flowName}: channel creation failed: ${error.trim()}`);

    await waitForChannelState(flow, 'ReadyForBitcoin', 60_000);
    const channelUuid = await flow.getAttribute('ConnectorChannel', 'data-channel-uuid', { timeoutMs: 1_000 });
    if (!channelUuid) throw new Error(`${flowName}: created Bitcoin channel has no wallet UUID.`);

    await pollEvery(1_000, async () => (await readBitcoinLockState(flow, channelUuid)).isPendingFunding, {
      timeoutMs: 60_000,
      timeoutMessage: `${flowName}: Bitcoin channel did not enter pending funding in time.`,
    });
  },
});

async function waitForChannelState(
  flow: IBitcoinFlowContext['flow'],
  expected: string,
  timeoutMs = 5_000,
): Promise<string> {
  let state: string | null = null;
  await pollEvery(
    50,
    async () => {
      state = await flow.getAttribute('ConnectorChannel', 'data-e2e-state', { timeoutMs: 1_000 }).catch(() => null);
      if (state === 'Error') throw new Error(`Bitcoin wallet entered an error state while waiting for ${expected}.`);
      return state === expected;
    },
    { timeoutMs, timeoutMessage: `Bitcoin wallet did not enter ${expected}.` },
  );
  return state!;
}
