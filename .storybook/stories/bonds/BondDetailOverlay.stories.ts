import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { mocked } from 'storybook/test';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { BondLot } from '@argonprotocol/apps-core';
import { setupBondPortfolioScenario, setupBondArchiveScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import BondDetailOverlay from '../../../src-vue/overlays/BondDetailOverlay.vue';

let bondLot: ReturnType<typeof setupBondPortfolioScenario>['lots'][number] | undefined;
let position: ReturnType<typeof setupBondPortfolioScenario>['positions'][number];

const meta = {
  title: 'Bonds/Details',
  render: () => ({
    components: { BondDetailOverlay },
    setup: () => ({ bondLot, position }),
    template: `
      <div class="fixed top-2 right-3 z-[10000] rounded-full border border-slate-400/40 bg-white/90 px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm">Fixed state preview</div>
      <BondDetailOverlay
        :bondLot="bondLot"
        :position="position"
        inert
      />
    `,
  }),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
  },
};

export const FlexibleBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots.find(lot => lot.isFlexible)!;
    position = positions.find(candidate => candidate.bondLot?.id === bondLot?.id)!;
  },
};

export const DisplacedFlexibleBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault', 26.32);
    bondLot = lots.find(lot => lot.isFlexible)!;
    position = positions.find(candidate => candidate.bondLot?.id === bondLot?.id)!;
  },
};

export const ReleasingBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots.find(lot => lot.isReleasing)!;
    position = positions[2];
  },
};

export const IncompleteBondHistory: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = new BondLot(lots[0].id, lots[0], lots[0].owner);
    position = { ...positions[0], returnIsComplete: false };
  },
};

export const IncompleteFlexibleHistory: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault', 0, false);
    bondLot = lots.find(lot => lot.isFlexible)!;
    position = positions.find(candidate => candidate.bondLot?.id === bondLot?.id)!;
  },
};

export const DailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    mocked(getMyVault, { partial: true }).mockReturnValue({ vaultId: 99 });
    getArgonBonds().data.dailyEarnings[0].earningsMicrogons = 300_000n;
    getArgonBonds().data.dailyEarnings[2].earningsMicrogons = 420_000n;
  },
};

export const IncompleteDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    getArgonBonds().data.dailyEarnings[0].earningsMicrogons = undefined;
    getArgonBonds().data.dailyEarnings[0].displacedMicrogons = undefined;
    getArgonBonds().data.dailyEarnings[0].bonds = undefined;
  },
};

export const NoDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    getArgonBonds().data.dailyEarnings = [];
  },
};

export const Archived: Story = {
  beforeEach: () => {
    position = setupBondArchiveScenario('Vault');
    bondLot = undefined;
  },
};

export const VaultOperatorDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault', 26.32);
    bondLot = lots[1];
    position = positions[1];
    mocked(getMyVault, { partial: true }).mockReturnValue({ vaultId: bondLot.vaultId });
  },
};
