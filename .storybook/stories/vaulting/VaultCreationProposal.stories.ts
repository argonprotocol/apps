import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import VaultCreatePanel from '../../../src-vue/panels/VaultCreatePanel.vue';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { fn } from 'storybook/test';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { TopTab } from '../../../src-vue/interfaces/IConfig.ts';
import Vaulting from '../../../src-vue/screens/Vaulting.vue';

const meta = {
  title: 'Vaulting/Creation Proposal',
  component: VaultCreatePanel,
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Vaulting, config: { hasSavedVaultSetup: true } });
    getCurrency().isLoaded = true;
    getCurrency().microgonsPer.BTC = 68_000_000_000n;
    getConfig().saveVaultSetup = fn(async () => undefined);
  },
  render: () => ({
    components: { AppScreen, Vaulting, VaultCreatePanel },
    template:
      '<AppScreen scenarioLabel="Fixed creation preview · Example values"><Vaulting /></AppScreen><VaultCreatePanel />',
  }),
  play: async () => {
    await within(document.body).findByRole('dialog', { name: 'Configure Your Stabilization Vault' });
    document
      .querySelectorAll(
        '[role="dialog"] button:not([aria-label$="details"]):not([aria-label$="guidance"]), [role="dialog"] input',
      )
      .forEach(element => element.setAttribute('inert', ''));
  },
} satisfies Meta<typeof VaultCreatePanel>;
export default meta;

type Story = StoryObj<typeof meta>;
export const CreationWithTerms: Story = {};

export const FeeEditAffordance: Story = {
  play: async () => {
    await userEvent.hover(await within(document.body).findByTestId('fee-edit-preview'));
    document
      .querySelectorAll(
        '[role="dialog"] button:not([aria-label$="details"]):not([aria-label$="guidance"]), [role="dialog"] input',
      )
      .forEach(element => element.setAttribute('inert', ''));
  },
};

export const CertificationGuidance: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'Certification guidance' }));
    await canvas.findByRole('tooltip');
    document
      .querySelectorAll(
        '[role="dialog"] button:not([aria-label$="details"]):not([aria-label$="guidance"]), [role="dialog"] input',
      )
      .forEach(element => element.setAttribute('inert', ''));
  },
};

export const BitcoinLockingFeeDetails: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'Bitcoin locking fee details' }));
    await canvas.findByRole('tooltip');
    document
      .querySelectorAll(
        '[role="dialog"] button:not([aria-label$="details"]):not([aria-label$="guidance"]), [role="dialog"] input',
      )
      .forEach(element => element.setAttribute('inert', ''));
  },
};

export const ArgonotGuidance: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'ARGNOT guidance' }));
    await canvas.findByRole('tooltip');
    document
      .querySelectorAll(
        '[role="dialog"] button:not([aria-label$="details"]):not([aria-label$="guidance"]), [role="dialog"] input',
      )
      .forEach(element => element.setAttribute('inert', ''));
  },
};

export const ExitNoticeDetails: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'Withdrawal notice details' }));
    await canvas.findByRole('tooltip');
    document
      .querySelectorAll(
        '[role="dialog"] button:not([aria-label$="details"]):not([aria-label$="guidance"]), [role="dialog"] input',
      )
      .forEach(element => element.setAttribute('inert', ''));
  },
};

export const ArgonSecuritizationDetails: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'Argon securitization details' }));
    await canvas.findByRole('tooltip');
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};

export const ArgonotSecuritizationDetails: Story = {
  play: async () => {
    const canvas = within(document.body);
    await userEvent.hover(await canvas.findByRole('button', { name: 'Argonot securitization details' }));
    await canvas.findByRole('tooltip');
    document.querySelector('[role="dialog"]')?.setAttribute('inert', '');
  },
};
