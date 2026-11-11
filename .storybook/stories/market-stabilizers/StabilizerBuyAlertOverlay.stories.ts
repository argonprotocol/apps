import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { buyOpportunity } from '../../../src-vue/__test__/helpers/stabilizerBuy.ts';
import AppScreen from '../../components/AppScreen.vue';
import { setupMarketStabilizers } from '../../scenarios/marketStabilizers.ts';
import { useMarketStabilizers } from '../../../src-vue/stores/marketStabilizers.ts';
import Dashboard from '../../../src-vue/screens/market-stabilizers-screen/Dashboard.vue';
import StabilizerBuyAlertOverlay from '../../../src-vue/overlays/StabilizerBuyAlertOverlay.vue';

const meta = {
  title: 'Market Stabilizers/Create a Stabilizer',
  component: StabilizerBuyAlertOverlay,
  beforeEach: () => {
    const network = NetworkConfig.networkName!;
    const previous = NetworkConfig.get();
    setupMarketStabilizers();
    NetworkConfig.setRuntimeOverride(network, {
      ...previous,
      ethereumNetwork: { ...previous.ethereumNetwork, stabilizerBuyQuoterAddress: buyOpportunity.quote.quoterAddress },
    });
    return () => NetworkConfig.setRuntimeOverride(network, previous);
  },
  render: () => ({
    components: { AppScreen, Dashboard, StabilizerBuyAlertOverlay },
    template: '<AppScreen><Dashboard /><StabilizerBuyAlertOverlay inert /></AppScreen>',
  }),
} satisfies Meta<typeof StabilizerBuyAlertOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Existing: Story = {
  beforeEach: () => {
    useMarketStabilizers().config.stabilizerBuyAlert = { minimumApy: 12 };
  },
};
