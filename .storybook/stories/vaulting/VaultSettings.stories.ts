import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { fn, mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupVaultingPortfolioScenario } from '../../scenarios/setupVaultingPortfolioScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import VaultCreatePanel from '../../../src-vue/panels/VaultCreatePanel.vue';
import VaultEditOverlay from '../../../src-vue/overlays/VaultEditOverlay.vue';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getMyVault } from '../../../src-vue/stores/vaults.ts';
import Vaulting from '../../../src-vue/screens/Vaulting.vue';

const meta = {
  title: 'Vaulting/Configuration',
  component: VaultEditOverlay,
  render: () => ({
    components: { AppScreen, Vaulting, VaultEditOverlay },
    template: '<AppScreen scenarioLabel="Fixed settings preview"><Vaulting /></AppScreen><VaultEditOverlay />',
  }),
  play: async () => {
    await within(document.body).findByRole('button', { name: 'Save Rules' });
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
} satisfies Meta<typeof VaultEditOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Creation: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting, config: { hasSavedVaultingRules: true } });
  },
  render: () => ({
    components: { AppScreen, Vaulting, VaultCreatePanel },
    template: '<AppScreen scenarioLabel="Fixed creation preview"><Vaulting /></AppScreen><VaultCreatePanel />',
  }),
  play: async () => {
    await within(document.body).findByRole('button', { name: 'Update Rules' });
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const Settings: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    getConfig().saveVaultingRules = fn(async () => undefined);
  },
};

export const CreationFees: Story = {
  ...Creation,
  play: async () => {
    const canvas = within(document.body);
    await canvas.findByRole('button', { name: 'Update Rules' });
    await userEvent.click(canvas.getByText('Bitcoin Locking Fee', { exact: true }));
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const CreationUtilization: Story = {
  ...Creation,
  play: async () => {
    const canvas = within(document.body);
    await canvas.findByRole('button', { name: 'Update Rules' });
    await userEvent.click(canvas.getByText('Projected Utilization', { exact: true }));
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const SettingsFees: Story = {
  ...Settings,
  play: async () => {
    const canvas = within(document.body);
    await canvas.findByRole('button', { name: 'Save Rules' });
    await userEvent.click(canvas.getByText('Bitcoin Locking Fee', { exact: true }));
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const LoadingSettings: Story = {
  beforeEach: () => {
    setupVaultingPortfolioScenario();
    mocked(getMyVault(), { partial: true }).load = fn(() => new Promise<void>(() => {}));
  },
  play: async () => {
    await within(document.body).findByText('Loading...');
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};
