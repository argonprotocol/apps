import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { setupHomeScenario } from '../../scenarios/setupHomeScenario.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import Home from '../../../src-vue/screens/Home.vue';

const meta = {
  title: 'Home',
  component: Home,
  render: () => ({
    components: { AppScreen, Home },
    template: '<AppScreen><Home /></AppScreen>',
  }),
} satisfies Meta<typeof Home>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => {
    setupHomeScenario('loading');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buyingPower = canvas.getByText(/Buying Power vs/);
    const restabilizationPower = canvas.getByText(/Restabilization Power/);
    const internalWallet = canvas
      .getAllByText('Internal App Wallet')
      .map(element => element.closest('article'))
      .find(Boolean);

    if (!internalWallet) throw new Error('Home loading wallet is missing');

    await expect(canvas.getByText('Your Gateway to Argon')).toBeVisible();
    await expect(buyingPower).toHaveTextContent(/--\s*Buying Power vs/);
    await expect(restabilizationPower).toHaveTextContent(/--\s*Restabilization Power/);
    await expect(internalWallet).toHaveTextContent(/\$--\.--/);
    await expect(canvas.getByText('Loading Argon Price')).toBeVisible();
  },
};

export const BasicAccount: Story = {
  beforeEach: () => {
    setupHomeScenario('basic');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Your Gateway to Argon')).toBeVisible();
    await expect(canvas.getAllByText('Internal App Wallet')).toHaveLength(2);
    await expect(canvas.getByText(/connect an Ethereum wallet/i)).toBeVisible();
  },
};

export const TreasuryAccount: Story = {
  beforeEach: () => {
    setupHomeScenario('treasury');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/upgraded to Treasury/i)).toBeVisible();
    await expect(canvas.getAllByText('Internal App Wallet')).toHaveLength(2);
    await expect(canvas.getByText('Main Wallet')).toBeVisible();
    await expect(canvas.getByText('Treasury Wallet')).toBeVisible();
  },
};

export const OperationsAccount: Story = {
  beforeEach: () => {
    setupHomeScenario('operations');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/top level of Argon's operational feature set/i)).toBeVisible();
    await expect(canvas.getByText('Main Wallet')).toBeVisible();
    await expect(canvas.getByText('Treasury Wallet')).toBeVisible();
  },
};

export const PriceUnavailable: Story = {
  beforeEach: () => {
    setupHomeScenario('priceUnavailable');
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Argon Price Unavailable')).toBeVisible();
    await expect(canvas.getAllByText('Internal App Wallet')).toHaveLength(2);
  },
};

export const MnemonicBackupGuide: Story = {
  beforeEach: () => {
    setupHomeScenario('basic');
    useCertificationController().isLoaded = true;
    setCertificationGuide(OperationalStepId.BackupMnemonic);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.findByText('Mouse Over')).resolves.toBeVisible();
    await expect(canvas.getByText('Your Gateway to Argon')).toBeVisible();
  },
};
