import { type ArgonClient, getClient } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import { MainchainClients, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from './startArgonTestNetwork.js';
import Path from 'path';
import { BlockWatch } from '../src/BlockWatch.ts';

afterAll(teardown);
const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E)('Mining Frames tests', () => {
  let client: ArgonClient;
  let mainchainUrl: string;
  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['bob'] });

    mainchainUrl = network.archiveUrl;
    client = await getClient(mainchainUrl);
    NetworkConfig.setNetwork('dev-docker');
  });

  it('syncs frames', async () => {
    const mainchainClients = new MainchainClients(mainchainUrl, undefined, client);
    const updatesWriter = {
      read: vi.fn().mockImplementation(async () => {}),
      write: vi.fn().mockImplementation(async () => {}),
    };
    const blockWatch = new BlockWatch(mainchainClients);
    const miningFrames = new MiningFrames(mainchainClients, blockWatch, updatesWriter);
    const rewardTicks = await client.query.miningSlot.miningConfig().then(x => x.ticksBetweenSlots.toNumber());

    await miningFrames.load();

    const waitForFrame = 3;
    await expect(miningFrames.waitForFrameId(waitForFrame)).resolves.toBeUndefined();
    await miningFrames.stop();

    expect(miningFrames.frameIds).toHaveLength(waitForFrame + 1);
    const blockNumbers = await client.query.miningSlot.frameStartBlockNumbers();
    const blockNumberByFrame = Object.fromEntries(
      blockNumbers.map((blockStart, index) => [waitForFrame - index, blockStart.toNumber()]),
    );
    const blockTickByFrame = Object.fromEntries(
      await client.query.miningSlot.frameStartTicks().then(x =>
        [...x].map(([frameId, tick]) => {
          return [frameId.toNumber(), tick.toNumber()];
        }),
      ),
    );
    const genesisTick = await client.query.ticks.genesisTick().then(x => x.toNumber());
    blockNumberByFrame[0] = 0;
    blockTickByFrame[0] = genesisTick;
    console.log('blockNumberByFrame', blockNumberByFrame);
    console.log('blockTickByFrame', blockTickByFrame);
    for (let i = 0; i <= waitForFrame; i++) {
      const frame = miningFrames.frameHistory[i];
      expect(frame.firstBlockNumber).toBe(blockNumberByFrame[i]);
      expect(frame.firstBlockTick).toBe(blockTickByFrame[i]);
      await expect(miningFrames.waitForTick(frame.firstBlockTick!)).resolves.toBeUndefined();
    }
    expect(miningFrames.currentFrameId).toBe(waitForFrame);
    expect(miningFrames.currentFrameRewardTicksRemaining).toBeLessThanOrEqual(rewardTicks);

    // could be re-called for a reorg
    expect(updatesWriter.write.mock.calls.length).toBeGreaterThanOrEqual(waitForFrame);
  });
});
