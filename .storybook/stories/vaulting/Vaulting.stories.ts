import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import { userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { setupVaultingPortfolioScenario } from '../../scenarios/setupVaultingPortfolioScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import { TopTab, VaultingSetupStatus, type IConfig } from '../../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import SecuritizationOverlay from '../../../src-vue/overlays/SecuritizationOverlay.vue';
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

    await userEvent.click(canvas.getByRole('button', { name: 'Set Up Your Stabilization Vault' }));
    getConfig().vaultingSetupStatus = VaultingSetupStatus.None;
    await Vue.nextTick();
  },
};

export const ServerRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Vaulting,
      config: { vaultingSetupStatus: VaultingSetupStatus.Checklist },
    });
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
};

export const Portfolio: Story = {
  name: 'Portfolio with securitization shortfall',
  beforeEach: setupVaultingPortfolioScenario,
};

export const UnderSecuritized: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole('button', { name: /Allowed BTC Is Locked/ }));
  },
};

export const SecuritizationShortfall: Story = {
  beforeEach: setupVaultingPortfolioScenario,
  render: () => ({
    components: { AppScreen, Vaulting, SecuritizationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openSecuritizationOverlay'));
    },
    template: '<AppScreen><Vaulting /></AppScreen><SecuritizationOverlay />',
  }),
};

export const VaultActivationGuide: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting });
    setCertificationGuide(OperationalStepId.ActivateVault);
  },
};
