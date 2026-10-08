import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { setupBondPurchaseScenario } from '../../scenarios/setupPurchaseOverlayScenario.ts';
import { useVaultingStats } from '../../../src-vue/stores/vaultingStats.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import BondPurchaseOverlay from '../../../src-vue/overlays/BondPurchaseOverlay.vue';

const meta = {
  title: 'Bonds/Purchase',
  component: BondPurchaseOverlay,
  render: () => ({
    components: { BondPurchaseOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openBondPurchaseOverlay'));
    },
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">
        Fixed state preview
      </div>
      <BondPurchaseOverlay inert />
    `,
  }),
} satisfies Meta<typeof BondPurchaseOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LoadingVaults: Story = {
  beforeEach: () => setupBondPurchaseScenario('loading'),
};

export const VaultLoadFailed: Story = {
  beforeEach: () => setupBondPurchaseScenario('loadError'),
};

export const NoActiveVaults: Story = {
  beforeEach: () => setupBondPurchaseScenario('ready'),
};

export const MarketValuedCapacity: Story = {
  beforeEach: () => setupBondPurchaseScenario('available'),
};

export const WalletLimitedMax: Story = {
  beforeEach: () => setupBondPurchaseScenario('walletLimited'),
};

export const WalletBelowMinimum: Story = {
  beforeEach: () => setupBondPurchaseScenario('belowMinimum'),
};

export const NetworkLotLimit: Story = {
  beforeEach: () => setupBondPurchaseScenario('lotLimit'),
};

export const PendingWithdrawalLimitsPurchase: Story = {
  beforeEach: () => setupBondPurchaseScenario('withdrawalLimited'),
};

export const VaultSelection: Story = {
  beforeEach: () => setupBondPurchaseScenario('selection'),
};

export const OwnerWithFlexibleBonds: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleSelection'),
};

export const OwnerUnfilledCapacity: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexible'),
};

export const OwnerWithReservedSpace: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleReserved'),
};

export const OwnerWithPendingWithdrawal: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleWithdrawal'),
};

export const OwnerOverUnfilledCapacity: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleOverCapacity'),
};

export const OwnerCertificationPending: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleCertificationPending'),
};

export const OwnerCertificationAlreadyComplete: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleCertificationComplete'),
};

export const OwnerFlexibleBondsFillCapacity: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownerFlexibleNoCapacity'),
};

export const NoUpstream: Story = {
  beforeEach: () => setupBondPurchaseScenario('noUpstream'),
};

export const OwnedVaultWithoutCapacity: Story = {
  beforeEach: () => setupBondPurchaseScenario('ownedNoCapacity'),
};

export const ReturnsUnavailable: Story = {
  beforeEach: () => {
    setupBondPurchaseScenario('available');
    useVaultingStats().argonBondsAPR = undefined;
  },
};
