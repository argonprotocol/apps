import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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
let pendingLiquidCreate: ReturnType<typeof setupBitcoinPortfolioScenario>['bitcoinLiquidCreate'];
let finalizePendingLiquidCreation: ReturnType<typeof setupBitcoinPortfolioScenario>['finalizePendingLiquidCreation'];

export const Loading: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ loading: true }),
};

export const LoadError: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ loadError: new Error('Archive node is temporarily unavailable.') }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Bitcoin could not be loaded.')).toBeVisible();
    await expect(canvas.getByText('Archive node is temporarily unavailable.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Create Your First Liquid' })).toBeVisible());
    await expect(canvas.queryByText('Bitcoin could not be loaded.')).not.toBeInTheDocument();
  },
};

export const Empty: Story = {
  beforeEach: () => setupBitcoinEmptyScenario(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Your First Liquid' }));

    const documentBody = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(documentBody.getByText('Create a Bitcoin Liquid')).toBeVisible());
    await waitFor(() =>
      expect(
        documentBody.getByText(
          "You don't have Bitcoin available in your wallet. Add Bitcoin before creating a Liquid.",
        ),
      ).toBeVisible(),
    );
    await expect(documentBody.getByRole('button', { name: 'Create Liquid' })).toBeDisabled();
    await expect(documentBody.queryByText('Choose How Much Bitcoin to Liquid Lock')).not.toBeInTheDocument();
  },
};

export const WalletBitcoinWithoutLiquids: Story = {
  beforeEach: () => setupBitcoinEmptyScenario({ walletBitcoin: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('BITCOIN LIQUIDS')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Create Your First Liquid' })).toBeVisible();
  },
};

export const Liquids: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const leftBar = canvasElement.querySelector<HTMLElement>('.Navigation.LeftBar');
    if (!leftBar) throw new Error('Bitcoin navigation is missing');
    const navigationRow = within(leftBar).getByText('Bitcoin Liquids').closest('li');

    await expect(navigationRow).toHaveTextContent('₳85,680.00');
    const closeAmounts = canvas.getAllByText(/ to close$/);
    await expect(closeAmounts).toHaveLength(2);
    await expect(closeAmounts[0]).toBeVisible();
    await expect(closeAmounts[1]).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /Close Liquid/ })).not.toBeInTheDocument();
    await expect(canvas.queryByText(/ debt$/)).not.toBeInTheDocument();
    await expect(canvas.getByText('₳47,600.00 liquidity')).toBeVisible();
    await expect(canvas.getByText(/₳38,080.00 liquidity/)).toBeVisible();
    await expect(canvas.getByText('(₳9,900.80 pending mint)')).toBeVisible();
    await expect(canvas.getByText('₳5.10 fees')).toBeVisible();
    await expect(canvas.getByText('₳2.55 fees')).toBeVisible();
    await expect(canvas.getByText('13.4% return')).toBeVisible();
    await expect(canvas.getByText('8.25% return')).toBeVisible();
    await expect(canvas.getByText('Cosigners: Meridian Vault and Atlas Operator')).toBeVisible();
    await expect(canvas.getByText('Cosigner: Meridian Vault')).toBeVisible();
    await expect(canvas.queryByText(/ of BTC$/)).not.toBeInTheDocument();
  },
};

export const ClosedLiquidArchive: Story = {
  name: 'Archived Liquids',
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen interactive><Bitcoin /></AppScreen>',
  }),
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ closedLiquidArchive: true, archivedOnly: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('1 Bitcoin Liquid has been archived')).toBeVisible();
    await expect(canvas.getAllByText(/BTC Liquid$/)).toHaveLength(1);
    await expect(canvas.getByText('₳1,652.40 profit')).toBeVisible();
    await expect(canvas.getByText('₳1.25 securitization fees')).toBeVisible();
    await expect(canvas.getByText('₳4.00 transaction fees')).toBeVisible();
    await expect(canvas.getByText('9.72% return')).toBeVisible();
    await userEvent.click(canvas.getByText(/BTC Liquid$/));

    const body = within(canvasElement.ownerDocument.body);
    const details = await body.findByRole('dialog', { name: 'Locked Bitcoin Details' });
    await waitFor(() => expect(details).toBeVisible());
    const overlay = within(details);
    await expect(overlay.getByText('₳16,499.998867 repaid')).toBeVisible();
    await expect(overlay.getByText('Aug 8, 2026')).toBeVisible();
    await expect(overlay.getByText('Total close cost was ₳16,500.000555, including transaction fees.')).toBeVisible();
    await expect(overlay.getByText('₳0.001688 fees')).toBeVisible();
    await expect(overlay.getByText('₳5.25')).toBeVisible();
    await expect(overlay.queryByRole('button', { name: 'Start Ratchet' })).not.toBeInTheDocument();
    await expect(overlay.queryByRole('button', { name: /Close Liquid/ })).not.toBeInTheDocument();

    await userEvent.click(overlay.getByTestId('OverlayBase.clickClose()'));
    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Locked Bitcoin Details' })).not.toBeInTheDocument());
    await userEvent.click(canvas.getByText(/BTC Liquid$/));
    const reopenedDetails = await body.findByRole('dialog', { name: 'Locked Bitcoin Details' });
    await waitFor(() => expect(reopenedDetails).toBeVisible());
  },
};

export const RatchetOpportunity: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ currentBitcoinPriceUsd: 72_000 });
  },
  play: async ({ canvasElement }) => {
    const opportunities = within(canvasElement).getAllByText('Ratchet +5.88% available');
    await expect(opportunities).toHaveLength(2);
    await expect(opportunities[0]).toBeVisible();
  },
};

