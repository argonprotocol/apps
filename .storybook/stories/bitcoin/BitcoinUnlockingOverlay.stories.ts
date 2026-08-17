import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
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
  title: 'Bitcoin/Unlocking',
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

export const Start: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/You are releasing/i));
  },
};

export const NearExpiration: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.bitcoinLocks.unlockDeadlineTime = fn(() => Date.now() + 1_000);
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText(/You are releasing/i));
    await expectEventuallyVisible(body.findByText('Initiate Unlock'));
    await waitFor(() =>
      expect(document.body.querySelector('[data-testid="BitcoinUnlockingOverlay"] svg.text-amber-500')).toBeTruthy(),
    );
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
    await expectEventuallyVisible(body.findByText(/Argon is processing your request to unlock/i));
    await expectEventuallyVisible(body.getByText(/Argon Block/));
  },
};

export const WaitingForVaultCosign: Story = {
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
    await expectEventuallyVisible(within(document.body).findByText('Waiting for Vault to Cosign'));
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
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText(/Argon is processing your request to unlock/i));
    await expectEventuallyVisible(body.getByText('83.00%'));
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
      statusError: 'The vault signature expired before the release could be broadcast.',
    });
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/vault signature expired before the release could be broadcast/i),
    );
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
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/officially unlocked from both/i));
  },
};
