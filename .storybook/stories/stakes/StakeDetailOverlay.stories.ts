import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { setupBondPortfolioScenario } from '../../scenarios/setupBondPortfolioScenario.ts';
import BondDetailOverlay from '../../../src-vue/overlays/BondDetailOverlay.vue';

let bondLot: ReturnType<typeof setupBondPortfolioScenario>['lots'][number];
let position: ReturnType<typeof setupBondPortfolioScenario>['positions'][number];
let returnPercent: number;

const meta = {
  title: 'Stakes/Details',
  render: () => ({
    components: { BondDetailOverlay },
    setup: () => ({ bondLot, position, returnPercent }),
    template: '<BondDetailOverlay :bondLot="bondLot" :position="position" :returnPercent="returnPercent" />',
  }),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots[0];
    position = positions[0];
    returnPercent = 11.76;
  },
};

export const Releasing: Story = {
  beforeEach: () => {
    const { lots, positions } = setupBondPortfolioScenario('Argonot');
    bondLot = lots.find(lot => lot.isReleasing)!;
    position = positions[2];
    returnPercent = 7.05;
  },
};
