import type { Meta, StoryObj } from '@storybook/vue3-vite';
import * as Vue from 'vue';
import { fn, mocked, userEvent, within } from 'storybook/test';
import {
  MoveFrom,
  MoveTo,
  MoveToken,
  UnitOfMeasurement,
  type IBotState,
  type IWinningBid,
} from '@argonprotocol/apps-core';
import { MotionGlobalConfig } from 'motion-v';
import AppScreen from '../../components/AppScreen.vue';
import { setupMiningPortfolioScenario } from '../../scenarios/setupMiningPortfolioScenario.ts';
import basicEmitter from '../../../src-vue/emitters/basicEmitter.ts';
import BiddingBotOverlay from '../../../src-vue/overlays/mining/BiddingBotOverlay.vue';
import MiningScreen from '../../../src-vue/screens/Mining.vue';
import type { MoveCapital } from '../../../src-vue/lib/MoveCapital.ts';
import type { ITransactionMoveMetadata } from '../../../src-vue/lib/txs/Balance.transfer.ts';
import type { TransactionInfo } from '../../../src-vue/lib/TransactionInfo.ts';
import { getBot } from '../../../src-vue/stores/bot.ts';
import { getCurrency } from '../../../src-vue/stores/currency.ts';
import {
  getBiddingCalculator,
  getMainchainClient,
  getMining,
  getMiningFrames,
} from '../../../src-vue/stores/mainchain.ts';
import { getMyMiningSeats } from '../../../src-vue/stores/myMiningSeats.ts';
import { getMoveCapital, useWallets } from '../../../src-vue/stores/wallets.ts';

function createCurrentBids(ownedBidCount: number): IWinningBid[] {
  const firstOwnedBidPosition = 1_400 - ownedBidCount;

  return Array.from({ length: 1_400 }, (_, bidPosition) => ({
    address: `5CurrentBid${bidPosition.toString().padStart(6, '0')}SyntheticAddress`,
    bidPosition,
    microgonsPerSeat: 588_000_000n - BigInt(bidPosition) * 10_722n,
    lastBidAtTick: 2_000_096 - (bidPosition % 30),
    ...(bidPosition >= firstOwnedBidPosition ? { subAccountIndex: bidPosition - firstOwnedBidPosition } : {}),
  }));
}

const currentBids = createCurrentBids(100);

const previousBids: IWinningBid[] = Array.from({ length: 1_386 }, (_, bidPosition) => ({
  address: `5PreviousBid${bidPosition.toString().padStart(6, '0')}SyntheticAddress`,
  bidPosition,
  microgonsPerSeat: 580_000_000n - BigInt(bidPosition) * 10_000n,
  lastBidAtTick: 1_998_700 - (bidPosition % 30),
  ...(bidPosition >= 1_290 ? { subAccountIndex: bidPosition - 1_290 } : {}),
}));

const startAllocationChange = fn<MoveCapital['changeAllocation']>();
const fetchPreviousFrame = fn(async () => ({ winningBids: previousBids }));
const fetchAuctionClose = fn<ReturnType<typeof getMining>['fetchTickAtStartOfAuctionClosing']>();

function createCapitalChangeInProgress(): TransactionInfo<ITransactionMoveMetadata> {
  const microgons = 8_833_860_000n;
  const micronots = 5_000_000_000n;

  return {
    tx: {
      id: 47,
      metadataJson: {
        moveFrom: MoveFrom.DefaultArgon,
        moveTo: MoveTo.MiningBot,
        assetsToMove: { [MoveToken.ARGN]: microgons, [MoveToken.ARGNOT]: micronots },
        allocationChange: {
          id: 'storybook-capital-change',
          targetMicrogons: microgons,
          targetMicronots: micronots,
          legIndex: 0,
          legs: [
            {
              moveFrom: MoveFrom.DefaultArgon,
              moveTo: MoveTo.MiningBot,
              assetsToMove: { [MoveToken.ARGN]: microgons, [MoveToken.ARGNOT]: micronots },
            },
          ],
        },
      },
    },
    getStatus: fn(() => ({ progressPct: 42 })),
    subscribeToProgress: fn((callback: Parameters<TransactionInfo['subscribeToProgress']>[0]) => {
      void callback({
        progressPct: 42,
        progressMessage: 'Waiting for 3rd Block...',
        confirmations: 1,
        expectedConfirmations: 4,
        isMaxed: false,
      });
      return fn();
    }),
  } as unknown as TransactionInfo<ITransactionMoveMetadata>;
}

