import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import {
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import type { WalletForBitcoin } from '../../../src-vue/lib/WalletForBitcoin.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import ConnectorChannel from '../../../src-vue/wallets/components/ConnectorChannel.vue';

let scenario: BitcoinOverlayScenario;
let open = true;
let isInteractive = false;
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
    components: { ConnectorChannel },
    setup() {
      const isOpen = Vue.ref(open);
      return { isInteractive, isOpen, wallet: useWallets().bitcoinWallet };
    },
    template: `
      <div class="flex h-screen w-screen items-start justify-center bg-slate-800 pt-48">
        <ConnectorChannel v-model:open="isOpen" direction="right" :wallet="wallet">
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
  observeFunding = () => undefined;
  scenario.locks.splice(0);
  if (status) {
    scenario.lock.status = status;
    scenario.lock.fundingUtxoRecordId = hasObservedFunding ? scenario.fundingRecord.id : null;
    scenario.locks.push(scenario.lock);
  }
  scenario.bitcoinLocks.hasObservedFundingSignal = fn(lock => lock.fundingUtxoRecordId != null);
  scenario.bitcoinLocks.isFundingWindowExpired = fn(() => false);
  scenario.bitcoinLocks.confirmAddress = fn();
  return () => scenario.cleanup();
}

export const Form: Story = {
  beforeEach: () => useScenario(),
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('Desired BTC Insurance')).resolves.toBeVisible();
    await expect(canvas.getByTestId('ConnectorChannel.fixedPreviewGuard')).toBeVisible();
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
    scenario.bitcoinLocks.initializeLock = fn(async () => {
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
    await expect(canvas.getByText('Send Bitcoin to this address before the funding window expires.')).toBeVisible();
  },
};

export const FundingObservedDuringCurrentVisit: Story = {
  beforeEach: () => {
    const cleanup = useScenario(BitcoinLockStatus.LockPendingFunding);
    observeFunding = () => {
      scenario.locks[0]!.fundingUtxoRecordId = scenario.fundingRecord.id;
    };
    return cleanup;
  },
  play: async () => {
    const canvas = within(document.body);
    await expect(canvas.findByText('Your Bitcoin channel is ready')).resolves.toBeVisible();
    observeFunding();
    await Vue.nextTick();
    await expect(canvas.findByText('Bitcoin funding detected')).resolves.toBeVisible();
    await expect(canvas.getByText('Funding window:')).toBeVisible();
    await expect(canvas.getByText('Bitcoin confirmation 2 of 4')).toBeVisible();
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
    await expect(
      canvas.findByText('Bitcoin funding is still being confirmed for a previous channel.'),
    ).resolves.toBeVisible();
    await expect(canvas.getByText('Desired BTC Insurance')).toBeVisible();
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
