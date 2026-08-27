import { Accountset, CohortBidder, getRange, MainchainClients, Mining, MiningFrames } from '../src/index.ts';
import { startArgonTestNetwork, waitForQueryableClient } from './startArgonTestNetwork.ts';
import { SKIP_E2E, sudo, teardown } from '@argonprotocol/testing';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'util';
import { getAuthorFromHeader, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import Path from 'path';
import { subscribeToFinalizedStorageChanges } from '../src/StorageSubscriber.ts';
import { sudoFundWallet } from './helpers/sudoFundWallet.ts';
import { getTestMainchainClient } from './helpers/mainchain.ts';

// set the default log depth to 10
inspect.defaultOptions.depth = 10;

const trackedMainchainClients: MainchainClients[] = [];
const trackedMiningFrames: MiningFrames[] = [];

afterEach(async () => {
  await cleanupTrackedResources();
  await teardown();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanupTrackedResources();
  await teardown();
});

describe.skipIf(SKIP_E2E)('Cohort Integration Bidder tests', () => {
  it('can compete on bids', async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['bob'] });

    const aliceClientPromise = getTestMainchainClient(network.archiveUrl);
    const aliceClient = await aliceClientPromise;
    const clients = trackMainchainClients(new MainchainClients(network.archiveUrl, () => false, aliceClient));
    const bobRing = new Keyring({ type: 'sr25519' }).addFromUri('//Bob');

    const alice = new Accountset({
      client: aliceClient,
      txSubmitter: sudo(),
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'alice',
    });
    await alice.registerKeys(network.archiveUrl);
    console.log('Alice set up');
    await sudoFundWallet({
      address: bobRing.address,
      microgons: Argons(75),
      micronots: 500_000n,
      archiveUrl: network.archiveUrl,
    });
    console.log('Bob funding is ready');

    const bobPort = await network.getPort('miner-1', 9944);
    const bobAddress = `ws://localhost:${bobPort}`;
    await waitForQueryableClient(bobAddress, { label: bobAddress });

    const bob = new Accountset({
      client: aliceClient,
      txSubmitter: bobRing,
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
    let bobWinningBidsAtStop: { address: string }[] = [];
    let aliceWinningBidsAtStop: { address: string }[] = [];
    const bobBidEvents: { type: 'submitted' | 'rejected'; microgonsPerSeat: bigint }[] = [];
    const aliceBidEvents: { type: 'submitted' | 'rejected'; microgonsPerSeat: bigint }[] = [];
    let hasStoppedBidders = false;
    // wait for the cohort to change so we have enough time
    const startingCohort = await aliceClient.query.miningSlot.nextFrameId();
    await new Promise(resolve => {
      const unsub = aliceClient.query.miningSlot.nextFrameId(x => {
        if (x > startingCohort) {
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
        const bobClients = trackMainchainClients(new MainchainClients(bobAddress, () => false, bob.client));
        const bobMiningFrames = trackMiningFrames(new MiningFrames(bobClients));
        const aliceMiningFrames = trackMiningFrames(new MiningFrames(clients));

        bobBidder = new CohortBidder(
          bob,
          bobMiningFrames,
          cohortStartingFrameId,
          await bob.getAvailableMinerAccounts(10),
          {
            minBid: 10_000n,
            maxBid: 5_000_000n,
            sidelinedWalletMicrogons: 25_000_000n,
            bidIncrement: 1_000_000n,
            bidDelay: 0,
          },
          {
            onBidsSubmitted: ({ microgonsPerSeat }) => {
              bobBidEvents.push({ type: 'submitted', microgonsPerSeat });
            },
            onBidsRejected: ({ microgonsPerSeat }) => {
              bobBidEvents.push({ type: 'rejected', microgonsPerSeat });
            },
          },
          `Bob #${cohortStartingFrameId}`,
        );
        aliceBidder = new CohortBidder(
          alice,
          aliceMiningFrames,
          cohortStartingFrameId,
          await alice.getAvailableMinerAccounts(10),
          {
            minBid: 10_000n,
            maxBid: 4_000_000n,
            sidelinedWalletMicrogons: 40_000_000n,
            bidIncrement: 1_000_000n,
            bidDelay: 0,
          },
          {
            onBidsSubmitted: ({ microgonsPerSeat }) => {
              aliceBidEvents.push({ type: 'submitted', microgonsPerSeat });
            },
            onBidsRejected: ({ microgonsPerSeat }) => {
              aliceBidEvents.push({ type: 'rejected', microgonsPerSeat });
            },
          },
          `Alice #${cohortStartingFrameId}`,
        );
        await bobBidder.start();
        await aliceBidder.start();
      },
      async onBiddingEnd(cohortStartingFrameId) {
        if (hasStoppedBidders) return;
        if (!aliceBidder || !bobBidder) return;
        if (cohortStartingFrameId < bobBidder.cohortStartingFrameId) return;
        hasStoppedBidders = true;
        console.log(`Cohort ${cohortStartingFrameId} ended bidding`);
        [aliceWinningBidsAtStop, bobWinningBidsAtStop] = await Promise.all([
          aliceBidder.stop(true),
          bobBidder.stop(true),
        ]);
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
    if (finalizedNextFrameId === null) throw new Error('Mining frame storage is unavailable');
    if (finalizedNextFrameId === bobBidder!.cohortStartingFrameId) {
      await new Promise(resolve =>
        // this is overkill here, but it's a place to test it
        subscribeToFinalizedStorageChanges(aliceClient, [
          {
            key: aliceClient.query.miningSlot.nextFrameId.key(),
            handler: async api => {
              const y = await api.query.miningSlot.nextFrameId();
              if (y !== null && y !== bobBidder!.cohortStartingFrameId) {
                resolve(true);
              }
            },
          },
        ]),
      );
    }
    const cohortStartingFrameId = aliceBidder!.cohortStartingFrameId;

    const aliceStats = {
      seatsWon: aliceWinningBidsAtStop.length,
      fees: aliceBidder!.txFees,
      bidsAttempted: aliceBidder!.bidsAttempted,
    };
    const bobStats = {
      seatsWon: bobWinningBidsAtStop.length,
      fees: bobBidder!.txFees,
      bidsAttempted: bobBidder!.bidsAttempted,
    };

    const finalizedHead = await aliceClient.rpc.chain.getFinalizedHead();
    const finalizedApi = await aliceClient.at(finalizedHead);
    const cohortSeats = await finalizedApi.query.miningSlot.minersByCohort(cohortStartingFrameId);
    if (!cohortSeats) throw new Error('Mining cohort storage is unavailable');

    const bobSeatsWonOnChain = cohortSeats.filter(x => {
      return x.externalFundingAccount === bob.fundingAccountId;
    }).length;
    const aliceSeatsWonOnChain = cohortSeats.filter(x => {
      return x.externalFundingAccount === alice.fundingAccountId;
    }).length;
    const bidLevels = new Set(
      [...bobBidEvents, ...aliceBidEvents].map(({ microgonsPerSeat }) => microgonsPerSeat.toString()),
    );
    const hasRejectedBid = [...bobBidEvents, ...aliceBidEvents].some(({ type }) => type === 'rejected');

    console.log({
      cohortStartingFrameId,
      aliceStats,
      bobStats,
      bidEvents: {
        bob: bobBidEvents,
        alice: aliceBidEvents,
      },
      onChainSeats: {
        bobSeatsWonOnChain,
        aliceSeatsWonOnChain,
      },
    });

    expect(bobSeatsWonOnChain).toBe(bobStats.seatsWon);
    expect(bobBidEvents.length).toBeGreaterThan(0);

    expect(aliceSeatsWonOnChain).toBe(aliceStats.seatsWon);
    expect(aliceBidEvents.length).toBeGreaterThan(0);
    expect(hasRejectedBid || bidLevels.size > 1).toBe(true);
    console.log('Waiting for each bidder to mine');
    if (bobStats.seatsWon > 0) {
      await expect(bobMinePromise).resolves.toBeTruthy();
    }
    if (aliceStats.seatsWon > 0) {
      await expect(aliceMinePromise).resolves.toBeTruthy();
    }
  }, 180e3);
});

function Argons(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

async function cleanupTrackedResources(): Promise<void> {
  await Promise.allSettled(trackedMiningFrames.map(x => x.stop()));
  trackedMiningFrames.length = 0;

  await Promise.allSettled(trackedMainchainClients.map(x => x.disconnect()));
  trackedMainchainClients.length = 0;
}

function trackMainchainClients(clients: MainchainClients): MainchainClients {
  trackedMainchainClients.push(clients);
  return clients;
}

function trackMiningFrames(miningFrames: MiningFrames): MiningFrames {
  trackedMiningFrames.push(miningFrames);
  return miningFrames;
}
