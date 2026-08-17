import * as Vue from 'vue';
import { type IWinningBid, NetworkConfig } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import { MiningSetupStatus, TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getBot } from '../../src-vue/stores/bot.ts';
import { getConfig } from '../../src-vue/stores/config.ts';
import { getInstaller } from '../../src-vue/stores/installer.ts';
import { getBiddingCalculator, getMining } from '../../src-vue/stores/mainchain.ts';
import { getMyMiningSeats } from '../../src-vue/stores/myMiningSeats.ts';
import { setupAppScenario } from './setupAppScenario.ts';

export type MiningAuctionScenario =
  | 'connecting'
  | 'syncing'
  | 'submitting'
  | 'winningOne'
  | 'winningMany'
  | 'argonShortage'
  | 'argonotShortage'
  | 'bothShortage'
  | 'bidLimitExceeded';

const tickAtStartOfNextCohort = Date.UTC(2030, 0, 1) / NetworkConfig.tickMillis;
const tickAtStartOfAuctionClosing = Date.UTC(2030, 0, 2) / NetworkConfig.tickMillis;
const microgonRequirement = 500_000_000n;
const micronotRequirement = 250_000_000n;
const zeroSeatScenarios = new Set<MiningAuctionScenario>([
  'argonShortage',
  'argonotShortage',
  'bothShortage',
  'bidLimitExceeded',
]);

export function setupMiningAuctionScenario(state: MiningAuctionScenario): void {
  const { config, wallets } = setupAppScenario({
    selectedTab: TopTab.Mining,
    config: {
      miningSetupStatus: MiningSetupStatus.Finished,
      hasMiningSeats: false,
      isServerAdded: true,
      isServerInstalled: true,
    },
  });

  config.isLoadedPromise = Promise.resolve();
  wallets.totalMiningMicrogons = microgonRequirement;
  wallets.miningBotWallet.availableMicrogons = 0n;
  Object.assign(wallets, { totalMiningMicronots: micronotRequirement });

  let winningBids: IWinningBid[] = [];
  if (state === 'winningMany') {
    winningBids = createWinningBids(2);
  } else if (state === 'winningOne') {
    winningBids = createWinningBids(1);
  } else if (state === 'bidLimitExceeded') {
    winningBids = [{ address: '5SyntheticExternalBid', bidPosition: 1, microgonsPerSeat: 100_000_000n }];
  }
  const pendingBids = state === 'winningMany' || state === 'winningOne' ? winningBids : [];
  const myMiningSeats = Vue.reactive({
    allWinningBids: winningBids,
    pendingBids: {
      bidCount: pendingBids.length,
      microgonsBidTotal: BigInt(pendingBids.length) * 75_000_000n,
      micronotsStakedTotal: BigInt(pendingBids.length) * 50_000_000n,
    },
    subscribeToActivity: fn(async () => undefined),
    unsubscribeFromActivity: fn(async () => undefined),
  });
  mocked(getMyMiningSeats, { partial: true }).mockReturnValue(
    myMiningSeats as unknown as ReturnType<typeof getMyMiningSeats>,
  );

  const calculatorSubscribers = new Set<() => void>();
  mocked(getBiddingCalculator, { partial: true }).mockReturnValue({
    data: { getMaxFrameSeats: fn(() => 2) },
    maximumBidAmount: 75_000_000n,
    load: fn(async () => {
      for (const subscriber of calculatorSubscribers) subscriber();
    }),
    onLoad: fn((subscriber: () => void) => {
      calculatorSubscribers.add(subscriber);
      return { unsubscribe: fn(() => calculatorSubscribers.delete(subscriber)) };
    }),
    runProjections: fn(() => ({ microgonRequirement, micronotRequirement })),
  } as unknown as ReturnType<typeof getBiddingCalculator>);
  mocked(getMining, { partial: true }).mockReturnValue({
    fetchTickAtStartOfAuctionClosing: fn(async () => tickAtStartOfAuctionClosing),
    fetchTickAtStartOfNextCohort: fn(async () => tickAtStartOfNextCohort),
  } as unknown as ReturnType<typeof getMining>);
  mocked(getInstaller).mockReturnValue(Vue.reactive({ isRunning: false }) as ReturnType<typeof getInstaller>);

  const bot = Vue.reactive({
    isReady: state !== 'connecting' && state !== 'syncing',
    isSyncing: state === 'syncing',
    isBroken: false,
    syncProgress: 60,
    state: {
      maxSeatsInPlay: zeroSeatScenarios.has(state) ? 0 : 2,
    },
  });
  mocked(getBot, { partial: true }).mockReturnValue(bot as unknown as ReturnType<typeof getBot>);

  if (state === 'winningOne' || state === 'winningMany') {
    config.hasMiningBids = true;
    return;
  }

  if (state === 'argonShortage' || state === 'bothShortage') {
    wallets.totalMiningMicrogons = 0n;
  }
  if (state === 'argonotShortage' || state === 'bothShortage') {
    Object.assign(wallets, { totalMiningMicronots: 0n });
  }
}

function createWinningBids(count: number): IWinningBid[] {
  return Array.from({ length: count }, (_, index) => ({
    address: `5SyntheticWinningBid${index + 1}`,
    subAccountIndex: index,
    bidPosition: index + 1,
    microgonsPerSeat: 75_000_000n,
  }));
}
