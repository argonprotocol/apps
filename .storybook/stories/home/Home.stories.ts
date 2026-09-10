import type { Meta, StoryObj } from '@storybook/vue3-vite';
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
};

export const BasicAccount: Story = {
  beforeEach: () => {
    setupHomeScenario('basic');
  },
};

export const ReadonlyOperationsAccount: Story = {
  render: () => ({
    components: { AppScreen, Home },
    template: '<AppScreen><Home /></AppScreen>',
  }),
  beforeEach: () => {
    const { controller, walletKeys } = setupHomeScenario('operations', {
      serverAdd: { localComputer: {} },
      upstreamOperator: {
        name: 'Testing',
        vaultId: 1,
        accountId: '5GrwvaEF5zXb26Fz9rcQpDWSvVvKQPiRyg2xHnUSzjZmCz7b',
      },
    });
    controller.isLoaded = true;
    walletKeys.canSign = false;
    walletKeys.canAccessServer = false;
  },
};

export const ReadonlyOperationsAccountWithoutServer: Story = {
  render: () => ({
    components: { AppScreen, Home },
    template: '<AppScreen><Home /></AppScreen>',
  }),
  beforeEach: () => {
    const { controller, walletKeys } = setupHomeScenario('operations');
    controller.isLoaded = true;
    walletKeys.canSign = false;
    walletKeys.canAccessServer = false;
  },
};

export const TreasuryAccount: Story = {
  beforeEach: () => {
    setupHomeScenario('treasury');
  },
};

export const OperationsAccount: Story = {
  beforeEach: () => {
    setupHomeScenario('operations');
  },
};

export const PriceUnavailable: Story = {
  beforeEach: () => {
    setupHomeScenario('priceUnavailable');
  },
};

export const MnemonicBackupGuide: Story = {
  beforeEach: () => {
    setupHomeScenario('basic');
    useCertificationController().isLoaded = true;
    setCertificationGuide(OperationalStepId.BackupMnemonic);
  },
};
