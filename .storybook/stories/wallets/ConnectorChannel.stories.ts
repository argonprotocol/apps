import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';
import {
  createBitcoinUtxo,
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoRole, BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { ExtrinsicType } from '../../../src-vue/interfaces/ITransactionRecord.ts';
import type { WalletForBitcoin } from '../../../src-vue/lib/WalletForBitcoin.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import AlertBars from '../../../src-vue/navigation/AlertBars.vue';
import ConnectorChannel from '../../../src-vue/wallets/components/ConnectorChannel.vue';

let scenario: BitcoinOverlayScenario;
let open = true;
let isInteractive = false;
let showUnlockReceiver = false;
let requestedChannelUuid: string | undefined;
let observeFunding = () => undefined;

const meta = {
  title: 'Wallets/Bitcoin channel',
  component: ConnectorChannel,
  args: {
    direction: 'right',
    open: true,
    wallet: undefined as unknown as WalletForBitcoin,
  },
  render: () => ({
    components: { AlertBars, ConnectorChannel },
    setup() {
      const isOpen = Vue.ref(open);
      return { isInteractive, isOpen, requestedChannelUuid, showUnlockReceiver, wallet: useWallets().bitcoinWallet };
    },
    template: `
      <div class="flex h-screen w-screen items-start justify-center bg-slate-800 pt-48">
        <AlertBars v-if="showUnlockReceiver" />
        <ConnectorChannel
          v-model:open="isOpen"
          :channelUuid="requestedChannelUuid"
          direction="right"
          :wallet="wallet"
        >
          <button class="rounded-full border border-white/30 bg-white px-5 py-3 font-semibold text-slate-700 shadow">
            Bitcoin channel
          </button>
        </ConnectorChannel>
        <div
          v-if="!isInteractive"
          data-testid="ConnectorChannel.fixedPreviewGuard"
          class="fixed inset-0 z-[999] cursor-not-allowed"
          aria-label="Channel controls are disabled in this fixed preview"
        >
          <span class="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white shadow">
            Fixed state preview
          </span>
        </div>
      </div>
    `,
  }),
} satisfies Meta<typeof ConnectorChannel>;

export default meta;
type Story = StoryObj<typeof meta>;

function useScenario(status?: BitcoinLockStatus, hasObservedFunding = false) {
  scenario = setupBitcoinOverlayScenario();
  open = true;
  isInteractive = false;
  showUnlockReceiver = false;
  requestedChannelUuid = undefined;
  observeFunding = () => undefined;
  scenario.locks.splice(0);
  if (status) {
    scenario.lock.status = status;
    if (status === BitcoinLockStatus.LockFunded || status === BitcoinLockStatus.Releasing || hasObservedFunding) {
      scenario.replaceUtxoRecords([scenario.fundingRecord]);
    } else {
      scenario.replaceUtxoRecords([]);
    }
    scenario.locks.push(scenario.lock);
  }
  scenario.bitcoinLocks.hasObservedFundingSignal = fn(lock => !!lock.fundingUtxo);
  scenario.bitcoinLocks.isFundingWindowExpired = fn(() => false);
  scenario.bitcoinLocks.confirmAddress = fn();
  return () => scenario.cleanup();
}

function setUnderinsuredChannel(): void {
  scenario.lock.fundedSatoshis = 20_000_000n;
  scenario.fundingRecord.satoshis = scenario.lock.fundedSatoshis;
}

export const WalletOverview: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    scenario.lock.status = BitcoinLockStatus.Released;
    scenario.lock.removalBlockTime = new Date('2026-08-31T15:30:00.000Z');
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseComplete,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      releaseTxid: 'a'.repeat(64),
    });
    scenario.replaceUtxoRecords([scenario.fundingRecord]);
    scenario.locks.push(
      {
        ...scenario.lock,
        uuid: 'synthetic-channel-81',
        utxoId: 81,
        status: BitcoinLockStatus.LockFunded,
        fundedSatoshis: 90_000_000n,
        securitizedSatoshis: 90_000_000n,
        fissionedSatoshis: 48_000_000n,
        scriptDetails: {
          ...scenario.lock.scriptDetails!,
          p2wshScriptHashHex: `0020${'81'.repeat(32)}`,
        },
        utxos: [],
        fundingUtxo: undefined,
      },
      {
        ...scenario.lock,
        uuid: 'synthetic-channel-103',
        utxoId: 103,
        status: BitcoinLockStatus.LockFunded,
        fundedSatoshis: 80_000_000n,
        securitizedSatoshis: 80_000_000n,
        fissionedSatoshis: 38_000_000n,
        scriptDetails: {
          ...scenario.lock.scriptDetails!,
          p2wshScriptHashHex: `0020${'82'.repeat(32)}`,
        },
        utxos: [],
        fundingUtxo: undefined,
      },
      {
        ...scenario.lock,
        uuid: 'synthetic-channel-122',
        utxoId: 122,
        status: BitcoinLockStatus.LockFunded,
        fundedSatoshis: 40_000_000n,
        securitizedSatoshis: 30_000_000n,
        fissionedSatoshis: 40_000_000n,
        scriptDetails: {
          ...scenario.lock.scriptDetails!,
          p2wshScriptHashHex: `0020${'83'.repeat(32)}`,
        },
        utxos: [],
        fundingUtxo: undefined,
      },
      scenario.lock,
    );
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findAllByTestId('ConnectorChannel.channelCaret')).resolves.toHaveLength(3);
    const channelAddresses = await canvas.findAllByTestId('ConnectorChannel.channelAddress');
    await expect(channelAddresses).toHaveLength(3);
    expect(new Set(channelAddresses.map(address => address.textContent)).size).toBe(3);
    await expect(canvas.getByRole('heading', { name: 'Channels' })).toBeVisible();
    const archivedChannelLink = canvas.getByRole('button', { name: 'View 1 archived channel' });
    await expect(archivedChannelLink).toBeVisible();
    await expect(archivedChannelLink.parentElement).toHaveClass('border-t');
    await expect(canvas.queryByTestId('ConnectorChannel.archivedChannelCaret')).not.toBeInTheDocument();

    const [channel] = await canvas.findAllByRole('button', { name: /Cosigner:/ });

    await userEvent.click(channel);
    await expect(canvas.findByRole('button', { name: 'Back to Bitcoin channels' })).resolves.toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: 'Back to Bitcoin channels' }));
    await expect(canvas.findByRole('heading', { name: 'Channels' })).resolves.toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: 'View 1 archived channel' }));
    await expect(canvas.findByRole('heading', { name: 'Archived channels' })).resolves.toBeVisible();
    const [archivedChannel] = await canvas.findAllByRole('button', { name: /Archived Aug 31, 2026/ });
    await expect(archivedChannel).toHaveTextContent('Cosigner: Atlas Operator');

    await userEvent.click(canvas.getByRole('button', { name: 'Back to Bitcoin channels' }));
    await expect(canvas.findByRole('heading', { name: 'Channels' })).resolves.toBeVisible();
  },
};

