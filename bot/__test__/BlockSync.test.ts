import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { runOnTeardown, sudo, teardown } from '@argonprotocol/testing';
import { getClient, mnemonicGenerate } from '@argonprotocol/mainchain';
import { AccountMiners, Accountset, MainchainClients, MiningFrames, NetworkConfig } from '@argonprotocol/apps-core';
import { BlockSync } from '../src/BlockSync.js';
import fs from 'node:fs';
import { Storage } from '../src/Storage.js';
import { DockerStatus } from '../src/DockerStatus.js';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import Path from 'path';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  NetworkConfig.setNetwork('dev-docker');
  const result = await startArgonTestNetwork(Path.basename(import.meta.filename));
  clientAddress = result.archiveUrl;
});

it('can backfill sync data', async () => {
  const client = await getClient(clientAddress);

  const botDataDir = fs.mkdtempSync('/tmp/block-sync-');
  runOnTeardown(() => fs.promises.rm(botDataDir, { recursive: true, force: true }));

  const storage = new Storage(botDataDir);
  const accountset = new Accountset({
    client,
    seedAccount: sudo(),
    sessionMiniSecretOrMnemonic: mnemonicGenerate(),
    subaccountRange: new Array(99).fill(0).map((_, i) => i),
  });
  const mainchainClients = new MainchainClients(clientAddress);
  void mainchainClients.setPrunedClient(clientAddress);
  const blockWatch = new BlockWatch(mainchainClients);
  const miningFrames = new MiningFrames(mainchainClients, blockWatch);
  await miningFrames.load();
  // don't auto-progress during test
  blockWatch.stop();
  const blockSync = new BlockSync(accountset, storage, mainchainClients, miningFrames, blockWatch, 0);
  // @ts-expect-error - it's private
  blockSync.localClient = await mainchainClients.archiveClientPromise;
  // @ts-expect-error - it's private
  blockSync.archiveClient = await mainchainClients.archiveClientPromise;
  blockSync.accountMiners = new AccountMiners(accountset, []);

  const blockNumber = await new Promise<number>(async resolve => {
    const unsub = await client.query.system.number(x => {
      if (x.toNumber() >= 20) {
        resolve(x.toNumber());
        unsub();
      }
    });
  });

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
  const finalized = await client.rpc.chain.getFinalizedHead();
  const finalizedHeader = await client.rpc.chain.getHeader(finalized);
  const latest = await client.rpc.chain.getHeader();
  const bestBlock = latest.number.toNumber();
  expect(bestBlock).gte(blockNumber);

  // @ts-expect-error - it's private
  await blockWatch.setFinalizedHeader(finalizedHeader);
  console.log('[BlockWatch]: After finalized', ...blockWatch.latestHeaders);

  expect(blockWatch.finalizedBlockHeader.blockNumber).toBe(finalizedHeader.number.toNumber());

  const result = await blockSync.backfillBestBlockHeader(blockWatch.bestBlockHeader);
  expect(result).toBeDefined();
  expect(result!.finalizedBlockNumber).toBeGreaterThanOrEqual(finalizedHeader.number.toNumber());
  expect(result!.bestBlockNumber).toBeGreaterThanOrEqual(latest.number.toNumber());
  expect(result!.syncedToBlockNumber).toBe(0);
  for (let i = 1; i <= blockNumber; i++) {
    const block = result!.blocksByNumber[i];
    expect(block).toBeDefined();
    expect(block.number).toBe(i);
    expect(block.hash).toBeDefined();
  }

  await expect(blockSync.processNext()).resolves.toStrictEqual({
    processed: expect.objectContaining({
      number: 1,
    }),
    remaining: result!.bestBlockNumber - 1,
  });

  await expect(blockSync.syncToLatest()).resolves.toBeUndefined();
  const status = await blockSync.botStateFile.get();
  expect(status.syncProgress).toBe(100);
});
