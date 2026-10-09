import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, mocked, userEvent, within } from 'storybook/test';
import { createTypedEventEmitter, type IBitcoinLockConfig } from '@argonprotocol/apps-core';
import {
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { getInstaller } from '../../../src-vue/stores/installer.ts';
import { getMainchainClients } from '../../../src-vue/stores/mainchain.ts';
import AlertBars from '../../../src-vue/navigation/AlertBars.vue';

let scenario: BitcoinOverlayScenario;
const isInteractive = Vue.ref(false);

const meta = {
  title: 'Bitcoin/Guarantee alerts',
  component: AlertBars,
  render: () => ({
    components: { AlertBars },
    setup: () => ({ isInteractive }),
    template: `
      <div class="h-screen bg-slate-800 pt-12">
        <div class="pointer-events-none fixed top-2 right-3 z-50 rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
          Fixed state preview
        </div>
        <div :inert="!isInteractive">
          <AlertBars />
        </div>
      </div>
    `,
  }),
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    isInteractive.value = false;
    scenario.lock.status = BitcoinLockStatus.LockPendingFunding;
    scenario.lock.fundedSatoshis = 0n;
    scenario.replaceUtxoRecords([]);
    scenario.bitcoinLocks.getSecuritizationHoldExpirationTime = fn(() => scenario.scenarioStartedAt + 60 * 60_000);
    Object.defineProperty(scenario.bitcoinLocks, 'config', {
      value: { securitizationHoldBlocks: 144 } satisfies Pick<IBitcoinLockConfig, 'securitizationHoldBlocks'>,
    });
    mocked(getMainchainClients, { partial: true }).mockReturnValue({
      hasConnectedClient: fn(() => true),
      events: createTypedEventEmitter(),
    });
    mocked(getInstaller, { partial: true }).mockReturnValue({});
    return () => scenario.cleanup();
  },
} satisfies Meta<typeof AlertBars>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReservationExpiring: Story = {};

export const ReservationDetails: Story = {
  beforeEach: () => {
    isInteractive.value = true;
    scenario.locks.push({ ...scenario.lock, uuid: 'synthetic-guarantee-alert-102', lockId: 102 });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Expand' }));
    const details = await canvas.findByTestId('AlertsRoot.details');
    details.setAttribute('inert', '');
    isInteractive.value = false;
  },
};
