import fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { Accountset, ArgonApi, MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import {
  BlockWatch,
  type IBlockHeaderInfo,
  type RuntimeSystemEventRecord,
} from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { BlockSync } from '../src/BlockSync.ts';
import { Storage } from '../src/Storage.ts';
import { MiningFrameHistory } from '../src/MiningFrameHistory.ts';
import { createDeferred, Currency, Mining, NetworkConfig } from '@argonprotocol/apps-core';

const dataDirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('uses the historical registrations for seat stakes when frame detail has not been cached', async () => {
  const dataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'mining-frame-history-'));
  dataDirs.push(dataDir);
  const storage = new Storage(dataDir);
  const argonotsPerMiningSeat = vi.fn(async () => 20n);
  const api = {
    query: {
      miningSlot: {
        minersByCohort: async () => [
          { accountId: 'our-miner', externalFundingAccount: 'funding-account', bid: 100n, argonots: 10n },
        ],
        historicalBidsPerSlot: async () => [{ bidsCount: 0 }, { bidsCount: 5 }],
        argonotsPerMiningSeat,
      },
    },
  } as unknown as ArgonApi;
  const history = new MiningFrameHistory(
    storage,
    {
      fundingAccountId: 'funding-account',
      subAccountsByAddress: { 'our-miner': { index: 3 } },
    } as unknown as Accountset,
    {} as MainchainClients,
    {
      framesById: { 4: { firstBlockHash: '0x123', firstBlockNumber: 120, firstBlockTick: 120 } },
      clientAt: async () => api,
      getForTick: () => 4,
    } as unknown as MiningFrames,
    { finalizedBlockHeader: { tick: 120 } } as BlockWatch,
    () => 4,
  );
  try {
    const detail = await history.getDetail(3);
    expect(detail.winningBids).toEqual([
      { address: 'our-miner', subAccountIndex: 3, bidPosition: 0, microgonsPerSeat: 100n, micronotsStakedPerSeat: 10n },
    ]);
    expect((await storage.miningFrameFile(3).get()).winningBids).toEqual(detail.winningBids);
    expect(argonotsPerMiningSeat).not.toHaveBeenCalled();
  } finally {
    await storage.close();
  }
});

