import { teardown } from '@argonprotocol/testing';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { Storage } from '../src/Storage.ts';
import Path from 'node:path';
import { JsonExt, MiningFrames, NetworkConfig, type MainchainClients } from '@argonprotocol/apps-core';

afterEach(teardown);
afterAll(teardown);
beforeEach(() => NetworkConfig.setNetwork('dev-docker'));

it.each([true, false])(
  'repairs old mint capture once without discarding earnings (frame checkpoint: %s)',
  async hasFrame => {
    const botDataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'bot-mint-repair-'));
    const miningFrames = new MiningFrames({ events: { on: () => () => undefined } } as unknown as MainchainClients);
    let storage = new Storage(botDataDir);
    try {
      await storage.botStateFile().mutate(state => {
        state.oldestFrameIdToSync = 3;
        state.hasMiningSeats = true;
        state.lastProcessedBlockNumber = 100;
        state.lastProcessedBlockHash = 'hash-100';
        state.lastFinalizedProcessedBlockNumber = 90;
        state.lastFinalizedProcessedBlockHash = 'hash-90';
      });
      await storage.earningsFile(7).mutate(file => {
        file.earningsByBlock[79] = {
          blockHash: 'hash-79',
          blockMinedAt: '',
          authorAddress: 'another-miner',
          authorCohortActivationFrameId: 5,
          microgonsMined: 0n,
          micronotsMined: 0n,
          microgonFeesCollected: 0n,
          microgonsMinted: 10n,
        };
      });
      if (hasFrame)
        miningFrames.framesById[6] = {
          frameId: 6,
          frameStartTick: 70,
          dateStart: new Date(),
          firstBlockNumber: 70,
          firstBlockHash: 'hash-70',
          firstBlockTick: 70,
          firstBlockSpecVersion: 159,
        };
      const earningsBefore = await storage.earningsFile(7).get();
      miningFrames.framesById[7] = {
        frameId: 7,
        frameStartTick: 79,
        dateStart: new Date(),
        firstBlockNumber: 79,
        firstBlockHash: 'hash-79',
        firstBlockTick: 79,
        firstBlockSpecVersion: 117,
      };
      await storage.migrate(miningFrames);
      expect(await storage.botStateFile().get()).toMatchObject({
        oldestFrameIdToSync: 3,
        hasMiningSeats: true,
        lastProcessedBlockNumber: hasFrame ? 70 : 0,
        lastProcessedBlockHash: hasFrame ? 'hash-70' : '',
        lastFinalizedProcessedBlockHash: '',
        lastFinalizedProcessedBlockNumber: 0,
      });
      expect(await storage.earningsFile(7).get()).toEqual(earningsBefore);

      await storage.earningsFile(7).mutate(file => {
        Object.assign(file.earningsByBlock[79], { microgonsMinted: 30n, microgonsMintedByCohort: { 5: 10n, 6: 20n } });
      });
      await storage.botStateFile().mutate(state => {
        state.lastProcessedBlockNumber = 101;
        state.lastProcessedBlockHash = 'hash-101';
      });
      await storage.close();
      storage = new Storage(botDataDir);
      await storage.migrate(miningFrames);
      expect((await storage.botStateFile().get()).lastProcessedBlockNumber).toBe(101);
      expect((await storage.earningsFile(7).get()).earningsByBlock[79].microgonsMintedByCohort).toEqual({
        5: 10n,
        6: 20n,
      });
      expect(JsonExt.parse(fs.readFileSync(storage.getPath('storage-version.json'), 'utf8')).version).toBe(2);
    } finally {
      await storage.close();
      await fs.promises.rm(botDataDir, { recursive: true, force: true });
    }
  },
);

it('imports the previous processed checkpoint once and preserves later progress on restart', async () => {
  const botDataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'bot-storage-'));
  fs.writeFileSync(
    Path.join(botDataDir, 'bot-blocks.json'),
    JSON.stringify({ syncedToBlockNumber: 119, blocksByNumber: { 119: { hash: 'hash-119' } } }),
  );
  const miningFrames = new MiningFrames({ events: { on: () => () => undefined } } as unknown as MainchainClients);
  let storage = new Storage(botDataDir);
  try {
    await expect(storage.version).resolves.toBe(0);
    await expect(storage.migrate(miningFrames)).resolves.toBeUndefined();
    await expect(storage.version).resolves.toBe(2);
    expect(await storage.botStateFile().get()).toMatchObject({
      lastProcessedBlockNumber: 119,
      lastProcessedBlockHash: 'hash-119',
    });
    await storage.botStateFile().mutate(state => {
      state.lastProcessedBlockNumber = 120;
      state.lastProcessedBlockHash = 'hash-120';
    });
    await storage.close();
    storage = new Storage(botDataDir);
    await storage.migrate(miningFrames);
    expect(await storage.botStateFile().get()).toMatchObject({
      lastProcessedBlockNumber: 120,
      lastProcessedBlockHash: 'hash-120',
    });
  } finally {
    await storage.close();
    await fs.promises.rm(botDataDir, { recursive: true, force: true });
  }
});

it.each([
  '{incomplete JSON',
  JSON.stringify({ syncedToBlockNumber: '119', blocksByNumber: {} }),
  JSON.stringify({ syncedToBlockNumber: 119, blocksByNumber: {} }),
])('keeps the starting frame and existing earnings when a checkpoint cannot be imported: %s', async contents => {
  const botDataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'bot-storage-recovery-'));
  const checkpointPath = Path.join(botDataDir, 'bot-blocks.json');
  fs.writeFileSync(checkpointPath, contents);
  const miningFrames = new MiningFrames({ events: { on: () => () => undefined } } as unknown as MainchainClients);
  let storage = new Storage(botDataDir);
  try {
    await storage.botStateFile().mutate(state => {
      state.oldestFrameIdToSync = 3;
      state.hasMiningSeats = true;
    });
    await storage.earningsFile(3).mutate(earnings => {
      earnings.firstBlockNumber = 110;
      earnings.lastBlockNumber = 119;
    });
    const state = await storage.botStateFile().get();
    const earnings = await storage.earningsFile(3).get();
    await expect(storage.migrate(miningFrames)).resolves.toBeUndefined();
    await expect(storage.version).resolves.toBe(2);
    expect(await storage.botStateFile().get()).toEqual(state);
    expect(await storage.earningsFile(3).get()).toEqual(earnings);
    expect(fs.readFileSync(checkpointPath, 'utf8')).toBe(contents);

    await storage.close();
    storage = new Storage(botDataDir);
    await storage.migrate(miningFrames);
    expect(await storage.botStateFile().get()).toMatchObject({
      oldestFrameIdToSync: 3,
      hasMiningSeats: true,
      lastProcessedBlockNumber: 0,
      lastProcessedBlockHash: '',
    });
    expect(await storage.earningsFile(3).get()).toEqual(earnings);
  } finally {
    await storage.close();
    await fs.promises.rm(botDataDir, { recursive: true, force: true });
  }
});
