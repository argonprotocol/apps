import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import { BlockWatch, JsonExt, MainchainClients, NetworkConfig } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { createTestDb } from './helpers/db.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import Path from 'path';

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Transaction tracker tests', { timeout: 60e3 }, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');

  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename));

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
  }, 60e3);

  it('should get and store errors on submission', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const blockwatch = new BlockWatch(clients);
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    await transactionTracker.load();
    expect(transactionTracker.data.txInfos).toHaveLength(0);
    const newMnemonic = mnemonicGenerate();
    const keypair = new Keyring({ type: 'sr25519' }).addFromMnemonic(newMnemonic);
    const { tx, txResult } = await transactionTracker.submitAndWatch({
      tx: client.tx.balances.transferAllowDeath(alice.address, 1_000_000n),
      signer: keypair,
      metadata: { testId: 1 },
      extrinsicType: ExtrinsicType.VaultCreate,
    });
    await expect(txResult.waitForInFirstBlock).rejects.toBeTruthy();
    expect(tx.status).toBe(TransactionStatus.Error);
    expect(transactionTracker.data.txInfos).toHaveLength(1);
    console.log('Transaction result', JsonExt.stringify(tx, 2));
    // doesn't reload status at load
    expect(transactionTracker.pendingBlockTxInfosAtLoad).toHaveLength(1);
    await transactionTracker.load(true);
    expect(transactionTracker.data.txInfos).toHaveLength(1);
    // now cleared on reload
    expect(transactionTracker.pendingBlockTxInfosAtLoad).toHaveLength(0);
  });

  it('should watch a transaction as it reaches a block', async () => {
    console.time('test');
    const client = await clients.get(false);
    const db = await createTestDb();
    const blockwatch = new BlockWatch(clients);
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    await transactionTracker.load();
    const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
    const watchSpy = vi.spyOn(transactionTracker, 'watchForUpdates' as any).mockImplementation(() => null);
    const unWatchSpy = vi.spyOn(transactionTracker, 'stopWatching' as any).mockImplementation(() => null);
    {
      const { tx } = await transactionTracker.submitAndWatch({
        tx: client.tx.balances.transferAllowDeath(bob.address, 1_000_000n),
        signer: alice,
        metadata: { testId: 2 },
        extrinsicType: ExtrinsicType.Transfer,
      });
      console.timeLog('test', 'after submitAndWatch');
      expect(watchSpy).toHaveBeenCalledTimes(1);
      expect(tx.status).toBe(TransactionStatus.Submitted);
      expect(tx.submittedAtTime).toBeTruthy();
      expect(tx.submissionErrorJson).not.toBeTruthy();
      expect(transactionTracker.data.txInfos).toHaveLength(1);
      watchSpy.mockReset();
    }
    await transactionTracker.load(true);
    expect(transactionTracker.data.txInfos).toHaveLength(1);
    expect(transactionTracker.pendingBlockTxInfosAtLoad).toHaveLength(1);
    console.timeLog('test', 'after reload');

    // @ts-expect-error Now actually watch for updates
    await transactionTracker.watchForUpdates();
    const { txResult, tx } = transactionTracker.pendingBlockTxInfosAtLoad[0];
    await expect(txResult.waitForInFirstBlock).resolves.toBeTruthy();
    console.timeLog('test', 'got inBlockPromise');

    expect(tx.status).toBe(TransactionStatus.InBlock);
    expect(transactionTracker.data.txInfos).toHaveLength(1);
    {
      const blockwatch = new BlockWatch(clients);
      const transactionTracker2 = new TransactionTracker(Promise.resolve(db), blockwatch);
      vi.spyOn(transactionTracker2, 'watchForUpdates' as any).mockImplementation(() => null);
      await transactionTracker2.load();
      expect(transactionTracker2.data.txInfos).toHaveLength(1);
      expect(transactionTracker2.pendingBlockTxInfosAtLoad).toHaveLength(1);
      console.timeLog('test', 'reloaded statuses 1');
    }

    await expect(txResult.waitForFinalizedBlock).resolves.toBeTruthy();
    console.timeLog('test', 'got finalized');
    expect(tx.status).toBe(TransactionStatus.Finalized);
    expect(transactionTracker.data.txInfos).toHaveLength(1);
    expect(unWatchSpy).toHaveBeenCalledTimes(1);
    // doesn't change the starting load status
    expect(transactionTracker.pendingBlockTxInfosAtLoad).toHaveLength(1);
    {
      const blockwatch = new BlockWatch(clients);
      const transactionTracker2 = new TransactionTracker(Promise.resolve(db), blockwatch);
      vi.spyOn(transactionTracker2, 'watchForUpdates' as any).mockImplementation(() => null);
      await transactionTracker2.load();
      expect(transactionTracker2.data.txInfos).toHaveLength(1);
      expect(transactionTracker2.pendingBlockTxInfosAtLoad).toHaveLength(0);
      console.timeLog('test', 'reloaded statuses 2');
    }
  });

  it('should record expired watching transactions', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const blockwatch = new BlockWatch(clients);
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    await transactionTracker.load();
    const watchSpy = vi.spyOn(transactionTracker, 'watchForUpdates' as any).mockImplementation(() => null);

    await transactionTracker.load();
    const bob = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Bob');
    const { tx, txResult } = await transactionTracker.submitAndWatch({
      tx: client.tx.balances.transferAllowDeath(bob.address, 1_000_000n),
      signer: alice,
      metadata: { testId: 2 },
      extrinsicType: ExtrinsicType.Transfer,
    });
    expect(tx.status).toBe(TransactionStatus.Submitted);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    blockwatch.latestHeaders = [
      {
        isFinalized: true,
        blockNumber: tx.submittedAtBlockHeight + 65,
        blockHash: '0xabc',
        parentHash: '0xdef',
        tick: 0,
        author: '0x123',
        blockTime: new Date().getTime(),
      },
    ];

    vi.spyOn(transactionTracker, 'findTransactionInBlocks' as any).mockImplementationOnce(async () => null);

    // @ts-expect-error Now actually watch for updates
    await transactionTracker.updatePendingStatuses(70);
    expect(tx.status).toBe(TransactionStatus.TimedOutWaitingForBlock);
    await expect(txResult.waitForInFirstBlock).rejects.toBeTruthy();
    await expect(txResult.waitForFinalizedBlock).rejects.toBeTruthy();
  });
});
