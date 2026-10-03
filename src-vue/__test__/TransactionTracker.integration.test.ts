import { integrationNetwork as sharedNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { Keyring, mnemonicGenerate } from '@argonprotocol/mainchain';
import { teardown } from '@argonprotocol/testing';
import { BlockWatch, JsonExt, MainchainClients, TransactionEvents } from '@argonprotocol/apps-core';
import { it, beforeAll, afterAll, afterEach, describe, expect, inject, vi } from 'vitest';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';
import { createTestDb } from './helpers/db.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from '../lib/db/TransactionsTable.ts';
import { TransactionHistorySource, TransactionHistoryStatus } from '../lib/db/TransactionStatusHistoryTable.ts';

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Transaction tracker tests', { timeout: 60e3 }, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  const blockWatches: BlockWatch[] = [];
  const accountUri = integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded');
  const alice = new Keyring({ type: 'sr25519' }).addFromUri(accountUri);

  beforeAll(async () => {
    mainchainUrl = sharedNetwork.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
  });

  afterEach(() => {
    destroyTrackedBlockWatches();
  });

  afterAll(async () => {
    destroyTrackedBlockWatches();
    await clients?.disconnect();
  });

  it('should get and store errors on submission', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const blockwatch = createTrackedBlockWatch();
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    await transactionTracker.load();
    expect(transactionTracker.data.txInfos).toHaveLength(0);
    const newMnemonic = mnemonicGenerate();
    const keypair = new Keyring({ type: 'sr25519' }).addFromMnemonic(newMnemonic);
    const { tx, txResult } = await transactionTracker.submitAndWatch({
      tx: client.tx.balances.transferAllowDeath(alice.address, 1_000_000n),
      txSigner: keypair,
      metadata: { testId: 1 },
      extrinsicType: ExtrinsicType.VaultCreate,
    });
    await expect(txResult.waitForInFirstBlock).rejects.toBeTruthy();
    expect(tx.status).toBe(TransactionStatus.Error);
    expect(tx.txNonce).toBeTypeOf('number');
    const history = await db.transactionStatusHistoryTable.fetchByTransactionId(tx.id);
    expect(history.map(({ status, source }) => [status, source])).toEqual([
      [TransactionHistoryStatus.Submitted, TransactionHistorySource.Local],
      [TransactionHistoryStatus.Error, TransactionHistorySource.Local],
    ]);
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
    const blockwatch = createTrackedBlockWatch();
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    await transactionTracker.load();
    const bob = new Keyring({ type: 'sr25519' }).addFromUri(`${accountUri}//recipient`);
    const watchSpy = vi.spyOn(transactionTracker, 'watchForUpdates' as any).mockResolvedValue(undefined);
    const unWatchSpy = vi.spyOn(transactionTracker, 'stopWatching' as any).mockImplementation(() => null);
    {
      const { tx } = await transactionTracker.submitAndWatch({
        tx: client.tx.balances.transferAllowDeath(bob.address, 1_000_000n),
        txSigner: alice,
        metadata: { testId: 2 },
        extrinsicType: ExtrinsicType.Transfer,
      });
      console.timeLog('test', 'after submitAndWatch');
      expect(watchSpy).toHaveBeenCalledTimes(1);
      expect(tx.status).toBe(TransactionStatus.Submitted);
      expect(tx.txNonce).toBeTypeOf('number');
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
      const blockwatch = createTrackedBlockWatch();
      const transactionTracker2 = new TransactionTracker(Promise.resolve(db), blockwatch);
      vi.spyOn(transactionTracker2, 'watchForUpdates' as any).mockResolvedValue(undefined);
      await transactionTracker2.load();
      expect(transactionTracker2.data.txInfos).toHaveLength(1);
      expect(transactionTracker2.pendingBlockTxInfosAtLoad).toHaveLength(1);
      console.timeLog('test', 'reloaded statuses 1');
    }

    await expect(txResult.waitForFinalizedBlock).resolves.toBeTruthy();
    console.timeLog('test', 'got finalized');
    expect(tx.status).toBe(TransactionStatus.Finalized);
    const history = await db.transactionStatusHistoryTable.fetchByTransactionId(tx.id);
    expect(history.some(x => x.source === TransactionHistorySource.Watch)).toBe(true);
    expect(
      history.some(x => x.source === TransactionHistorySource.Block && x.status === TransactionHistoryStatus.InBlock),
    ).toBe(true);
    expect(
      history.some(x => x.source === TransactionHistorySource.Block && x.status === TransactionHistoryStatus.Finalized),
    ).toBe(true);
    expect(transactionTracker.data.txInfos).toHaveLength(1);
    expect(unWatchSpy).toHaveBeenCalledTimes(1);
    // doesn't change the starting load status
    expect(transactionTracker.pendingBlockTxInfosAtLoad).toHaveLength(1);
    {
      const blockwatch = createTrackedBlockWatch();
      const transactionTracker2 = new TransactionTracker(Promise.resolve(db), blockwatch);
      vi.spyOn(transactionTracker2, 'watchForUpdates' as any).mockResolvedValue(undefined);
      await transactionTracker2.load();
      expect(transactionTracker2.data.txInfos).toHaveLength(1);
      expect(transactionTracker2.pendingBlockTxInfosAtLoad).toHaveLength(0);
      console.timeLog('test', 'reloaded statuses 2');
    }
  });

  it('expires an unbroadcast transaction after the finalized inclusion window and preserves it on reload', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const blockwatch = createTrackedBlockWatch();
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    const recipient = new Keyring({ type: 'sr25519' }).addFromUri(`${accountUri}//unbroadcast-recipient`);
    const account = await client.query.system.account(alice.address);
    const signed = await client.tx.balances
      .transferAllowDeath(recipient.address, 1_000_000n)
      .signAsync(alice, { nonce: account.nonce });
    const submittedHeader = await client.rpc.chain.getHeader();
    // The durable record survives a crash between signing and RPC submission.
    const stored = await db.transactionsTable.insert({
      extrinsicHash: signed.hash.toHex(),
      extrinsicMethodJson: signed.method.toHuman(),
      metadataJson: {},
      extrinsicType: ExtrinsicType.Transfer,
      accountAddress: alice.address,
      submittedAtBlockHeight: submittedHeader.number.toNumber(),
      submittedAtTime: new Date(),
      txNonce: signed.nonce.toNumber(),
    });
    const pauseWatch = vi.spyOn(transactionTracker, 'watchForUpdates' as any).mockResolvedValue(undefined);
    await transactionTracker.load();
    blockwatch.stop();
    blockwatch.latestHeaders = [
      { ...blockwatch.finalizedBlockHeader, isFinalized: true, blockNumber: stored.submittedAtBlockHeight + 65 },
    ];
    // Advance the external block clock without waiting for 65 live blocks.
    const absent = vi.spyOn(TransactionEvents, 'findByExtrinsicHash').mockResolvedValueOnce(undefined);
    try {
      const { tx, txResult } = transactionTracker.data.txInfos[0];
      // @ts-expect-error Exercise the production reconciliation boundary.
      await transactionTracker.updatePendingStatuses(blockwatch.bestBlockHeader);
      expect(tx.status).toBe(TransactionStatus.TimedOutWaitingForBlock);
      await expect(txResult.waitForInFirstBlock).rejects.toBeTruthy();
      await expect(txResult.waitForFinalizedBlock).rejects.toBeTruthy();
      expect((await db.transactionsTable.fetchAll())[0].status).toBe(TransactionStatus.TimedOutWaitingForBlock);
      expect(await db.transactionStatusHistoryTable.fetchByTransactionId(tx.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: TransactionHistoryStatus.TimedOutWaitingForBlock,
            source: TransactionHistorySource.Local,
          }),
        ]),
      );
      const restored = new TransactionTracker(Promise.resolve(db), createTrackedBlockWatch());
      await restored.load();
      expect(restored.data.txInfos[0].tx.status).toBe(TransactionStatus.TimedOutWaitingForBlock);
      expect(restored.pendingBlockTxInfosAtLoad).toHaveLength(0);
    } finally {
      absent.mockRestore();
      pauseWatch.mockRestore();
      await db.close();
    }
  });

  it('should restore follow-on transaction links after reload', async () => {
    const db = await createTestDb();
    const firstSubmittedAt = new Date('2026-03-20T20:05:00Z');
    const secondSubmittedAt = new Date('2026-03-20T20:06:00Z');
    const firstTx = await db.transactionsTable.insert({
      extrinsicHash: `0x${'11'.repeat(32)}`,
      extrinsicMethodJson: { section: 'bitcoinLocks', method: 'cosignRelease' },
      metadataJson: { utxoId: 51 },
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      accountAddress: alice.address,
      submittedAtBlockHeight: 100,
      submittedAtTime: firstSubmittedAt,
      txNonce: 7,
    });
    await db.transactionsTable.recordSubmissionError(
      firstTx,
      new Error('Transaction was dropped from the node transaction pool'),
    );

    const secondTx = await db.transactionsTable.insert({
      extrinsicHash: `0x${'22'.repeat(32)}`,
      extrinsicMethodJson: { section: 'bitcoinLocks', method: 'cosignRelease' },
      metadataJson: { utxoId: 51 },
      extrinsicType: ExtrinsicType.VaultCosignBitcoinRelease,
      accountAddress: alice.address,
      submittedAtBlockHeight: 101,
      submittedAtTime: secondSubmittedAt,
      txNonce: 8,
    });
    await db.transactionsTable.recordInBlock(secondTx, {
      blockNumber: 101,
      blockHash: `0x${'aa'.repeat(32)}`,
      blockTime: secondSubmittedAt,
      tip: 2n,
      feePlusTip: 5n,
      extrinsicIndex: 1,
      transactionEvents: [],
    });
    await db.transactionsTable.markFinalized(secondTx, {
      blockNumber: 105,
      blockTime: new Date('2026-03-20T20:10:00Z'),
    });
    await db.transactionsTable.recordFollowOnTxId(firstTx, secondTx.id);

    const blockwatch = createTrackedBlockWatch();
    const transactionTracker = new TransactionTracker(Promise.resolve(db), blockwatch);
    await transactionTracker.load();

    const loadedFirst = transactionTracker.data.txInfos.find(x => x.tx.id === firstTx.id)!;
    const loadedSecond = transactionTracker.data.txInfos.find(x => x.tx.id === secondTx.id)!;

    await expect(loadedFirst.followOnTxInfo).resolves.toBe(loadedSecond);
  });

  function createTrackedBlockWatch(): BlockWatch {
    const blockWatch = new BlockWatch(clients);
    blockWatches.push(blockWatch);
    return blockWatch;
  }

  function destroyTrackedBlockWatches(): void {
    for (const blockWatch of blockWatches.splice(0)) {
      blockWatch.destroy();
    }
  }
});
