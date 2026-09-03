import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, within } from 'storybook/test';

import {
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import { ExtrinsicType, TransactionStatus } from '../../../src-vue/interfaces/ITransactionRecord.ts';
import BitcoinUnlockingOverlay from '../../../src-vue/overlays/BitcoinUnlockingOverlay.vue';

let scenario: BitcoinOverlayScenario;

const meta = {
  title: 'Bitcoin/Send locked Bitcoin',
  component: BitcoinUnlockingOverlay,
  render: () => ({
    components: { BitcoinUnlockingOverlay },
    setup() {
      Vue.onMounted(() => {
        void Vue.nextTick(() => {
          document.querySelector('[data-testid="BitcoinUnlockingOverlay"]')?.setAttribute('inert', '');
        });
      });
      return { scenario };
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
      <BitcoinUnlockingOverlay :personalLock="scenario.lock" />
    `,
  }),
} satisfies Meta<typeof BitcoinUnlockingOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Form: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expect(body.findByRole('heading', { name: 'Send Bitcoin', hidden: true })).resolves.toBeInTheDocument();
    await expect(body.findByTestId('BitcoinSend.destinationAddress')).resolves.toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Send Bitcoin' })).toBeDisabled();
  },
};

export const ArgonRequest: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    Object.assign(scenario.myVault, {
      getBitcoinReleaseRequestTxInfo: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: { utxoId: scenario.lock.utxoId! },
        }),
      ),
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expect(body.findByText(/This process requires several steps/)).resolves.toBeInTheDocument();
    await expect(body.findByText(/Argon Block/)).resolves.toBeInTheDocument();
  },
};

export const WaitingForCosigner: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
    });
    scenario.releaseVaultWaitProgress.value = 42;
    Object.assign(scenario.myVault, {
      getBitcoinReleaseRequestTxInfo: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: { utxoId: scenario.lock.utxoId! },
          status: TransactionStatus.Finalized,
        }),
      ),
      getTxInfoByType: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
          metadata: { utxoId: scenario.lock.utxoId! },
        }),
      ),
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    await expect(within(document.body).findByText('Waiting for Atlas Operator to sign')).resolves.toBeInTheDocument();
  },
};

export const BitcoinConfirmations: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
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
    return () => scenario.cleanup();
  },
  play: async () => {
    await expect(within(document.body).findByText(/Bitcoin Block/)).resolves.toBeInTheDocument();
  },
};

export const Error: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      statusError: 'The cosigner signature expired before the transfer could be broadcast.',
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    await expect(within(document.body).findByText(/cosigner signature expired/i)).resolves.toBeInTheDocument();
  },
};

export const Complete: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Released;
    Object.assign(scenario.fundingRecord, {
      status: BitcoinUtxoStatus.ReleaseComplete,
      requestedReleaseAtTick: 10_010,
      releaseToDestinationAddress: `0014${'55'.repeat(20)}`,
      releaseBitcoinNetworkFee: 18_000n,
      releaseCosignVaultSignature: new Uint8Array([1, 2, 3]),
      releaseCosignHeight: 250_020,
      releaseTxid: 'synthetic-complete-release',
      releasedAtBitcoinHeight: 250_026,
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expect(body.findByText('Bitcoin sent')).resolves.toBeInTheDocument();
    await expect(body.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  },
};
