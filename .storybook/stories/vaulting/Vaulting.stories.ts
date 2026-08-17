import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import { expect, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { setupVaultingPortfolioScenario } from '../../scenarios/setupVaultingPortfolioScenario.ts';
import { TopTab, VaultingSetupStatus, type IConfig } from '../../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { OperationalStepId } from '../../../src-vue/stores/certificationController.ts';
import Vaulting from '../../../src-vue/screens/Vaulting.vue';

const vaultingRules = Config.getDefault('vaultingRules') as IConfig['vaultingRules'];

const meta = {
  title: 'Vaulting/Overview',
  component: Vaulting,
  render: () => ({
    components: { AppScreen, Vaulting },
    template: '<AppScreen><Vaulting /></AppScreen>',
  }),
} satisfies Meta<typeof Vaulting>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
  },
  render: () => ({
    components: { AppScreen, Vaulting },
    setup() {
      return {
        config: getConfig(),
        VaultingSetupStatus,
      };
    },
    template: `
      <AppScreen :interactive="config.vaultingSetupStatus === VaultingSetupStatus.None">
        <Vaulting />
      </AppScreen>
    `,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Argon Desktop')).toBeVisible();
    await expect(canvas.getByText('Vaulting')).toBeVisible();
    await expect(canvas.getByText('Interactive scenario')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Set Up Your Stabilization Vault' }));
    await expect(canvas.getByRole('heading', { name: 'Start Vaulting In Three Steps' })).toBeVisible();
    await expect(canvas.getByText('Fixed state preview')).toBeVisible();

    getConfig().vaultingSetupStatus = VaultingSetupStatus.None;

    await expect(await canvas.findByRole('button', { name: 'Set Up Your Stabilization Vault' })).toBeVisible();
    await expect(await canvas.findByText('Interactive scenario')).toBeVisible();
  },
};

export const ServerRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: { vaultingSetupStatus: VaultingSetupStatus.Checklist },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Argon Desktop')).toBeVisible();
    await expect(canvas.getByText('Vaulting')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Start Vaulting In Three Steps' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Connect a Cloud Machine' })).toBeVisible();
  },
};

export const ServerInstalling: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        serverAdd: { localComputer: {} },
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('INSTALLING')).toBeVisible();
    await expect(canvas.getByText(/This local computer will run your vaulting and mining software/)).toBeVisible();
  },
};

export const RulesRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('heading', { name: 'Confirm Your Vault Settings' })).toBeVisible();
    await expect(canvas.getByText(/Decide how much capital to commit/)).toBeVisible();
  },
};

export const FundingRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
        hasSavedVaultingRules: true,
        vaultingRules,
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const launchButton = canvas.getByRole('button', { name: 'Launch Stabilization Vault' });

    await expect(canvas.getByRole('heading', { name: 'Fund Your Wallet' })).toBeVisible();
    await expect(launchButton).toHaveClass('pointer-events-none');
  },
};

export const ReadyToLaunch: Story = {
  beforeEach: () => {
    const { wallets } = setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: {
        vaultingSetupStatus: VaultingSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
        hasSavedVaultingRules: true,
        vaultingRules,
      },
    });

    wallets.defaultArgonWallet.availableMicrogons =
      vaultingRules.baseMicrogonCommitment + 2n * BigInt(MICROGONS_PER_ARGON);
    wallets.defaultArgonWallet.availableMicronots = vaultingRules.baseMicronotCommitment;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const launchButton = canvas.getByRole('button', { name: 'Launch Stabilization Vault' });

    await expect(launchButton).not.toHaveClass('pointer-events-none');
  },
};

export const Portfolio: Story = {
  name: 'Portfolio with mixed states',
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId('VaultingDashboard')).toBeVisible();
    await expect(canvas.getByText('Unused BTC Space')).toBeVisible();
    await expect(canvas.getByText('Available Bonds')).toBeVisible();
    await expect(canvas.getByText('Total Bitcoin Locked')).toBeVisible();
    await expect(canvas.getByText('External Treasury Bonds')).toBeVisible();
  },
};

export const VaultActivationGuide: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    setCertificationGuide(OperationalStepId.ActivateVault);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const setupButton = canvas.getByRole('button', { name: /Set Up Your Stabilization Vault/ });

    await expect(setupButton).toBeVisible();
    await expect(within(setupButton).getByText('Click Here')).toBeVisible();
  },
};
