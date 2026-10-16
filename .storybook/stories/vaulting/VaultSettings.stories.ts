import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import VaultCreatePanel from '../../../src-vue/panels/VaultCreatePanel.vue';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getVaults } from '../../../src-vue/stores/vaults.ts';
import { useVaultingStats } from '../../../src-vue/stores/vaultingStats.ts';
import Vaulting from '../../../src-vue/screens/Vaulting.vue';

const meta = {
  title: 'Vaulting/Configuration',
  component: VaultCreatePanel,
} satisfies Meta<typeof VaultCreatePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Creation: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: { hasSavedVaultSetup: false },
    });
    getCurrency().isLoaded = true;
    getCurrency().microgonsPer.BTC = 68_000_000_000n;
    getConfig().saveVaultSetup = fn(async () => undefined);
  },
  render: () => ({
    components: { AppScreen, Vaulting, VaultCreatePanel },
    template: '<AppScreen scenarioLabel="Fixed creation preview"><Vaulting /></AppScreen><VaultCreatePanel />',
  }),
  play: async () => {
    await within(document.body).findByRole('button', { name: 'Confirm Settings »' });
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const CreationFees: Story = {
  ...Creation,
  play: async () => {
    const canvas = within(document.body);
    await canvas.findByRole('button', { name: 'Confirm Settings »' });
    await userEvent.click(canvas.getByRole('button', { name: 'Edit Bitcoin locking fee' }));
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const CreationWithoutGuidance: Story = {
  ...Creation,
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    getVaults().rewards!.averageMicrogonsPerArgonot = undefined;
    getVaults().currentState.argonotSecuritizationRewardRatio = 2;
    getVaults().rewards!.constants = { ...getVaults().rewards!.constants, argonotSecuritizationMultiplier: 2 };
    getCurrency().isLoaded = true;
    getCurrency().microgonsPer.BTC = 68_000_000_000n;
    getConfig().saveVaultSetup = fn(async () => undefined);
  },
};

export const CreationLoadingReturns: Story = {
  ...Creation,
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    useVaultingStats().isLoadedPromise = new Promise<void>(fn());
    getCurrency().isLoaded = true;
    getCurrency().microgonsPer.BTC = 68_000_000_000n;
    getConfig().saveVaultSetup = fn(async () => undefined);
  },
};

export const CreationSaveError: Story = {
  ...Creation,
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    getCurrency().isLoaded = true;
    getCurrency().microgonsPer.BTC = 68_000_000_000n;
    getConfig().saveVaultSetup = fn(async () => {
      throw new Error('Unable to save vault settings. Please retry.');
    });
  },
  play: async () => {
    const canvas = within(document.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Confirm Settings »' }));
    await canvas.findByText('Unable to save vault settings. Please retry.');
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};
