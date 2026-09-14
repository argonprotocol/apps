import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn } from 'storybook/test';

import {
  createBitcoinRelease,
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinReleaseStatus } from '../../../src-vue/interfaces/IBitcoinReleaseRecord.ts';
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
};

export const ArgonRequest: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    scenario.setRelease(createBitcoinRelease({ status: BitcoinReleaseStatus.SubmittingRequestOnArgon }));
    Object.assign(scenario.myVault, {
      getBitcoinReleaseRequestTxInfo: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: { lockId: scenario.lock.lockId! },
        }),
      ),
    });
    return () => scenario.cleanup();
  },
};

export const WaitingForCosigner: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    scenario.setRelease(createBitcoinRelease({ status: BitcoinReleaseStatus.WaitingForVaultCosign }));
    scenario.releaseVaultWaitProgress.value = 42;
    Object.assign(scenario.myVault, {
      getBitcoinReleaseRequestTxInfo: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.BitcoinRequestRelease,
          metadata: { lockId: scenario.lock.lockId! },
          status: TransactionStatus.Finalized,
        }),
      ),
      getTxInfoByType: fn(() =>
        scenario.createTransactionInfo({
          extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
          metadata: { lockId: scenario.lock.lockId! },
        }),
      ),
    });
    return () => scenario.cleanup();
  },
};

export const BitcoinConfirmations: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    scenario.setRelease(
      createBitcoinRelease({
        status: BitcoinReleaseStatus.ConfirmingOnBitcoin,
        vaultSignatures: [new Uint8Array([1, 2, 3])],
        cosignBlockNumber: 250_020,
        bitcoinTxid: 'synthetic-release-transaction',
        bitcoinFirstSeenAt: new Date('2026-08-16T14:30:00.000Z'),
      }),
    );
    scenario.releaseProcessing.progressPct = 50;
    scenario.releaseProcessing.confirmations = 3;
    return () => scenario.cleanup();
  },
};

export const Error: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Releasing;
    scenario.setRelease(
      createBitcoinRelease({
        status: BitcoinReleaseStatus.WaitingForVaultCosign,
        statusError: 'The cosigner signature expired before the transfer could be broadcast.',
      }),
    );
    return () => scenario.cleanup();
  },
};

export const Complete: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Released;
    scenario.setRelease(
      createBitcoinRelease({
        status: BitcoinReleaseStatus.Complete,
        vaultSignatures: [new Uint8Array([1, 2, 3])],
        cosignBlockNumber: 250_020,
        bitcoinTxid: 'synthetic-complete-release',
        bitcoinConfirmedHeight: 250_026,
      }),
    );
    return () => scenario.cleanup();
  },
};
