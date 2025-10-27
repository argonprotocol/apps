import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { runOnTeardown, sudo, teardown } from '@argonprotocol/testing';
import { getClient, mnemonicGenerate } from '@argonprotocol/mainchain';
import {
  AccountMiners,
  Accountset,
  type IBotSyncStatus,
  MainchainClients,
  MiningFrames,
} from '@argonprotocol/apps-core';
import { BlockSync } from '../src/BlockSync.js';
import fs from 'node:fs';
import { Storage } from '../src/Storage.js';
import { Dockers } from '../src/Dockers.js';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  MiningFrames.setNetwork('dev-docker');
  const result = await startArgonTestNetwork('block-sync');
  clientAddress = result.archiveUrl;
});

it('can backfill sync data', async () => {
  const client = await getClient(clientAddress);

  const botDataDir = fs.mkdtempSync('/tmp/block-sync-');
  runOnTeardown(() => fs.promises.rm(botDataDir, { recursive: true, force: true }));

  const botStatus = {
    isReady: false,
  } as IBotSyncStatus;
  const storage = new Storage(botDataDir);
  const accountset = new Accountset({
    client,
    seedAccount: sudo(),
    sessionMiniSecretOrMnemonic: mnemonicGenerate(),
    subaccountRange: new Array(99).fill(0).map((_, i) => i),
  });
  const mainchainClients = new MainchainClients(clientAddress);
  void mainchainClients.setPrunedClient(clientAddress);
  const blockSync = new BlockSync(botStatus, accountset, storage, mainchainClients, 0);
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
  const finalized = await client.rpc.chain.getFinalizedHead();
  const finalizedHeader = await client.rpc.chain.getHeader(finalized);
  const latest = await client.rpc.chain.getHeader();
  const bestBlock = latest.number.toNumber();
  expect(bestBlock).gte(blockNumber);
  blockSync.latestFinalizedBlockNumber = finalizedHeader.number.toNumber();
  const result = await blockSync.backfillBestBlockHeader(latest);
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
  const status = await blockSync.state();
  expect(status.syncedToBlockNumber).toBeGreaterThanOrEqual(result!.bestBlockNumber);
  expect(status.syncProgress).toBe(100);
});
