import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import { JsonExt, MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { createTestDb } from './helpers/db.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Transaction tracker tests', { timeout: 60e3 }, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');

  beforeAll(async () => {
    const network = await startArgonTestNetwork(__filename);

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
    MiningFrames.setNetwork('dev-docker');
  }, 60e3);

  it('should get and store errors on submission', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const transactionTracker = new TransactionTracker(Promise.resolve(db));
    await transactionTracker.load();
    expect(transactionTracker.data.transactions).toHaveLength(0);
    const newMnemonic = mnemonicGenerate();
    const keypair = new Keyring({ type: 'sr25519' }).addFromMnemonic(newMnemonic);
    const { tx, txResult } = await transactionTracker.submitAndWatch({
      tx: client.tx.balances.transferAllowDeath(alice.address, 1_000_000n),
      signer: keypair,
      extrinsicMetadata: { testId: 1 },
      extrinsicType: ExtrinsicType.VaultCreate,
    });
    expect(tx.status).toBe(TransactionStatus.Error);
    expect(transactionTracker.data.transactions).toHaveLength(1);
    expect(transactionTracker.pendingBlockTransactionsAtLoad).toHaveLength(0);
    console.log('Transaction result', JsonExt.stringify(tx, 2));
    await expect(txResult.inBlockPromise).rejects.toBeTruthy();
  });

  it('should watch a transaction as it reaches a block', async () => {
    console.time('test');
    const client = await clients.get(false);
    const db = await createTestDb();
    const transactionTracker = new TransactionTracker(Promise.resolve(db));
    await transactionTracker.load();
    const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
    const watchSpy = vi.spyOn(transactionTracker, 'watchForUpdates' as any).mockImplementation(() => null);
    const unWatchSpy = vi.spyOn(transactionTracker, 'stopWatching' as any).mockImplementation(() => null);
    {
      const { tx } = await transactionTracker.submitAndWatch({
        tx: client.tx.balances.transferAllowDeath(bob.address, 1_000_000n),
        signer: alice,
        extrinsicMetadata: { testId: 2 },
        extrinsicType: ExtrinsicType.Transfer,
      });
      console.timeLog('test', 'after submitAndWatch');
      expect(watchSpy).toHaveBeenCalledTimes(1);
      expect(tx.status).toBe(TransactionStatus.Submitted);
      expect(tx.submittedAtTime).toBeTruthy();
      expect(tx.submissionErrorJson).not.toBeTruthy();
      expect(transactionTracker.data.transactions).toHaveLength(1);
      watchSpy.mockReset();
    }
    await transactionTracker.load(true);
    expect(transactionTracker.data.transactions).toHaveLength(1);
    expect(transactionTracker.pendingBlockTransactionsAtLoad).toHaveLength(1);
    console.timeLog('test', 'after reload');

    // @ts-expect-error Now actually watch for updates
    await transactionTracker.watchForUpdates();
    const { txResult, tx } = transactionTracker.pendingBlockTransactionsAtLoad[0];
    await expect(txResult.inBlockPromise).resolves.toBeTruthy();
    console.timeLog('test', 'got inBlockPromise');

    expect(tx.status).toBe(TransactionStatus.InBlock);
    expect(transactionTracker.data.transactions).toHaveLength(1);
    {
      const transactionTracker2 = new TransactionTracker(Promise.resolve(db));
      vi.spyOn(transactionTracker2, 'watchForUpdates' as any).mockImplementation(() => null);
      await transactionTracker2.load();
      expect(transactionTracker2.data.transactions).toHaveLength(1);
      expect(transactionTracker2.pendingBlockTransactionsAtLoad).toHaveLength(0);
      console.timeLog('test', 'reloaded statuses 1');
    }

    // fake out finalization
    // vi.spyOn(transactionTracker, 'getFinalizedBlockNumber' as any)
    //   .mockImplementation(async () => tx.submittedAtBlockHeight);
    await expect(txResult.finalizedPromise).resolves.toBeTruthy();
    console.timeLog('test', 'got finalized');
    expect(tx.status).toBe(TransactionStatus.Finalized);
    expect(transactionTracker.data.transactions).toHaveLength(1);
    expect(unWatchSpy).toHaveBeenCalledTimes(1);
    expect(transactionTracker.pendingBlockTransactionsAtLoad).toHaveLength(1);
  });

  it('should record expired watching transactions', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const transactionTracker = new TransactionTracker(Promise.resolve(db));
    await transactionTracker.load();
    const watchSpy = vi.spyOn(transactionTracker, 'watchForUpdates' as any).mockImplementation(() => null);

    await transactionTracker.load();
    const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
    const { tx, txResult } = await transactionTracker.submitAndWatch({
      tx: client.tx.balances.transferAllowDeath(bob.address, 1_000_000n),
      signer: alice,
      extrinsicMetadata: { testId: 2 },
      extrinsicType: ExtrinsicType.Transfer,
    });
    expect(tx.status).toBe(TransactionStatus.Submitted);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    const finalizedHeightSpy = vi
      .spyOn(transactionTracker, 'getFinalizedBlockNumber' as any)
      .mockImplementation(async () => tx.submittedAtBlockHeight + 65);

    // @ts-expect-error Now actually watch for updates
    await transactionTracker.updatePendingStatuses(70);
    expect(tx.status).toBe(TransactionStatus.TimedOutWaitingForBlock);
    await expect(txResult.inBlockPromise).rejects.toBeTruthy();
  });
});
