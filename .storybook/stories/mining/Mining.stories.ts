import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, MINING_BID_PROXY_FEE_FLOAT } from '@argonprotocol/apps-core';
import { fn, mocked, userEvent, within } from 'storybook/test';
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
import { getMiningSetup } from '../../../src-vue/stores/wallets.ts';
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

function setupMiningSetupErrorScenario(retrySucceeds = false) {
  setupMiningPortfolioScenario();
  Object.assign(getConfig(), {
    miningSetupStatus: MiningSetupStatus.Installing,
    isServerAdded: true,
    isServerInstalled: true,
    isServerInstalling: false,
    hasSavedBiddingRules: true,
    biddingRules,
  });

  const ensure = fn().mockRejectedValue(new Error('Unable to submit the mining setup transaction.'));
  if (retrySucceeds) {
    ensure.mockRejectedValueOnce(new Error('Unable to submit the mining setup transaction.')).mockResolvedValue({
      kind: 'ready',
    });
  }
  mocked(getMiningSetup, { partial: true }).mockReturnValue({ ensure });
}

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
};

export const ServerRequired: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: { miningSetupStatus: MiningSetupStatus.Checklist },
    });
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
};

export const MiningSetupTransactionRecovery: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: {
        miningSetupStatus: MiningSetupStatus.Installing,
        isServerAdded: true,
        isServerInstalled: true,
        isServerInstalling: false,
        hasSavedBiddingRules: true,
        biddingRules,
      },
    });
    mocked(getMiningSetup, { partial: true }).mockReturnValue({
      ensure: fn(async () => ({
        kind: 'transaction' as const,
        txInfo: {
          tx: { id: 42 },
          getStatus: fn(() => ({ progressPct: 62 })),
          subscribeToProgress: fn((callback: any) => {
            void callback({ progressPct: 62, progressMessage: 'Waiting for 4th Block...' });
            return fn();
          }),
        } as any,
        waitForCompletion: new Promise<void>(() => undefined),
      })),
    });
  },
};

export const MiningSetupTransactionError: Story = {
  beforeEach: () => {
    setupMiningSetupErrorScenario();
  },
};

export const MiningSetupTransactionRetry: Story = {
  beforeEach: () => {
    setupMiningSetupErrorScenario(true);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole('button', { name: 'Retry Mining Setup' }));
  },
};

export const ServerUpdatingWithoutBotApi: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
    Object.assign(getBot(), { isReady: false });
    getConfig().isServerInstalling = true;
  },
};

export const ServerUpdatingWithBotApi: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
    getConfig().isServerInstalling = true;
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
};

export const OwnedSeatPortfolio: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByText('A1'));
  },
};

export const HistoricalSeatPortfolio: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario(118);
  },
};

export const FirstAuctionConnecting: Story = {
  beforeEach: () => setupMiningAuctionScenario('connecting'),
};

export const FirstAuctionSyncing: Story = {
  beforeEach: () => setupMiningAuctionScenario('syncing'),
};

export const FirstAuctionSubmitting: Story = {
  beforeEach: () => setupMiningAuctionScenario('submitting'),
};

export const FirstAuctionWinningOne: Story = {
  beforeEach: () => setupMiningAuctionScenario('winningOne'),
};

export const FirstAuctionWinningMany: Story = {
  beforeEach: () => setupMiningAuctionScenario('winningMany'),
};

export const FirstAuctionArgonShortage: Story = {
  beforeEach: () => setupMiningAuctionScenario('argonShortage'),
};

export const FirstAuctionArgonotShortage: Story = {
  beforeEach: () => setupMiningAuctionScenario('argonotShortage'),
};

export const FirstAuctionBothShortage: Story = {
  beforeEach: () => setupMiningAuctionScenario('bothShortage'),
};

export const FirstAuctionBidLimitExceeded: Story = {
  beforeEach: () => setupMiningAuctionScenario('bidLimitExceeded'),
};

export const FirstMiningSeatGuide: Story = {
  beforeEach: () => {
    setupAppScenario({ selectedTab: TopTab.Mining });
    setCertificationGuide(OperationalStepId.FirstMiningSeat);
  },
};