type BiddingStoryBotState = Pick<
  IBotState,
  | 'isReady'
  | 'isSyncing'
  | 'isBiddingOpen'
  | 'currentTick'
  | 'maxSeatsInPlay'
  | 'maxSeatsReductionReason'
  | 'maximumBidMicrogonsPerSeat'
  | 'winningBids'
  | 'currentAuctionSeatCount'
  | 'currentAuctionMicronotsPerSeat'
  | 'seatGoalCount'
  | 'botCapital'
  | 'lastBid'
  | 'nextBid'
>;

const lastBid: NonNullable<IBotState['lastBid']> = {
  submittedAtTick: 2_000_088,
  expectedFinalizationTick: 2_000_093,
  isFinalized: true,
  microgonsPerSeat: 573_000_000n,
  seats: 100,
  seatsWon: 100,
};

const botState: BiddingStoryBotState = {
  isReady: true,
  isSyncing: false,
  isBiddingOpen: true,
  currentTick: 2_000_100,
  maxSeatsInPlay: 100,
  maximumBidMicrogonsPerSeat: 600_000_000n,
  winningBids: currentBids,
  currentAuctionSeatCount: 144,
  currentAuctionMicronotsPerSeat: 390_740_000n,
  seatGoalCount: 100,
  botCapital: {
    microgons: 58_833_860_000n,
    micronots: 39_084_250_000n,
  },
  lastBid,
  nextBid: undefined,
};

interface IBiddingStoryScenario {
  state: BiddingStoryBotState;
  winningBids?: (IWinningBid & { micronotsStakedPerSeat?: bigint })[];
  miningBotWallet?: Partial<ReturnType<typeof useWallets>['miningBotWallet']>;
  walletMicronots?: bigint;
}

function setBiddingStoryState({
  state,
  winningBids = currentBids,
  miningBotWallet,
  walletMicronots,
}: IBiddingStoryScenario) {
  const currentState = { ...state, winningBids };
  Object.assign(getBot(), { isReady: state.isReady, isSyncing: state.isSyncing, state: currentState });
  const myWinningBids = winningBids.filter(bid => typeof bid.subAccountIndex === 'number');
  Object.assign(getMyMiningSeats(), {
    allWinningBids: winningBids,
    pendingBids: {
      bidCount: myWinningBids.length,
      microgonsBidTotal: myWinningBids.reduce((total, bid) => total + (bid.microgonsPerSeat ?? 0n), 0n),
      micronotsStakedTotal: myWinningBids.reduce((total, bid) => total + (bid.micronotsStakedPerSeat ?? 0n), 0n),
    },
  });
  if (miningBotWallet) Object.assign(useWallets().miningBotWallet, miningBotWallet);
  if (walletMicronots !== undefined) useWallets().defaultArgonWallet.availableMicronots = walletMicronots;
}

function useLimitedByArgonotScenario() {
  setBiddingStoryState({
    state: {
      ...botState,
      maxSeatsInPlay: 95,
      maxSeatsReductionReason: 'insufficient-argonot-balance',
      lastBid: { ...lastBid, seats: 95, seatsWon: 95 },
      nextBid: undefined,
    },
    winningBids: createCurrentBids(95),
    miningBotWallet: {
      availableMicrogons: 4_398_860_000n,
      reservedMicrogons: 54_435_000_000n,
      availableMicronots: 0n,
      reservedMicronots: 37_120_300_000n,
    },
    walletMicronots: 5_000_000_000n,
  });
}

