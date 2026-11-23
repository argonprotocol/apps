import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick, watch } from 'vue';
import BigNumber from 'bignumber.js';
import { getOfflineRegistry } from '@argonprotocol/mainchain';
import {
  BlockWatch,
  Currency,
  Mining,
  NetworkConfig,
  createTypedEventEmitter,
  type ArgonClient,
  type IBlockHeaderInfo,
  type MainchainClients,
} from '@argonprotocol/apps-core';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { createDeferred } from '../../core/src/Deferred.ts';
import { GlobalMiningStats } from '../lib/GlobalMiningStats.ts';
import type { Db } from '../lib/Db.ts';
import { createTestDb } from './helpers/db.ts';
import { FinancialCacheTypes } from '../lib/db/FinancialCacheTable.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { AccountRecoverySnapshot } from '../../e2e/local-mainnet/AccountRecoverySnapshot.ts';
import { reduceFinancialPositions } from '../lib/financials/index.ts';

const mocks = vi.hoisted(() => ({
  mining: undefined as Mining | undefined,
  currency: undefined as Currency | undefined,
  blockWatch: undefined as BlockWatch | undefined,
  db: undefined as Db | undefined,
}));

vi.mock('../stores/mainchain.ts', () => ({
  getMining: () => mocks.mining,
  getBlockWatch: () => mocks.blockWatch,
}));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => mocks.currency }));
vi.mock('../stores/helpers/dbPromise.ts', () => ({ getDbPromise: () => Promise.resolve(mocks.db!) }));
vi.mock('../../core/src/fetch.ts', () => ({
  fetch: async () => ({ ok: true, json: async () => ({ rates: { GBP: 1, EUR: 1, INR: 1 }, price: '100' }) }),
}));

import { useMiningStats } from '../stores/miningStats.ts';

let pinia: Pinia;
let chain: ReturnType<typeof createChain>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  NetworkConfig.setNetwork('mainnet');
  NetworkConfig.setRuntimeOverride('mainnet', { genesisTick: 0, ticksBetweenFrames: 4 });
  pinia = createPinia();
  setActivePinia(pinia);
  chain = createChain();
  mocks.mining = new Mining(chain.clients);
  mocks.currency = new Currency(chain.clients);
  mocks.blockWatch = chain.blockWatch;
  mocks.db = await createTestDb();
});

afterEach(async () => {
  disposePinia(pinia);
  NetworkConfig.clearRuntimeOverride('mainnet');
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await mocks.db?.close();
});