export const FundedChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await expect(canvas.findByRole('heading', { name: 'Bitcoin with Atlas Operator' })).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Back to Bitcoin channels' })).toBeVisible();
    const channelSummary = canvas.getByTestId('ConnectorChannel.channelSummary');
    await expect(channelSummary).toHaveTextContent('0.125 BTC');
    await expect(channelSummary).toHaveTextContent(/^.*Created /);
    await expect(canvas.getByText('Expires')).toBeVisible();
    await expect(canvas.queryByText('Expired')).not.toBeInTheDocument();
    await expect(canvas.getByText('Channel address')).toBeVisible();
    await expect(canvas.getByTestId('ConnectorChannel.channelAddressDetail')).toHaveTextContent(/^bc1/);
    await expect(canvas.getByTestId('ConnectorChannel.insurance')).toHaveTextContent('Insurance');
    await expect(canvas.getByRole('button', { name: 'Update Insurance' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Send Bitcoin' })).toBeDisabled();
    await userEvent.hover(canvas.getByTestId('ConnectorChannel.sendUnavailableTrigger'));
    const [sendUnavailableExplanation] = await canvas.findAllByText(
      'This Bitcoin is backing one or more Liquids. Close them before sending it.',
    );
    await expect(sendUnavailableExplanation).toBeVisible();
    await fireEvent.mouseLeave(canvas.getByTestId('ConnectorChannel.sendUnavailableTrigger'));
    await waitFor(() => {
      expect(
        canvas.queryAllByText('This Bitcoin is backing one or more Liquids. Close them before sending it.'),
      ).toHaveLength(0);
    });
    await userEvent.hover(canvas.getByTestId('ConnectorChannel.expiration'));
    const [expirationExplanation] = await canvas.findAllByText(
      'Move this Bitcoin before the channel expires to keep it recoverable. Close any Liquids backed by it, then create a new channel or send it to another wallet.',
    );
    await expect(expirationExplanation).toBeVisible();
    await fireEvent.mouseLeave(canvas.getByTestId('ConnectorChannel.expiration'));
    await waitFor(() => {
      expect(
        canvas.queryAllByText(
          'Move this Bitcoin before the channel expires to keep it recoverable. Close any Liquids backed by it, then create a new channel or send it to another wallet.',
        ),
      ).toHaveLength(0);
    });
  },
};

export const AddInsurance: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    setUnderinsuredChannel();
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    const underInsuranceMessage = await canvas.findByText(/Only .* current market value is insured/);
    await expect(underInsuranceMessage).toBeVisible();
    await expect(underInsuranceMessage).toHaveTextContent(
      "Only ₳850.00 of this channel's ₳1,360.00 current market value is insured. If you don’t know the vault operator, full insurance is recommended.",
    );
    await expect(canvas.getByTestId('ConnectorChannel.insurance')).toContainElement(underInsuranceMessage);
    await expect(underInsuranceMessage.closest('.relative')?.querySelectorAll('.pointer-events-none')).toHaveLength(0);
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Insurance' }));
    await expect(canvas.findByTestId('ConnectorChannel.addInsuranceAmount')).resolves.toBeVisible();
    await expect(canvas.findByText(/BTC at the current market price/)).resolves.toBeVisible();
    await expect(canvas.findByText('One-time insurance fee')).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Update Insurance' })).toBeDisabled();

    await userEvent.click(canvas.getByRole('button', { name: 'Back to Bitcoin channel' }));
    await expect(canvas.findByRole('button', { name: 'Send Bitcoin' })).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Back to Bitcoin channels' })).toBeVisible();
  },
};

