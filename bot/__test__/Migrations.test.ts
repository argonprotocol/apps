import { teardown } from '@argonprotocol/testing';
import { afterAll, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import { Storage } from '../src/Storage.ts';
import { type IBidsFile, type IBotStateFile, JsonExt } from '@argonprotocol/apps-core';
import Path from 'node:path';

afterEach(teardown);
afterAll(teardown);

it('can autobid and store stats', async () => {
  const botDataDir = fs.mkdtempSync('/tmp/bot-storage-');
  await fs.promises.rm(botDataDir, { recursive: true, force: true });

  const storage = new Storage(botDataDir);
  await fs.promises.writeFile(
    Path.join(storage.botBidsDir, 'frame-0-1.json'),
    JsonExt.stringify({
      biddingFrameTickRange: [100, 200],
      cohortBiddingFrameId: 0,
      micronotsStakedPerSeat: 0n,
      allMinersCount: 10,
      cohortActivationFrameId: 1,
      lastBlockNumber: 1,
      microgonsBidTotal: 10n,
      microgonsToBeMinedPerBlock: 100n,
      transactionFeesByBlock: {},
      seatCountWon: 0,
      winningBids: [],
      lastModifiedAt: new Date(),
    } as Omit<IBidsFile, 'biddingFrameRewardTicksRemaining' | 'biddingFrameFirstTick'>),
  );
  await fs.promises.writeFile(
    Path.join(storage.botBidsDir, 'frame-1-2.json'),
    JsonExt.stringify({
      biddingFrameTickRange: [200, 300],
      cohortBiddingFrameId: 1,
      cohortActivationFrameId: 2,
      micronotsStakedPerSeat: 0n,
      allMinersCount: 10,
      lastBlockNumber: 1,
      microgonsBidTotal: 10n,
      microgonsToBeMinedPerBlock: 100n,
      transactionFeesByBlock: {},
      seatCountWon: 0,
      winningBids: [],
      lastModifiedAt: new Date(),
    } as Omit<IBidsFile, 'biddingFrameRewardTicksRemaining' | 'biddingFrameFirstTick'>),
  );
  await fs.promises.writeFile(
    Path.join(botDataDir, 'bot-state.json'),
    JsonExt.stringify({
      currentFrameTickRange: [300, 400],
      currentFrameId: 0,
      bidsLastModifiedAt: new Date(),
      oldestFrameIdToSync: 0,
      hasMiningBids: false,
      currentTick: 100,
      earningsLastModifiedAt: new Date(),
      hasMiningSeats: false,
      syncProgress: 100,
    } as Omit<IBotStateFile, 'currentFrameFirstTick' | 'currentFrameRewardTicksRemaining'> & {
      currentFrameTickRange: [number, number];
    }),
  );
  await expect(storage.version).resolves.toBe(0);
  await expect(storage.migrate()).resolves.toBeUndefined();
  await expect(storage.version).resolves.toBe(1);

  const bid0 = await storage.bidsFile(0, 1).get();
  expect(bid0.biddingFrameFirstTick).toBe(100);
  expect(bid0.biddingFrameRewardTicksRemaining).toBe(0);

  const bid1 = await storage.bidsFile(1, 2).get();
  expect(bid1.biddingFrameFirstTick).toBe(200);
  expect(bid1.biddingFrameRewardTicksRemaining).toBe(0);
});