it('restores daily sale estimates after cache retry and restart', { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(Path.join(tmpdir(), 'mining-cache-snapshot-'));
  const databasePath = Path.join(directory, 'database.sqlite');
  const db = await createTestDb(databasePath);
  try {
    chain.state.twoCohorts = true;
    chain.state.latestBlock = 6;
    vi.spyOn(chain.archive.rpc.chain, 'getBlockHash').mockImplementation(async block => ({
      toHex: () => `${block}-other-fork`,
    }));
    const genesisHash = getOfflineRegistry().createType('Hash', `0x${'11'.repeat(32)}`);
    Object.assign(chain.client, { genesisHash });
    const cache = Promise.resolve(db.financialCacheTable);
    const stats = new GlobalMiningStats(new Mining(chain.clients), mocks.currency!, cache);
    vi.spyOn(db.financialCacheTable, 'upsert').mockRejectedValueOnce(new Error('Cache write interrupted'));
    await stats.update();
    // Frame1 expected20 ARGNOT/seat at2; future frames10/seat. Total ARGN400 + ARGNOT420.
    expect(stats.aggregatedBlockRewards).toBe(820n);
    expect(
      await db.financialCacheTable.get(FinancialCacheTypes.GlobalMiningStats, genesisHash.toHex()),
    ).toBeUndefined();
    const beforeRetry = AccountRecoverySnapshot.capture({
      databasePath,
      financials: reduceFinancialPositions([]),
    });
    await stats.update();
    const saved = await db.financialCacheTable.get(FinancialCacheTypes.GlobalMiningStats, genesisHash.toHex());
    expect(saved?.frames).toMatchObject([
      { frameId: 1, blockNumber: 1, blockHash: '1', micronotsPerSeat: 20n, argonotPrice: 2_000_000n },
      { frameId: 2, blockNumber: 5, blockHash: '5', micronotsPerSeat: 10n, argonotPrice: 2_000_000n },
    ]);
    const afterRetry = AccountRecoverySnapshot.capture({
      databasePath,
      financials: reduceFinancialPositions([]),
    });
    expect(() => AccountRecoverySnapshot.assertEquivalent(beforeRetry, afterRetry, 'mining cache retry')).not.toThrow();

    chain.archive.at.mockClear();
    chain.archive.at.mockRejectedValue(new Error('Daily snapshots are no longer available'));
    chain.state.latestPrice = 1;
    const restarted = new GlobalMiningStats(new Mining(chain.clients), mocks.currency!, cache);
    await restarted.update();
    // The40 of past daily ARGNOT sales stays40; future sales fall from380 to190.
    expect(restarted.aggregatedBlockRewards).toBe(630n);
    expect(restarted.investedCapital).toBe(700n);
    expect(chain.archive.at).not.toHaveBeenCalled();
    const readHash = chain.client.rpc.chain.getBlockHash;
    vi.spyOn(chain.client.rpc.chain, 'getBlockHash').mockImplementation(async block => {
      if (block === saved!.frames.at(-1)!.blockNumber) return { toHex: () => 'replacement-chain' };
      return readHash(block);
    });
    const reset = new GlobalMiningStats(new Mining(chain.clients), mocks.currency!, cache);
    await expect(reset.update()).rejects.toThrow('Daily snapshots are no longer available');
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('publishes a complete estimate after daily observations load', async () => {
  chain.state.twoCohorts = true;
  chain.state.latestBlock = 6;
  const history = createDeferred<void>();
  const readSnapshot = chain.archive.at.getMockImplementation()!;
  chain.archive.at.mockImplementation(async hash => {
    if (hash === '1') await history.promise;
    return readSnapshot(hash);
  });
  const stats = useMiningStats();
  await vi.advanceTimersByTimeAsync(0);
  expect(stats.averageAPY).toBeUndefined();
  expect(stats.hasCurrentStats).toBe(false);
  history.resolve();
  await stats.isLoadedPromise;
  expect(stats.investedCapital).toBe(700n);
  expect(stats.aggregatedBlockRewards).toBe(820n);
  expect(stats.projectedProfit).toBe(420n);
  expect(stats.averageAPY).toBeCloseTo((1.6 ** 36.5 - 1) * 100);
});

it('reuses global mining returns within a frame and refreshes them at the finalized frame turn', async () => {
  chain.blockWatch.latestHeaders = [{ ...chain.finalizedHeader, frameId: 1 }];
  const stats = useMiningStats();
  await stats.isLoadedPromise;
  expect(stats.aggregatedBlockRewards).toBe(800n);
  const reads = chain.client.rpc.chain.getFinalizedHead.mock.calls.length;

  chain.state.latestBlock = 3;
  await stats.update();
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(reads);
  expect(stats.aggregatedBlockRewards).toBe(800n);

  chain.blockWatch.events.emit('finalized', [chain.blockWatch.finalizedBlockHeader]);
  await vi.advanceTimersByTimeAsync(0);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(reads);

  chain.state.latestBlock = 6;
  chain.state.twoCohorts = true;
  chain.blockWatch.latestHeaders = [{ ...chain.finalizedHeader, blockNumber: 6, tick: 6, frameId: 2 }];
  chain.blockWatch.events.emit('finalized', [chain.blockWatch.finalizedBlockHeader]);
  await vi.advanceTimersByTimeAsync(0);
  expect(stats.activeMiningSeatCount).toBe(2);
  expect(stats.aggregatedBlockRewards).toBe(820n);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(reads + 1);
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

  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  await vi.advanceTimersByTimeAsync(0);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledOnce();

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

it('keeps the previous quote visible if the new frame observation fails, then publishes its retry', async () => {
  const stats = useMiningStats();
  await stats.isLoadedPromise;
  const previous = stats.averageAPY;
  chain.state.twoCohorts = true;
  chain.state.latestBlock = 6;
  chain.state.archiveUnavailable = true;
  await expect(stats.update()).rejects.toThrow('Archive temporarily unavailable');
  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.averageAPY).toBe(previous);
  chain.state.archiveUnavailable = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(stats.aggregatedBlockRewards).toBe(820n);
  expect(stats.averageAPY).toBeCloseTo((1.6 ** 36.5 - 1) * 100);
  expect(stats.error).toBe('');
});

it('retains the last quote through refresh failure and publishes the newer quote after retry', async () => {
  const stats = useMiningStats();
  await stats.isLoadedPromise;
  expect(stats.aggregatedBlockRewards).toBe(800n);

  chain.state.latestBlock = 3;
  chain.state.latestPrice = 3;
  chain.client.rpc.chain.getFinalizedHead.mockRejectedValueOnce(new Error('Finalized head temporarily unavailable'));
  await expect(stats.update()).rejects.toThrow('Finalized head temporarily unavailable');
  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(700n);
  expect(stats.averageAPR).toBe(12_775);

  await vi.advanceTimersByTimeAsync(1_000);

  expect(stats.aggregatedBlockRewards).toBe(1_000n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(900n);
  expect(stats.averageAPR).toBe(16_425);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(3);
});

it('recovers existing observers on finalization after the delayed retry budget is exhausted', async () => {
  chain.state.archiveUnavailable = true;
  const stats = useMiningStats();
  const observedRates: (number | undefined)[] = [];
  const stopWatching = watch(
    () => stats.averageAPR,
    rate => observedRates.push(rate),
    { immediate: true },
  );
  await expect(stats.isLoadedPromise).rejects.toThrow('Archive temporarily unavailable');

  for (const delay of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(4);
  expect(stats.averageAPR).toBeUndefined();

  chain.state.archiveUnavailable = false;
  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();

  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.averageAPR).toBe(12_775);
  expect(observedRates).toEqual([undefined, 12_775]);

  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(5);
  stopWatching();
});

it('preserves a loaded quote through exhausted retries and publishes one recovered refresh on finalization', async () => {
  const stats = useMiningStats();
  await stats.isLoadedPromise;
  const observedRates: (number | undefined)[] = [];
  const stopWatching = watch(
    () => stats.averageAPR,
    rate => observedRates.push(rate),
    { immediate: true },
  );

  chain.state.latestBlock = 3;
  chain.state.latestPrice = 3;
  chain.client.rpc.chain.getFinalizedHead.mockRejectedValue(new Error('Finalized head temporarily unavailable'));
  await expect(stats.update()).rejects.toThrow('Finalized head temporarily unavailable');
  for (const delay of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay);

  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  await vi.advanceTimersByTimeAsync(0);
  expect(stats.aggregatedBlockRewards).toBe(800n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(700n);
  expect(observedRates).toEqual([12_775]);

  const head = createDeferred<string>();
  chain.client.rpc.chain.getFinalizedHead.mockReturnValue(head.promise);
  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  head.resolve('3');
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();

  expect(stats.aggregatedBlockRewards).toBe(1_000n);
  expect(stats.investedCapital).toBe(200n);
  expect(stats.projectedProfit).toBe(900n);
  expect(observedRates).toEqual([12_775, 16_425]);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(7);
  stopWatching();
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

it('stops finalized-block recovery when disposed after retry exhaustion', async () => {
  chain.state.archiveUnavailable = true;
  const stats = useMiningStats();
  await expect(stats.isLoadedPromise).rejects.toThrow('Archive temporarily unavailable');
  for (const delay of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay);

  stats.$dispose();
  chain.state.archiveUnavailable = false;
  chain.blockWatch.events.emit('finalized', [chain.finalizedHeader]);
  await vi.advanceTimersByTimeAsync(60_000);

  expect(stats.averageAPR).toBeUndefined();
  expect(stats.aggregatedBlockRewards).toBe(0n);
  expect(chain.client.rpc.chain.getFinalizedHead).toHaveBeenCalledTimes(4);
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
  const state = { latestBlock: 2, latestPrice: 2, archiveUnavailable: false, twoCohorts: false };
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
      blockSeal: { isBlockFromVoteSeal: async () => true },
      ticks: { currentTick: async () => block },
      priceIndex: { current: async () => priceIndex(block) },
      miningSlot: {
        activeMinersCount: async () => (state.twoCohorts && block >= 5 ? 2 : 1),
        nextFrameId: async () => (state.twoCohorts && block >= 5 ? 3 : 2),
        frameStartBlockNumbers: async () => (state.twoCohorts && block >= 5 ? [1, 5] : [1]),
        frameRewardTicksRemaining: async () => (state.twoCohorts && block >= 5 ? 9 - block : 5 - block),
        minerNonceScoringByCohort: async () => {
          const score = { nonce: 1n, lastWinBlock: block, blocksWonInFrame: block - 1, frameStartBlocksWonSurplus: 0n };
          if (state.twoCohorts && block >= 5) {
            return { 1: [{ ...score, blocksWonInFrame: 0 }], 2: [{ ...score, blocksWonInFrame: block - 5 }] };
          }
          return { 1: [score] };
        },
        minersByCohort: {
          entries: async () => {
            const cohorts = [[{ args: [1] }, [{ bid: 100n, argonots: 50n }]]];
            if (state.twoCohorts && block >= 5) cohorts.push([{ args: [2] }, [{ bid: 300n, argonots: 100n }]]);
            return cohorts;
          },
        },
      },
      blockRewards: {
        blockRewardsByCohort: async () => [[1, 20n], [2, 20n], ...(state.twoCohorts && block >= 5 ? [[3, 20n]] : [])],
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
    rpc: {
      chain: {
        getFinalizedHead: vi.fn(async () => String(state.latestBlock)),
        getBlockHash: async (block: number) => ({ toHex: () => String(block) }),
      },
    },
    at: async (hash: string) => snapshot(Number(hash)),
  };
  const archive = {
    rpc: {
      chain: {
        getFinalizedHead: async () => String(state.latestBlock),
        getHeader: async (hash: string) => getOfflineRegistry().createType('Header', { number: Number(hash) }),
        getBlockHash: async (block: number) => ({ toHex: () => String(block) }),
      },
    },
    at: vi.fn(async (hash: string) => {
      if (state.archiveUnavailable) throw new Error('Archive temporarily unavailable');
      return snapshot(Number.parseInt(hash));
    }),
  };
  const clients = {
    prunedClientPromise: Promise.resolve(client as unknown as ArgonClient),
    prunedClientOrArchivePromise: Promise.resolve(client as unknown as ArgonClient),
    archiveClientPromise: Promise.resolve(archive as unknown as ArgonClient),
    events: createTypedEventEmitter(),
  } as unknown as MainchainClients;
  const blockWatch = new BlockWatch(clients);
  const finalizedHeader: IBlockHeaderInfo = {
    isFinalized: true,
    blockNumber: 3,
    blockHash: '0x03',
    parentHash: '0x02',
    blockTime: 3_000,
    tick: 3,
    author: 'synthetic-miner',
  };
  return { state, client, archive, clients, blockWatch, finalizedHeader };
}