export const AddInsuranceWithoutCosignerCapacity: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    setUnderinsuredChannel();
    scenario.vault.securitization = 0n;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Insurance' }));
    await expect(
      canvas.findByText('Atlas Operator does not currently have capacity for more insurance.'),
    ).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Update Insurance' })).toBeDisabled();
  },
};

export const AddInsuranceAfterBitcoinPriceIncrease: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    scenario.lock.microgonsAtTargetPerBtc = 3_400_000_000n;
    scenario.lock.securitizationCoverageMicrogons = 425_000_000n;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await expect(canvas.queryByText(/This channel currently guarantees/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Update Insurance' }));
    await expect(canvas.findByText(/₳850.00 maximum/)).resolves.toBeVisible();
    await expect(canvas.findByText(/0.0625 BTC at the current market price/)).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Update Insurance' })).toBeDisabled();
  },
};

export const AddingInsurance: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    setUnderinsuredChannel();
    const submission = scenario.defer();
    scenario.bitcoinLockResecuritize.submit = fn(async () => {
      await submission.promise;
      throw new Error('Story cleanup ended the pending insurance request.');
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Insurance' }));
    const amount = await canvas.findByTestId('input-number');
    await userEvent.click(amount);
    await userEvent.keyboard('{Control>}a{/Control}1000');
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Insurance' }));
    await expect(canvas.findByRole('button', { name: 'Updating Insurance...' })).resolves.toBeDisabled();
    await expect(canvas.getByText('You can close this window without stopping the transaction.')).toBeVisible();
  },
};

