import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, MINING_BID_PROXY_FEE_FLOAT } from '@argonprotocol/apps-core';
import { expect, fn, mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupMiningAuctionScenario } from '../../scenarios/setupMiningAuctionScenario.ts';
import { setupMiningPortfolioScenario } from '../../scenarios/setupMiningPortfolioScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import { InstallStepErrorType, MiningSetupStatus, TopTab, type IConfig } from '../../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import { getBot } from '../../../src-vue/stores/bot.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getInstaller } from '../../../src-vue/stores/installer.ts';
import { OperationalStepId } from '../../../src-vue/stores/certificationController.ts';
import Mining from '../../../src-vue/screens/Mining.vue';

const biddingRules = {
  ...(Config.getDefault('biddingRules') as IConfig['biddingRules']),
  initialMicrogonRequirement: 500n * BigInt(MICROGONS_PER_ARGON),
  initialMicronotRequirement: 100n * BigInt(MICRONOTS_PER_ARGONOT),
};

const meta = {
  title: 'Mining/Overview',
  component: Mining,
  render: () => ({
    components: { AppScreen, Mining },
    template: '<AppScreen><Mining /></AppScreen>',
  }),
} satisfies Meta<typeof Mining>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Mining });
  },
  render: () => ({
    components: { AppScreen, Mining },
    setup() {
      return {
        config: getConfig(),
        MiningSetupStatus,
      };
    },
    template: `
      <AppScreen :interactive="config.miningSetupStatus === MiningSetupStatus.None">
        <Mining />
      </AppScreen>
    `,
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Argon Desktop')).toBeVisible();
    await expect(canvas.getByText('Mining')).toBeVisible();
    await expect(canvas.getByText('Interactive scenario')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Set Up Your Mining Operation' }));
    await expect(canvas.getByRole('heading', { name: 'Start Mining In Three Steps' })).toBeVisible();
    await expect(canvas.getByText('Fixed state preview')).toBeVisible();

    getConfig().miningSetupStatus = MiningSetupStatus.None;

    await expect(await canvas.findByRole('button', { name: 'Set Up Your Mining Operation' })).toBeVisible();
    await expect(await canvas.findByText('Interactive scenario')).toBeVisible();
  },
};

export const ServerRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: { miningSetupStatus: MiningSetupStatus.Checklist },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Argon Desktop')).toBeVisible();
    await expect(canvas.getByText('Mining')).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Start Mining In Three Steps' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: 'Connect a Cloud Machine' })).toBeVisible();
  },
};

export const ServerInstalling: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: {
        miningSetupStatus: MiningSetupStatus.Checklist,
        isServerAdded: true,
        serverAdd: { localComputer: {} },
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('INSTALLING')).toBeVisible();
    await expect(canvas.getByText(/This local computer will be used to run your mining software/)).toBeVisible();
  },
};

export const ServerUpdatingWithoutBotApi: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
    Object.assign(getBot(), { isReady: false });
    getConfig().isServerInstalling = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('heading', { name: 'Updating Your Server' })).toBeVisible();
    await expect(canvas.getByText(/Mining will reconnect automatically/)).toBeVisible();
  },
};

export const ServerUpdatingWithBotApi: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
    getConfig().isServerInstalling = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId('MiningDashboard')).toBeVisible();
    await expect(canvas.queryByRole('heading', { name: 'Updating Your Server' })).not.toBeInTheDocument();
  },
};

export const ServerUpdateFailed: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
    Object.assign(getBot(), { isReady: false });

    const config = getConfig();
    config.isServerInstalling = true;
    config.serverInstaller = Config.getDefault('serverInstaller') as IConfig['serverInstaller'];
    config.serverInstaller.errorType = InstallStepErrorType.ArgonInstall;
    config.serverInstaller.errorMessage = 'Argon syncstatus returned error JSON too many times';

    mocked(getInstaller, { partial: true }).mockReturnValue({
      runFailedStep: fn(async () => undefined),
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId('LeftBar.goto(TopTab.Mining)')).toHaveClass('Selected');
    await expect(canvas.getByText('Server Update Failed')).toBeVisible();
    await expect(canvas.getByText(/Failed to Install Argon/)).toBeVisible();
    await expect(canvas.getByText('Argon syncstatus returned error JSON too many times')).toBeVisible();

    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }));
    await expect(getInstaller().runFailedStep).toHaveBeenCalledWith('all');
  },
};

export const RulesRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: {
        miningSetupStatus: MiningSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('heading', { name: 'Confirm Your Bidding Rules' })).toBeVisible();
    await expect(canvas.getByText(/Decide how much capital you want to commit/)).toBeVisible();
  },
};

