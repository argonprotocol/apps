import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Accountset,
  BlockWatch,
  CohortBidder,
  createTypedEventEmitter,
  getRange,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { Storage } from '../src/Storage.ts';
import { AutoBidder } from '../src/AutoBidder.ts';
import { History } from '../src/History.ts';

const onBiddingStart = Object.getOwnPropertyDescriptor(AutoBidder.prototype, 'onBiddingStart')!.value as (
  this: AutoBidder,
  cohortActivationFrameId: number,
) => Promise<void>;
const onBiddingEnd = Object.getOwnPropertyDescriptor(AutoBidder.prototype, 'onBiddingEnd')!.value as (
  this: AutoBidder,
  cohortActivationFrameId: number,
  waitForFinalBids?: boolean,
) => Promise<void>;

describe('AutoBidder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes empty capacity for the current auction while the mining bid proxy is unavailable', async () => {
    vi.useFakeTimers();

    const history = new History({} as any, 11);
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argonot-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        planMiningBidProxySetup: vi.fn().mockResolvedValue({ kind: 'tx' }),
      } as any,
      {} as any,
      history,
      {} as any,
      {} as any,
    );
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);
    const createBidderParams = vi.fn();
    const reloadActiveCohort = vi.fn().mockResolvedValue(undefined);
    Object.assign(autoBidder, {
      createBidderParams,
      reloadActiveCohort,
    });

    await onBiddingStart.call(autoBidder, 12);

    expect(createBidderParams).not.toHaveBeenCalled();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).toHaveBeenCalledOnce();
  });

  it('clears a pending proxy retry once bidding can start', async () => {
    vi.useFakeTimers();

    const initCohort = vi.fn();
    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        planMiningBidProxySetup: vi.fn().mockResolvedValueOnce({ kind: 'tx' }).mockResolvedValueOnce({ kind: 'ready' }),
      } as any,
      {} as any,
      { initCohort } as any,
      {} as any,
      {} as any,
    );
    const reloadActiveCohort = vi.fn().mockResolvedValue(undefined);
    const createBidderParams = vi.fn().mockResolvedValue({
      minBid: 0n,
      maxBid: 0n,
      maxSeats: 0,
      bidDelay: 0,
      bidIncrement: 1n,
      sidelinedWalletMicrogons: 0n,
      sidelinedWalletMicronots: 0n,
    });
    Object.assign(autoBidder, {
      createBidderParams,
      reloadActiveCohort,
    });

    await onBiddingStart.call(autoBidder, 12);
    await onBiddingStart.call(autoBidder, 12);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).not.toHaveBeenCalled();
    expect(createBidderParams).toHaveBeenCalledWith(12);
  });

  it('starts bidding without checking proxy setup', async () => {
    const planMiningBidProxySetup = vi.fn();
    const history = new History({} as any, 11);
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        planMiningBidProxySetup,
      } as any,
      {} as any,
      history,
      {} as any,
      {} as any,
    );
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);
    const createBidderParams = vi.fn().mockResolvedValue({
      minBid: 0n,
      maxBid: 0n,
      maxSeats: 0,
      bidDelay: 0,
      bidIncrement: 1n,
      sidelinedWalletMicrogons: 0n,
      sidelinedWalletMicronots: 0n,
    });
    Object.assign(autoBidder, {
      createBidderParams,
    });

    await onBiddingStart.call(autoBidder, 12);

    expect(planMiningBidProxySetup).not.toHaveBeenCalled();
    expect(createBidderParams).toHaveBeenCalledWith(12);
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('retries a failed bidder start while the auction remains open', async () => {
    vi.useFakeTimers();

    const client = {
      query: {
        miningSlot: {
          isNextSlotBiddingOpen: vi.fn().mockResolvedValue(true),
          nextFrameId: vi.fn().mockResolvedValue(12),
        },
      },
    };
    const history = new History({} as any, 11);
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        txSubmitterPair: { address: '5FundingAccount' },
        miningSeatsAndBids: vi.fn().mockResolvedValue([]),
        getAvailableMinerAccounts: vi.fn().mockResolvedValue([{ index: 0, isRebid: false, address: '5MiningAccount' }]),
      } as any,
      {
        prunedClientOrArchivePromise: Promise.resolve(client),
      } as any,
      history,
      {} as any,
      {} as any,
    );
    const createBidderParams = vi.fn().mockResolvedValue({
      minBid: 100_000n,
      maxBid: 1_000_000n,
      maxSeats: 1,
      bidDelay: 1,
      bidIncrement: 10_000n,
      sidelinedWalletMicrogons: 0n,
      sidelinedWalletMicronots: 0n,
    });
    const startBidder = vi
      .spyOn(CohortBidder.prototype, 'start')
      .mockRejectedValueOnce(new Error('temporary RPC failure'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(CohortBidder.prototype, 'stop').mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams,
    });
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);

    await onBiddingStart.call(autoBidder, 12);

    expect(autoBidder.currentBidder).toBeUndefined();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await (autoBidder as any).lifecycleQueue;

    expect(startBidder).toHaveBeenCalledTimes(2);
    expect(autoBidder.currentBidder?.cohortStartingFrameId).toBe(12);
  });

  it('shuts down during a stalled finalized cohort activation without clearing valid capacity', async () => {
    const directory = await mkdtemp(Path.join(tmpdir(), 'autobidder-shutdown-'));
    const storage = new Storage(directory);
    const history = new History(storage, 12);
    const clients = { events: createTypedEventEmitter() } as MainchainClients;
    const blockWatch = new BlockWatch(clients);
    blockWatch.latestHeaders.push({
      isFinalized: true,
      blockNumber: 100,
      blockHash: `0x${'01'.repeat(32)}`,
      parentHash: `0x${'00'.repeat(32)}`,
      blockTime: 100_000,
      tick: 100,
      author: '',
      frameId: 11,
      frameRewardTicksRemaining: 1,
    });
    NetworkConfig.setNetwork('dev-docker');
    const miningFrames = new MiningFrames(clients, blockWatch);
    const accountset = new Accountset({
      client: {} as Accountset['client'],
      txSubmitter: new Keyring({ type: 'sr25519' }).addFromUri('//Alice'),
      subaccountRange: getRange(0, 0),
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'shutdown',
    });
    const cohortBidder = new CohortBidder(accountset, miningFrames, 12, [], {
      minBid: 10_000n,
      maxBid: 10_000n,
      bidIncrement: 10_000n,
      bidDelay: 0,
    });
    const autoBidder = new AutoBidder(accountset, clients, history, null, miningFrames);
    Object.assign(autoBidder, {
      nextCohortActivationFrameId: 12,
      cohortBiddersByActivationFrameId: new Map([[12, cohortBidder]]),
    });
    history.maxSeatsInPlay = 4;
    try {
      // @ts-expect-error reproduce the queued production bidding-end callback
      const biddingEnd = autoBidder.queueLifecycle(() => onBiddingEnd.call(autoBidder, 12));
      await new Promise(setImmediate);
      expect(cohortBidder.isStopping).toBe(true);
      expect(history.maxSeatsInPlay).toBe(4);

      await autoBidder.stop();
      await biddingEnd;

      expect(autoBidder.currentBidder).toBeUndefined();
      expect(history.maxSeatsInPlay).toBe(4);
      expect(blockWatch.finalizedBlockHeader.frameId).toBe(11);
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 1_000);

  it('restores winning bids from current chain state before historical bid files exist', async () => {
    const accountset = {
      isProxy: false,
      txSubmitterPair: { address: '5FundingAccount' },
      subAccountsByAddress: {
        '5AlreadyWinning': { index: 2 },
        '5Available': { index: 3 },
      },
      miningSeatsAndBids: vi.fn().mockResolvedValue([
        { address: '5AlreadyWinning', subaccountIndex: 2, hasWinningBid: true },
        { address: '5Available', subaccountIndex: 3, hasWinningBid: false },
      ]),
      getAvailableMinerAccounts: vi.fn().mockResolvedValue([{ index: 3, isRebid: false, address: '5Available' }]),
    };
    const autoBidder = new AutoBidder(accountset as any, {} as any, new History({} as any, 11), {} as any, {} as any);
    vi.spyOn(CohortBidder.prototype, 'start').mockResolvedValue(undefined);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams: vi.fn().mockResolvedValue({ maxSeats: 2 }),
    });

    await onBiddingStart.call(autoBidder, 12);

    expect(autoBidder.currentBidder?.subaccounts).toEqual([
      { index: 2, isRebid: true, address: '5AlreadyWinning' },
      { index: 3, isRebid: false, address: '5Available' },
    ]);
    expect(accountset.miningSeatsAndBids).toHaveBeenCalledOnce();
  });

  it('clears the completed auction capacity when bidding ends', async () => {
    const history = new History({} as any, 12);
    history.maxSeatsInPlay = 4;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder({} as any, {} as any, history, {} as any, {} as any);
    const bidder = {
      isBiddingOpen: true,
      stop: vi.fn().mockResolvedValue([]),
    };
    Object.assign(autoBidder, {
      nextCohortActivationFrameId: 12,
      cohortBiddersByActivationFrameId: new Map([[12, bidder]]),
    });
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);

    await onBiddingEnd.call(autoBidder, 12, false);

    expect(autoBidder.currentBidder).toBeUndefined();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('reconciles a stale bidder when a new frame arrives without a cohort notification', async () => {
    const client = {
      queryMulti: vi.fn().mockResolvedValue(() => undefined),
      query: {
        miningSlot: {
          isNextSlotBiddingOpen: vi.fn().mockResolvedValue(true),
          nextFrameId: vi.fn().mockResolvedValue(539),
        },
      },
    };
    const miningFrames = {
      events: createTypedEventEmitter<{
        'on-frame': (frame: { frameId: number; blockNumber: number; blockHash: string }) => void;
      }>(),
    };
    const history = new History({} as any, 537);
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        registerKeys: vi.fn(),
      } as any,
      {
        prunedClientOrArchivePromise: Promise.resolve(client),
      } as any,
      history,
      {} as any,
      miningFrames as any,
    );
    const staleBidder = {
      isBiddingOpen: true,
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const createBidderParams = vi.fn().mockResolvedValue({ maxSeats: 0 });
    Object.assign(autoBidder, {
      biddingCalculator: {
        load: vi.fn(),
        unload: vi.fn(),
      },
      cohortBiddersByActivationFrameId: new Map([[537, staleBidder]]),
      nextCohortActivationFrameId: 537,
      createBidderParams,
    });

    await autoBidder.start('ws://argon-miner:9944');

    miningFrames.events.emit('on-frame', {
      frameId: 538,
      blockNumber: 876_000,
      blockHash: '0xframe538',
    });
    await (autoBidder as any).lifecycleQueue;

    expect(autoBidder.currentBidder).toBeUndefined();
    expect(staleBidder.stop).toHaveBeenCalledOnce();
    expect(createBidderParams).toHaveBeenCalledWith(539);
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
  });
});
