import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { runOnTeardown, sudo, teardown } from '@argonprotocol/testing';
import { mnemonicGenerate } from '@argonprotocol/mainchain';
import { Accountset, MainchainClients, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { BlockSync } from '../src/BlockSync.js';
import fs from 'node:fs';
import os from 'node:os';
import { Storage } from '../src/Storage.js';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import Path from 'node:path';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { getTestMainchainClient } from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  if (skipE2E) return;
  NetworkConfig.setNetwork('dev-docker');
  const result = await startArgonTestNetwork(Path.basename(import.meta.filename));
  clientAddress = result.archiveUrl;
});

it.skipIf(skipE2E)('starts at the first known frame block and resumes forward after restart', async () => {
  const client = await getTestMainchainClient(clientAddress);
  const botDataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'block-sync-'));
  runOnTeardown(() => fs.promises.rm(botDataDir, { recursive: true, force: true }));

  const accountset = new Accountset({
    client,
    txSubmitter: sudo(),
    sessionMiniSecretOrMnemonic: mnemonicGenerate(),
    subaccountRange: new Array(99).fill(0).map((_, i) => i),
  });
  const mainchainClients = new MainchainClients(clientAddress);
  await mainchainClients.setPrunedClient(clientAddress);
  const blockWatch = new BlockWatch(mainchainClients);
  const miningFrames = new MiningFrames(mainchainClients, blockWatch);
  await miningFrames.load();
  const storage = new Storage(botDataDir);
  const blockSync = new BlockSync(accountset, storage, mainchainClients, miningFrames, blockWatch, 0);
  const processed: number[] = [];
  blockSync.didProcessBlock = ({ blockNumber }) => processed.push(blockNumber);
  await blockSync.load();

  expect(processed[0]).toBe(1);
  const checkpoint = await storage.botStateFile().get();
  expect(checkpoint.lastProcessedBlockNumber).toBeGreaterThan(0);
  expect(checkpoint.lastProcessedBlockHash).toBeTruthy();
  await blockSync.stop();
  await storage.close();

  const restartedStorage = new Storage(botDataDir);
  const restartedClients = new MainchainClients(clientAddress);
  await restartedClients.setPrunedClient(clientAddress);
  const restartedBlockWatch = new BlockWatch(restartedClients);
  const restartedMiningFrames = new MiningFrames(restartedClients, restartedBlockWatch);
  const restartedBlockSync = new BlockSync(
    accountset,
    restartedStorage,
    restartedClients,
    restartedMiningFrames,
    restartedBlockWatch,
    0,
  );
  const processedAfterRestart: number[] = [];
  restartedBlockSync.didProcessBlock = ({ blockNumber }) => processedAfterRestart.push(blockNumber);
  await restartedBlockSync.load();

  expect(processedAfterRestart.every(number => number > checkpoint.lastProcessedBlockNumber)).toBe(true);
  expect((await restartedStorage.botStateFile().get()).lastProcessedBlockNumber).toBeGreaterThanOrEqual(
    checkpoint.lastProcessedBlockNumber,
  );
  await restartedBlockSync.stop();
  await restartedStorage.close();
});
