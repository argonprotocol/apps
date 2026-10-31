import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Accountset,
  BlockWatch,
  BotActivityType,
  CohortBidder,
  createTypedEventEmitter,
  createArgonClient,
  createDeferred,
  getRange,
  MainchainClients,
  Mining,
  MiningFrames,
  NetworkConfig,
  RangeCohortBidder,
  TxResult,
  TxSubmitter,
  JsonExt,
  type IHistoryFile,
  type ArgonClient,
} from '@argonprotocol/apps-core';
import { getOfflineRegistry, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import { Storage } from '../src/Storage.ts';
import { AutoBidder } from '../src/AutoBidder.ts';
import { History } from '../src/History.ts';
import BiddingCalculator from '@argonprotocol/apps-core/src/BiddingCalculator.ts';
import * as Fs from 'node:fs';

const reconcileAuction = Object.getOwnPropertyDescriptor(AutoBidder.prototype, 'reloadActiveCohort')!.value as (
  this: AutoBidder,
  refreshOptions?: boolean,
) => Promise<void>;
const openAuctionClient = {
  query: { miningSlot: { isNextSlotBiddingOpen: async () => true, nextFrameId: async () => 12 } },
};
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

  it.for([
    { scenario: 'handles delayed storage before broadcast', storageOutcome: 'delayed', resumeBidding: true },
    { scenario: 'handles failed storage before broadcast', storageOutcome: 'failed', resumeBidding: true },
    {
      scenario: 'publishes a recovered winner while bidding stays disabled',
      storageOutcome: 'delayed',
      resumeBidding: false,
    },
  ])('$scenario', async ({ storageOutcome, resumeBidding }) => {
    NetworkConfig.setNetwork('dev-docker');
    const directory = await mkdtemp(Path.join(tmpdir(), 'autobidder-prepared-'));
    let storage = new Storage(directory);
    let history = new History(storage, 10);
    const registry = getOfflineRegistry();
    const pallet = registry.metadata.pallets.find(entry => entry.name.eq('MiningSlot'))!;
    const bidMeta = registry.lookup
      .getSiType(pallet.calls.unwrap().type)
      .def.asVariant.variants.find(entry => entry.name.eq('bid'))!;
    const funding = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
    const address = Accountset.createMiningSubaccount(funding.address, 0);
    const nextAddress = Accountset.createMiningSubaccount(funding.address, 1);
    let settled = false;
    let evicted = false;
    let biddingOpen = true;
    let pendingBlock: number | undefined;
    let maxHash = '';
    const account = registry.createType('FrameSystemAccountInfo', { providers: 1, data: { free: 100_000_000n } });
    const client = createArgonClient({
      registry,
      genesisHash: registry.createType('H256', `0x${'00'.repeat(32)}`),
      consts: { balances: { existentialDeposit: 10_000n }, miningSlot: { bidRevealBlocks: 5, bidIncrements: 10_000n } },
      tx: { miningSlot: { bid: { meta: bidMeta } } },
      queryMulti: async () => () => undefined,
      query: {
        system: {
          account: Object.assign(async () => account, {
            multi: async (addresses: string[]) => addresses.map(() => account),
          }),
        },
        ownership: { account: async () => registry.createType('PalletBalancesAccountData', { free: 1_000_000n }) },
        miningSlot: {
          nextFrameId: async () => registry.createType('u64', 10),
          auctionRulesStartAt: async () => registry.createType('u64', 1),
          nextCohortSize: async () => registry.createType('u32', 10),
          argonotsPerMiningSeat: async () => registry.createType('u128', 10_000n),
          isNextSlotBiddingOpen: async () => biddingOpen,
          auctionAdmissionClosed: async () => false,
          bidsForNextSlotCohort: async () => {
            const bids = [];
            if (settled && !evicted) {
              bids.push({
                accountId: address,
                externalFundingAccount: funding.address,
                bid: 10_000n,
                argonots: 10_000n,
              });
            }
            return registry.createType('Vec<ArgonPrimitivesBlockSealMiningRegistration>', bids);
          },
          standingBids: {
            multi: async () => {
              if (!settled || evicted) return [];
              return [
                registry.createType('Option<PalletMiningSlotStandingBid>', { max: 1_000_000n, submittedAt: 100 }),
              ];
            },
          },
          pendingBids: {
            multi: async (addresses: string[]) =>
              addresses.map(miner => {
                if (pendingBlock === undefined || settled || miner !== address) {
                  return registry.createType('Option<PalletMiningSlotPendingBid>', null);
                }
                return registry.createType('Option<PalletMiningSlotPendingBid>', {
                  block: pendingBlock,
                  frame: 10,
                  funding: funding.address,
                  miner: address,
                  bid: 10_000n,
                  maxHash,
                });
              }),
          },
        },
      },
      at: async () => client,
    } as unknown as Parameters<typeof createArgonClient>[0]);
    const accountset = new Accountset({
      client,
      txSubmitter: funding,
      subaccountRange: [0, 1],
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
    });
    const commitment = accountset.miningBidCommitment({ address, frameId: 10, bidAmount: 10_000n, maxBid: 1_000_000n });
    maxHash = commitment.maxHash;
    vi.spyOn(accountset, 'registerKeys').mockResolvedValue(undefined);
    vi.spyOn(accountset, 'loadRegisteredMiners').mockResolvedValue([
      { subaccountIndex: 0, address, isLastDay: false },
      { subaccountIndex: 1, address: nextAddress, isLastDay: false },
    ]);

    const clients = {
      events: createTypedEventEmitter(),
      prunedClientOrArchivePromise: Promise.resolve(client),
    } as MainchainClients;
    const blockWatch = new BlockWatch(clients);
    const header = {
      isFinalized: false,
      blockNumber: 100,
      blockHash: `0x${'01'.repeat(32)}`,
      parentHash: `0x${'00'.repeat(32)}`,
      tick: 100,
      frameId: 9,
      frameRewardTicksRemaining: 30,
      blockTime: 100_000,
      author: '',
    };
    blockWatch.latestHeaders = [{ ...header, isFinalized: true, blockNumber: 96 }, header];
    blockWatch.subscriptionClient = client;
    vi.spyOn(blockWatch, 'start').mockResolvedValue(undefined);
    const frames = new MiningFrames(clients, blockWatch);
    vi.spyOn(frames, 'load').mockResolvedValue(undefined);
    let autoBidder = new AutoBidder(accountset, clients, history, {} as never, frames);
    // Pricing is unchanged; keep controller, bidder, persistence and reveal decisions real.
    const loadPricing = vi.spyOn(BiddingCalculator.prototype, 'load').mockResolvedValue(undefined);
    Object.defineProperty(autoBidder, 'createBidderParams', {
      value: async () => ({ minBid: 10_000n, maxBid: 1_000_000n, maxSeats: 1, bidDelay: 0, bidIncrement: 10_000n }),
    });

    const saveGate = createDeferred<void>();
    const pricingGate = createDeferred<void>();
    const save = history.saveBidMaxima.bind(history);
    vi.spyOn(history, 'saveBidMaxima').mockImplementation(async (frameId, maxima) => {
      await saveGate.promise;
      await save(frameId, maxima);
    });
    const commitResult = new TxResult({
      signedHash: `0x${'11'.repeat(32)}`,
      method: {},
      submittedTime: new Date(),
      submittedAtBlockNumber: 100,
      accountAddress: funding.address,
      nonce: 0,
    });
    const revealResult = new TxResult({ ...commitResult.extrinsic, signedHash: `0x${'22'.repeat(32)}`, nonce: 1 });
    const commitSubmitter = new TxSubmitter(client, registry.createType('Extrinsic') as never, funding);
    const revealSubmitter = new TxSubmitter(client, registry.createType('Extrinsic') as never, funding);
    for (const submitter of [commitSubmitter, revealSubmitter]) {
      vi.spyOn(submitter, 'feeEstimate').mockResolvedValue(1_000n);
      vi.spyOn(submitter, 'signMortal').mockResolvedValue({
        signedTx: submitter.tx,
        birthBlock: 96,
        deathBlock: 108,
        tip: 0n,
      });
    }
    let broadcastHash = maxHash;
    const commitments = vi.spyOn(accountset, 'createMiningBidTx').mockImplementation(async args => {
      broadcastHash = accountset.miningBidCommitment({
        address: args.subaccounts[0].address,
        bidAmount: args.bidAmount,
        maxBid: args.maxBid!,
        frameId: args.frameId!,
      }).maxHash;
      return commitSubmitter;
    });
    const revealRequests = vi.spyOn(accountset, 'createMiningBidMaxTx').mockResolvedValue(revealSubmitter);
    const committedMaxima: bigint[] = [];
    const broadcasts: number[] = [];
    vi.spyOn(commitSubmitter, 'submitSigned').mockImplementation(async () => {
      broadcasts.push(blockWatch.bestBlockHeader.blockNumber);
      const saved: IHistoryFile = JsonExt.parse(await readFile(storage.getPath('bot-history/frame-10.json'), 'utf8'));
      committedMaxima.push(saved.preparedBidMaxima![broadcastHash]);
      return commitResult;
    });
    const revealedAt: number[] = [];
    vi.spyOn(revealSubmitter, 'submitSigned').mockImplementation(async () => {
      revealedAt.push(blockWatch.bestBlockHeader.blockNumber);
      return revealResult;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await autoBidder.start('http://synthetic-keystore');
      await new Promise(setImmediate);
      expect(broadcasts).toEqual([]);
      expect(committedMaxima).toEqual([]);
      expect(await history.getBidMaxima(10)).toEqual({});
      if (storageOutcome === 'failed') {
        vi.spyOn(Fs.promises, 'rename').mockRejectedValueOnce(
          Object.assign(new Error('intent write failed'), { code: 'ENOENT' }),
        );
        saveGate.resolve();
        await vi.waitFor(() => expect(autoBidder.currentBidder?.isBidInProgress).toBe(false));
        expect(broadcasts).toEqual([]);
        expect(committedMaxima).toEqual([]);
        expect(await history.getBidMaxima(10)).toEqual({});
        return;
      }

      saveGate.resolve();
      await vi.waitFor(() => expect(committedMaxima).toEqual([1_000_000n]));
      await autoBidder.updateBiddingRules(null);
      expect(autoBidder.currentBidder).toBeInstanceOf(RangeCohortBidder);
      expect(autoBidder.currentBidder?.isBiddingOpen).toBe(false);
      expect(autoBidder.currentBidder?.seatGoalCount).toBe(0);

      await autoBidder.stop();
      await history.handleShutdown();
      await storage.close();
      storage = new Storage(directory);
      history = new History(storage, 10);
      autoBidder = new AutoBidder(accountset, clients, history, null, frames);
      await autoBidder.start('http://synthetic-keystore');
      expect(autoBidder.currentBidder).toBeInstanceOf(RangeCohortBidder);
      expect(autoBidder.currentBidder?.seatGoalCount).toBe(0);

      let updating: Promise<void> | undefined;
      if (resumeBidding) {
        Object.defineProperty(autoBidder, 'createBidderParams', {
          value: async () => ({ minBid: 10_000n, maxBid: 500_000n, maxSeats: 2, bidDelay: 0, bidIncrement: 10_000n }),
        });
        loadPricing.mockImplementationOnce(() => pricingGate.promise);
        updating = autoBidder.updateBiddingRules({} as never);
        await new Promise(setImmediate);
      }
      const draining = autoBidder.currentBidder;
      expect(draining?.isBiddingOpen).toBe(false);

      pendingBlock = 100;
      for (const blockNumber of [101, 102]) {
        const next = { ...header, blockNumber, blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` };
        blockWatch.latestHeaders.push(next);
        blockWatch.events.emit('best-blocks', [next]);
        await vi.waitFor(() => expect(autoBidder.currentBidder?.latestBlockNumber).toBe(blockNumber));
        expect(autoBidder.currentBidder?.myAddresses.has(address)).toBe(true);
        expect(revealedAt).toEqual([]);
      }
      const next = { ...header, blockNumber: 103, blockHash: `0x${'03'.repeat(32)}` };
      blockWatch.latestHeaders.push(next);
      blockWatch.events.emit('best-blocks', [next]);
      await vi.waitFor(() => expect(revealedAt).toEqual([103]));
      expect(revealRequests).toHaveBeenLastCalledWith({
        bids: [{ address, maxBid: 1_000_000n, salt: commitment.salt }],
        frameId: 10,
      });
      expect(committedMaxima).toEqual([1_000_000n]);

      if (!resumeBidding) {
        settled = true;
        const winner = { ...header, blockNumber: 104, blockHash: `0x${'04'.repeat(32)}` };
        blockWatch.latestHeaders.push(winner);
        blockWatch.events.emit('best-blocks', [winner]);
        await vi.waitFor(() => expect(draining?.myWinningBids.map(bid => bid.address)).toEqual([address]));
        expect(history.maxSeatsInPlay).toBe(1);
        expect(draining?.seatGoalCount).toBe(0);
        expect(committedMaxima).toEqual([1_000_000n]);

        evicted = true;
        const eviction = { ...header, blockNumber: 105, blockHash: `0x${'05'.repeat(32)}` };
        blockWatch.latestHeaders.push(eviction);
        blockWatch.events.emit('best-blocks', [eviction]);
        await vi.waitFor(() => expect(draining?.myWinningBids).toEqual([]));
        expect(history.maxSeatsInPlay).toBe(0);
        expect(committedMaxima).toEqual([1_000_000n]);
        return;
      }

      pricingGate.resolve();
      await updating;
      expect(autoBidder.currentBidder).toBe(draining);
      expect(autoBidder.currentBidder?.options.maxBid).toBe(500_000n);
      const following = { ...header, blockNumber: 104, blockHash: `0x${'04'.repeat(32)}` };
      blockWatch.latestHeaders.push(following);
      blockWatch.events.emit('best-blocks', [following]);
      await vi.waitFor(() => expect(autoBidder.currentBidder?.latestBlockNumber).toBe(104));
      expect(revealedAt).toEqual([103]);

      // Once the pending seat settles, the increased goal must select a different miner.
      settled = true;
      const settlement = { ...header, blockNumber: 105, blockHash: `0x${'05'.repeat(32)}` };
      blockWatch.latestHeaders.push(settlement);
      blockWatch.events.emit('best-blocks', [settlement]);
      await vi.waitFor(() => expect(committedMaxima).toEqual([1_000_000n, 500_000n]));
      expect(commitments).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subaccounts: [{ address: nextAddress }],
          maxBid: 500_000n,
        }),
      );
      expect(autoBidder.currentBidder?.myWinningBids.map(bid => bid.address)).toEqual([address]);

      // Reconciliation also closes admission if its subscription notification was missed.
      biddingOpen = false;
      await reconcileAuction.call(autoBidder);
      expect(autoBidder.currentBidder).toBe(draining);
      expect(draining?.isBiddingOpen).toBe(false);
      expect(draining?.myWinningBids.map(bid => bid.address)).toEqual([address]);
    } finally {
      saveGate.resolve();
      pricingGate.resolve();
      commitResult.submissionError = new Error('Test transport closed');
      revealResult.submissionError = new Error('Test transport closed');
      await autoBidder.stop();
      await history.handleShutdown();
      await storage.close();
      blockWatch.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('publishes empty capacity for the current auction while the mining bid proxy is unavailable', async () => {
    vi.useFakeTimers();

    const history = new History({} as any, 11);
    vi.spyOn(history, 'getBidMaxima').mockResolvedValue({});
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argonot-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: true,
        pendingMiningBids: vi.fn().mockResolvedValue([]),
        planMiningBidProxySetup: vi.fn().mockResolvedValue({ kind: 'tx' }),
      } as any,
      { prunedClientOrArchivePromise: Promise.resolve(openAuctionClient) } as any,
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

    await reconcileAuction.call(autoBidder);

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
        pendingMiningBids: vi.fn().mockResolvedValue([]),
        planMiningBidProxySetup: vi.fn().mockResolvedValueOnce({ kind: 'tx' }).mockResolvedValueOnce({ kind: 'ready' }),
      } as any,
      { prunedClientOrArchivePromise: Promise.resolve(openAuctionClient) } as any,
      { initCohort, getBidMaxima: async () => ({}) } as any,
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
    });
    Object.assign(autoBidder, {
      createBidderParams,
      reloadActiveCohort,
    });

    await reconcileAuction.call(autoBidder);
    await reconcileAuction.call(autoBidder);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reloadActiveCohort).not.toHaveBeenCalled();
    expect(createBidderParams).toHaveBeenCalledWith(12, expect.anything());
  });

  it('starts bidding without checking proxy setup', async () => {
    const planMiningBidProxySetup = vi.fn();
    const history = new History({} as any, 11);
    vi.spyOn(history, 'getBidMaxima').mockResolvedValue({});
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        pendingMiningBids: vi.fn().mockResolvedValue([]),
        client: { query: { miningSlot: {} } },
        planMiningBidProxySetup,
      } as any,
      { prunedClientOrArchivePromise: Promise.resolve(openAuctionClient) } as any,
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
    });
    Object.assign(autoBidder, {
      createBidderParams,
    });

    await reconcileAuction.call(autoBidder);

    expect(planMiningBidProxySetup).not.toHaveBeenCalled();
    expect(createBidderParams).toHaveBeenCalledWith(12, expect.anything());
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it.for(['auction read', 'bidder start'])('retries a failed %s while the auction remains open', async failure => {
    vi.useFakeTimers();

    const client = {
      query: {
        miningSlot: {
          isNextSlotBiddingOpen: vi.fn().mockResolvedValue(true),
          nextFrameId: vi.fn().mockResolvedValue(12),
        },
      },
    };
    if (failure === 'auction read')
      client.query.miningSlot.isNextSlotBiddingOpen.mockRejectedValueOnce(new Error('temporary RPC failure'));
    const history = new History({} as any, 11);
    vi.spyOn(history, 'getBidMaxima').mockResolvedValue({});
    vi.spyOn(history, 'getSubmittedBidCount').mockResolvedValue(0);
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        pendingMiningBids: vi.fn().mockResolvedValue([]),
        client: { query: { miningSlot: {} } },
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
    });
    const startBidder = vi.spyOn(CohortBidder.prototype, 'start').mockResolvedValue(undefined);
    if (failure === 'bidder start') startBidder.mockRejectedValueOnce(new Error('temporary RPC failure'));
    vi.spyOn(CohortBidder.prototype, 'stop').mockResolvedValue([]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams,
    });
    const onUpdated = vi.fn();
    autoBidder.subscribeToUpdates(onUpdated);

    await reconcileAuction.call(autoBidder);

    expect(autoBidder.currentBidder).toBeUndefined();
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_000);
    await (autoBidder as any).lifecycleQueue;

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
      expect(cohortBidder.isBiddingOpen).toBe(false);
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

  it('starts the range bidder after admission closes only while a maximum is pending', async () => {
    const directory = await mkdtemp(Path.join(tmpdir(), 'autobidder-closed-restart-'));
    const storage = new Storage(directory);
    const history = new History(storage, 12);
    const registry = getOfflineRegistry();
    const funding = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
    const address = Accountset.createMiningSubaccount(funding.address, 0);
    let pendingBid = registry.createType('Option<PalletMiningSlotPendingBid>', {
      block: 100,
      frame: 12,
      funding: funding.address,
      miner: address,
      bid: 10_000n,
      maxHash: `0x${'11'.repeat(32)}`,
    });
    const client = createArgonClient({
      query: {
        miningSlot: {
          auctionRulesStartAt: async () => registry.createType('u64', 1),
          isNextSlotBiddingOpen: async () => false,
          nextFrameId: async () => 12,
          pendingBids: { multi: async () => [pendingBid] },
        },
      },
    } as unknown as Parameters<typeof createArgonClient>[0]);
    const accountset = new Accountset({
      client,
      txSubmitter: funding,
      subaccountRange: [0],
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
    });
    vi.spyOn(accountset, 'miningSeatsAndBids').mockResolvedValue([
      {
        address,
        subaccountIndex: 0,
        isLastDay: false,
        hasWinningBid: false,
      },
    ]);
    const clients = { prunedClientOrArchivePromise: Promise.resolve(client) } as MainchainClients;
    const autoBidder = new AutoBidder(accountset, clients, history, null, {} as MiningFrames);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams: async () => ({
        minBid: 10_000n,
        maxBid: 1_000_000n,
        maxSeats: 1,
        bidIncrement: 10_000n,
        bidDelay: 100,
      }),
    });
    const drain = createDeferred<void>();
    const start = vi.spyOn(RangeCohortBidder.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(RangeCohortBidder.prototype, 'stop').mockImplementation(async () => {
      await drain.promise;
      return [];
    });

    try {
      // @ts-expect-error exercise the production current-state startup reconciliation
      const restarting = autoBidder.reloadActiveCohort();
      await vi.waitFor(() => expect(autoBidder.currentBidder).toBeInstanceOf(RangeCohortBidder));
      expect(autoBidder.currentBidder?.cohortStartingFrameId).toBe(12);
      expect(autoBidder.currentBidder?.isBiddingOpen).toBe(false);
      expect(autoBidder.currentBidder?.myAddresses.has(address)).toBe(true);
      expect(history.maxSeatsInPlay).toBe(1);
      drain.resolve();
      await restarting;

      pendingBid = registry.createType('Option<PalletMiningSlotPendingBid>', null);
      // @ts-expect-error exercise the same production startup reconciliation without pending work
      await autoBidder.reloadActiveCohort();
      expect(autoBidder.currentBidder).toBeUndefined();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      drain.resolve();
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores winning positions and all submitted bids after restarting without historical bid files', async () => {
    NetworkConfig.setNetwork('dev-docker');
    const directory = await mkdtemp(Path.join(tmpdir(), 'autobidder-submissions-'));
    const storage = new Storage(directory);
    const history = new History(storage, 12);
    history.handleBidsSubmitted({
      tick: 1,
      blockNumber: 1,
      frameId: 12,
      microgonsPerSeat: 42n,
      maxMicrogonsPerSeat: 50n,
      submittedCount: 2,
      txFeePlusTip: 0n,
    });
    history.handleBidsRejected({
      tick: 2,
      blockNumber: 2,
      frameId: 12,
      microgonsPerSeat: 41n,
      maxMicrogonsPerSeat: 60n,
      submittedCount: 3,
      rejectedCount: 3,
    });
    expect(await history.getSubmittedBidCount(12)).toBe(5);

    await history.handleShutdown();
    await storage.close();
    const restoredStorage = new Storage(directory);
    const restoredHistory = new History(restoredStorage, 12);
    expect(Mining.summarizeBidHistory(await restoredStorage.historyFile(12).get())?.maximumMicrogons).toBe(50n);
    const accountset = {
      isProxy: false,
      pendingMiningBids: vi.fn().mockResolvedValue([]),
      client: { query: { miningSlot: {} } },
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
    const autoBidder = new AutoBidder(
      accountset as any,
      { prunedClientOrArchivePromise: Promise.resolve(openAuctionClient) } as any,
      restoredHistory,
      {} as any,
      {} as any,
    );
    vi.spyOn(CohortBidder.prototype, 'start').mockResolvedValue(undefined);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams: vi.fn().mockResolvedValue({ maxSeats: 2 }),
    });

    try {
      await reconcileAuction.call(autoBidder);

      expect(autoBidder.currentBidder?.subaccounts).toEqual([
        { index: 2, isRebid: true, address: '5AlreadyWinning' },
        { index: 3, isRebid: false, address: '5Available' },
      ]);
      expect(accountset.miningSeatsAndBids).toHaveBeenCalledOnce();
      expect(autoBidder.currentBidder?.bidsAttempted).toBe(5);
      expect(await restoredHistory.getSubmittedBidCount(11)).toBe(0);
    } finally {
      await restoredStorage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an unrecorded finalized bid error in its original cohort history', async () => {
    NetworkConfig.setNetwork('dev-docker');
    const directory = await mkdtemp(Path.join(tmpdir(), 'autobidder-history-'));
    const storage = new Storage(directory);
    const history = new History(storage, 12);
    const accountset = {
      isProxy: false,
      pendingMiningBids: vi.fn().mockResolvedValue([]),
      client: { query: { miningSlot: {} } },
      txSubmitterPair: { address: 'synthetic-funding' },
      subAccountsByAddress: { 'synthetic-seat': { index: 0 } },
      miningSeatsAndBids: vi.fn().mockResolvedValue([]),
      getAvailableMinerAccounts: vi.fn().mockResolvedValue([{ index: 0, isRebid: false, address: 'synthetic-seat' }]),
    };
    const autoBidder = new AutoBidder(
      accountset as any,
      { prunedClientOrArchivePromise: Promise.resolve(openAuctionClient) } as any,
      history,
      {} as any,
      {} as any,
    );
    vi.spyOn(CohortBidder.prototype, 'start').mockResolvedValue(undefined);
    Object.assign(autoBidder, {
      biddingCalculator: {},
      createBidderParams: vi.fn().mockResolvedValue({ maxSeats: 1 }),
    });

    try {
      await reconcileAuction.call(autoBidder);
      history.initCohort(13, new Set());
      const bidder = autoBidder.currentBidder!;
      if (!(bidder instanceof CohortBidder)) throw new Error('Expected the compatibility bidder');
      bidder.miningFrames = {
        blockWatch: { getHeader: vi.fn().mockRejectedValue(new Error('archive unavailable')) },
      } as unknown as MiningFrames;
      const txResult = new TxResult({
        signedHash: `0x${'01'.repeat(32)}`,
        method: {},
        submittedTime: new Date(),
        submittedAtBlockNumber: 100,
        accountAddress: 'synthetic-payer',
        nonce: 0,
      });
      await txResult.setSeenInBlock({} as ArgonClient, {
        blockHash: Buffer.from('02'.repeat(32), 'hex'),
        blockNumber: 101,
        events: [],
        extrinsicIndex: 0,
      });

      // @ts-expect-error exercising production finalization through the AutoBidder history callback
      const finalization = bidder.awaitFinalization({
        txResult,
        tip: 0n,
        deathBlock: 108,
        microgonsPerSeat: 500_000n,
        subaccounts: ['synthetic-seat'],
      });
      await txResult.setFinalized({} as ArgonClient);
      await finalization;
      await history.handleShutdown();

      const original = await storage.historyFile(12).get();
      expect(original.activities).toContainEqual(
        expect.objectContaining({
          frameId: 12,
          type: BotActivityType.Error,
          data: expect.objectContaining({ message: expect.stringContaining('Finalized bid at block 101') }),
        }),
      );
      const current = await storage.historyFile(13).get();
      expect(current.activities).not.toContainEqual(expect.objectContaining({ type: BotActivityType.Error }));
    } finally {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('clears the completed auction capacity when bidding ends', async () => {
    const history = new History({} as any, 12);
    vi.spyOn(history, 'getBidMaxima').mockResolvedValue({});
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
    vi.spyOn(history, 'getBidMaxima').mockResolvedValue({});
    history.maxSeatsInPlay = 10;
    history.maxSeatsReductionReason = 'insufficient-argon-balance';
    const autoBidder = new AutoBidder(
      {
        isProxy: false,
        pendingMiningBids: vi.fn().mockResolvedValue([]),
        client: { query: { miningSlot: {} } },
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
    expect(createBidderParams).toHaveBeenCalledWith(539, expect.anything());
    expect(history.maxSeatsInPlay).toBe(0);
    expect(history.maxSeatsReductionReason).toBeUndefined();
  });
});
