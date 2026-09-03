import * as Vue from 'vue';
import { numericToAlpha, type IMiningFrameDetail, type IMiningSlot, type IWinningBid } from '@argonprotocol/apps-core';
import { fn, mocked } from 'storybook/test';
import type { IDashboardFrameStats } from '../../src-vue/interfaces/IMiningSeatStats.ts';
import { MiningSetupStatus, TopTab } from '../../src-vue/interfaces/IConfig.ts';
import { getBot } from '../../src-vue/stores/bot.ts';
import { useFinancials } from '../../src-vue/stores/financials.ts';
import { getDbPromise } from '../../src-vue/stores/helpers/dbPromise.ts';
import { getBlockWatch, getMining, getMiningFrames } from '../../src-vue/stores/mainchain.ts';
import { getMyMiningSeats } from '../../src-vue/stores/myMiningSeats.ts';
import { getWalletKeys } from '../../src-vue/stores/wallets.ts';
import { setupAppScenario } from './setupAppScenario.ts';

export function setupMiningPortfolioScenario(selectedFrameId = 120) {
  setupAppScenario({
    selectedTab: TopTab.Mining,
    config: {
      miningSetupStatus: MiningSetupStatus.Finished,
      hasMiningSeats: true,
      isServerInstalled: true,
    },
  });

  const frames = Array.from({ length: 12 }, (_, index) => createFrame(109 + index));
  const liveSlots = createMiningSlots(120);
  const historicalSlots = createMiningSlots(118, true);
  const winningBids = createWinningBids();
  const detailsByFrame = new Map<number, IMiningFrameDetail>([
    [120, createFrameDetail(120, liveSlots, winningBids)],
    [118, createFrameDetail(118, historicalSlots, winningBids.slice(1))],
  ]);
  const myMiningSeats = Vue.reactive({
    isLoaded: true,
    latestFrameId: 120,
    selectedFrameId,
    frames,
    global: {
      seatsTotal: 23,
      framesCompleted: 17,
      framesRemaining: 44,
      framedCost: 875_000_000n,
      microgonsBidTotal: 1_280_000_000n,
      transactionFeesTotal: 2_300_000n,
      micronotsMinedTotal: 86_000_000n,
      microgonsMinedTotal: 340_000_000n,
      microgonsMintedTotal: 52_000_000n,
      microgonValueOfRewards: 465_000_000n,
    },
    allWinningBids: winningBids,
    currentFrameBids: [],
    activeSeats: {
      seatCount: 6,
      microgonsBidTotal: 420_000_000n,
      micronotsStakedTotal: 24_000_000n,
      microgonsMinedTotal: 180_000_000n,
      micronotsMinedTotal: 31_000_000n,
      microgonsMintedTotal: 22_000_000n,
      microgonsToBeMined: 95_000_000n,
      microgonsToBeMinted: 15_000_000n,
      micronotsToBeMined: 12_000_000n,
      microgonValueRemaining: 210_000_000n,
    },
    selectFrameId: fn((frameId: number) => {
      myMiningSeats.selectedFrameId = frameId;
      return true;
    }),
    subscribeToDashboard: fn(async () => undefined),
    subscribeToActivity: fn(async () => undefined),
    unsubscribeFromDashboard: fn(async () => undefined),
    unsubscribeFromActivity: fn(async () => undefined),
    refresh: fn(async () => undefined),
  });

  mocked(getMyMiningSeats).mockReturnValue(myMiningSeats as unknown as ReturnType<typeof getMyMiningSeats>);
  mocked(getBot).mockReturnValue(
    Vue.reactive({
      isReady: true,
      isSyncing: false,
      state: {
        finalizedFrameId: 120,
        lastBid: {
          submittedAtTick: 2_000_080,
          expectedFinalizationTick: 2_000_085,
          isFinalized: true,
          microgonsPerSeat: 58_000_000n,
          seats: 2,
        },
        nextBid: { atTick: 2_000_130, microgonsPerSeat: 63_000_000n, alreadyWinningSeats: 1, seats: 2 },
      },
      refreshState: fn(async () => undefined),
      getClient: fn(async () => ({
        fetch: fn(
          async (_path: string, frameId: number) =>
            detailsByFrame.get(frameId) ?? createFrameDetail(frameId, createMiningSlots(frameId), winningBids),
        ),
      })),
    }) as unknown as ReturnType<typeof getBot>,
  );
  mocked(getMining, { partial: true }).mockReturnValue({
    fetchCurrentMiningSeats: fn(async () => liveSlots),
    fetchTickAtStartOfAuctionClosing: fn(async () => 2_000_120),
  });
  mocked(getMiningFrames, { partial: true }).mockReturnValue({
    currentTick: 2_000_100,
    currentFrameId: 120,
    load: fn(async () => undefined),
    getTickEnd: fn((frameId: number) => 2_000_000 + frameId * 10),
    getCurrentFrameProgress: fn(() => 62),
    onTick: fn(() => ({ unsubscribe: fn() })),
  });
  mocked(getBlockWatch).mockReturnValue({
    latestHeaders: [{ author: '5SyntheticOurMiner' }],
    bestBlockHeader: { author: '5SyntheticOurMiner' },
    start: fn(async () => undefined),
    events: { on: fn(() => fn()) },
  } as unknown as ReturnType<typeof getBlockWatch>);
  mocked(getWalletKeys, { partial: true }).mockReturnValue({
    defaultArgonAddress: '5SyntheticInternalWallet',
    getMiningBotSubaccounts: fn(async () => ({
      '5SyntheticOurBid1': { index: 0 },
      '5SyntheticOurBid2': { index: 1 },
    })),
  });
  mocked(getDbPromise).mockReturnValue(
    Promise.resolve({
      bitcoinFissionsTable: { fetchAll: fn(async () => []) },
      cohortsTable: {
        fetchByIds: fn(async (ids: number[]) =>
          ids.map(id => ({
            id,
            microgonsToBeMinedPerSeat: 42_000_000n,
            micronotsToBeMinedPerSeat: 8_000_000n,
            argonotPriceAtBid: 14_000_000n,
          })),
        ),
      },
    }) as unknown as ReturnType<typeof getDbPromise>,
  );
  mocked(useFinancials).mockReturnValue(
    Vue.reactive({
      financialPositionAggregate: {
        groupSummaries: {
          mining: {
            returnSummary: {
              investedCost: 875_000_000n,
              returnAmount: 196_000_000n,
              paidIncome: 465_000_000n,
              percent: 22.4,
            },
          },
        },
      },
    }) as unknown as ReturnType<typeof useFinancials>,
  );
}

