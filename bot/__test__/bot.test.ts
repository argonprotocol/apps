import { runOnTeardown, sudo, teardown } from '@argonprotocol/testing';
import { getClient, getTickFromHeader, mnemonicGenerate } from '@argonprotocol/mainchain';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import Path from 'node:path';
import Bot from '../src/Bot.ts';
import * as BiddingCalculator from '@argonprotocol/apps-core';
import { MiningFrames } from '@argonprotocol/apps-core';
import { Dockers } from '../src/Dockers.js';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  MiningFrames.setNetwork('localnet');
  const result = await startArgonTestNetwork(Path.basename(import.meta.filename));
  clientAddress = result.archiveUrl;
});

it('can autobid and store stats', async () => {
  const client = await getClient(clientAddress);

  const botDataDir = fs.mkdtempSync('/tmp/bot-');

  runOnTeardown(() => fs.promises.rm(botDataDir, { recursive: true, force: true }));

  vi.spyOn(BiddingCalculator, 'createBidderParams').mockImplementation(async () => {
    return {
      maxSeats: 10,
      bidDelay: 0,
      maxBudget: 100_000_000n,
      maxBid: 1_000_000n,
      minBid: 10_000n,
      bidIncrement: 10_000n,
    };
  });

  vi.spyOn(Bot.prototype as any, 'loadBiddingRules').mockImplementation(() => {
    /* return an empty object so it's not undefined */
    return {};
  });

  vi.spyOn(Dockers, 'getArgonBlockNumbers').mockImplementation(async () => {
    return {
      localNode: 0,
      mainNode: 0,
    };
  });
  vi.spyOn(Dockers, 'getBitcoinBlockNumbers').mockImplementation(async () => {
    return {
      localNode: 0,
      mainNode: 0,
      localNodeBlockTime: 0,
    };
  });

  const bot = new Bot({
    pair: sudo(),
    archiveRpcUrl: clientAddress,
    localRpcUrl: clientAddress,
    biddingRulesPath: Path.resolve(botDataDir, 'rules.json'),
    datadir: botDataDir,
    sessionMiniSecret: mnemonicGenerate(),
    shouldSkipDockerSync: true,
  });

  await expect(bot.start()).resolves.toBeUndefined();
  const status = await bot.blockSync.state();
  expect(status.lastBlockNumber).toBeGreaterThanOrEqual(status.lastFinalizedBlockNumber);
  console.log('BotState', status);
  let firstCohortActivationFrameId: number | undefined = undefined;

  console.log('Waiting for first mined vote block');

  let voteBlocks = 0;
  let lastSeenBlockNumber = 0;
  const frameIdsWithVoteBlocks = new Set<number>();
  if ((await client.query.miningSlot.activeMinersCount().then(x => x.toNumber())) > 0) {
    firstCohortActivationFrameId = await client.query.miningSlot.minersByCohort.keys().then(x => {
      if (!x.length) return 0;
      return x[0].args[0].toNumber();
    });
  }
  // wait for first finalized vote block
  await new Promise(async resolve => {
    const unsubscribe = await client.rpc.chain.subscribeNewHeads(async x => {
      const api = await client.at(x.hash);
      if (firstCohortActivationFrameId === undefined) {
        const events = await api.query.system.events();
        for (const e of events) {
          if (client.events.miningSlot.NewMiners.is(e.event)) {
            const { frameId, newMiners } = e.event.data;
            if (newMiners.length > 0) {
              firstCohortActivationFrameId = frameId.toNumber();
            }
          }
        }
      }
      const isVoteBlock = await api.query.blockSeal.isBlockFromVoteSeal().then(x => x.isTrue);
      lastSeenBlockNumber = x.number.toNumber();
      if (isVoteBlock) {
        console.log(`Block ${x.number.toNumber()} is vote block`);
        const tick = getTickFromHeader(client, x);
        const frameId = MiningFrames.getForTick(tick!);
        frameIdsWithVoteBlocks.add(frameId);
        voteBlocks++;
        if (voteBlocks > 5) {
          unsubscribe();
          resolve(x);
        }
      }
    });
  });

  if (firstCohortActivationFrameId === undefined) {
    expect(firstCohortActivationFrameId).toBeDefined();
  }
  firstCohortActivationFrameId = firstCohortActivationFrameId!;
  expect(firstCohortActivationFrameId).toBeGreaterThan(0);

  console.log(
    `Frames with vote-mined earnings: ${[...frameIdsWithVoteBlocks]}. First cohort ${firstCohortActivationFrameId}`,
  );
  expect(frameIdsWithVoteBlocks.size).toBeGreaterThan(0);

  // wait for bot to sync to last seen block
  await new Promise(resolve => {
    bot.blockSync.didProcessBlock = x => {
      console.log(`Bot processed block (${x.blockNumber}), waiting for ${lastSeenBlockNumber}`);
      if (x.blockNumber > lastSeenBlockNumber) {
        resolve(x);
        bot.blockSync.didProcessBlock = undefined;
      }
    };
  });

  // wait for a clean stop
  const waitForFrame = bot.blockSync.lastProcessed?.frameId ?? firstCohortActivationFrameId;
  console.log('Wait for frame to be Processed', { waitForFrame });
  await new Promise(resolve => {
    bot.blockSync.didProcessBlock = x => {
      console.log(`Bot processed block (${x.blockNumber}). Waiting for frameId ${x.frameId} > ${waitForFrame}`);
      if (x.frameId > waitForFrame) {
        resolve(x);
        bot.blockSync.didProcessBlock = undefined;
      }
    };
  });

  const cohort1Bids = await bot.storage.bidsFile(firstCohortActivationFrameId - 1, firstCohortActivationFrameId).get();
  expect(cohort1Bids).toBeTruthy();
  console.log(`Cohort ${firstCohortActivationFrameId} BidsFile`, cohort1Bids);
  expect(cohort1Bids?.micronotsStakedPerSeat).toBeGreaterThanOrEqual(10000);
  expect(cohort1Bids?.seatCountWon).toBe(10);
  expect(cohort1Bids?.microgonsBidTotal).toBeGreaterThanOrEqual(10_000n * 10n);

  const cohortActivationFrameIds = new Set<number>();
  let microgonsMined = 0n;
  for (const frameId of frameIdsWithVoteBlocks) {
    const earningsData = await bot.storage.earningsFile(frameId).get();
    expect(earningsData).toBeDefined();
    expect(Object.keys(earningsData!.earningsByBlock).length).toBeGreaterThanOrEqual(1);
    for (const blockEarnings of Object.values(earningsData!.earningsByBlock)) {
      expect(blockEarnings.authorCohortActivationFrameId).toBeGreaterThan(0);
      cohortActivationFrameIds.add(blockEarnings.authorCohortActivationFrameId);
      expect(blockEarnings.microgonsMined).toBeGreaterThan(0n);
      microgonsMined += blockEarnings.microgonsMined;
    }
  }
  expect(microgonsMined).toBeGreaterThanOrEqual(375_000 * voteBlocks);

  console.log('Stopping bot 1', {
    frameIdsWithVoteBlocks,
    cohortActivationFrameIds,
  });
  await bot.shutdown();

  // try to recover from blocks

  const path2 = fs.mkdtempSync('/tmp/bot2-');
  runOnTeardown(() => fs.promises.rm(path2, { recursive: true, force: true }));
  const botRestart = new Bot({
    pair: sudo(),
    archiveRpcUrl: clientAddress,
    localRpcUrl: clientAddress,
    biddingRulesPath: Path.resolve(botDataDir, 'rules.json'),
    datadir: path2,
    sessionMiniSecret: mnemonicGenerate(),
    oldestFrameIdToSync: 0,
    shouldSkipDockerSync: true,
  });
  console.log('Starting bot 2');
  await expect(botRestart.start()).resolves.toBeUndefined();
  console.log('Stopping bot 2');
  await botRestart.shutdown();

  // compare directories
  for (const cohortActivationFrameId of frameIdsWithVoteBlocks) {
    const earningsFile1 = await bot.storage.earningsFile(cohortActivationFrameId).get();
    const earningsFile2 = await botRestart.storage.earningsFile(cohortActivationFrameId).get();
    console.info('Checking earnings for frameId', cohortActivationFrameId);
    expect(earningsFile1).toBeTruthy();
    expect(earningsFile2).toBeTruthy();
    expect(earningsFile1).toEqual(earningsFile2);
  }

  for (const cohortActivationFrameId of cohortActivationFrameIds) {
    const cohortBiddingFrameId = cohortActivationFrameId - 1;
    const bidsFile1 = await bot.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
    const bidsFile2 = await botRestart.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
    console.info('Checking bidding for cohort', cohortActivationFrameId);
    expect(bidsFile1).toBeTruthy();
    expect(bidsFile2).toBeTruthy();
    expect(bidsFile1!).toEqual(bidsFile2!);
  }
});
