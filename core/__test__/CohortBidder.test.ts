import {
  Accountset,
  CohortBidder,
  getRange,
  type ICohortBidderOptions,
  MainchainClients,
  Mining,
  MiningFrames,
} from '../src/index.js';
import { startArgonTestNetwork } from './startArgonTestNetwork.js';
import { SKIP_E2E, sudo, teardown } from '@argonprotocol/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inspect } from 'util';
import { getAuthorFromHeader, getClient, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import Path from 'path';
import { subscribeToFinalizedStorageChanges } from '../src/StorageSubscriber.js';

// set the default log depth to 10
inspect.defaultOptions.depth = 10;
afterEach(teardown);
afterAll(teardown);

describe('CohortBidder unit tests', () => {
  let accountset: Accountset;
  const subaccountRange = getRange(0, 49);
  beforeAll(() => {
    accountset = new Accountset({
      client: null as any,
      seedAccount: sudo(),
      subaccountRange,
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'alice',
    });
  });

  it('increases bids correctly', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();
    expect(cohortBidder.nextBid!.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid!.subaccounts.length).toBe(10);
  });

  it('bids with min bid before increment', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(5),
      accountBalance: Argons(51),
      bidIncrement: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(1.0));
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();
    expect(cohortBidder.nextBid!.microgonsPerSeat).toBe(Argons(5));
    expect(cohortBidder.nextBid!.subaccounts.length).toBe(10);
  });

  it('bids up to max budget', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(0.51),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('does not bid if next bid is over max', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(0.6),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.6));
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };
    // works fine with

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeUndefined();
    expect(onBidParamsAdjusted).toHaveBeenCalledTimes(1);
    expect(onBidParamsAdjusted.mock.calls[0][0]).toMatchObject(
      expect.objectContaining({
        reason: 'max-bid-too-low',
        tick: 10,
      }),
    );
  });

  it('reduces bids to fit budget', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(4.9),
      accountBalance: Argons(10),
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(4.4));
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(4.41));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(2);
  });

  it('submits bids for all seats if no others are present', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(4.9),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.5));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('can bid up existing seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      maxBid: Argons(4.9),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(6, Argons(4.1)),
      ...cohortBidder.subaccounts.slice(0, 4).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(4.11));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('can bid up only some existing seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(4),
      maxBid: Argons(5.5),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 4).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(6, Argons(3.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(4));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(6);
  });

  it('can beat out multiple tiers of seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(5.5),
      accountBalance: Argons(50),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(4, Argons(3.53)),
      ...createBids(2, Argons(3.52)),
      ...createBids(2, Argons(3.51)),
      ...createBids(2, Argons(3.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(3.54));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(10);
  });

  it('can beat out multiple tiers of seats when some are own', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(5.5),
      accountBalance: Argons(40 + 0.06 - 3 * 3.53),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(1, Argons(4.1)),
      ...cohortBidder.subaccounts.slice(0, 3).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(3.53), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(4, Argons(3.51)),
      ...createBids(2, Argons(3.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.subaccounts.length).toBe(6);
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(3.52)); // should take available spot
  });

  it('fills empty bids at lowest price when owning high bid', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(10),
      accountBalance: Argons(90 + 0.6),
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 1).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(10), address: x.address, micronotsStaked: 10_000n };
      }),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.subaccounts.length).toBe(9);
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.5)); // should take available spot
  });

  it('can take lower bids if only competing against self', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(10),
      accountBalance: Argons(90 + 0.6),
    });
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 1).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(10), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(5, Argons(1)),
      ...createBids(4, Argons(0.5)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.subaccounts.length).toBe(9);
    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(1.01));
  });

  it('can maximize seats', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(8),
      bidIncrement: Argons(1),
      accountBalance: Argons(40 + 0.06 - 4),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(2, Argons(10)),
      ...cohortBidder.subaccounts.slice(0, 1).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(3, Argons(4)),
      ...createBids(2, Argons(4)),
      ...createBids(2, Argons(4)),
    ];
    cohortBidder.currentBids.atTick = 10;
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(5));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(8);
  });

  it("should not bid if it doesn't increase seats", async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(3),
      maxBid: Argons(8),
      bidIncrement: Argons(1),
      accountBalance: Argons(40 + 0.06 - 4),
    });
    cohortBidder.currentBids.bids = [
      ...createBids(3, Argons(10)),
      ...cohortBidder.subaccounts.slice(0, 7).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(4), address: x.address, micronotsStaked: 10_000n };
      }),
    ];
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };
    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeUndefined();
    expect(onBidParamsAdjusted).toHaveBeenCalledTimes(1);
    expect(onBidParamsAdjusted.mock.calls[0][0].reason).toBe('max-bid-too-low');
  });

  it('should be not exceed available argonots', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 30_000n,
      sidelinedWalletMicronots: 10_000n, // max of 2 seats worth
    });
    cohortBidder.currentBids.bids = createBids(10, Argons(0.5));
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(2);
  });

  it('should be able to set a max argonot budget', async () => {
    const { cohortBidder } = await createBidderWithMocks(accountset, [0, 9], {
      minBid: Argons(0.5),
      maxBid: Argons(5),
      accountBalance: Argons(10),
      accountMicronots: 100_000n, // max of 2 seats worth
    });
    cohortBidder.options.sidelinedWalletMicronots = 90_000n; // max 1 more
    cohortBidder.currentBids.bids = [
      ...cohortBidder.subaccounts.slice(0, 2).map(x => {
        return { bidAtTick: 10, bidMicrogons: Argons(1), address: x.address, micronotsStaked: 10_000n };
      }),
      ...createBids(8, Argons(0.5)),
    ];
    // @ts-expect-error - private var
    cohortBidder.lastLoggedSeatsInBudget = 4;
    cohortBidder.currentBids.atTick = 10;
    const onBidParamsAdjusted = vi.fn();
    cohortBidder.callbacks = {
      onBidParamsAdjusted,
    };

    // @ts-expect-error - private var
    await expect(cohortBidder.planNextBid()).resolves.toBeUndefined();
    expect(cohortBidder.nextBid).toBeTruthy();

    expect(cohortBidder.nextBid?.microgonsPerSeat).toBe(Argons(0.51));
    expect(cohortBidder.nextBid?.subaccounts.length).toBe(1);

    expect(onBidParamsAdjusted).toHaveBeenCalledTimes(1);
    expect(onBidParamsAdjusted.mock.calls[0][0].reason).toBe('insufficient-argonot-balance');
    expect(onBidParamsAdjusted.mock.calls[0][0].availableMicronots).toBe(10_000n);
  });
});

