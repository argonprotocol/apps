import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { runOnTeardown, sudo, teardown } from '@argonprotocol/testing';
import { getAuthorFromHeader, Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { it, beforeAll, afterAll, afterEach, expect, inject, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import Path from 'node:path';
import Bot from '../src/Bot.ts';
import { BlockSync } from '../src/BlockSync.ts';
import {
  BidAmountAdjustmentType,
  BidAmountFormulaType,
  type IBiddingRules,
  JsonExt,
  MINING_BID_PROXY_FEE_FLOAT,
  MicronotPriceChangeType,
  SeatGoalInterval,
  SeatGoalType,
  TxSubmitter,
} from '@argonprotocol/apps-core';
import { DockerStatus } from '../src/DockerStatus.js';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { getTestMainchainClient } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

afterEach(teardown);

let clientAddress: string;
beforeAll(async () => {
  if (skipE2E) return;
  clientAddress = sharedNetwork.archiveUrl;
});
afterAll(async () => {
  await teardown();
});

// prettier-ignore
it.skipIf(skipE2E)(
  'can autobid and store stats',
  { tags: ['mining-auction'], timeout: 600_000 },
  async () => {
    const client = await getTestMainchainClient(clientAddress);
    runOnTeardown(async () => {
      await client.disconnect().catch(() => undefined);
    });

    const botDataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'bot-'));
    await fs.promises.rm(botDataDir, { recursive: true, force: true });
    await fs.promises.mkdir(botDataDir, { recursive: true });
    const biddingRulesPath = Path.resolve(botDataDir, 'rules.json');
    const biddingRules: IBiddingRules = {
      argonCirculationGrowthPctMin: 0,
      argonCirculationGrowthPctMax: 0,
      argonotPriceChangeType: MicronotPriceChangeType.Between,
      argonotPriceChangePctMin: 0,
      argonotPriceChangePctMax: 0,
      startingBidFormulaType: BidAmountFormulaType.Custom,
      startingBidAdjustmentType: BidAmountAdjustmentType.Absolute,
      startingBidCustom: 10_000n,
      startingBidAdjustAbsolute: 0n,
      startingBidAdjustRelative: 0,
      rebiddingDelay: 0,
      rebiddingIncrementBy: 10_000n,
      maximumBidFormulaType: BidAmountFormulaType.Custom,
      maximumBidAdjustmentType: BidAmountAdjustmentType.Relative,
      maximumBidCustom: 100_000_000n,
      maximumBidAdjustAbsolute: 0n,
      maximumBidAdjustRelative: 0,
      seatGoalType: SeatGoalType.Max,
      seatGoalCount: 10,
      seatGoalPercent: 0,
      seatGoalInterval: SeatGoalInterval.Frame,
      initialMicrogonRequirement: 0n,
      initialMicronotRequirement: 0n,
      sidelinedMicrogons: 0n,
      sidelinedMicronots: 0n,
    };
    await fs.promises.writeFile(biddingRulesPath, JsonExt.stringify(biddingRules));

    vi.spyOn(DockerStatus, 'getArgonBlockNumbers').mockImplementation(async () => {
      return {
        localNode: 0,
        mainNode: 0,
      };
    });
    vi.spyOn(DockerStatus, 'getBitcoinBlockNumbers').mockImplementation(async () => {
      return {
        localNode: 0,
        mainNode: 0,
        localNodeBlockTime: 0,
      };
    });

    const accountUri = integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded');
    const fundingAccount = new Keyring({ type: 'sr25519' }).addFromUri(accountUri);
    const useProxyBidder = true;
    const proxyKeypair = new Keyring({ type: 'sr25519' }).addFromUri(`${accountUri}//mining-proxy`);
    const bidderKeypair = useProxyBidder ? proxyKeypair : fundingAccount;
    const setupCalls = [];
    if (useProxyBidder) {
      setupCalls.push(
        client.tx.proxy.addProxy(proxyKeypair.address, 'MiningBidRealPaysFee', 0),
        client.tx.balances.transferAllowDeath(proxyKeypair.address, MINING_BID_PROXY_FEE_FLOAT),
      );
    }
    const fundingSetup = await new TxSubmitter(client, client.tx.utility.batchAll(setupCalls), fundingAccount).submit();
    await fundingSetup.waitForInFirstBlock;

    const historyStartingFrameId = (await client.query.miningSlot.nextFrameId()) - 1;
    const bot = new Bot({
      bitcoinInitializerDelegateKeypair: sudo(),
      fundingAccountId: fundingAccount.address,
      bidderKeypair,
      archiveRpcUrl: clientAddress,
      localRpcUrl: clientAddress,
      biddingRulesPath,
      datadir: botDataDir,
      sessionMiniSecret: mnemonicGenerate(),
      vaultOperatorAddress: fundingAccount.address,
      oldestFrameIdToSync: historyStartingFrameId,
      shouldSkipDockerSync: true,
    });
    runOnTeardown(async () => {
      await bot.shutdown();
      await fs.promises.rm(botDataDir, { recursive: true, force: true });
    });

    await expect(bot.start()).resolves.toBeUndefined();
    const activeBidder = await waitFor(30e3, 'initial active bidder', () => bot.autobidder.currentBidder);
    const updatedBiddingRules: IBiddingRules = {
      ...biddingRules,
      maximumBidCustom: 50_000_000n,
      rebiddingDelay: 3,
      rebiddingIncrementBy: 20_000n,
    };
    await fs.promises.writeFile(biddingRulesPath, JsonExt.stringify(updatedBiddingRules));
    await waitFor(30e3, 'updated active bidder', () => {
      const updatedBidder = bot.autobidder.currentBidder;
      if (!updatedBidder || updatedBidder === activeBidder) return;
      expect(updatedBidder.options).toMatchObject({
        maxBid: 50_000_000n,
        bidDelay: 3,
        bidIncrement: 20_000n,
      });
      return updatedBidder;
    });
    const status = await bot.state();
    console.log('BotState', status);
    let firstCohortActivationFrameId: number | undefined = undefined;

    console.log('Waiting for first mined vote block');

    let voteBlocks = 0;
    let lastSeenBlockNumber = 0;
    const targetVoteBlocks = 1;
    const frameIdsWithVoteBlocks = new Set<number>();
    // Observe this bot's finalized work, even when older cohorts remain on the chain.
    await new Promise(async resolve => {
      const unsubscribe = await client.rpc.chain.subscribeFinalizedHeads(async x => {
        const author = getAuthorFromHeader(x);
        if (!author || !bot.accountset.subAccountsByAddress[author]) return;
        const api = await client.at(x.hash);
        if (firstCohortActivationFrameId === undefined) {
          const miners = await bot.accountset.loadRegisteredMiners(api);
          firstCohortActivationFrameId = miners.find(miner => miner.address === author)?.seat?.startingFrameId;
        }
        const isVoteBlock = await api.query.blockSeal.isBlockFromVoteSeal();
        lastSeenBlockNumber = x.number.toNumber();
        if (isVoteBlock) {
          console.log(`Block ${x.number.toNumber()} is vote block`);
          const nextFrameId = await api.query.miningSlot.nextFrameId();
          if (nextFrameId === null) throw new Error('Mining frame storage is unavailable');
          const earningsFrameId = nextFrameId - 1;
          frameIdsWithVoteBlocks.add(earningsFrameId);
          voteBlocks++;
          if (voteBlocks >= targetVoteBlocks) {
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

    const cohort1BiddingFrameId = firstCohortActivationFrameId - 1;
    let cohort1Bids = await bot.storage.bidsFile(cohort1BiddingFrameId, firstCohortActivationFrameId).get();
    for (let i = 0; i < 30 && !cohort1Bids; i += 1) {
      cohort1Bids = await bot.storage.bidsFile(cohort1BiddingFrameId, firstCohortActivationFrameId).get();
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    expect(cohort1Bids).toBeTruthy();
    console.log(`Cohort ${firstCohortActivationFrameId} BidsFile`, cohort1Bids);
    expect(cohort1Bids?.micronotsStakedPerSeat).toBeGreaterThanOrEqual(10000);
    expect(cohort1Bids?.seatCountWon).toBe(10);
    expect(cohort1Bids?.microgonsBidTotal).toBeGreaterThanOrEqual(10_000n * 10n);
    expect(cohort1Bids?.argonotPriceAtBid).toBeGreaterThan(0n);

    const cohortActivationFrameIds = new Set<number>();
    let microgonsMined = 0n;
    for (const frameId of frameIdsWithVoteBlocks) {
      let earningsData = await bot.storage.earningsFile(frameId).get();
      for (let i = 0; i < 30; i += 1) {
        if (earningsData && Object.keys(earningsData.earningsByBlock).length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 1_000));
        earningsData = await bot.storage.earningsFile(frameId).get();
      }
      expect(earningsData).toBeDefined();
      expect(Object.keys(earningsData.earningsByBlock).length).toBeGreaterThanOrEqual(1);
      for (const blockEarnings of Object.values(earningsData.earningsByBlock)) {
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

    const path2 = fs.mkdtempSync(Path.join(os.tmpdir(), 'bot2-'));
    const botRestart = new Bot({
      bitcoinInitializerDelegateKeypair: sudo(),
      fundingAccountId: fundingAccount.address,
      bidderKeypair,
      archiveRpcUrl: clientAddress,
      localRpcUrl: clientAddress,
      biddingRulesPath,
      datadir: path2,
      sessionMiniSecret: mnemonicGenerate(),
      vaultOperatorAddress: fundingAccount.address,
      oldestFrameIdToSync: historyStartingFrameId,
      shouldSkipDockerSync: true,
    });
    runOnTeardown(async () => {
      await botRestart.shutdown();
      await fs.promises.rm(path2, { recursive: true, force: true });
    });
    console.log('Starting bot 2');
    const loadSpy = vi.spyOn(BlockSync.prototype, 'load');
    const originalLoad = loadSpy.getMockImplementation()!;
    let releaseHistory!: () => void;
    const historyCanStart = new Promise<void>(resolve => {
      releaseHistory = resolve;
    });
    loadSpy.mockImplementation(async function (this: BlockSync) {
      await historyCanStart;
      return originalLoad.call(this);
    });
    try {
      await expect(botRestart.start()).resolves.toBeUndefined();
      expect(botRestart.isReady).toBe(true);
      expect(botRestart.isSyncing).toBe(true);
      const liveFrameId = botRestart.miningFrames.currentFrameId;
      await botRestart.storage.botStateFile().mutate(state => {
        state.currentFrameId = Math.max(0, liveFrameId - 1);
      });
      expect((await botRestart.state()).currentFrameId).toBe(liveFrameId);
    } finally {
      releaseHistory();
      loadSpy.mockRestore();
    }
    for (const cohortActivationFrameId of frameIdsWithVoteBlocks) {
      await waitFor(30e3, `restart earnings recovery for frame ${cohortActivationFrameId}`, async () => {
        const earningsFile1 = await bot.storage.earningsFile(cohortActivationFrameId).get();
        const earningsFile2 = await botRestart.storage.earningsFile(cohortActivationFrameId).get();
        if (!earningsFile1 || !earningsFile2) return;
        if (earningsFile2.lastBlockNumber < earningsFile1.lastBlockNumber) return;
        for (const [blockNumber, earnings] of Object.entries(earningsFile1.earningsByBlock)) {
          const recoveredEarnings = earningsFile2.earningsByBlock[Number(blockNumber)];
          if (!recoveredEarnings) return;
          expect(recoveredEarnings).toEqual(earnings);
        }
        return {
          original: earningsFile1,
          recovered: earningsFile2,
        };
      });
    }
    for (const cohortActivationFrameId of cohortActivationFrameIds) {
      const cohortBiddingFrameId = cohortActivationFrameId - 1;
      await waitFor(30e3, `restart bids recovery for cohort ${cohortActivationFrameId}`, async () => {
        const bidsFile1 = await bot.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
        const bidsFile2 = await botRestart.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
        if (!bidsFile1 || !bidsFile2) return;
        expect(bidsFile2).toEqual(bidsFile1);
        return true;
      });
    }
    console.log('Stopping bot 2');
    await botRestart.shutdown();

    // compare directories
    for (const cohortActivationFrameId of frameIdsWithVoteBlocks) {
      const earningsFile1 = await bot.storage.earningsFile(cohortActivationFrameId).get();
      const earningsFile2 = await botRestart.storage.earningsFile(cohortActivationFrameId).get();
      console.info('Checking earnings for frameId', cohortActivationFrameId);
      expect(earningsFile1).toBeTruthy();
      expect(earningsFile2).toBeTruthy();
      expect(earningsFile2.firstBlockNumber).toBe(earningsFile1.firstBlockNumber);
      expect(earningsFile2.lastBlockNumber).toBeGreaterThanOrEqual(earningsFile1.lastBlockNumber);
      for (const [blockNumber, earnings] of Object.entries(earningsFile1.earningsByBlock)) {
        expect(earningsFile2.earningsByBlock[Number(blockNumber)]).toEqual(earnings);
      }
    }

    for (const cohortActivationFrameId of cohortActivationFrameIds) {
      const cohortBiddingFrameId = cohortActivationFrameId - 1;
      const bidsFile1 = await bot.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
      const bidsFile2 = await botRestart.storage.bidsFile(cohortBiddingFrameId, cohortActivationFrameId).get();
      console.info('Checking bidding for cohort', cohortActivationFrameId);
      expect(bidsFile1).toBeTruthy();
      expect(bidsFile2).toBeTruthy();
      expect(bidsFile1).toEqual(bidsFile2);
    }
  },
);
