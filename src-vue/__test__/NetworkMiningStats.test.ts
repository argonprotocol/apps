import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick, watch } from 'vue';
import { EventEmitter } from 'node:events';
import BigNumber from 'bignumber.js';
import { Currency, Mining, NetworkConfig, type ArgonClient, type MainchainClients } from '@argonprotocol/apps-core';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { createDeferred } from '../../core/src/Deferred.ts';

const mocks = vi.hoisted(() => ({
  mining: undefined as Mining | undefined,
  currency: undefined as Currency | undefined,
}));

vi.mock('../stores/mainchain.ts', () => ({ getMining: () => mocks.mining }));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => mocks.currency }));
vi.mock('../../core/src/fetch.ts', () => ({
  fetch: async () => ({ ok: true, json: async () => ({ rates: { GBP: 1, EUR: 1, INR: 1 }, price: '100' }) }),
}));

import { useMiningStats } from '../stores/miningStats.ts';

let pinia: Pinia;
let chain: ReturnType<typeof createChain>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.setRuntimeOverride('mainnet', { genesisTick: 0, ticksBetweenFrames: 4 });
  pinia = createPinia();
  setActivePinia(pinia);
  chain = createChain();
  mocks.mining = new Mining(chain.clients);
  mocks.currency = new Currency(chain.clients);
});

afterEach(() => {
  disposePinia(pinia);
  NetworkConfig.clearRuntimeOverride('mainnet');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('publishes a mining quote to existing observers when an automatic retry recovers initial archive failure', async () => {
  chain.state.archiveUnavailable = true;
  const stats = useMiningStats();
  const observedRates: (number | undefined)[] = [];
  const stopWatching = watch(
    () => stats.averageAPR,
    rate => observedRates.push(rate),
    { immediate: true },
  );

  await expect(Promise.all([stats.isLoadedPromise, stats.update()])).rejects.toThrow('Archive temporarily unavailable');
  expect(observedRates).toEqual([undefined]);

  chain.state.archiveUnavailable = false;
  await vi.advanceTimersByTimeAsync(1_000);
  await nextTick();

  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(700n);
  expect(observedRates).toEqual([undefined, 12_775]);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(2);
  stopWatching();
});

it('retains the last quote through refresh failure and publishes the newer quote after retry', async () => {
  const stats = useMiningStats();
  await stats.isLoadedPromise;
  expect(stats.aggregatedBlockRewards).toBe(800n);

  chain.state.latestBlock = 3;
  chain.state.latestPrice = 3;
  chain.state.archiveUnavailable = true;
  await expect(stats.update()).rejects.toThrow('Archive temporarily unavailable');
  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(700n);
  expect(stats.averageAPR).toBe(12_775);

  chain.state.archiveUnavailable = false;
  await vi.advanceTimersByTimeAsync(1_000);

  expect(stats.aggregatedBlockRewards).toBe(1_000n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(900n);
  expect(stats.averageAPR).toBe(16_425);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(3);
});

it('stops after three delayed retries and still accepts a later explicit refresh', async () => {
  chain.state.archiveUnavailable = true;
  const stats = useMiningStats();
  await expect(stats.isLoadedPromise).rejects.toThrow('Archive temporarily unavailable');

  for (const delay of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(4);
  expect(stats.averageAPR).toBeUndefined();

  chain.state.archiveUnavailable = false;
  await stats.update();
  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.averageAPR).toBe(12_775);
});

it('cancels a scheduled retry when the store is disposed', async () => {
  chain.state.archiveUnavailable = true;
  const stats = useMiningStats();
  await expect(stats.isLoadedPromise).rejects.toThrow('Archive temporarily unavailable');

  stats.$dispose();
  chain.state.archiveUnavailable = false;
  await vi.advanceTimersByTimeAsync(10_000);

  expect(stats.averageAPR).toBeUndefined();
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
});

it('does not schedule a retry when an in-flight refresh fails after disposal', async () => {
  const head = createDeferred<string>();
  chain.client.rpc.chain.getFinalizedHead.mockReturnValueOnce(head.promise);
  const stats = useMiningStats();
  await vi.advanceTimersByTimeAsync(0);

  stats.$dispose();
  head.reject(new Error('Finalized head temporarily unavailable'));
  await expect(stats.isLoadedPromise).rejects.toThrow('Finalized head temporarily unavailable');
  await vi.advanceTimersByTimeAsync(10_000);

  expect(stats.averageAPR).toBeUndefined();
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();
});

function createChain() {
  const state = { latestBlock: 2, latestPrice: 2, archiveUnavailable: false };
  const priceIndex = (block: number): HistoricalQueryRecord<'priceIndex', 'current'> => ({
    btcUsdPrice: new BigNumber(100),
    argonUsdPrice: new BigNumber(1),
    argonUsdTargetPrice: new BigNumber(1),
    argonotUsdPrice: new BigNumber(block >= 2 ? state.latestPrice : 2),
    argonTimeWeightedAverageLiquidity: new BigNumber(0),
    tick: block,
  });
  const snapshot = (block: number) => ({
    consts: {
      blockRewards: {
        startingArgonsPerBlock: 20n,
        startingOwnershipTokensPerBlock: 10n,
        minerPayoutPercent: new BigNumber(0.5),
        incrementalGrowth: [0n, 1_000n, 10n],
        halvingBeginTicks: 1_000_000,
        halvingTicks: 1_000_000,
      },
    },
    query: {
      system: { number: async () => block },
      ticks: { currentTick: async () => block },
      priceIndex: { current: async () => priceIndex(block) },
      miningSlot: {
        activeMinersCount: async () => 1,
        nextFrameId: async () => 2,
        frameStartBlockNumbers: async () => [1],
        frameRewardTicksRemaining: async () => 5 - block,
        minerNonceScoringByCohort: async () => ({
          1: [{ nonce: 1n, lastWinBlock: block, blocksWonInFrame: block - 1, frameStartBlocksWonSurplus: 0n }],
        }),
        minersByCohort: {
          entries: async () => [[{ args: [1] }, [{ bid: 100n, argonots: 50n }]]],
        },
      },
      blockRewards: {
        blockRewardsByCohort: async () => [
          [1, 20n],
          [2, 20n],
        ],
        payoutsByBlock: async () => [],
      },
      mint: { miningMintPerCohort: async () => ({}) },
    },
  });
  const client = {
    query: {
      priceIndex: {
        current: async (callback?: unknown) => (callback ? () => undefined : priceIndex(state.latestBlock)),
      },
    },
    rpc: { chain: { getFinalizedHead: vi.fn(async () => String(state.latestBlock)) } },
    at: async (hash: string) => snapshot(Number(hash)),
  };
  const archive = {
    rpc: { chain: { getBlockHash: async (block: number) => ({ toHex: () => String(block) }) } },
    at: async (hash: string) => {
      if (state.archiveUnavailable) throw new Error('Archive temporarily unavailable');
      return snapshot(Number(hash));
    },
  };
  const clients = {
    prunedClientPromise: Promise.resolve(client as unknown as ArgonClient),
    prunedClientOrArchivePromise: Promise.resolve(client as unknown as ArgonClient),
    archiveClientPromise: Promise.resolve(archive as unknown as ArgonClient),
    events: new EventEmitter(),
  } as unknown as MainchainClients;
  return { state, client, clients };
}
