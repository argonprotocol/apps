import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import {
  setupBitcoinEmptyScenario,
  setupBitcoinPortfolioScenario,
} from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import Bitcoin from '../../../src-vue/screens/Bitcoin.vue';
import { getBitcoinFissions } from '../../../src-vue/stores/bitcoin.ts';
import { useCertificationController } from '../../../src-vue/stores/certificationController.ts';

const meta = {
  title: 'Bitcoin/Overview',
  component: Bitcoin,
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen><Bitcoin /></AppScreen>',
  }),
} satisfies Meta<typeof Bitcoin>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ loading: true }),
};

export const LoadError: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ loadError: new Error('Archive node is temporarily unavailable.') }),
};

export const Empty: Story = {
  beforeEach: () => setupBitcoinEmptyScenario(),
};

export const WalletBitcoinWithoutLiquids: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ walletBitcoin: true }),
};

export const Liquids: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
};

export const ClosedLiquidArchive: Story = {
  name: 'Archived Liquids',
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ closedLiquidArchive: true, archivedOnly: true });
  },
};

export const ArchivedLiquidDetails: Story = {
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen interactive><Bitcoin /></AppScreen>',
  }),
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ closedLiquidArchive: true, archivedOnly: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/BTC Liquid$/));
  },
};

export const RatchetOpportunity: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ currentBitcoinPriceUsd: 72_000 });
  },
};

export const LiquidDetails: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ currentBitcoinPriceUsd: 72_000 });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[0]);
  },
};

export const LiquidDetailsWithoutRatchet: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[0]);
  },
};

export const LiquidsWithFeeWaiver: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
  },
};

export const LiquidFinancialHistoryUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ financialHistoryUnavailable: true });
  },
};

export const CreateLiquidForm: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
  },
};

export const CreateLiquidForTreasuryCertification: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true });
    getBitcoinFissions().data.fissionsById = {};
  },
  play: async ({ canvasElement }) => {
    const certification = useCertificationController();
    certification.rewardConfig = {
      ...certification.rewardConfig,
      treasuryMinimumBitcoin: 500_000_000n,
    };
    certification.chainProgress = {
      ...certification.chainProgress,
      hasOperationalAccount: true,
      hasBitcoinLock: false,
    };
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Create.*Liquid/ }));

    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Select Vaults' }));
    const certificationAmount = await dialog.findByText('Certification');
    if (certificationAmount.tagName === 'BUTTON') await userEvent.click(certificationAmount);
  },
};

export const CreateLiquidWithoutBitcoin: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ noAvailableBitcoin: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
  },
};

export const CreateLiquidWhileFeeWaiversUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true, feeWaiverRefreshPending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
  },
};

export const CreateLiquidWhileQuoteLoads: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidPreviewPending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
  },
};

export const CreateLiquidQuoteUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidError: 'Network Bitcoin pricing is currently unavailable.' });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
  },
};

export const CreateLiquidWithoutSecuritization: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidAvailableVaultId: 7, createLiquidWithoutSecuritization: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
  },
};

export const CloseWhileCreatingLiquid: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ pendingLiquidCreation: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);

    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    await userEvent.click(await body.findByRole('button', { name: 'Select Vaults' }));
    await userEvent.click(await body.findByRole('button', { name: 'Create Liquid' }));
    await body.findByText('Creating Liquid...');
    await userEvent.click(await body.findByTestId('OverlayBase.clickClose()'));
    await canvas.findByTestId('PendingBitcoinLiquid-2700');
  },
};