function Argons(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

function createBids(count: number, bidMicrogons: bigint, atTick: number = 100) {
  return Array(count)
    .fill(0)
    .map((_, i) => {
      return { bidAtTick: atTick, bidMicrogons: bidMicrogons, address: `5EANERnc__${i}`, micronotsStaked: 10_000n };
    });
}

async function createBidderWithMocks(
  accountset: Accountset,
  subaccountRange: [number, number],
  options: Partial<ICohortBidderOptions> & { accountBalance: bigint; accountMicronots?: bigint },
) {
  const range = Array.from({ length: subaccountRange[1] - subaccountRange[0] + 1 }, (_, i) => i + subaccountRange[0]);
  const subaccounts = accountset.getAccountsInRange(range).map(account => {
    return {
      address: account.address,
      isRebid: false,
      index: account.index,
    };
  });
  options.maxBid ??= 1_000_000n;
  options.minBid ??= 500_000n;
  options.bidIncrement ??= 10_000n;
  options.bidDelay ??= 1;

  const cohortBidder = new CohortBidder(accountset, null as any, 10, subaccounts, options as ICohortBidderOptions);
  // @ts-expect-error - private var
  cohortBidder.nextCohortSize = 10;
  // @ts-expect-error - private var
  cohortBidder.micronotsPerSeat = 10_000n;
  vi.spyOn(cohortBidder, 'estimateFee' as any).mockImplementation(() => {
    return 60_000n;
  });
  vi.spyOn(accountset, 'submitterBalance').mockImplementation(() => {
    return Promise.resolve(options.accountBalance);
  });
  vi.spyOn(accountset, 'accountMicronots').mockImplementation(() => {
    return Promise.resolve(options.accountMicronots ?? 100_000n);
  });

  const submitBids = vi.fn().mockImplementation(() => Promise.resolve());
  // @ts-expect-error - private var
  cohortBidder.submitBids = submitBids;
  return { cohortBidder, submitBids };
}

describe.skipIf(SKIP_E2E)('Cohort Integration Bidder tests', () => {
  it('can compete on bids', async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['bob'] });

    const aliceClientPromise = getClient(network.archiveUrl);
    const aliceClient = await aliceClientPromise;
    const clients = new MainchainClients(network.archiveUrl, () => false, aliceClient);
    const bobRing = new Keyring({ type: 'sr25519' }).addFromUri('//Bob');

    const alice = new Accountset({
      client: aliceClient,
      seedAccount: sudo(),
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'alice',
    });
    await alice.registerKeys(network.archiveUrl);
    console.log('Alice set up');
    // wait for bob to have ownership tokens
    await new Promise(async resolve => {
      const unsub = await alice.client.query.ownership.account(bobRing.address, x => {
        if (x.free.toBigInt() > 100_000n) {
          resolve(true);
          unsub();
        } else {
          console.log(`Waiting for bob to have ownership tokens`);
        }
      });
    });
    console.log('Bob has ownership tokens');

    const bobPort = await network.getPort('miner-1', 9944);
    const bobAddress = `ws://localhost:${bobPort}`;

    const bob = new Accountset({
      client: await getClient(bobAddress),
      seedAccount: bobRing,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'bob',
    });
    console.log('registering bob keys on', bobAddress);
    await bob.registerKeys(bobAddress);

    console.log('Alice and Bob set up');

    const miningBids = new Mining(clients);
    let bobBidder: CohortBidder;
    let aliceBidder: CohortBidder;
    // wait for the cohort to change so we have enough time
    const startingCohort = await aliceClient.query.miningSlot.nextFrameId();
    await new Promise(resolve => {
      const unsub = aliceClient.query.miningSlot.nextFrameId(x => {
        if (x.toNumber() > startingCohort.toNumber()) {
          resolve(true);
          unsub.then();
        }
      });
    });

    let resolveWaitForStopPromise: () => void;
    const waitForStop = new Promise<void>(resolve => {
      resolveWaitForStopPromise = resolve;
    });
    const { unsubscribe } = await miningBids.onCohortChange({
      async onBiddingStart(cohortStartingFrameId) {
        if (bobBidder) return;
        console.log(`Cohort ${cohortStartingFrameId} started bidding`);
        bobBidder = new CohortBidder(
          bob,
          new MiningFrames(new MainchainClients(bobAddress, () => false, bob.client)),
          cohortStartingFrameId,
          await bob.getAvailableMinerAccounts(10),
          {
            minBid: 10_000n,
            maxBid: 5_000_000n,
            sidelinedWalletMicrogons: 25_000_000n,
            bidIncrement: 1_000_000n,
            bidDelay: 0,
          },
          undefined,
          `Bob #${cohortStartingFrameId}`,
        );
        aliceBidder = new CohortBidder(
          alice,
          new MiningFrames(clients),
          cohortStartingFrameId,
          await alice.getAvailableMinerAccounts(10),
          {
            minBid: 10_000n,
            maxBid: 4_000_000n,
            sidelinedWalletMicrogons: 40_000_000n,
            bidIncrement: 1_000_000n,
            bidDelay: 0,
          },
          undefined,
          `Alice #${cohortStartingFrameId}`,
        );
        await bobBidder.start();
        await aliceBidder.start();
      },
      async onBiddingEnd(cohortStartingFrameId) {
        console.log(`Cohort ${cohortStartingFrameId} ended bidding`);
        await aliceBidder.stop(true);
        await bobBidder.stop(true);
        resolveWaitForStopPromise();
      },
    });
    await waitForStop;
    unsubscribe();

    expect(aliceBidder!).toBeTruthy();
    expect(bobBidder!).toBeTruthy();

    const bobMinePromise = new Promise(resolve => {
      bob.client.rpc.chain.subscribeNewHeads(h => {
        const author = getAuthorFromHeader(h)!;
        if (bob.subAccountsByAddress[author]) {
          resolve(true);
        }
      });
    });
    const aliceMinePromise = new Promise(resolve => {
      alice.client.rpc.chain.subscribeNewHeads(h => {
        const author = getAuthorFromHeader(h)!;
        if (alice.subAccountsByAddress[author]) {
          resolve(true);
        }
      });
    });

    // wait for the slot to fully complete
    const finalizedBlock = await aliceClient.rpc.chain.getFinalizedHead();
    const finalizedClient = await aliceClient.at(finalizedBlock);
    const finalizedNextFrameId = await finalizedClient.query.miningSlot.nextFrameId();
    if (finalizedNextFrameId.toNumber() === bobBidder!.cohortStartingFrameId) {
      await new Promise(resolve =>
        // this is overkill here, but it's a place to test it
        subscribeToFinalizedStorageChanges(aliceClient, [
          {
            key: aliceClient.query.miningSlot.nextFrameId.key(),
            handler: async api => {
              const y = await api.query.miningSlot.nextFrameId();
              if (y.toNumber() !== bobBidder!.cohortStartingFrameId) {
                resolve(true);
              }
            },
          },
        ]),
      );
    }
    const aliceMiners = await alice.miningSeatsAndBids();
    const cohortStartingFrameId = aliceBidder!.cohortStartingFrameId;
    const bobMiners = await bob.miningSeatsAndBids();

    const aliceStats = {
      seatsWon: aliceBidder!.myWinningBids.length,
      fees: aliceBidder!.txFees,
      bidsAttempted: aliceBidder!.bidsAttempted,
    };
    const bobStats = {
      seatsWon: bobBidder!.myWinningBids.length,
      fees: bobBidder!.txFees,
      bidsAttempted: bobBidder!.bidsAttempted,
    };
    console.log({
      cohortStartingFrameId,
      aliceStats,
      bobStats,
      bobMiners: bobMiners.filter(x => x.hasWinningBid || !!x.seat),
    });

    const bobActive = bobMiners.filter(x => x.seat?.startingFrameId === cohortStartingFrameId);
    const aliceActive = aliceMiners.filter(x => x.seat?.startingFrameId === cohortStartingFrameId);

    expect(bobActive.length).toBe(bobStats.seatsWon);
    expect(bobBidder!.bidsAttempted).toBeGreaterThanOrEqual(4);
    expect(bobStats.fees).toBeGreaterThanOrEqual(6_000n * 4n);

    expect(aliceActive.length).toBe(aliceStats.seatsWon);
    expect(aliceBidder!.bidsAttempted).toBeGreaterThanOrEqual(6);
    console.log('Waiting for each bidder to mine');
    if (bobStats.seatsWon > 0) {
      await expect(bobMinePromise).resolves.toBeTruthy();
    }
    if (aliceStats.seatsWon > 0) {
      await expect(aliceMinePromise).resolves.toBeTruthy();
    }
  }, 180e3);
});
