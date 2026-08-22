import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import {
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { ExtrinsicType } from '../../../src-vue/interfaces/ITransactionRecord.ts';
import type { IBitcoinRatchetMetadata } from '../../../src-vue/lib/BitcoinLocks.ts';
import BitcoinRatchetingOverlay from '../../../src-vue/overlays/BitcoinRatchetingOverlay.vue';

let scenario: BitcoinOverlayScenario;

const meta = {
  title: 'Bitcoin/Ratcheting',
  render: () => ({
    components: { BitcoinRatchetingOverlay },
    setup() {
      Vue.onMounted(() => {
        void Vue.nextTick(() => {
          document.querySelector('[data-testid="BitcoinRatchetingOverlay"]')?.setAttribute('inert', '');
        });
      });
      return { scenario };
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
      <BitcoinRatchetingOverlay data-testid="BitcoinRatchetingOverlay" :personalLock="scenario.lock" />
    `,
  }),
} satisfies Meta<typeof BitcoinRatchetingOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    const preview = scenario.defer();
    scenario.bitcoinLocks.getRatchetPreview = fn(async () => {
      await preview.promise;
      return scenario.ratchetPreview.value;
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText('Loading ratchet details...'));
  },
};

export const Available: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
  },
  play: async () => {
    const submitButton = await within(document.body).findByRole('button', { name: 'Finish Ratchet' });
    await waitFor(() => expect(submitButton).toBeEnabled());
  },
};

export const AddedSecurity: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.ratchetPreview.value.securitizationToAdd = 225_000_000n;
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText(/must be fully securitized before it can ratchet/i));
    await expect(body.getByRole('button', { name: 'Add Security & Ratchet' })).toBeEnabled();
  },
};

export const SecurityShortfall: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    Object.assign(scenario.ratchetPreview.value, { canRatchet: false, shortfall: 175_000_000n });
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/needs .* more security before it can ratchet/i));
  },
};

export const Unavailable: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    Object.assign(scenario.ratchetPreview.value, {
      additionalLiquidityToMint: 0n,
      canRatchet: false,
      shortfall: 0n,
    });
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('No ratchet is currently available for this Bitcoin lock.'),
    );
  },
};

export const LoadError: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.bitcoinLocks.getRatchetPreview = fn(async () => {
      throw new Error('The vault ratchet preview is temporarily unavailable.');
    });
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('The vault ratchet preview is temporarily unavailable.'),
    );
  },
};

export const Pending: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.pendingRatchet.value = scenario.createTransactionInfo<IBitcoinRatchetMetadata>({
      extrinsicType: ExtrinsicType.BitcoinRatchet,
      metadata: { utxoId: scenario.lock.utxoId! },
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText(/Waiting for/));
    await expect(body.getByRole('button', { name: 'Ratchet pending...' })).toBeDisabled();
  },
};

export const ProgressError: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.pendingRatchet.value = scenario.createTransactionInfo<IBitcoinRatchetMetadata>({
      error: new Error('The ratchet transaction was rejected by the chain.'),
      extrinsicType: ExtrinsicType.BitcoinRatchet,
      metadata: { utxoId: scenario.lock.utxoId! },
    });
    return () => scenario.cleanup();
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText('The ratchet transaction was rejected by the chain.'),
    );
  },
};