export const AddingInsuranceAfterReturning: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    setUnderinsuredChannel();
    scenario.pendingResecuritization.value = scenario.createTransactionInfo({
      extrinsicType: ExtrinsicType.BitcoinResecuritize,
      metadata: {
        bitcoin: {
          utxoId: scenario.lock.utxoId!,
          vaultId: scenario.lock.vaultId,
          securitizedSatoshis: scenario.lock.fundedSatoshis,
          microgonsAtTargetPerBtc: 6_800_000_000n,
          securityFee: 4_500_000n,
        },
      },
      progress: { progressPct: 45, confirmations: 1, expectedConfirmations: 4 },
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await expect(canvas.findByRole('button', { name: 'Updating Insurance...' })).resolves.toBeDisabled();
    await expect(canvas.getByText('You can close this window without stopping the transaction.')).toBeVisible();
  },
};

export const AddInsuranceError: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    setUnderinsuredChannel();
    scenario.bitcoinLockResecuritize.submit = fn(async () => {
      throw new Error('Synthetic insurance transaction failure.');
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Insurance' }));
    const amount = await canvas.findByTestId('input-number');
    await userEvent.click(amount);
    await userEvent.keyboard('{Control>}a{/Control}1000');
    await userEvent.click(await canvas.findByRole('button', { name: 'Update Insurance' }));
    await expect(canvas.findByText('Synthetic insurance transaction failure.')).resolves.toBeVisible();
  },
};

export const SendBitcoin: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    scenario.lock.fissionedSatoshis = 0n;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Send Bitcoin' }));
    await expect(canvas.findByRole('heading', { name: 'Send Bitcoin' })).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Back to Bitcoin channel' })).toBeVisible();
    await expect(canvas.getByTestId('BitcoinSend.destinationAddress')).toBeVisible();
  },
};

export const SendBitcoinWithoutTransactionFee: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    scenario.lock.fissionedSatoshis = 0n;
    scenario.bitcoinLockRelease.prepare = fn(async () => ({
      canAfford: false,
      availableBalance: 0n,
      txFeePlusTip: 125_000n,
    }));
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Send Bitcoin' }));
    await userEvent.type(
      canvas.getByTestId('BitcoinSend.destinationAddress'),
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    );
    await expect(canvas.findByText(/cover the Argon transaction fee/)).resolves.toBeVisible();
    await expect(canvas.getByTestId('BitcoinSend.submit()')).toBeDisabled();
  },
};

export const SendingBitcoinOnArgon: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Releasing);
    isInteractive = true;
    scenario.lock.fissionedSatoshis = 0n;
    Object.assign(scenario.myVault, {
      getBitcoinReleaseRequestTxInfo: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: { utxoId: scenario.lock.utxoId! },
        }),
      ),
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await expect(canvas.findByRole('heading', { name: 'Send Bitcoin' })).resolves.toBeVisible();
    await expect(canvas.findByText(/This process requires several steps/)).resolves.toBeVisible();
    await expect(canvas.findByText(/Argon Block/)).resolves.toBeVisible();
  },
};

export const WaitingForCosigner: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Releasing);
    isInteractive = true;
    scenario.lock.fissionedSatoshis = 0n;
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
    });
    scenario.releaseVaultWaitProgress.value = 42;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await expect(canvas.findByRole('heading', { name: 'Send Bitcoin' })).resolves.toBeVisible();
    await expect(canvas.findByText(/This process requires several steps/)).resolves.toBeVisible();
    await expect(canvas.findByText('Waiting for Atlas Operator to sign')).resolves.toBeVisible();
    const channelWidth = canvas.getByTestId('ConnectorChannel').getBoundingClientRect().width;
    const progressWidth = canvas.getByTestId('ProgressBar').getBoundingClientRect().width;
    expect(progressWidth / channelWidth).toBeGreaterThan(0.85);
  },
};

export const WaitingForBitcoinConfirmations: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Releasing);
    isInteractive = true;
    scenario.lock.fissionedSatoshis = 0n;
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnBitcoin,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 250_020,
      releaseTxid: 'synthetic-release-transaction',
    });
    scenario.releaseProcessing.progressPct = 50;
    scenario.releaseProcessing.confirmations = 3;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await expect(canvas.findByRole('heading', { name: 'Send Bitcoin' })).resolves.toBeVisible();
    await expect(canvas.findByText(/This process requires several steps/)).resolves.toBeVisible();
    await expect(canvas.findByText(/Bitcoin Block/)).resolves.toBeVisible();
  },
};