it('restarts from a JSON checkpoint without attributing rewards to the new cohort', async () => {
  NetworkConfig.setNetwork('dev-docker');
  const dataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'block-sync-transition-'));
  dataDirs.push(dataDir);
  let storage = new Storage(dataDir);
  const transition = { number: 120, hash: 'hash-120', author: 'our-miner', tick: 120, frameId: 4, isNewFrame: true };
  await storage.close();
  fs.writeFileSync(
    Path.join(dataDir, 'bot-blocks.json'),
    JSON.stringify({
      blocksByNumber: { 119: { ...transition, number: 119, hash: 'hash-119', frameId: 3, isNewFrame: false } },
      syncedToBlockNumber: 119,
      bestBlockNumber: 120,
      finalizedBlockNumber: 120,
    }),
  );

  const blockFees = vi.fn().mockRejectedValueOnce(new Error('fee RPC unavailable')).mockResolvedValue(2n);
  const api = {
    query: {
      miningSlot: {
        historicalBidsPerSlot: async () => [{ bidsCount: 0 }, { bidsCount: 1 }],
        activeMinersCount: async () => 10,
      },
      blockRewards: { blockFees },
    },
  } as unknown as ArgonApi;
  const beforeTransitionApi = { ...api };
  const archive = {
    query: { system: { number: async () => 120 } },
    genesisHash: { toHex: () => 'genesis' },
    rpc: {
      chain: {
        getFinalizedHead: async () => 'hash-120',
        getHeader: async () => ({ number: { toNumber: () => 120 }, parentHash: 'hash-119' }),
        getBlockHash: async () => ({ toHex: () => 'hash-120' }),
      },
    },
    at: async (hash: string) => (hash === 'hash-119' ? beforeTransitionApi : api),
    disconnect: async () => undefined,
  };
  const accountset = {
    fundingAccountId: 'funding-account',
    subAccountsByAddress: { 'our-miner': { index: 0 } },
    loadRegisteredMiners: async (state: ArgonApi) => [
      {
        address: 'our-miner',
        subaccountIndex: 0,
        seat: { startingFrameId: state === beforeTransitionApi ? 3 : 4 },
      },
    ],
  } as unknown as Accountset;
  const mainchainClients = {
    prunedClientPromise: Promise.resolve(archive),
    archiveClientPromise: Promise.resolve(archive),
    events: { on: () => () => undefined },
  } as unknown as MainchainClients;
  const miningFrames = {
    currentFrameId: 5,
    framesById: { 3: { firstBlockNumber: 120 } },
    load: async () => undefined,
    waitForTick: async () => undefined,
    waitForFrameId: async () => undefined,
    getTickStart: () => 100,
    getFrameRewardTicksRemaining: (id: number) => (id === 3 ? 0 : 100),
    getForTick: () => 4,
  } as unknown as MiningFrames;
  const blockWatch = new BlockWatch(mainchainClients);
  blockWatch.latestHeaders = [
    {
      ...transition,
      blockNumber: 120,
      blockHash: 'hash-120',
      parentHash: 'hash-119',
      blockTime: 120,
      isFinalized: true,
    },
  ] as IBlockHeaderInfo[];
  vi.spyOn(blockWatch, 'start').mockResolvedValue();
  const getApi = vi
    .spyOn(blockWatch, 'getApi')
    .mockImplementation(async ({ blockHash }) => (blockHash === 'hash-119' ? beforeTransitionApi : api));
  vi.spyOn(blockWatch, 'getParentHeader').mockImplementation(() => {
    throw new Error('Historical replay must not walk backward from the chain head');
  });
  vi.spyOn(blockWatch, 'getHeaderByBlockNumber').mockImplementation(async (number: number) =>
    number === 119
      ? ({ blockNumber: 119, blockHash: 'hash-119', tick: 119, frameId: 3 } as IBlockHeaderInfo)
      : blockWatch.latestHeaders.find(header => header.blockNumber === number)!,
  );
  const getEventsWithSpec = vi.spyOn(blockWatch, 'getEventsWithSpec').mockImplementation(async ({ blockNumber }) => {
    const events: RuntimeSystemEventRecord[] = [
      {
        topics: [],
        phase: { type: 'Initialization' },
        event: {
          section: 'blockRewards',
          method: 'RewardCreated',
          data: {
            rewards: [
              {
                accountId: 'our-miner',
                argons: 10n,
                ownership: 1n,
                rewardType: { type: 'Miner' },
                blockSealAuthority: null,
              },
            ],
          },
        },
      },
    ];
    if (blockNumber === 120) {
      events.push({
        topics: [],
        phase: { type: 'Finalization' },
        event: {
          section: 'miningSlot',
          method: 'NewMiners',
          data: {
            frameId: 4,
            releasedMiners: 0,
            newMiners: [
              {
                accountId: 'our-miner',
                bid: 50n,
                argonots: 10n,
                startingFrameId: 4,
                externalFundingAccount: null,
                authorityKeys: { grandpa: 'grandpa', blockSealAuthority: 'block-seal' },
                bidAtTick: 119,
              },
            ],
          },
        },
      });
    }
    return { api, events, specVersion: 160 };
  });

  vi.spyOn(Currency.prototype, 'fetchMainchainRates').mockResolvedValue({ USD: 1n, BTC: 1n, ARGNOT: 1n } as any);
  vi.spyOn(Mining.prototype, 'fetchMicrogonsPerBlockForMiner').mockResolvedValue(30n);

  for (const attempt of [0, 1, 2, 3]) {
    storage = new Storage(dataDir);
    const blockSync = new BlockSync(accountset, storage, mainchainClients, miningFrames, blockWatch, 3);
    await storage.migrate(miningFrames);
    try {
      if (attempt === 0) {
        const savedState = await storage.botStateFile().get();
        getApi.mockRejectedValueOnce(new Error('Registration state unavailable'));
        const loads = await Promise.allSettled([blockSync.load(), blockSync.load()]);
        expect(loads.map(result => result.status)).toEqual(['rejected', 'rejected']);
        expect(await storage.botStateFile().get()).toEqual(savedState);
        expect(await storage.earningsFile(3).exists()).toBe(false);

        await expect(blockSync.load()).rejects.toThrow('fee RPC unavailable');
        expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(119);
        for (const _retry of [0, 1]) {
          await blockSync.start();
          expect((await storage.earningsFile(3).get()).earningsByBlock[120].authorCohortActivationFrameId).toBe(3);
          // Model interruption after the earnings write but before the checkpoint write.
          await storage.botStateFile().mutate(x => {
            x.lastProcessedBlockNumber = 119;
            x.lastProcessedBlockHash = 'hash-119';
            x.lastFinalizedProcessedBlockNumber = 119;
            x.lastFinalizedProcessedBlockHash = 'hash-119';
          });
        }

        // A head arriving during a slow read joins the same drain instead of queuing another replay.
        const processingStarted = createDeferred<void>(false);
        const finishProcessing = createDeferred<void>(false);
        const fetchEvents = blockWatch.getEventsWithSpec.bind(blockWatch);
        vi.spyOn(blockWatch, 'getEventsWithSpec').mockImplementationOnce(async block => {
          processingStarted.resolve();
          await finishProcessing.promise;
          return fetchEvents(block);
        });
        const processed: number[] = [];
        blockSync.didProcessBlock = ({ blockNumber }) => processed.push(blockNumber);
        const activePass = blockSync.start();
        await processingStarted.promise;
        const joinedStart = blockSync.start();
        const joinedLoad = blockSync.load();
        const nextHeader = {
          ...blockWatch.bestBlockHeader,
          blockNumber: 121,
          blockHash: 'hash-121',
          parentHash: 'hash-120',
          tick: 121,
          isFinalized: false,
          isNewFrame: false,
        };
        blockWatch.latestHeaders.push(nextHeader);
        for (let i = 0; i < 1000; i++) {
          blockWatch.events.emit('best-blocks', [nextHeader]);
          blockWatch.events.emit('finalized', [blockWatch.finalizedBlockHeader]);
        }
        vi.useFakeTimers();
        finishProcessing.resolve();
        await Promise.all([activePass, joinedStart, joinedLoad]);
        expect(processed).toEqual([120, 121]);
        expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(121);
        expect((await storage.earningsFile(4).get()).earningsByBlock[121].authorCohortActivationFrameId).toBe(4);

        // A caught-up bot remains idle until another BlockWatch event.
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(processed).toEqual([120, 121]);
        vi.useRealTimers();

        // Shutdown finishes the active block, then ignores further heads.
        const shutdownProcessingStarted = createDeferred<void>(false);
        const finishShutdownProcessing = createDeferred<void>(false);
        getEventsWithSpec.mockImplementationOnce(async block => {
          shutdownProcessingStarted.resolve();
          await finishShutdownProcessing.promise;
          return fetchEvents(block);
        });
        const lastHeader = {
          ...nextHeader,
          blockNumber: 122,
          blockHash: 'hash-122',
          parentHash: 'hash-121',
          tick: 122,
        };
        blockWatch.latestHeaders.push(lastHeader);
        blockWatch.events.emit('best-blocks', [lastHeader]);
        await shutdownProcessingStarted.promise;
        const lastPass = blockSync.start();
        blockWatch.events.emit('best-blocks', [lastHeader]);
        let shutdownFinished = false;
        const shutdown = blockSync.stop().then(() => {
          shutdownFinished = true;
        });
        try {
          await setImmediate();
          expect(shutdownFinished).toBe(false);
          expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(121);
        } finally {
          finishShutdownProcessing.resolve();
          await Promise.all([lastPass, shutdown]);
        }
        blockWatch.events.emit('best-blocks', [lastHeader]);
        await setImmediate();
        expect(processed).toEqual([120, 121, 122]);
        expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(122);
        expect((await storage.earningsFile(3).get()).earningsByBlock[120].authorCohortActivationFrameId).toBe(3);
      } else {
        await blockSync.load();
        expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(122);
        expect((await storage.botStateFile().get()).oldestFrameIdToSync).toBe(3);
        const earnings = await storage.earningsFile(3).get();
        expect(earnings.earningsByBlock[120]).toMatchObject({
          authorCohortActivationFrameId: 3,
          microgonsMined: 10n,
          micronotsMined: 1n,
        });
        expect(Object.keys(earnings.earningsByBlock)).toEqual(['120']);
        expect(earnings.microgonToUsd).toEqual([1n]);
        expect((await storage.bidsFile(3, 4).get()).seatCountWon).toBe(1);
      }
    } finally {
      await blockSync.stop();
      await storage.close();
    }
    if (attempt === 1) {
      // An explicit resync removes the checkpoint; the same starting frame still reproduces the same earnings.
      fs.rmSync(Path.join(dataDir, 'bot-state.json'));
    }
    if (attempt === 2) {
      // An unusable upgrade checkpoint falls back to the configured starting frame and reproduces the same earnings.
      fs.rmSync(Path.join(dataDir, 'bot-state.json'));
      fs.rmSync(Path.join(dataDir, 'storage-version.json'));
      fs.writeFileSync(
        Path.join(dataDir, 'bot-blocks.json'),
        JSON.stringify({ syncedToBlockNumber: 119, blocksByNumber: {} }),
      );
    }
  }
  blockWatch.destroy();
});