function useLimitedByArgonScenario() {
  setBiddingStoryState({
    state: {
      ...botState,
      maxSeatsInPlay: 92,
      maxSeatsReductionReason: 'insufficient-argon-balance',
      lastBid: { ...lastBid, seats: 92, seatsWon: 92 },
      nextBid: undefined,
    },
    winningBids: createCurrentBids(92),
    miningBotWallet: {
      availableMicrogons: 0n,
      reservedMicrogons: 52_716_000_000n,
      availableMicronots: 3_140_170_000n,
      reservedMicronots: 35_944_080_000n,
    },
  });
}

function useOutbidScenario() {
  setBiddingStoryState({
    state: {
      ...botState,
      nextBid: {
        atTick: 2_000_108,
        microgonsPerSeat: 575_000_000n,
        alreadyWinningSeats: 98,
        seats: 2,
      },
    },
    winningBids: createCurrentBids(98),
    miningBotWallet: {
      availableMicrogons: 2_679_860_000n,
      reservedMicrogons: 56_154_000_000n,
      availableMicronots: 791_730_000n,
      reservedMicronots: 38_292_520_000n,
    },
  });
}

function usePendingBidScenario() {
  setBiddingStoryState({
    state: {
      ...botState,
      lastBid: { ...lastBid, isFinalized: false },
    },
  });
}

function useMaximumBidScenario() {
  setBiddingStoryState({
    state: {
      ...botState,
      maxSeatsInPlay: 96,
      maxSeatsReductionReason: 'max-bid-too-low',
      lastBid: { ...lastBid, seatsWon: 96 },
      nextBid: undefined,
    },
    winningBids: createCurrentBids(96),
    miningBotWallet: {
      availableMicrogons: 3_825_860_000n,
      reservedMicrogons: 55_008_000_000n,
      availableMicronots: 1_573_210_000n,
      reservedMicronots: 37_511_040_000n,
    },
  });
}

function useSmallCapitalRangeScenario() {
  const wallets = useWallets();
  Object.assign(wallets, { defaultArgonSpendableMicrogons: 9_000_000n });
  wallets.miningBotWallet.availableMicrogons = 5_400_000n;
  wallets.miningBotWallet.reservedMicrogons = 0n;
  Object.assign(getMyMiningSeats().pendingBids, {
    bidCount: 0,
    microgonsBidTotal: 0n,
    micronotsStakedTotal: 0n,
  });
}

const meta = {
  title: 'Mining/Bidding bot',
  component: BiddingBotOverlay,
  beforeEach: () => {
    MotionGlobalConfig.skipAnimations = true;
    setupMiningPortfolioScenario();
    const currency = getCurrency();
    currency._key = UnitOfMeasurement.USD;
    currency.record = currency.recordsByKey[UnitOfMeasurement.USD];
    currency.symbol = currency.record.symbol;
    startAllocationChange.mockReset();
    startAllocationChange.mockResolvedValue(undefined);
    getMoveCapital().changeAllocation = startAllocationChange;
    getMoveCapital().data.pendingAllocationChange = undefined;
    setBiddingStoryState({ state: botState });
    fetchPreviousFrame.mockReset();
    fetchPreviousFrame.mockResolvedValue({ winningBids: previousBids });
    fetchAuctionClose.mockReset();
    fetchAuctionClose.mockResolvedValue(2_001_120);
    Object.assign(getBot(), {
      getClient: fn(async () => ({
        fetch: fetchPreviousFrame,
      })),
    });
    Object.assign(getMining(), { fetchTickAtStartOfAuctionClosing: fetchAuctionClose });
  },
  render: (_args, context) => ({
    components: { AppScreen, MiningScreen },
    setup() {
      Vue.onMounted(() => {
        void Vue.nextTick().then(() => {
          basicEmitter.emit('openMiningBiddingBotOverlay');
        });
      });

      return { scenarioLabel: context.name };
    },
    template: `
      <AppScreen interactive interactiveNavigation :scenarioLabel="scenarioLabel">
        <MiningScreen />
      </AppScreen>
    `,
  }),
  args: {
    isOpen: true,
  },
} satisfies Meta<typeof BiddingBotOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkingWithinLimits: Story = {
  name: 'All Current Bids Are Winning',
};