export const BitcoinSentWhileOpen: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockFunded);
    isInteractive = true;
    scenario.lock.fissionedSatoshis = 0n;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: /Cosigner:/ }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Send Bitcoin' }));
    scenario.lock.status = BitcoinLockStatus.Released;
    scenario.replaceUtxoRecords([
      {
        ...scenario.fundingRecord,
        status: BitcoinUtxoStatus.ReleaseComplete,
        releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
        releaseBitcoinNetworkFee: 18_000n,
        releaseTxid: 'synthetic-complete-release',
      },
    ]);
    await Vue.nextTick();

    await expect(canvas.getByTestId('ConnectorChannel')).toHaveAttribute('data-e2e-state', 'Sent');
    await expect(canvas.findByText('Bitcoin sent')).resolves.toBeVisible();
    await expect(canvas.findByText(/^bc1/)).resolves.toBeVisible();
    await expect(canvas.getByRole('link', { name: 'View Bitcoin transaction' })).toHaveAttribute(
      'href',
      expect.stringContaining('synthetic-complete-release'),
    );
    await expect(canvas.getByTestId('BitcoinSend.done()')).toBeVisible();
  },
};

export const OrphanAfterLastChannelClosed: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Released);
    isInteractive = true;
    scenario.replaceUtxoRecords([
      scenario.fundingRecord,
      createBitcoinUtxo({
        id: 202,
        lockUtxoId: scenario.lock.utxoId!,
        role: BitcoinUtxoRole.Orphan,
        status: BitcoinUtxoStatus.Orphaned,
      }),
    ]);
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('1 unattached Bitcoin deposit')).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /Review/ }));
    const backButton = await canvas.findByTestId('BitcoinOrphanRecoveryOverlay.back');
    await waitFor(() => expect(backButton).toBeVisible());

    await userEvent.click(backButton);
    await expect(canvas.findByText('1 unattached Bitcoin deposit')).resolves.toBeVisible();
    await expect(canvas.queryByTestId('ConnectorChannel.insuranceAmount')).not.toBeInTheDocument();
  },
};

export const ArchivedChannel: Story = {
  name: 'Archived channels',
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.Released);
    isInteractive = true;
    scenario.lock.removalBlockTime = new Date('2026-08-31T15:30:00.000Z');
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseComplete,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      releaseTxid: 'a'.repeat(64),
    });
    scenario.replaceUtxoRecords([scenario.fundingRecord]);
    scenario.locks.unshift({
      ...scenario.lock,
      uuid: 'synthetic-older-archived-channel',
      utxoId: 84,
      scriptDetails: {
        ...scenario.lock.scriptDetails!,
        p2wshScriptHashHex: `0020${'84'.repeat(32)}`,
      },
      removalBlockTime: new Date('2026-08-30T15:30:00.000Z'),
      updatedAt: new Date('2026-08-30T15:30:00.000Z'),
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'View 2 archived channels' }));
    await expect(canvas.findByRole('heading', { name: 'Archived channels' })).resolves.toBeVisible();
    const archivedChannels = await canvas.findAllByRole('button', { name: /Archived / });
    expect(archivedChannels.map(channel => channel.getAttribute('data-channel-uuid'))).toEqual([
      'synthetic-bitcoin-overlay-lock',
      'synthetic-older-archived-channel',
    ]);

    await userEvent.click(archivedChannels[0]);
    await expect(canvas.getByTestId('ConnectorChannel')).toHaveAttribute('data-e2e-state', 'Archived');
    await userEvent.click(canvas.getByRole('button', { name: 'Back to archived channels' }));
    await expect(canvas.findByRole('heading', { name: 'Archived channels' })).resolves.toBeVisible();
    await expect(canvas.findAllByRole('button', { name: /Archived / })).resolves.toHaveLength(2);
  },
};

export const Form: Story = {
  beforeEach: () => useScenario(),
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('Insurance guarantee')).resolves.toBeVisible();
    await expect(canvas.getByTestId('ConnectorChannel.fixedPreviewGuard')).toBeVisible();
  },
};