function createFrame(id: number): IDashboardFrameStats {
  const activeSeatCount = Math.max(0, id - 112);
  return {
    id,
    date: `2026-08-${String(id - 105).padStart(2, '0')}`,
    firstTick: 2_000_000 + id * 10 - 9,
    allMinersCount: 40 + (id % 8),
    seatCountActive: activeSeatCount,
    seatCostTotalFramed: BigInt(activeSeatCount) * 55_000_000n,
    accruedMicrogonProfits: BigInt(activeSeatCount) * 9_000_000n,
    blocksMinedTotal: activeSeatCount * 74,
    microgonToUsd: [1_000_000n],
    microgonToArgonot: [14_000_000n],
    microgonsMinedTotal: BigInt(activeSeatCount) * 11_000_000n,
    microgonsMintedTotal: BigInt(activeSeatCount) * 3_000_000n,
    micronotsMinedTotal: BigInt(activeSeatCount) * 2_000_000n,
    microgonFeesCollectedTotal: BigInt(activeSeatCount) * 500_000n,
    microgonValueOfRewards: BigInt(activeSeatCount) * 14_000_000n,
    progress: id === 120 ? 62 : 100,
    profit: activeSeatCount * 9,
    profitPct: activeSeatCount * 1.2,
    score: activeSeatCount * 12,
    expected: {
      blocksMinedTotal: activeSeatCount * 95,
      micronotsMinedTotal: BigInt(activeSeatCount) * 3_000_000n,
      microgonsMinedTotal: BigInt(activeSeatCount) * 14_000_000n,
      microgonsMintedTotal: BigInt(activeSeatCount) * 4_000_000n,
      microgonValueOfRewards: BigInt(activeSeatCount) * 17_000_000n,
    },
  };
}

function createFrameDetail(
  frameId: number,
  slots: IMiningSlot[],
  winningBids: (IWinningBid & { micronotsStakedPerSeat: bigint })[],
): IMiningFrameDetail {
  return {
    frameId,
    totalBidCount: 47,
    myLastBidMicrogons: 58_000_000n,
    winningBids,
    slots,
    expectedAuctionCloseTick: 2_000_160,
  };
}

function createWinningBids(): (IWinningBid & { micronotsStakedPerSeat: bigint })[] {
  return [
    { address: '5SyntheticOurBid1', bidPosition: 2, microgonsPerSeat: 63_000_000n, micronotsStakedPerSeat: 9_000_000n },
    {
      address: '5SyntheticCompetitor1',
      bidPosition: 4,
      microgonsPerSeat: 60_000_000n,
      micronotsStakedPerSeat: 7_500_000n,
    },
    { address: '5SyntheticOurBid2', bidPosition: 7, microgonsPerSeat: 57_000_000n, micronotsStakedPerSeat: 6_500_000n },
    {
      address: '5SyntheticCompetitor2',
      bidPosition: 9,
      microgonsPerSeat: 52_000_000n,
      micronotsStakedPerSeat: 5_000_000n,
    },
  ];
}

function createMiningSlots(frameId: number, historical = false): IMiningSlot[] {
  return Array.from({ length: 10 }, (_, slotId) => ({
    slotId,
    seats: Array.from({ length: 5 }, (_, index) => {
      const isOurs = (slotId + index) % 7 === 0;
      const isEmpty = (slotId + index) % 6 === 0;
      const hasBid = slotId === frameId % 10 && index >= 2;
      return {
        id: `${numericToAlpha(slotId)}${index + 1}`,
        index,
        slotId,
        miner: isEmpty
          ? null
          : {
              startingFrameId: frameId - ((slotId + index) % 9),
              address: isOurs ? '5SyntheticOurMiner' : `5SyntheticCompetitor${slotId}${index}`,
              isOurs,
              bidAmount: BigInt(48 + slotId + index) * 1_000_000n,
              micronotsStaked: BigInt(5 + index) * 1_000_000n,
            },
        bid: hasBid
          ? {
              startingFrameId: frameId + (historical ? 0 : 10),
              slotId,
              address: index === 2 ? '5SyntheticOurBid1' : `5SyntheticChallenger${index}`,
              bidAmount: BigInt(64 - index) * 1_000_000n,
              micronotsStaked: BigInt(8 - index) * 1_000_000n,
            }
          : null,
      };
    }),
  }));
}
