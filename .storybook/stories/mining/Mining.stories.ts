import * as Vue from 'vue';
import { Chart } from 'chart.js';
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { MICROGONS_PER_ARGON, MICRONOTS_PER_ARGONOT, MINING_BID_PROXY_FEE_FLOAT } from '@argonprotocol/apps-core';
import { fn, mocked, userEvent, within } from 'storybook/test';
import AppScreen from '../../components/AppScreen.vue';
import { setupAppScenario } from '../../scenarios/setupAppScenario.ts';
import { setupMiningAuctionScenario } from '../../scenarios/setupMiningAuctionScenario.ts';
import { setupMiningPortfolioScenario } from '../../scenarios/setupMiningPortfolioScenario.ts';
import { setCertificationGuide } from '../../scenarios/setupCertificationScenario.ts';
import {
  InstallStepErrorType,
  InstallStepKey,
  InstallStepStatus,
  MiningSetupStatus,
  TopTab,
  type IConfig,
} from '../../../src-vue/interfaces/IConfig.ts';
import { Config } from '../../../src-vue/lib/Config.ts';
import type { TransactionInfo } from '../../../src-vue/lib/TransactionInfo.ts';
import { getBot } from '../../../src-vue/stores/bot.ts';
import { getConfig } from '../../../src-vue/stores/config.ts';
import { getInstaller } from '../../../src-vue/stores/installer.ts';
import { getMiningSetup } from '../../../src-vue/stores/wallets.ts';
import { getMyMiningSeats } from '../../../src-vue/stores/myMiningSeats.ts';
import { useFinancials } from '../../../src-vue/stores/financials.ts';
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
  render: (_args, { parameters }) => ({
    components: { AppScreen, Mining },
    setup() {
      function preventCommands(event: Event) {
        if (event instanceof KeyboardEvent && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        if (event.target instanceof Element && event.target.closest('[data-chart-history]')) return;
        event.preventDefault();
        event.stopPropagation();
      }
      return { hoverInfo: Boolean(parameters.hoverInfo), preventCommands };
    },
    template:
      '<AppScreen :interactive="hoverInfo" :scenarioLabel="hoverInfo ? \'Chart details preview\' : undefined"><div class="h-full" @click.capture="preventCommands" @keydown.capture="preventCommands"><Mining /></div></AppScreen>',
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

export const BotStartupFailed: Story = {
  beforeEach: () => {
    setupAppScenario({
      selectedTab: TopTab.Mining,
      config: {
        miningSetupStatus: MiningSetupStatus.Installing,
        isServerAdded: true,
        isServerInstalled: false,
        isServerInstalling: true,
      },
    });
    const config = getConfig();
    config.serverInstaller = Config.getDefault('serverInstaller') as IConfig['serverInstaller'];
    for (const step of Object.values(InstallStepKey)) {
      config.serverInstaller[step].status =
        step === InstallStepKey.MiningLaunch ? InstallStepStatus.Failed : InstallStepStatus.Completed;
      config.serverInstaller[step].progress = step === InstallStepKey.MiningLaunch ? 0 : 100;
    }
    config.serverInstaller.errorType = InstallStepErrorType.MiningLaunch;
    config.serverInstaller.errorMessage = 'Bot startup failed: Local client has not synchronized';
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
          subscribeToProgress: fn((callback: Parameters<TransactionInfo['subscribeToProgress']>[0]) => {
            void callback({
              progressPct: 62,
              progressMessage: 'Waiting for 4th Block...',
              confirmations: 2,
              expectedConfirmations: 4,
              isMaxed: false,
            });
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

export const ChartHistory: Story = {
  parameters: { hoverInfo: true },
  beforeEach: async () => {
    const frameDetails = setupMiningPortfolioScenario();
    getBot().state!.finalizedFrameId = 117;

    const frame = getMyMiningSeats().frames.at(-2)!;
    frame.allMinersCount = 1_440;

    const client = await getBot().getClient();
    const detail = structuredClone(await client.fetch('/mining-frame', frame.id));
    detail.totalBidCount = 144;
    for (const [index, bid] of detail.winningBids.entries()) {
      bid.bidPosition = index;
      bid.microgonsPerSeat = BigInt(58 - index * 2) * 1_000_000n;
    }
    for (let index = detail.winningBids.length; index < 144; index++) {
      detail.winningBids.push({
        address: `5SyntheticAuctionMiner${index}`,
        bidPosition: index,
        microgonsPerSeat: BigInt(52 + (index % 7)) * 1_000_000n,
        micronotsStakedPerSeat: 5_000_000n,
      });
    }
    frameDetails.set(frame.id, detail);
  },
  play: async ({ canvasElement }) => {
    const canvas = await within(canvasElement).findByLabelText('Earnings history');
    const bounds = canvas.getBoundingClientRect();
    const point = Chart.getChart(canvas as HTMLCanvasElement)!
      .getDatasetMeta(1)
      .data.at(-2)!;
    await userEvent.pointer({
      target: canvas,
      coords: { clientX: bounds.left + point.x, clientY: bounds.top + point.y },
      keys: '[MouseLeft]',
    });
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

export const LiveBiddingBeforeEarningsImport: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
    const seats = getMyMiningSeats();
    seats.frames = seats.frames.filter(frame => frame.id < seats.latestFrameId);
  },
};

export const RestoringHistoricalEarnings: Story = {
  parameters: { hoverInfo: true },
  beforeEach: () => {
    setupMiningPortfolioScenario();
    Object.assign(getMyMiningSeats(), { frames: [], miningCohorts: [] });
    const bot = getBot();
    Object.assign(bot.state!, { isSyncing: true, syncProgress: 64.5 });
    bot.syncProgress = 58.05;
  },
};

export const HistoricalEarningsRecoveryNeedsAttention: Story = {
  parameters: { hoverInfo: true },
  beforeEach: () => {
    setupMiningPortfolioScenario();
    const bot = getBot();
    Object.assign(bot.state!, { isSyncing: true, historyError: 'Archive RPC is unavailable' });
  },
};

export const UpdatingHistoricalMiningData: Story = {
  parameters: { hoverInfo: true },
  beforeEach: () => {
    setupMiningPortfolioScenario();
    Object.assign(getMyMiningSeats(), { frames: [], miningCohorts: [] });
    Object.assign(getBot(), { historicalDbProgress: 58, syncProgress: 95.8 });
  },
};

export const PartiallyRecoveredMiningHistory: Story = {
  parameters: { hoverInfo: true },
  beforeEach: () => {
    setupMiningPortfolioScenario();
    const seats = getMyMiningSeats();
    seats.frames = seats.frames.filter(frame => frame.id < seats.latestFrameId);
    seats.global.framesCompleted = 5;
    seats.global.framesRemaining = 56;
    Object.assign(getBot(), { historicalDbProgress: 98, syncProgress: 99.8 });
  },
};

export const UpdatingWithPreviousTotals: Story = {
  beforeEach: () => {
    setupMiningPortfolioScenario();
  },
  render: () => ({
    components: { AppScreen, Mining },
    setup() {
      Vue.onMounted(() => {
        getBot().historicalDbProgress = 58;
        getBot().syncProgress = 95.8;
        const seats = getMyMiningSeats();
        seats.global.framesCompleted = 5;
        seats.global.framesRemaining = 56;
        const summary = useFinancials().financialPositionAggregate.groupSummaries.mining.returnSummary;
        summary.investedCost = 200_000_000n;
        summary.returnAmount = 40_000_000n;
        summary.percent = 20;
      });
      return {};
    },
    template:
      '<AppScreen :interactive="true" scenarioLabel="Tooltip preview"><div class="h-full" @click.capture.stop.prevent @pointerdown.capture.stop.prevent @keydown.capture.stop.prevent><Mining /></div></AppScreen>',
  }),
};

export const HistoricalMiningDataNeedsAttention: Story = {
  parameters: { hoverInfo: true },
  beforeEach: () => {
    setupMiningPortfolioScenario();
    Object.assign(getBot(), { historicalDbProgress: 58, historicalDbError: 'Unable to fetch an old frame' });
  },
};

export const HistoricalSeatPortfolio: Story = {
  parameters: { hoverInfo: true },
  beforeEach: () => {
    setupMiningPortfolioScenario(118);
  },
};

export const ExistingMinerWithCertificationGuide: Story = {
  name: 'Existing miner with certification guide',
  beforeEach: () => {
    setupMiningPortfolioScenario();
    setCertificationGuide(OperationalStepId.FirstMiningSeat);
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