export const CreateWithoutInsurance: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    const submit = scenario.bitcoinLockCreate.submit;
    scenario.bitcoinLockCreate.submit = fn(async input => {
      const txInfo = await submit(input);
      scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
      scenario.locks.push(scenario.lock);
      return txInfo;
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const createButton = await canvas.findByRole('button', { name: /Create Channel/ });

    await expect(createButton).toBeEnabled();
    await expect(canvas.findByText('₳0.00')).resolves.toBeVisible();
    await userEvent.click(createButton);
    await expect(scenario.bitcoinLockCreate.submit).toHaveBeenCalledWith(
      expect.objectContaining({ satoshis: 0n, operatorCoupon: undefined }),
    );
  },
};

export const CreatedChannelSurvivesFinalizationHandoff: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    scenario.lock.fundedSatoshis = 0n;
    scenario.lock.fundingUtxo = undefined;
    scenario.lock.utxos = [];
    scenario.bitcoinLocks.getLockByUuid = fn(() => scenario.lock);
    const submit = scenario.bitcoinLockCreate.submit;
    scenario.bitcoinLockCreate.submit = fn(async input => {
      const txInfo = await submit(input);
      scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
      return txInfo;
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: /Create Channel/ }));
    await expect(canvas.findByTestId('ConnectorChannel')).resolves.toHaveAttribute(
      'data-channel-uuid',
      scenario.lock.uuid,
    );

    scenario.locks.push({ ...scenario.lock, status: BitcoinLockStatus.LockPendingFunding });
    await expect(canvas.findByText('Your Bitcoin channel is ready')).resolves.toBeVisible();
  },
};

export const FeeWaiver: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    scenario.setFeeWaiver();
    const submit = scenario.bitcoinLockCreate.submit;
    scenario.bitcoinLockCreate.submit = fn(async input => {
      const txInfo = await submit(input);
      scenario.lock.status = BitcoinLockStatus.LockIsProcessingOnArgon;
      scenario.locks.push(scenario.lock);
      return txInfo;
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const input = await canvas.findByTestId('input-number');
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}a{/Control}10');

    await expect(canvas.findByText('₳2.80')).resolves.toHaveClass('line-through');
    await expect(canvas.findByText('₳2.00')).resolves.toBeVisible();
    await expect(canvas.findByText(/₳0.80 fee waiver from Atlas Operator/)).resolves.toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: /Create Channel/ }));
    await expect(scenario.bitcoinLockCreate.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorCoupon: expect.objectContaining({
          vaultId: scenario.vault.vaultId,
          offerCode: 'synthetic-fee-waiver',
          remainingFeeCreditMicrogons: 20_400_000n,
        }),
      }),
    );
  },
};

export const CreatingOnArgon: Story = {
  beforeEach: () => useScenario(BitcoinLockStatus.LockIsProcessingOnArgon),
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('Creating your Bitcoin channel')).resolves.toBeVisible();
    await expect(canvas.getByText('Argon confirmation 2 of 4')).toBeVisible();
  },
};

export const PreparingRequest: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    isInteractive = true;
    const request = scenario.defer();
    scenario.bitcoinLockCreate.submit = fn(async () => {
      await request.promise;
      throw new Error('Story cleanup ended the pending request.');
    });
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const input = await canvas.findByTestId('input-number');
    await userEvent.click(input);
    await userEvent.keyboard('10');
    await userEvent.click(canvas.getByRole('button', { name: /Create Channel/ }));
    await expect(canvas.findByText('Preparing the Bitcoin channel request...')).resolves.toBeVisible();
  },
};

export const ReadyForBitcoin: Story = {
  beforeEach: () => useScenario(BitcoinLockStatus.LockPendingFunding),
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('Your Bitcoin channel is ready')).resolves.toBeVisible();
    await expect(canvas.getByText('Funding window:')).toBeVisible();
    await expect(canvas.getByTestId('ConnectorChannel.fundingAddress')).toBeVisible();
    await expect(canvas.getByText('Send Bitcoin to this address before the funding window expires.')).toBeVisible();
  },
};

