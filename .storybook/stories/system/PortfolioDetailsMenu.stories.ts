import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { NavigationMenuList, NavigationMenuRoot, NavigationMenuViewport } from 'reka-ui';
import { userEvent, within } from 'storybook/test';
import { UnitOfMeasurement } from '@argonprotocol/apps-core';
import { setupBitcoinPortfolioScenario } from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import { setupWalletScenario } from '../../scenarios/setupWalletScenario.ts';
import PortfolioDetailsMenu from '../../../src-vue/navigation/PortfolioDetailsMenu.vue';
import { reduceFinancialPositions } from '../../../src-vue/lib/financials/index.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
import { useWallets } from '../../../src-vue/stores/wallets.ts';
import type { IFinancialPosition } from '../../../src-vue/interfaces/IFinancialPosition.ts';

const meta = {
  title: 'System/Portfolio details',
  component: PortfolioDetailsMenu,
  render: () => ({
    components: { NavigationMenuList, NavigationMenuRoot, NavigationMenuViewport, PortfolioDetailsMenu },
    template: `
      <div class="flex h-screen w-screen items-start justify-end bg-white p-6">
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

export const ExpandedAssetBreakdowns: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
    const financials = useFinancials();
    const positions = [
      {
        id: 'mining-balance',
        kind: 'mining-balance',
        group: 'mining',
        label: 'Mining ARGN',
        lifecycle: 'available',
        accountId: '5SyntheticMiningAccount',
        asset: 'ARGN',
        amount: 300_000_000n,
        currentValue: 300_000_000n,
      },
      {
        id: 'vault:1',
        kind: 'vault',
        group: 'vaulting',
        label: 'Vault 1',
        lifecycle: 'active',
        vaultId: 1,
        securitization: 1_000_000_000n,
        uncollectedRevenue: 0n,
        capitalHistory: [],
        revenueHistory: [],
        currentValue: 1_000_000_000n,
      },
    ] satisfies IFinancialPosition[];
    Object.assign(financials, {
      financialPositionAggregate: reduceFinancialPositions(
        financials.financialPositionAggregate.groups
          .filter(group => group.state === 'ready' || group.group === 'mining' || group.group === 'vaulting')
          .map(group => ({
            ...group,
            state: 'ready',
            positions: [...group.positions, ...positions.filter(position => position.group === group.group)],
            observation: { observedAt: new Date('2026-08-16T12:00:00Z') },
          })),
      ),
    });
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await userEvent.click(body.getByRole('button', { name: 'View portfolio details' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Internal App Wallet tokens' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Bitcoin details' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Mining details' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle Vaulting details' }));
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

export const EthereumPriceUnavailable: Story = {
  beforeEach: () => {
    setupWalletScenario('defaultArgon');
    const wallet = useWallets().ethereumWallets.find(41)!;
    wallet.data.otherTokens = [
      {
        symbol: 'ETH',
        decimals: 18,
        address: null,
        chain: 'ethereum',
        unitOfMeasurement: UnitOfMeasurement.ETH,
        value: 1_000_000_000_000_000_000n,
      },
    ];
    const currency = getCurrency();
    currency.hasEthPrice = false;
    Object.assign(useFinancials(), {
      financialPositionAggregate: reduceFinancialPositions([
        {
          group: 'ethereum',
          state: 'ready',
          positions: wallet.createFinancialPositions(currency),
          observation: { observedAt: new Date('2026-08-16T12:00:00.000Z') },
        },
      ]),
    });
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await userEvent.click(body.getByRole('button', { name: 'View portfolio details' }));
    await userEvent.click(await body.findByRole('button', { name: 'Toggle individual Ethereum wallets' }));
  },
};
