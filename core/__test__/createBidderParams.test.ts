import { afterAll, afterEach, expect, it } from 'vitest';
import { runOnTeardown, teardown } from '@argonprotocol/testing';
import createBidderParams from '../src/createBidderParams.js';
import { type IBiddingRules, MainchainClients, MiningFrames } from '../src/index.js';
import { startArgonTestNetwork } from './startArgonTestNetwork.js';
import { JsonExt } from '../src/utils.ts';
import Path from 'path';

afterEach(teardown);
afterAll(teardown);

it('can create bidder params', async () => {
  const network = await startArgonTestNetwork(Path.basename(import.meta.filename));
  const mainchainClients = new MainchainClients(network.archiveUrl);
  await mainchainClients.setPrunedClient(network.archiveUrl);
  runOnTeardown(() => mainchainClients.disconnect());

  const biddingRules = JsonExt.parse(
    JsonExt.stringify({
      argonCirculationGrowthPctMin: 91,
      argonCirculationGrowthPctMax: 92,
      argonotPriceChangeType: 'Between',
      argonotPriceChangePctMin: 0,
      argonotPriceChangePctMax: 0,
      startingBidFormulaType: 'PreviousDayMid',
      startingBidAdjustmentType: 'Relative',
      startingBidCustom: 500000000n,
      startingBidAdjustAbsolute: 10000000n,
      startingBidAdjustRelative: 0,
      rebiddingDelay: 1,
      rebiddingIncrementBy: 1000000n,
      maximumBidFormulaType: 'BreakevenAtSlowGrowth',
      maximumBidAdjustmentType: 'Relative',
      maximumBidCustom: 0n,
      maximumBidAdjustAbsolute: 0n,
      maximumBidAdjustRelative: -7.47,
      seatGoalType: 'Min',
      seatGoalCount: 3,
      seatGoalPercent: 0,
      seatGoalInterval: 'Epoch',
      initialMicrogonRequirement: 10000000n,
      initialMicronotRequirement: 1000000n,
      sidelinedMicrogons: 0n,
      sidelinedMicronots: 0n,
    } as IBiddingRules),
  );
  MiningFrames.setNetwork('localnet');
  const cohortActivationFrameId = MiningFrames.calculateCurrentFrameIdFromSystemTime();
  const bidderParams = await createBidderParams(cohortActivationFrameId, mainchainClients, biddingRules);

  expect(bidderParams.minBid).toBe(0n);
  // BAB: not sure how to test this - it's based on live data from the chain
  // expect(bidderParams.maxBid).toBe(66_532_221n);
  expect(bidderParams.maxSeats).toBe(10);
  expect(bidderParams.bidDelay).toBe(1);
  expect(bidderParams.bidIncrement).toBe(1_000_000n);
});