export const OneCurrentWinningBid: Story = {
  name: 'One Current Winning Bid',
  beforeEach: () => {
    setBiddingStoryState({
      state: {
        ...botState,
        lastBid: { ...lastBid, seatsWon: 1 },
      },
      winningBids: createCurrentBids(1),
    });
  },
};

export const AuctionClosedAfterBotTick: Story = {
  name: 'Auction Closed After Bot Tick',
  beforeEach: () => {
    setBiddingStoryState({
      state: {
        ...botState,
        isBiddingOpen: false,
        currentTick: 2_001_110,
        nextBid: undefined,
      },
    });
    getMiningFrames().currentTick = 2_001_116;
    fetchAuctionClose.mockResolvedValue(2_001_116);
  },
};

export const LoadsBidsFromChainWithoutBotServer: Story = {
  name: 'Loads Bids From Chain Without Bot Server',
  beforeEach: () => {
    const chainCurrentBids = [
      {
        accountId: '5SyntheticOurBid1',
        bidAtTick: 2_000_098,
        bid: 574_000_000n,
        argonots: 390_740_000n,
        externalFundingAccount: '5SyntheticMiningBot',
      },
      {
        accountId: '5SyntheticCompetitor1',
        bidAtTick: 2_000_097,
        bid: 572_000_000n,
        argonots: 390_740_000n,
        externalFundingAccount: undefined,
      },
    ];
    const chainPreviousBids = [
      {
        accountId: '5SyntheticOurBid2',
        bidAtTick: 1_998_700,
        bid: 568_000_000n,
        argonots: 380_000_000n,
        externalFundingAccount: '5SyntheticMiningBot',
      },
    ];

    Object.assign(getBot(), {
      isReady: false,
      isSyncing: false,
      state: null,
      getClient: fn(async () => Promise.reject(new Error('Bot server is unavailable.'))),
    });
    Object.assign(getMyMiningSeats(), { allWinningBids: [] });
    mocked(getMainchainClient).mockResolvedValue({
      query: {
        miningSlot: {
          bidsForNextSlotCohort: fn(async () => chainCurrentBids),
          minersByCohort: fn(async () => chainPreviousBids),
        },
      },
    } as unknown as Awaited<ReturnType<typeof getMainchainClient>>);
  },
};

export const CapitalChangeResumes: Story = {
  name: 'Capital Change Resumes',
  beforeEach: () => {
    getMoveCapital().data.pendingAllocationChange = createCapitalChangeInProgress();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
  },
};

export const CapitalChangeSubmissionError: Story = {
  name: 'Capital Change Submission Error',
  beforeEach: () => {
    startAllocationChange.mockRejectedValue(new Error('The mining capital change could not be signed.'));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
    const fundsPopover = await canvas.findByTestId('BiddingBotOverlay.fundsPopover');
    await userEvent.click(within(fundsPopover).getByRole('button', { name: 'Save Changes' }));
  },
};