export const LiquidDetails: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ currentBitcoinPriceUsd: 72_000 });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[0]);
    const body = within(canvasElement.ownerDocument.body);
    const details = await body.findByRole('dialog', { name: 'Locked Bitcoin Details' });
    await waitFor(() => expect(details).toBeVisible());
    const overlay = within(details);
    await expect(overlay.getByRole('heading', { name: '0.7 BTC Locked' })).toBeVisible();
    await expect(overlay.getByText('TOTAL FEES')).toBeVisible();
    await expect(overlay.getByText('Recorded costs to date')).toBeVisible();
    await expect(overlay.queryByText(/insurance · .* transactions/)).not.toBeInTheDocument();
    await expect(overlay.getByRole('heading', { name: 'RATCHET OPPORTUNITY' })).toBeVisible();
    await expect(overlay.getByRole('heading', { name: 'HISTORY' })).toBeVisible();
    await expect(overlay.getByText(/Would unlock/)).toBeVisible();
    await expect(overlay.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
  },
};

export const LiquidDetailsWithoutRatchet: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[0]);
    const body = within(canvasElement.ownerDocument.body);
    const details = await body.findByRole('dialog', { name: 'Locked Bitcoin Details' });
    await waitFor(() => expect(details).toBeVisible());
    const overlay = within(details);
    await expect(overlay.getByText('A ratchet requires at least a 5% Bitcoin price change.')).toBeVisible();
    await expect(overlay.queryByText('Fees unavailable')).not.toBeInTheDocument();
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
    await waitFor(() => within(canvasElement.ownerDocument.body).getByText('Create a Bitcoin Liquid'));
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
    const certificationAmount = await dialog.findByText('Certification');
    if (certificationAmount.tagName === 'BUTTON') await userEvent.click(certificationAmount);
    await waitFor(() => expect(dialog.getByTestId('input-number')).toHaveTextContent('0.08823529'));
  },
};

export const CreateLiquidWithoutBitcoin: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ noAvailableBitcoin: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    const documentBody = within(canvasElement.ownerDocument.body);
    await expect(
      documentBody.findByText("You don't have Bitcoin available in your wallet. Add Bitcoin before creating a Liquid."),
    ).resolves.toBeTruthy();
    await expect(documentBody.getByRole('button', { name: 'Create Liquid' })).toBeDisabled();
  },
};

export const CreateLiquidWhileFeeWaiversUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true, feeWaiverRefreshPending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    await waitFor(() => within(canvasElement.ownerDocument.body).getByText('Create a Bitcoin Liquid'));
  },
};

export const CreateLiquidWhileQuoteLoads: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidPreviewPending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByText('Checking available securitization…')).toBeVisible());
    await expect(dialog.getByRole('button', { name: 'Create Liquid' })).toBeDisabled();
  },
};

export const CreateLiquidQuoteUnavailable: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidError: 'Network Bitcoin pricing is currently unavailable.' });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByText('Network Bitcoin pricing is currently unavailable.'),
      ).toBeVisible(),
    );
  },
};

export const CreateLiquidWithoutSecuritization: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ createLiquidAvailableVaultId: 7, createLiquidWithoutSecuritization: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByRole('dialog'));

    await waitFor(() =>
      expect(
        dialog.getByText('Atlas Operator does not have enough securitization to create another Liquid.'),
      ).toBeVisible(),
    );
    await expect(dialog.getByTestId('input-number')).toHaveTextContent('0.0');
    await expect(dialog.getByRole('button', { name: 'Create Liquid' })).toBeDisabled();
  },
};

export const CloseWhileCreatingLiquid: Story = {
  beforeEach: () => {
    const scenario = setupBitcoinPortfolioScenario({ pendingLiquidCreation: true });
    pendingLiquidCreate = scenario.bitcoinLiquidCreate;
    finalizePendingLiquidCreation = () => scenario.finalizePendingLiquidCreation();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Create Liquid' }));
    const documentBody = within(canvasElement.ownerDocument.body);
    await userEvent.click(await documentBody.findByRole('button', { name: 'Create Liquid' }));
    await waitFor(() => expect(pendingLiquidCreate.submit).toHaveBeenCalled());
    await documentBody.findByText('Creating Liquid...');
    const close = canvasElement.ownerDocument.body.querySelector<HTMLElement>(
      '[data-testid="OverlayBase.clickClose()"]',
    );
    if (!close) throw new Error('The Liquid creation overlay close action was not rendered.');
    await userEvent.click(close);
    await waitFor(() => expect(documentBody.queryByText('Create a Bitcoin Liquid')).not.toBeInTheDocument());
    const pendingRow = await canvas.findByTestId('PendingBitcoinLiquid-2700');
    await expect(within(pendingRow).getByText(/BTC Liquid Is Being Created$/)).toBeVisible();
    await expect(within(pendingRow).getByRole('button', { name: 'View Progress' })).toBeVisible();
    await expect(within(pendingRow).getAllByText('42.0%')).toHaveLength(2);
    await expect(canvas.getByRole('button', { name: 'Create Liquid' })).toBeVisible();

    await userEvent.click(within(pendingRow).getByRole('button', { name: 'View Progress' }));
    const reopenedDialog = await documentBody.findByRole('dialog');
    await waitFor(() => expect(reopenedDialog).toBeVisible());
    await expect(within(reopenedDialog).getByText('Creating Liquid...')).toBeVisible();

    finalizePendingLiquidCreation();
    await waitFor(() => expect(within(reopenedDialog).queryByText('Creating Liquid...')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(within(reopenedDialog).getByRole('heading', { name: 'Your Bitcoin Liquid Is Active' })).toBeVisible(),
    );
    await userEvent.click(within(reopenedDialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(documentBody.queryByRole('dialog')).not.toBeInTheDocument());
  },
};
