import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import {
  setupBitcoinEmptyScenario,
  setupBitcoinPortfolioScenario,
} from '../../scenarios/setupBitcoinPortfolioScenario.ts';
import Bitcoin from '../../../src-vue/screens/Bitcoin.vue';
import { BitcoinLockStatus } from '../../../src-vue/interfaces/IBitcoinLockRecord.ts';
import {
  getBitcoinFissions,
  getBitcoinLocks,
  getBitcoinTransactionOperations,
} from '../../../src-vue/stores/bitcoin.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { OperationalStepId, useCertificationController } from '../../../src-vue/stores/certificationController.ts';
import * as Vue from 'vue';
import CertificationOverlay from '../../../src-vue/overlays/CertificationOverlay.vue';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';

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

export const BitcoinLockWalletGuide: Story = {
  beforeEach: () => {
    setupBitcoinEmptyScenario();
    getConfig().hasExtensionOperations = false;
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const BitcoinFirstLiquidGuide: Story = {
  parameters: {
    docs: { description: { story: 'Funded Bitcoin points directly to the Create Your First Liquid button.' } },
  },
  beforeEach: () => {
    setupBitcoinEmptyScenario({ walletBitcoin: true });
    getConfig().hasExtensionOperations = false;
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const BitcoinAdditionalLiquidGuide: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
    getConfig().hasExtensionOperations = false;
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const BitcoinGuideComplete: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
    getConfig().hasExtensionOperations = false;
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasBitcoinLock = true;
    controller.activeGuideId = OperationalStepId.LiquidLock;
  },
};

export const LiquidTaskResume: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ feeWaiver: true, createLiquidAvailableVaultId: 7, pendingLiquidCreation: true });
    getBitcoinFissions().data.fissionsById = {};
    getConfig().hasExtensionOperations = false;
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasTreasuryUniswapTransfer = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = null;
  },
  render: () => ({
    components: { AppScreen, Bitcoin, CertificationOverlay },
    setup() {
      Vue.onMounted(() => basicEmitter.emit('openOperationalOverlay', OperationalStepId.LiquidLock));
    },
    template: '<AppScreen interactive><Bitcoin /></AppScreen><CertificationOverlay />',
  }),
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
    await userEvent.click(await canvas.findByText(/been archived/));
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

export const LiquidsWhileUpstreamProfileLoads: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ upstreamOperatorProfilePending: true });
  },
};

export const LiquidDetailsWhileUpstreamProfileLoads: Story = {
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen interactive><Bitcoin /></AppScreen>',
  }),
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ upstreamOperatorProfilePending: true });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByText(/BTC Liquid$/)[0]);
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
    await userEvent.click(dialog.getByRole('button', { name: /Use Selected Vaults/ }));
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

export const CreateLiquidVaultCapacityRetried: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
    mocked(getBitcoinTransactionOperations().bitcoinLiquidCreate.preview).mockRejectedValueOnce(
      new Error('Unable to check vault securitization.'),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Create.*Liquid/ }));
    await userEvent.click(await body.findByRole('button', { name: 'Retry' }));
  },
};

export const CreateLiquidVaultCapacityApplied: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario();
    const activeLocks = getBitcoinLocks()
      .getAllLocks()
      .filter(lock => lock.status === BitcoinLockStatus.LockFunded && lock.lockId != null);
    const maximumSatoshisByLockId = Object.fromEntries(
      activeLocks.map((lock, index) => [lock.lockId!, index === 0 ? 1_000_000n : lock.fundedSatoshis]),
    );
    mocked(getBitcoinTransactionOperations().bitcoinLiquidCreate.preview)
      .mockResolvedValueOnce({
        microgonsAtTargetPerBtc: 6_800_000_000n,
        microgonsAtTargetPerBtcTick: 10_000,
        liquidityMicrogons: 68_000_000_000n,
        totalSecurityFeeMicrogons: 136_000_000n,
        securityFeeMicrogons: 108_800_000n,
        couponCreditMicrogons: 0n,
        maximumSatoshisByLockId,
      })
      .mockImplementation(() => new Promise(() => undefined));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole('button', { name: /Create.*Liquid/ }));
    await userEvent.click(await body.findByRole('button', { name: /Use Selected Vaults/ }));
  },
};

export const CloseWhileCreatingLiquid: Story = {
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ pendingLiquidCreation: true });
    getBitcoinFissions().data.fissionsById = {};
    getConfig().hasExtensionOperations = false;
    const controller = useCertificationController();
    controller.isLoaded = true;
    controller.chainProgress.hasOperationalAccount = true;
    controller.chainProgress.hasBitcoinLock = false;
    controller.activeGuideId = OperationalStepId.LiquidLock;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);

    await userEvent.click(canvas.getByRole('button', { name: /Create.*Liquid/ }));
    await userEvent.click(await body.findByRole('button', { name: /Use Selected Vaults/ }));
    await userEvent.click(await body.findByRole('button', { name: /^Create Liquid/ }));
    await body.findByText('Creating Liquid...');
    await userEvent.click(await body.findByTestId('OverlayBase.clickClose()'));
    await userEvent.click(await body.findByRole('button', { name: 'Task guidance' }));
  },
};

export const ExpandedLiquidArchive: Story = {
  render: () => ({
    components: { AppScreen, Bitcoin },
    template: '<AppScreen interactive><Bitcoin /></AppScreen>',
  }),
  beforeEach: () => {
    setupBitcoinPortfolioScenario({ closedLiquidArchive: true, archivedOnly: true });
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText(/been archived/));
  },
};
