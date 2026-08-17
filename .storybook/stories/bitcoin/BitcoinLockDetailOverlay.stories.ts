import * as Vue from 'vue';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { within } from 'storybook/test';
import { expectEventuallyVisible } from '../../support/expectEventuallyVisible.ts';
import {
  createExternalBitcoinLock,
  setupBitcoinOverlayScenario,
  type BitcoinOverlayScenario,
} from '../../scenarios/setupBitcoinOverlayScenario.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import { BitcoinUtxoStatus } from '../../../src-vue/interfaces/IBitcoinUtxoRecord.ts';
import type { IExternalBitcoinLock } from '../../../src-vue/lib/MyVault.ts';
import BitcoinLockDetailOverlay from '../../../src-vue/overlays/BitcoinLockDetailOverlay.vue';

let scenario: BitcoinOverlayScenario;
let displayLock: IBitcoinLockRecord | IExternalBitcoinLock;

const meta = {
  title: 'Bitcoin/Lock details',
  render: () => ({
    components: { BitcoinLockDetailOverlay },
    setup() {
      Vue.onMounted(() => {
        void Vue.nextTick(() => {
          document.querySelector('[data-testid="BitcoinLockDetailOverlay"]')?.setAttribute('inert', '');
        });
      });
      return { displayLock };
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
      <BitcoinLockDetailOverlay :lock="displayLock" />
    `,
  }),
} satisfies Meta<typeof BitcoinLockDetailOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalLock: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    displayLock = scenario.lock;
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('YOURS'));
    await expectEventuallyVisible(body.getByText('This bitcoin is locked and generating revenue on Argon.'));
  },
};

export const ExternalLock: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    const externalLock = createExternalBitcoinLock();
    scenario.myVault.data.externalLocks[externalLock.utxoId] = externalLock;
    displayLock = externalLock;
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('EXTERNAL'));
    await expectEventuallyVisible(body.getByText('This bitcoin is locked and generating revenue on Argon.'));
  },
};

export const PendingCosign: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.releaseVaultWaitProgress.value = 42;
    scenario.myVault.data.pendingCosignUtxosById.set(scenario.lock.utxoId!, {
      targetValue: scenario.lock.satoshis,
      dueFrame: 10_012,
    });
    displayLock = scenario.lock;
  },
  play: async () => {
    await expectEventuallyVisible(within(document.body).findByText(/pending release request.*cosign automatically/i));
  },
};

export const Released: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    scenario.lock.status = BitcoinLockStatus.Released;
    scenario.lock.releaseRedemptionMicrogons = 825_000_000n;
    scenario.lock.releaseArgonTxFeeMicrogons = 135_000n;
    scenario.lock.btcPriceAtRemovalMicrogons = 6_900_000_000n;
    scenario.lock.removalBlockTime = new Date('2026-08-15T16:00:00.000Z');
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
    scenario.financials.bitcoinLockPerformanceByUuid[scenario.lock.uuid] = { profit: 58_000_000n, percent: 6.8 };
    displayLock = scenario.lock;
  },
  play: async () => {
    await expectEventuallyVisible(
      within(document.body).findByText(/bitcoin was unlocked and returned to your wallet/i),
    );
  },
};

export const ExternalReleased: Story = {
  beforeEach: () => {
    scenario = setupBitcoinOverlayScenario();
    const externalLock = createExternalBitcoinLock({ utxoId: 802 });
    scenario.myVault.data.externalLocks[externalLock.utxoId] = externalLock;
    scenario.myVault.data.releasedExternalUtxoIds.add(externalLock.utxoId);
    displayLock = externalLock;
  },
  play: async () => {
    const body = within(document.body);
    await expectEventuallyVisible(body.findByText('EXTERNAL'));
    await expectEventuallyVisible(body.getByText('This bitcoin has been unlocked and returned to the owner.'));
  },
};