export const RoundedCapitalSliders: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
    const argonSection = within(await canvas.findByTestId('MiningCapitalForm.argonSection'));
    const argonotSection = within(canvas.getByTestId('MiningCapitalForm.argonotSection'));
    argonSection.getByRole('slider', { name: 'ARGN bidding capital' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    argonotSection.getByRole('slider', { name: 'ARGNOT bidding capital' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
  },
};

export const WholeNumberSliderBelowTen: Story = {
  beforeEach: useSmallCapitalRangeScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
    const argonSection = within(await canvas.findByTestId('MiningCapitalForm.argonSection'));
    argonSection.getByRole('slider', { name: 'ARGN bidding capital' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
  },
};

export const ExactCapitalInput: Story = {
  beforeEach: useSmallCapitalRangeScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
    const argonInput = within(await canvas.findByTestId('MiningCapitalForm.argonSection')).getByTestId('input-number');
    await userEvent.clear(argonInput);
    await userEvent.type(argonInput, '5.37');
    await userEvent.tab();
  },
};

export const ArgonotRequirement: Story = {
  beforeEach: () => {
    const wallets = useWallets();
    Object.assign(wallets, { defaultArgonSpendableMicrogons: 40_000_000_000n });
    Object.assign(getMyMiningSeats().pendingBids, {
      bidCount: 0,
      microgonsBidTotal: 0n,
      micronotsStakedTotal: 0n,
    });
    wallets.defaultArgonWallet.availableMicronots = 30_000_000_000n;
    Object.assign(wallets.miningBotWallet, {
      availableMicrogons: 30_000_000_000n,
      reservedMicrogons: 0n,
      availableMicronots: 20_000_000_000n,
      reservedMicronots: 0n,
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
    const argonInput = within(await canvas.findByTestId('MiningCapitalForm.argonSection')).getByTestId('input-number');
    const argonotInput = within(canvas.getByTestId('MiningCapitalForm.argonotSection')).getByTestId('input-number');
    await userEvent.clear(argonInput);
    await userEvent.type(argonInput, '60000');
    await userEvent.tab();
    await userEvent.clear(argonotInput);
    await userEvent.type(argonotInput, '38000');
    await userEvent.tab();
  },
};

export const HigherLockedBidBalances: Story = {
  beforeEach: () => {
    Object.assign(getMyMiningSeats().pendingBids, {
      bidCount: 7,
      microgonsBidTotal: 57_800_000_000n,
      micronotsStakedTotal: 39_080_000_000n,
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.click(await canvas.findByRole('button', { name: 'Manage bot capital' }));
  },
};

export const LimitedByArgonot: Story = {
  name: 'ARGNOT Only Covers 95 Seats',
  beforeEach: useLimitedByArgonotScenario,
};

export const LimitedByArgonotDetails: Story = {
  beforeEach: useLimitedByArgonotScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByTestId('BiddingBotOverlay.maxSeatsStat'));
  },
};

export const NoSeatCapacity: Story = {
  name: 'ARGNOT Supports No Seats',
  beforeEach: () => {
    setBiddingStoryState({
      state: {
        ...botState,
        maxSeatsInPlay: 0,
        maxSeatsReductionReason: 'insufficient-argonot-balance',
        lastBid: undefined,
      },
      winningBids: [],
      miningBotWallet: {
        availableMicronots: 0n,
        reservedMicronots: 0n,
      },
    });
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByTestId('BiddingBotOverlay.maxSeatsStat'));
  },
};

export const LimitedByArgon: Story = {
  name: 'ARGN Only Covers 92 Seats',
  beforeEach: useLimitedByArgonScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByTestId('BiddingBotOverlay.maxSeatsStat'));
  },
};

export const BidPlannedAfterOutbid: Story = {
  name: 'Recovering 2 Outbid Seats',
  beforeEach: useOutbidScenario,
};

export const OutbidDetails: Story = {
  beforeEach: useOutbidScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByTestId('BiddingBotOverlay.winningBidsStat'));
  },
};

export const BidAwaitingFinalization: Story = {
  name: 'Bid Awaiting Finalization',
  beforeEach: usePendingBidScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByTestId('BiddingBotOverlay.winningBidsStat'));
  },
};

export const StoppedAtMaximumBid: Story = {
  name: 'Next Bid Above $600 Limit',
  beforeEach: useMaximumBidScenario,
};

export const MaximumBidDetails: Story = {
  beforeEach: useMaximumBidScenario,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);

    await userEvent.hover(await canvas.findByTestId('BiddingBotOverlay.maxSeatsStat'));
  },
};
