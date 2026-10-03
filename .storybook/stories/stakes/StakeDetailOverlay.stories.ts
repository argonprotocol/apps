import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { mocked } from 'storybook/test';
import { getArgonBonds } from '../../../src-vue/stores/argonBonds.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import { setupBondPortfolioScenario, setupBondArchiveScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import BondDetailOverlay from '../../../src-vue/overlays/BondDetailOverlay.vue';

let bondLot: ReturnType<typeof setupBondPortfolioScenario>['lots'][number] | undefined;
let position: ReturnType<typeof setupBondPortfolioScenario>['positions'][number];

const meta = {
  title: 'Stakes/Details',
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

export const Active: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots[0];
    position = positions[0];
  },
};

export const Releasing: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots.find(lot => lot.isReleasing)!;
    position = positions[2];
  },
};

export const IncompleteHistory: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot', 0, false);
    bondLot = lots[0];
    position = positions[0];
  },
};

export const DailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots[0];
    position = positions[0];
    mocked(getMyVault, { partial: true }).mockReturnValue({ vaultId: 99 });
    getArgonBonds().data.dailyEarnings[0].earningsMicrogons = 300_000n;
    getArgonBonds().data.dailyEarnings[2].earningsMicrogons = 420_000n;
  },
};

export const IncompleteDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots[0];
    position = positions[0];
    getArgonBonds().data.dailyEarnings[0].earningsMicrogons = undefined;
    getArgonBonds().data.dailyEarnings[0].displacedMicrogons = undefined;
    getArgonBonds().data.dailyEarnings[0].bonds = undefined;
  },
};

export const NoDailyEarnings: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots[0];
    position = positions[0];
    getArgonBonds().data.dailyEarnings = [];
  },
};

export const Archived: Story = {
  beforeEach: () => {
    position = setupBondArchiveScenario('Argonot');
    bondLot = undefined;
  },
};
