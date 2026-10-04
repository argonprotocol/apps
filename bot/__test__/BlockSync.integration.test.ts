import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';
import { runOnTeardown, teardown } from '@argonprotocol/testing';
import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { Accountset, MainchainClients, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { BlockSync } from '../src/BlockSync.js';
import fs from 'node:fs';
import os from 'node:os';
import { Storage } from '../src/Storage.js';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
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
  clientAddress = sharedNetwork.archiveUrl;
});

it.skipIf(skipE2E)('starts at the first known frame block and resumes forward after restart', async () => {
  const client = await getTestMainchainClient(clientAddress);
  const botDataDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'block-sync-'));
  runOnTeardown(() => fs.promises.rm(botDataDir, { recursive: true, force: true }));

  const accountset = new Accountset({
    client,
    txSubmitter: new Keyring({ type: 'sr25519' }).addFromUri(
      integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded'),
    ),
    sessionMiniSecretOrMnemonic: mnemonicGenerate(),
    subaccountRange: new Array(99).fill(0).map((_, i) => i),
  });
  const mainchainClients = new MainchainClients(clientAddress);
  await mainchainClients.setPrunedClient(clientAddress);
  const blockWatch = new BlockWatch(mainchainClients);
  const miningFrames = new MiningFrames(mainchainClients, blockWatch);
  await miningFrames.load();
  const storage = new Storage(botDataDir);
  const historyStartingFrameId = Math.max(0, miningFrames.currentFrameId - 1);
  const blockSync = new BlockSync(
    accountset,
    storage,
    mainchainClients,
    miningFrames,
    blockWatch,
    historyStartingFrameId,
  );
  const processed: number[] = [];
  blockSync.didProcessBlock = ({ blockNumber }) => processed.push(blockNumber);
  await blockSync.load();

  expect(processed[0]).toBe(Math.max(1, miningFrames.framesById[historyStartingFrameId].firstBlockNumber!));
  let checkpoint = await storage.botStateFile().get();
  expect(checkpoint.lastProcessedBlockNumber).toBeGreaterThan(0);
  expect(checkpoint.lastProcessedBlockHash).toBeTruthy();
  await blockSync.stop();

  await waitFor(60_000, 'canonical finalized checkpoint before restart', async () => {
    const finalizedHash = await client.rpc.chain.getFinalizedHead();
    const finalizedHeader = await client.rpc.chain.getHeader(finalizedHash);
    if (finalizedHeader.number.toNumber() <= checkpoint.lastProcessedBlockNumber) return;
    const canonicalHash = await client.rpc.chain.getBlockHash(checkpoint.lastProcessedBlockNumber);
    if (canonicalHash.toHex() === checkpoint.lastProcessedBlockHash) return true;

    const canonicalSync = new BlockSync(
      accountset,
      storage,
      mainchainClients,
      miningFrames,
      blockWatch,
      historyStartingFrameId,
    );
    await canonicalSync.load();
    await canonicalSync.stop();
    checkpoint = await storage.botStateFile().get();
  });
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
    historyStartingFrameId,
  );
  const processedAfterRestart: number[] = [];
  restartedBlockSync.didProcessBlock = ({ blockNumber }) => processedAfterRestart.push(blockNumber);
  await restartedBlockSync.load();

  expect(processedAfterRestart[0]).toBe(checkpoint.lastProcessedBlockNumber + 1);
  expect(processedAfterRestart.every(number => number > checkpoint.lastProcessedBlockNumber)).toBe(true);
  expect((await restartedStorage.botStateFile().get()).lastProcessedBlockNumber).toBeGreaterThan(
    checkpoint.lastProcessedBlockNumber,
  );
  await restartedBlockSync.stop();
  await restartedStorage.close();
});