it('recovers a replaced checkpoint after the archive client changes and persists the recovery position', async () => {
  const dataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'block-sync-reorg-'));
  dataDirs.push(dataDir);
  let storage = new Storage(dataDir);
  await storage.botStateFile().mutate(x => {
    x.oldestFrameIdToSync = 1;
    x.lastProcessedBlockNumber = 102;
    x.lastProcessedBlockHash = 'orphan-102';
    x.lastFinalizedProcessedBlockNumber = 100;
    x.lastFinalizedProcessedBlockHash = 'finalized-100';
    x.earningsLastModifiedAt = new Date(1_000);
    x.bidsLastModifiedAt = new Date(1_000);
  });
  await storage.earningsFile(1).mutate(x => {
    x.firstBlockNumber = 100;
    x.lastBlockNumber = 103;
    for (const number of [100, 101, 102, 103]) {
      x.earningsByBlock[number] = {
        blockHash: `block-${number}`,
        authorCohortActivationFrameId: 1,
        authorAddress: 'our-miner',
        blockMinedAt: '2026-10-01T00:00:00Z',
        microgonsMined: 10n,
        micronotsMined: 0n,
        microgonsMinted: 0n,
        microgonFeesCollected: 0n,
      };
    }
  });
  const orphanReward = (await storage.earningsFile(1).get()).earningsByBlock[103];
  await storage.earningsFile(2).mutate(x => {
    x.firstBlockNumber = 103;
    x.lastBlockNumber = 103;
    x.earningsByBlock[103] = orphanReward;
  });
  await storage.bidsFile(1, 2).mutate(x => {
    x.lastBlockNumber = 103;
    x.seatCountWon = 2;
    x.microgonsBidTotal = 20n;
    x.argonotPriceAtBid = 2n;
    x.micronotsStakedPerSeat = 5n;
    x.microgonsToBeMinedPerBlock = 10n;
    x.allMinersCount = 10;
    x.transactionFeesByBlock = { 101: 1n, 102: 2n, 103: 3n };
  });
  await storage.miningFrameFile(1).mutate(x => {
    x.auctionCloseTick = 102;
    x.totalBidCount = 2;
    x.winningBids = [{ address: 'orphan-miner', microgonsPerSeat: 10n, micronotsStakedPerSeat: 5n }];
  });
  await storage.bidsFile(0, 1).mutate(x => {
    x.lastBlockNumber = 100;
    x.seatCountWon = 1;
    x.microgonsBidTotal = 7n;
  });

  const api = {} as ArgonApi;
  const archive = {
    query: { system: { number: async () => 100 } },
    genesisHash: { toHex: () => 'genesis' },
    rpc: {
      chain: {
        getFinalizedHead: async () => 'finalized-100',
        getHeader: async () => ({ number: { toNumber: () => 100 } }),
      },
    },
    at: vi.fn(async () => api),
    disconnect: vi.fn(),
  };
  const mainchainClients = {
    prunedClientPromise: Promise.resolve(archive),
    archiveClientPromise: Promise.resolve(archive),
    events: { on: () => () => undefined },
  } as unknown as MainchainClients;
  const accountset = {
    loadRegisteredMiners: vi
      .fn()
      .mockRejectedValueOnce(new Error('Registration state unavailable'))
      .mockResolvedValue([]),
  } as unknown as Accountset;
  const blockWatch = new BlockWatch(mainchainClients);
  const headers = [
    { blockNumber: 100, blockHash: 'finalized-100', tick: 100, isFinalized: true, frameId: 1, isNewFrame: false },
    {
      blockNumber: 101,
      blockHash: 'shared-101',
      parentHash: 'finalized-100',
      tick: 101,
      isFinalized: false,
      frameId: 1,
      isNewFrame: false,
    },
  ] as IBlockHeaderInfo[];
  blockWatch.latestHeaders = headers;
  vi.spyOn(blockWatch, 'start').mockResolvedValue();
  vi.spyOn(blockWatch, 'getHeaderByBlockNumber').mockImplementation(async number => {
    if (number > blockWatch.bestBlockHeader.blockNumber) throw new Error('Block is beyond the current best chain');
    return headers[number === 100 ? 0 : 1];
  });
  const readHeader = blockWatch.getHeader.bind(blockWatch);
  vi.spyOn(blockWatch, 'getHeader').mockImplementation(async block => {
    if (typeof block === 'number') return readHeader(block);
    const { blockNumber } = block;
    return {
      blockNumber,
      blockHash: `orphan-${blockNumber}`,
      parentHash: `orphan-${blockNumber - 1}`,
    } as IBlockHeaderInfo;
  });
  vi.spyOn(blockWatch, 'getParentHeader').mockImplementation(async ({ blockNumber }) =>
    blockNumber === 102
      ? headers[1]
      : ({ blockNumber: 100, blockHash: 'orphan-100', parentHash: 'orphan-99' } as IBlockHeaderInfo),
  );
  const miningFrames = {
    currentFrameId: 2,
    load: async () => undefined,
    waitForTick: async () => undefined,
    waitForFrameId: async () => undefined,
    getTickStart: () => 100,
    getFrameRewardTicksRemaining: () => 100,
  } as unknown as MiningFrames;
  vi.spyOn(blockWatch, 'getEventsWithSpec').mockResolvedValue({ api, events: [], specVersion: 160 });
  vi.spyOn(Currency.prototype, 'fetchMainchainRates').mockResolvedValue({ USD: 1n, BTC: 1n, ARGNOT: 1n } as any);
  let blockSync = new BlockSync(accountset, storage, mainchainClients, miningFrames, blockWatch);
  await blockSync.ensureCurrentStateReady();
  archive.at.mockRejectedValue(new Error('Previous archive client disconnected'));
  const replacement = { ...archive, at: async () => api, disconnect: vi.fn() };
  mainchainClients.archiveClientPromise = Promise.resolve(
    replacement,
  ) as unknown as MainchainClients['archiveClientPromise'];

  const checkpointBeforeRewind = await storage.botStateFile().get();
  await expect(blockSync.load()).rejects.toThrow('Registration state unavailable');
  expect(await storage.botStateFile().get()).toEqual(checkpointBeforeRewind);
  expect(Object.keys((await storage.earningsFile(1).get()).earningsByBlock)).toEqual(['100', '101', '102', '103']);
  const rename = fs.promises.rename.bind(fs.promises);
  const failedFeeWrite = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (to === storage.getPath('bot-bids/frame-1-2.json')) throw new Error('Fee write failed');
    await rename(from, to);
  });
  await expect(blockSync.start()).rejects.toThrow('Fee write failed');
  // Earnings can be trimmed before a later file fails; the old cursor keeps that retry restart-safe.
  expect(await storage.botStateFile().get()).toEqual(checkpointBeforeRewind);
  expect(Object.keys((await storage.earningsFile(1).get()).earningsByBlock)).toEqual(['100', '101']);
  expect((await storage.miningFrameFile(1).get()).winningBids).toEqual([]);
  expect((await storage.bidsFile(1, 2).get()).lastBlockNumber).toBe(103);
  await blockSync.stop();
  await storage.close();
  failedFeeWrite.mockRestore();
  storage = new Storage(dataDir);
  blockSync = new BlockSync(accountset, storage, mainchainClients, miningFrames, blockWatch);
  await blockSync.start();
  expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(101);
  expect((await storage.botStateFile().get()).earningsLastModifiedAt.getTime()).toBeGreaterThan(1_000);
  expect((await storage.botStateFile().get()).bidsLastModifiedAt.getTime()).toBeGreaterThan(1_000);
  expect(Object.keys((await storage.earningsFile(1).get()).earningsByBlock)).toEqual(['100', '101']);
  expect((await storage.earningsFile(1).get()).lastBlockNumber).toBe(101);
  expect((await storage.earningsFile(2).get()).lastBlockNumber).toBe(0);
  expect(await storage.bidsFile(1, 2).get()).toMatchObject({
    lastBlockNumber: 0,
    seatCountWon: 0,
    microgonsBidTotal: 0n,
    argonotPriceAtBid: 0n,
    micronotsStakedPerSeat: 0n,
    microgonsToBeMinedPerBlock: 0n,
    allMinersCount: 0,
    transactionFeesByBlock: { 101: 1n },
  });
  expect(await storage.miningFrameFile(1).get()).toMatchObject({ totalBidCount: 0, winningBids: [], slots: [] });
  expect((await storage.miningFrameFile(1).get()).auctionCloseTick).toBeUndefined();
  expect(await storage.bidsFile(0, 1).get()).toMatchObject({
    lastBlockNumber: 100,
    seatCountWon: 1,
    microgonsBidTotal: 7n,
  });
  await blockSync.stop();
  expect(archive.disconnect).not.toHaveBeenCalled();
  expect(replacement.disconnect).not.toHaveBeenCalled();
  await storage.close();

  const restarted = new Storage(dataDir);
  expect(Object.keys((await restarted.earningsFile(1).get()).earningsByBlock)).toEqual(['100', '101']);
  expect((await restarted.earningsFile(2).get()).earningsByBlock).toEqual({});
  expect(await restarted.bidsFile(1, 2).get()).toMatchObject({
    lastBlockNumber: 0,
    transactionFeesByBlock: { 101: 1n },
  });
  expect((await restarted.miningFrameFile(1).get()).winningBids).toEqual([]);
  expect(await restarted.botStateFile().get()).toMatchObject({
    lastProcessedBlockNumber: 101,
    lastProcessedBlockHash: 'shared-101',
    lastFinalizedProcessedBlockNumber: 100,
    lastFinalizedProcessedBlockHash: 'finalized-100',
  });
  await restarted.botStateFile().mutate(x => {
    x.lastProcessedBlockNumber = 101;
    x.lastProcessedBlockHash = 'orphan-101';
  });
  blockWatch.latestHeaders = [{ ...headers[1], isFinalized: true }];
  const finalizedSync = new BlockSync(accountset, restarted, mainchainClients, miningFrames, blockWatch);
  await finalizedSync.start();
  expect((await restarted.botStateFile().get()).lastProcessedBlockHash).toBe('shared-101');
  await finalizedSync.stop();
  await restarted.close();
  blockWatch.destroy();
});