export const RestoredPendingFunding: Story = {
  beforeEach: () => useScenario(BitcoinLockStatus.LockPendingFunding),
  play: async () => {
    const canvas = within(document.body);

    await expect(scenario.bitcoinLocks.load).toHaveBeenCalled();
    await expect(canvas.findByText('Your Bitcoin channel is ready')).resolves.toBeVisible();
    await expect(canvas.getByTestId('ConnectorChannel.fundingAddress')).toHaveTextContent(/^bc1/);
    await expect(canvas.getByText('Funding window:')).toBeVisible();
  },
};

export const FocusedPendingChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding);
    scenario.locks.unshift({
      ...scenario.lock,
      uuid: 'different-pending-channel',
      utxoId: 202,
      scriptDetails: {
        ...scenario.lock.scriptDetails!,
        p2wshScriptHashHex: `0020${'55'.repeat(32)}`,
      },
    });
    requestedChannelUuid = scenario.lock.uuid;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByTestId('ConnectorChannel')).resolves.toHaveAttribute(
      'data-channel-uuid',
      scenario.lock.uuid,
    );
    await expect(canvas.findByText('Your Bitcoin channel is ready')).resolves.toBeVisible();
  },
};

export const FundingObservedDuringCurrentVisit: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding);
    observeFunding = () => {
      scenario.locks[0].fundingUtxo = scenario.fundingRecord;
    };
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('Your Bitcoin channel is ready')).resolves.toBeVisible();
    observeFunding();
    await Vue.nextTick();
    await expect(canvas.findByText('Bitcoin funding detected')).resolves.toBeVisible();
    await expect(canvas.queryByText('Funding window:')).not.toBeInTheDocument();
    await expect(canvas.getByText('Bitcoin confirmation 2 of 4')).toBeVisible();
  },
};

export const ObservedFundingInWalletOverview: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding, true);
    scenario.fundingRecord.satoshis = 5_000_000n;
    scenario.lock.fundedSatoshis = 0n;
    scenario.lockProcessing.receivedSatoshis = scenario.fundingRecord.satoshis;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    const totalBitcoin = (await canvas.findByText('Total Bitcoin')).parentElement;
    const [channel] = await canvas.findAllByRole('button', { name: /Cosigner:/ });

    await expect(totalBitcoin).toHaveTextContent('0.05 BTC');
    await expect(channel).toHaveTextContent('0.05 BTC');
  },
};

export const PreviousFundedChannel: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding, true);
    isInteractive = true;
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Create Channel' }));
    await expect(
      canvas.findByText('Bitcoin funding is still being confirmed for a previous channel.'),
    ).resolves.toBeVisible();
    await expect(canvas.getByText('Insurance guarantee')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /View channel/ }));
    await expect(canvas.findByText('Bitcoin funding detected')).resolves.toBeVisible();
  },
};

export const RestoreError: Story = {
  beforeEach: () => {
    const cleanup = useScenario();
    scenario.bitcoinLocks.load = fn(async () => {
      throw new Error('Synthetic channel restore failure.');
    });
    return cleanup;
  },
  play: async () => {
    await expect(within(document.body).findByText('Synthetic channel restore failure.')).resolves.toBeVisible();
  },
};

export const __namedExportsOrder = [
  'WalletOverview',
  'Form',
  'CreateWithoutInsurance',
  'CreatedChannelSurvivesFinalizationHandoff',
  'FeeWaiver',
  'PreparingRequest',
  'CreatingOnArgon',
  'ReadyForBitcoin',
  'RestoredPendingFunding',
  'FocusedPendingChannel',
  'RestoreError',
  'FundingObservedDuringCurrentVisit',
  'ObservedFundingInWalletOverview',
  'PreviousFundedChannel',
  'FundedChannel',
  'AddInsurance',
  'AddInsuranceWithoutCosignerCapacity',
  'AddInsuranceAfterBitcoinPriceIncrease',
  'AddingInsurance',
  'AddingInsuranceAfterReturning',
  'AddInsuranceError',
  'SendBitcoin',
  'SendBitcoinWithoutTransactionFee',
  'SendingBitcoinOnArgon',
  'WaitingForCosigner',
  'WaitingForBitcoinConfirmations',
  'BitcoinSentWhileOpen',
  'ArchivedChannel',
  'OrphanAfterLastChannelClosed',
];
