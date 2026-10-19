import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Path from 'node:path';
import docker from 'docker-compose';
import { teardown } from '@argonprotocol/testing';
import { MainchainClients, MiningFrames, type IFrameHistory } from '@argonprotocol/apps-core';
import { it, beforeAll, afterAll, describe, expect } from 'vitest';
import { COMPOSE_CONFIG, COMPOSE_DIR } from './startArgonTestNetwork.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E)('Mining Frames tests', () => {
  let clients: MainchainClients;
  let miningFrames: MiningFrames;
  let restored: MiningFrames | undefined;
  let directory: string;

  beforeAll(async () => {
    clients = new MainchainClients(sharedNetwork.archiveUrl);
    directory = await mkdtemp(Path.join(tmpdir(), 'mining-frames-'));
  });

  afterAll(async () => {
    await miningFrames?.stop();
    await restored?.stop();
    await clients?.disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
    await teardown();
  });

  it('starts joining nodes from the same low-difficulty genesis', async () => {
    const client = await clients.get(false);
    const genesis = await client.at(client.genesisHash.toHex());

    expect(await genesis.query.blockSealSpec.currentComputeDifficulty()).toBe(25n);

    const minerPort = await docker.port('miner-1', '9944', {
      cwd: COMPOSE_DIR,
      config: COMPOSE_CONFIG,
      env: { ...process.env, COMPOSE_PROJECT_NAME: sharedNetwork.composeProjectName },
    });
    const minerClients = new MainchainClients(`ws://127.0.0.1:${minerPort.data.port}`);
    try {
      const miner = await minerClients.get(false);
      expect(miner.genesisHash.toHex()).toBe(client.genesisHash.toHex());
      await expect
        .poll(
          async () => {
            const finalizedHash = await miner.rpc.chain.getFinalizedHead();
            return (await miner.rpc.chain.getHeader(finalizedHash)).number.toNumber();
          },
          { timeout: 120_000 },
        )
        .toBeGreaterThan(0);
    } finally {
      await minerClients.disconnect();
    }
  });

  it('syncs live frames and restores their durable history on a continuing chain', async () => {
    const historyPath = Path.join(directory, 'frames.json');
    const updatesWriter = {
      read: () =>
        readFile(historyPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        }),
      write: (data: string) => writeFile(historyPath, data),
    };
    miningFrames = new MiningFrames(clients, undefined, updatesWriter);
    await miningFrames.load();
    const nextFrame = miningFrames.currentFrameId + 1;
    await miningFrames.waitForFrameId(nextFrame);
    // Best-chain frame starts can change until finalized. Later frames may still be provisional at restart.
    await expect
      .poll(() => miningFrames.blockWatch.finalizedBlockHeader.frameId, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(nextFrame);
    await miningFrames.stop();

    const finalizedFrames = structuredClone(miningFrames.frames.filter(frame => frame.frameId <= nextFrame));
    expect(finalizedFrames.map(frame => frame.frameId)).toEqual(Array.from({ length: nextFrame + 1 }, (_, id) => id));
    const latestFrame = finalizedFrames.at(-1)!;
    const client = await clients.get(false);
    expect(latestFrame.firstBlockHash).toBe(
      (await client.rpc.chain.getBlockHash(latestFrame.firstBlockNumber!)).toHex(),
    );
    const atFrameStart = await client.at(latestFrame.firstBlockHash!);
    const blockNumbers = (await atFrameStart.query.miningSlot.frameStartBlockNumbers())!;
    const frameTicks = (await atFrameStart.query.miningSlot.frameStartTicks())!;
    for (const [index, blockNumber] of blockNumbers.entries()) {
      const frame = finalizedFrames[latestFrame.frameId - index];
      expect(frame.firstBlockNumber).toBe(blockNumber);
      expect(frame.firstBlockTick).toBe(Number(frameTicks[frame.frameId]));
    }
    await expect
      .poll(async () => {
        const savedFrames = JSON.parse(await readFile(historyPath, 'utf8')) as IFrameHistory[];
        return savedFrames.filter(frame => frame.frameId <= nextFrame);
      })
      .toEqual(finalizedFrames.map(frame => ({ ...frame, dateStart: frame.dateStart.toISOString() })));

    restored = new MiningFrames(clients, undefined, updatesWriter);
    await restored.load();
    for (const frame of finalizedFrames) {
      expect(restored.framesById[frame.frameId]).toEqual(frame);
    }
  });
});
