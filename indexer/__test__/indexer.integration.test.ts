import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { runOnTeardown, teardown } from '@argonprotocol/testing';
import { getClient, Keyring, TxSubmitter } from '@argonprotocol/mainchain';
import fs from 'node:fs';
import os from 'node:os';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import Path from 'path';
import { IndexerServer } from '../src/IndexerServer.ts';
import { AccountActivityKind } from '../src/AccountActivity.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  if (skipE2E) return;
  const result = await startArgonTestNetwork(Path.basename(import.meta.filename));
  clientAddress = result.archiveUrl;
});

it.skipIf(skipE2E)('indexes account activity blocks', async () => {
  const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');
  const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
  const charlie = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Charlie');

  const indexerDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'indexer-'));

  const client = await getClient(clientAddress);
  const indexer = new IndexerServer({
    port: 0,
    dbDir: indexerDir,
    network: 'dev-docker',
    mainchainUrl: clientAddress,
  });
  await indexer.start();
  runOnTeardown(async () => {
    await indexer.stop();
    await fs.promises.rm(indexerDir, { recursive: true, force: true });
  });
  {
    const response = await fetch(`http://localhost:${indexer.port}/v2/activity/${bob.address}`);
    expect(response.ok).toBe(true);
    const activity = (await response.json()) as { blocks: unknown[]; asOfBlock: number };
    expect(activity.blocks).toHaveLength(0);
    expect(activity.asOfBlock).toBeGreaterThanOrEqual(0);

    const transfersResponse = await fetch(`http://localhost:${indexer.port}/transfers/${bob.address}`);
    expect(transfersResponse.status).toBe(404);

    const collectsResponse = await fetch(`http://localhost:${indexer.port}/vault-collects/${bob.address}`);
    expect(collectsResponse.status).toBe(404);
  }

  const submitter = new TxSubmitter(client, client.tx.balances.transferAllowDeath(bob.address, 1_000_000n), alice);
  const result = await submitter.submit();
  await result.waitForFinalizedBlock;

  while (true) {
    const response = await fetch(`http://localhost:${indexer.port}/v2/activity/${bob.address}`);
    const activity = (await response.json()) as { asOfBlock: number };
    if (activity.asOfBlock >= result.blockNumber!) break;

    await new Promise(resolve => setTimeout(resolve, 500));
  }
  {
    const response = await fetch(`http://localhost:${indexer.port}/v2/activity/${bob.address}`);
    expect(response.ok).toBe(true);
    const activity = (await response.json()) as { blocks: { blockNumber: number; activityMask: number }[] };
    const transferBlock = activity.blocks.find(block => block.blockNumber === result.blockNumber);
    expect(transferBlock).toBeDefined();
    expect((transferBlock?.activityMask ?? 0) & AccountActivityKind.Transfer).toBe(AccountActivityKind.Transfer);
  }

  const proxySetup = await new TxSubmitter(client, client.tx.proxy.addProxy(bob.address, 'Any', 0), alice).submit();
  await proxySetup.waitForFinalizedBlock;

  const proxyTransfer = await new TxSubmitter(
    client,
    client.tx.proxy.proxy(alice.address, null, client.tx.balances.transferAllowDeath(charlie.address, 1_000_000n)),
    bob,
  ).submit();
  await proxyTransfer.waitForFinalizedBlock;

  while (true) {
    const response = await fetch(`http://localhost:${indexer.port}/v2/activity/${bob.address}`);
    const activity = (await response.json()) as { asOfBlock: number };
    if (activity.asOfBlock >= proxyTransfer.blockNumber!) break;

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const [aliceActivity, bobActivity, charlieActivity] = await Promise.all(
    [alice, bob, charlie].map(async account => {
      const response = await fetch(`http://localhost:${indexer.port}/v2/activity/${account.address}`);
      return (await response.json()) as { blocks: { blockNumber: number; activityMask: number }[] };
    }),
  );
  const proxyBlock = proxyTransfer.blockNumber!;
  const aliceProxyActivity = aliceActivity.blocks.find(block => block.blockNumber === proxyBlock)?.activityMask ?? 0;
  const bobProxyActivity = bobActivity.blocks.find(block => block.blockNumber === proxyBlock)?.activityMask ?? 0;
  const charlieProxyActivity =
    charlieActivity.blocks.find(block => block.blockNumber === proxyBlock)?.activityMask ?? 0;

  expect(aliceProxyActivity & AccountActivityKind.Transfer).toBe(AccountActivityKind.Transfer);
  expect(bobProxyActivity & AccountActivityKind.Fee).toBe(AccountActivityKind.Fee);
  expect(charlieProxyActivity & AccountActivityKind.Transfer).toBe(AccountActivityKind.Transfer);
});
