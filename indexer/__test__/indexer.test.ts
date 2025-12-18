import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { runOnTeardown, teardown } from '@argonprotocol/testing';
import { getClient, Keyring, TxSubmitter } from '@argonprotocol/mainchain';
import fs from 'node:fs';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import Path from 'path';
import { IndexerServer } from '../src/IndexerServer.ts';

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  const result = await startArgonTestNetwork(Path.basename(import.meta.filename));
  clientAddress = result.archiveUrl;
});

it('syncs transfers', async () => {
  const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');

  const indexerDir = fs.mkdtempSync('/tmp/indexer-');
  runOnTeardown(() => fs.promises.rm(indexerDir, { recursive: true, force: true }));

  const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
  const client = await getClient(clientAddress);
  const indexer = new IndexerServer({
    port: 0,
    dbDir: indexerDir,
    network: 'dev-docker',
    mainchainUrl: clientAddress,
  });
  await indexer.start();
  runOnTeardown(() => indexer.stop());
  // @ts-expect-error - private access
  const insertSpy = vi.spyOn(indexer.db, 'recordFinalizedBlock');

  {
    console.log(`http://localhost:${indexer.port}/transfers/${bob.address}`);
    const getTransfers = await fetch(`http://localhost:${indexer.port}/transfers/${bob.address}`);
    expect(getTransfers.ok).toBe(true);
    const transfers = (await getTransfers.json()) as any;
    expect(transfers.transfers).toHaveLength(0);
    expect(transfers.asOfBlock).toBeGreaterThanOrEqual(0);
  }

  const submitter = new TxSubmitter(client, client.tx.balances.transferAllowDeath(bob.address, 1_000_000n), alice);
  const result = await submitter.submit();
  await result.waitForFinalizedBlock;

  await new Promise(async resolve => {
    while (insertSpy.mock.calls.at(-1)![0].blockNumber < result.blockNumber!) {
      await new Promise(r => setTimeout(r, 500));
    }
    resolve(true);
  });
  {
    const getTransfers = await fetch(`http://localhost:${indexer.port}/transfers/${bob.address}`);
    expect(getTransfers.ok).toBe(true);
    const transfers = (await getTransfers.json()) as any;
    expect(transfers.transfers).toHaveLength(1);
    expect(transfers.transfers[0]).toEqual(
      expect.objectContaining({
        currency: 'argon',
        source: 'transfer',
      }),
    );
  }
});
