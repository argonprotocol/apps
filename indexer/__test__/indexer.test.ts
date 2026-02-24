import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { runOnTeardown, teardown } from '@argonprotocol/testing';
import { getClient, Keyring, TxSubmitter } from '@argonprotocol/mainchain';
import fs from 'node:fs';
import os from 'node:os';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import Path from 'path';
import { IndexerServer } from '../src/IndexerServer.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

afterEach(teardown);
afterAll(teardown);

let clientAddress: string;
beforeAll(async () => {
  if (skipE2E) return;
  const result = await startArgonTestNetwork(Path.basename(import.meta.filename));
  clientAddress = result.archiveUrl;
});

it.skipIf(skipE2E)('syncs transfers', async () => {
  const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');

  const indexerDir = fs.mkdtempSync(Path.join(os.tmpdir(), 'indexer-'));

  const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
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
    while (true) {
      const lastCall = insertSpy.mock.calls.at(-1);
      if (lastCall && lastCall[0] && lastCall[0].blockNumber >= result.blockNumber!) {
        break;
      }
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
