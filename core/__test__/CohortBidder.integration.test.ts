import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { Accountset, CohortBidder, getRange, MainchainClients, Mining, MiningFrames } from '../src/index.ts';
import { COMPOSE_CONFIG, COMPOSE_DIR, waitForQueryableClient } from './startArgonTestNetwork.ts';
import { runOnTeardown, SKIP_E2E, teardown } from '@argonprotocol/testing';
import { it, afterAll, afterEach, describe, expect, inject, vi } from 'vitest';
import { inspect } from 'util';
import { getAuthorFromHeader, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import docker from 'docker-compose';
import { integrationAccountUri } from './integrationNetwork.ts';
import { sudoFundWallet } from './helpers/sudoFundWallet.ts';

// set the default log depth to 10
inspect.defaultOptions.depth = 10;

const trackedMainchainClients: MainchainClients[] = [];
const trackedMiningFrames: MiningFrames[] = [];
const trackedBidders: CohortBidder[] = [];

afterEach(async () => {
  await teardown();
  await cleanupTrackedResources();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await teardown();
  await cleanupTrackedResources();
});

describe.skipIf(SKIP_E2E)('Cohort Integration Bidder tests', { tags: ['mining-auction'] }, () => {
  it('can compete on bids', async () => {
    const network = sharedNetwork;
    const accountUri = integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded');
    const aliceRing = new Keyring({ type: 'sr25519' }).addFromUri(accountUri);

    const clients = trackMainchainClients(new MainchainClients(network.archiveUrl, () => false));
    const aliceClient = await clients.get(false);
    const bobRing = new Keyring({ type: 'sr25519' }).addFromUri(`${accountUri}//bob`);

    const alice = new Accountset({
      client: aliceClient,
      txSubmitter: aliceRing,
      subaccountRange: getRange(0, 49),
      sessionMiniSecretOrMnemonic: mnemonicGenerate(),
      name: 'alice',
    });
    await alice.registerKeys(network.archiveUrl);
    console.log('Alice set up');
    await sudoFundWallet({
      address: bobRing.address,
      microgons: Argons(75),
      micronots:
        (await aliceClient.query.miningSlot.argonotsPerMiningSeat()) *
        BigInt(aliceClient.consts.mint.maxPossibleMiners.toNumber()),
      archiveUrl: network.archiveUrl,
    });
    console.log('Bob funding is ready');

    const {
      data: { port: bobPort },
    } = await docker.port('miner-1', '9944', {
      config: COMPOSE_CONFIG,
      cwd: COMPOSE_DIR,
      env: { ...process.env, COMPOSE_PROJECT_NAME: network.composeProjectName },
    });
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
    const bobClients = trackMainchainClients(new MainchainClients(network.archiveUrl, () => false));
    const bobMiningFrames = trackMiningFrames(new MiningFrames(bobClients));
    const aliceMiningFrames = trackMiningFrames(new MiningFrames(clients));
    await Promise.all([bobMiningFrames.load(), aliceMiningFrames.load()]);
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
        trackedBidders.push(bobBidder, aliceBidder);
        await Promise.all([bobBidder.start(), aliceBidder.start()]);
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
    runOnTeardown(async () => unsubscribe());
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

    // Shutdown must return only after the awarded cohort is finalized.
    const finalizedBlock = await aliceClient.rpc.chain.getFinalizedHead();
    const finalizedClient = await aliceClient.at(finalizedBlock);
    const finalizedNextFrameId = await finalizedClient.query.miningSlot.nextFrameId();
    if (finalizedNextFrameId === null) throw new Error('Mining frame storage is unavailable');
    expect(finalizedNextFrameId).toBeGreaterThan(bobBidder!.cohortStartingFrameId);
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

    expect(bobSeatsWonOnChain + aliceSeatsWonOnChain).toBeGreaterThan(0);
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
  await Promise.allSettled(trackedBidders.map(x => x.stop(false)));
  trackedBidders.length = 0;

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
