import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { NavigationMenuList, NavigationMenuRoot, NavigationMenuViewport } from 'reka-ui';
import { userEvent, within } from 'storybook/test';
import { setupBitcoinPortfolioScenario } from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import PortfolioDetailsMenu from '../../../src-vue/navigation/PortfolioDetailsMenu.vue';

const meta = {
  title: 'System/Portfolio details',
  component: PortfolioDetailsMenu,
  render: () => ({
    components: { NavigationMenuList, NavigationMenuRoot, NavigationMenuViewport, PortfolioDetailsMenu },
    template: `
      <div class="flex h-screen w-screen justify-end bg-white p-6">
        <NavigationMenuRoot class="relative">
          <NavigationMenuList>
            <PortfolioDetailsMenu />
          </NavigationMenuList>
          <NavigationMenuViewport
            class="absolute top-full right-0 mt-2 h-[var(--reka-navigation-menu-viewport-height)] w-[var(--reka-navigation-menu-viewport-width)]"
          />
        </NavigationMenuRoot>
      </div>
    `,
  }),
} satisfies Meta<typeof PortfolioDetailsMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BitcoinWalletHolding: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await userEvent.click(body.getByRole('button', { name: 'View portfolio details' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Internal App Wallet tokens' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Bitcoin details' }));
  },
};

export const SettledBitcoinLiquid: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ settledLiquid: true });
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await userEvent.click(body.getByRole('button', { name: 'View portfolio details' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Internal App Wallet tokens' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Bitcoin details' }));
  },
};