it('saves a finalized processed block behind the live tip for restart', async () => {
  const dataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'block-sync-finalized-'));
  dataDirs.push(dataDir);
  const storage = new Storage(dataDir);
  await storage.botStateFile().mutate(x => {
    x.lastProcessedBlockNumber = 102;
    x.lastProcessedBlockHash = 'best-102';
    x.lastFinalizedProcessedBlockNumber = 100;
    x.lastFinalizedProcessedBlockHash = 'finalized-100';
  });

  const mainchainClients = { events: { on: () => () => undefined } } as unknown as MainchainClients;
  const blockWatch = new BlockWatch(mainchainClients);
  const headers = [
    { blockNumber: 100, blockHash: 'finalized-100', tick: 100, isFinalized: true },
    { blockNumber: 101, blockHash: 'finalized-101', tick: 101, isFinalized: false },
    { blockNumber: 102, blockHash: 'best-102', tick: 102, isFinalized: false },
  ] as IBlockHeaderInfo[];
  blockWatch.latestHeaders = headers;
  const blockSync = new BlockSync({} as Accountset, storage, mainchainClients, {} as MiningFrames, blockWatch);
  const pendingPath = Path.join(dataDir, 'bot-state.json.tmp');
  await blockSync.start();
  fs.mkdirSync(pendingPath);
  try {
    headers[1].isFinalized = true;
    blockWatch.latestHeaders = headers.slice(1);
    blockWatch.events.emit('finalized', [headers[1]]);
    await expect(blockSync.start()).rejects.toThrow();
    expect((await storage.botStateFile().get()).lastFinalizedProcessedBlockNumber).toBe(100);
    fs.rmSync(pendingPath, { recursive: true });
    await vi.waitFor(
      async () => {
        expect((await storage.botStateFile().get()).lastFinalizedProcessedBlockNumber).toBe(101);
      },
      { timeout: 3000 },
    );
  } finally {
    await blockSync.stop();
  }
  blockWatch.destroy();
  await storage.close();

  const restarted = new Storage(dataDir);
  expect(await restarted.botStateFile().get()).toMatchObject({
    lastProcessedBlockNumber: 102,
    lastProcessedBlockHash: 'best-102',
    lastFinalizedProcessedBlockNumber: 101,
    lastFinalizedProcessedBlockHash: 'finalized-101',
  });
  await restarted.close();
});