export const FundingRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: {
        miningSetupStatus: MiningSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
        hasSavedBiddingRules: true,
        biddingRules,
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const launchButton = canvas.getByRole('button', { name: 'Launch Mining Bot' });

    await expect(canvas.getByRole('heading', { name: 'Fund Your Wallet' })).toBeVisible();
    await expect(launchButton).toHaveClass('pointer-events-none');
  },
};

export const ReadyToLaunch: Story = {
  beforeEach: () => {
    const { wallets } = setupAppScenario({
      selectedTab: TopTab.Mining,
      config: {
        miningSetupStatus: MiningSetupStatus.Checklist,
        isServerAdded: true,
        isServerInstalled: true,
        serverAdd: { localComputer: {} },
        hasSavedBiddingRules: true,
        biddingRules,
      },
    });

    wallets.totalMiningMicrogons = biddingRules.initialMicrogonRequirement + MINING_BID_PROXY_FEE_FLOAT;
    wallets.miningBotWallet.availableMicronots = biddingRules.initialMicronotRequirement;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const launchButton = canvas.getByRole('button', { name: 'Launch Mining Bot' });

    await expect(launchButton).not.toHaveClass('pointer-events-none');
  },
};

export const OwnedSeatPortfolio: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const months = Array.from(canvasElement.querySelectorAll('[Dates] li')).map(month => month.textContent?.trim());

    await expect(months).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  },
};

export const HistoricalSeatPortfolio: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario(118);
  },
};

export const FirstAuctionConnecting: Story = {
  beforeEach: () => setupMiningAuctionScenario('connecting'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('CONNECTING TO')).toBeVisible();
    await expect(canvas.getByText('BIDDING BOT')).toBeVisible();
  },
};

export const FirstAuctionSyncing: Story = {
  beforeEach: () => setupMiningAuctionScenario('syncing'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole('heading', { name: 'Syncing Your Mining Machine' })).toBeVisible();
  },
};

export const FirstAuctionSubmitting: Story = {
  beforeEach: () => setupMiningAuctionScenario('submitting'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('FIRST-EVER MINING BID')).toBeVisible();
    await expect(
      canvas.getByText(
        (_, element) =>
          element?.tagName === 'P' && /The current auction will begin closing in/.test(element.textContent ?? ''),
      ),
    ).toBeVisible();
    await expect(canvas.getByText('9 hours, 23 minutes and 24 seconds')).toBeVisible();
  },
};

export const FirstAuctionWinningOne: Story = {
  beforeEach: () => setupMiningAuctionScenario('winningOne'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Your First Auction Is Live!')).toBeVisible();
    await expect(canvas.getByText('YOU ARE IN BID POSITION')).toBeVisible();
    await expect(canvas.getByText(/9 hours, 23 minutes and 24 seconds\./)).toBeVisible();
  },
};

export const FirstAuctionWinningMany: Story = {
  beforeEach: () => setupMiningAuctionScenario('winningMany'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText('Your First Auction Is Live!')).toBeVisible();
    await expect(canvas.getByText('YOU ARE IN BID POSITIONS')).toBeVisible();
    await expect(canvas.getByText(/9 hours, 23 minutes and 24 seconds\./)).toBeVisible();
  },
};

export const FirstAuctionArgonShortage: Story = {
  beforeEach: () => setupMiningAuctionScenario('argonShortage'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const message = canvas.getByText(
      (_, element) => element?.tagName === 'P' && /Your wallet needs an additional/.test(element.textContent ?? ''),
    );

    await expect(message).toHaveTextContent(/argons.*to win mining bids/s);
  },
};

export const FirstAuctionArgonotShortage: Story = {
  beforeEach: () => setupMiningAuctionScenario('argonotShortage'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const message = canvas.getByText(
      (_, element) => element?.tagName === 'P' && /Your wallet needs an additional/.test(element.textContent ?? ''),
    );

    await expect(message).toHaveTextContent(/argonots.*to win mining bids/s);
  },
};

export const FirstAuctionBothShortage: Story = {
  beforeEach: () => setupMiningAuctionScenario('bothShortage'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const message = canvas.getByText(
      (_, element) => element?.tagName === 'P' && /Your wallet needs an additional/.test(element.textContent ?? ''),
    );

    await expect(message).toHaveTextContent(/argons.*and.*argonots.*to win mining bids/s);
  },
};

export const FirstAuctionBidLimitExceeded: Story = {
  beforeEach: () => setupMiningAuctionScenario('bidLimitExceeded'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText(/Maximum Price/)).toBeVisible();
  },
};

export const FirstMiningSeatGuide: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Mining });
    setCertificationGuide(OperationalStepId.FirstMiningSeat);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const setupButton = canvas.getByRole('button', { name: /Set Up Your Mining Operation/ });

    await expect(setupButton).toBeVisible();
    await expect(within(setupButton).getByText('Click Here')).toBeVisible();
  },
};
