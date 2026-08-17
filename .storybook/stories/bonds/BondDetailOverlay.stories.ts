import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { setupBondPortfolioScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import BondDetailOverlay from '../../../src-vue/overlays/BondDetailOverlay.vue';

let bondLot: ReturnType<typeof setupBondPortfolioScenario>['lots'][number];
let position: ReturnType<typeof setupBondPortfolioScenario>['positions'][number];
let returnPercent: number;

const meta = {
  title: 'Bonds/Details',
  render: () => ({
    components: { BondDetailOverlay },
    setup: () => ({ bondLot, position, returnPercent }),
    template: '<BondDetailOverlay :bondLot="bondLot" :position="position" :returnPercent="returnPercent" />',
  }),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots[0];
    position = positions[0];
    returnPercent = 8.42;
  },
};

export const ReleasingBond: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Vault');
    bondLot = lots.find(lot => lot.isReleasing)!;
    position = positions[2];
    returnPercent = 5.18;
  },
};
