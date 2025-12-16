import { closeOnTeardown, teardown } from '@argonprotocol/testing';
import { IBalanceTransfer, MainchainClients, NetworkConfig } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { createTestDb } from './helpers/db.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import Path from 'path';
import { WalletBalances } from '../lib/WalletBalances.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { Keyring, TxResult, TxSubmitter } from '@argonprotocol/mainchain';
import { createDeferred } from '../lib/Utils.ts';
import { WalletLedgerTable } from '../lib/db/WalletLedgerTable.ts';
import { BlockWatch } from '@argonprotocol/apps-core/src/BlockWatch.ts';
import { WalletTransfersTable } from '../lib/db/WalletTransfersTable.ts';

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Wallet balances monitoring tests', { timeout: 60e3 }, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  let transferBlocks: number[] = [];
  let transferCount = 0;
  const { walletKeys, miningAccount } = createTestWallet('//Alice');

  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['miners'] });

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
    NetworkConfig.setNetwork('dev-docker');
  }, 60e3);

  it.sequential('should track balances', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const blockWatch = new BlockWatch(clients);
    const walletBalances = new WalletBalances(walletKeys, Promise.resolve(db), blockWatch, undefined);
    await walletBalances.load();
    closeOnTeardown(walletBalances);
    const onBalanceChange = vi.fn();
    const onTransferIn = vi.fn();
    const onBlockDeleted = vi.fn();
    const didBlockGetDeleted = createDeferred<string>();
    let blocksDeleted = 0;
    let balanceChanges = 0;
    walletBalances.events.on('block-deleted', block => {
      console.log('Block deleted:', block);
      didBlockGetDeleted.resolve(block.blockHash);
      onBlockDeleted(block);
      blocksDeleted++;
    });
    const didGetBalanceChange = createDeferred();
    walletBalances.events.on('balance-change', (balanceChange, type) => {
      console.log('Balance Change:', balanceChange);
      onBalanceChange(type);
      didGetBalanceChange.resolve();
      balanceChanges++;
    });
    walletBalances.events.on('transfer-in', onTransferIn);
    expect(walletBalances.miningWallet.totalMicrogons).toBe(0n);
    expect(walletBalances.vaultingWallet.totalMicrogons).toBe(0n);

    const alice = new Keyring({ type: 'sr25519' }).addFromMnemonic('//Alice');
    const result = await new TxSubmitter(
      client,
      client.tx.balances.transferKeepAlive(miningAccount.address, 5_000_000n),
      alice,
    ).submit();
    await result.waitForInFirstBlock;
    await expect(didGetBalanceChange.promise).resolves.toBeUndefined();
    expect(walletBalances.miningWallet.availableMicrogons).toBe(5_000_000n);
    expect(walletBalances.miningWallet.finalizedBalance?.availableMicrogons ?? 0n).toBe(0n);
    expect(onBalanceChange).toHaveBeenCalledTimes(1 + onBlockDeleted.mock.calls.length);
    expect(onBalanceChange).toHaveBeenCalledWith('mining');
    expect(onTransferIn).toHaveBeenCalledTimes(1);
    expect(onTransferIn.mock.calls[0][1].microgonsAdded).toBe(5_000_000n);
    expect(onTransferIn.mock.calls[0][1].transfers).toHaveLength(1);
    expect(onTransferIn.mock.calls[0][1].transfers[0]).toMatchObject(
      expect.objectContaining({
        to: miningAccount.address,
        from: alice.address,
        amount: 5_000_000n,
        isInbound: true,
        transferType: 'transfer',
        isInternal: false,
      } as IBalanceTransfer),
    );
    expect(walletBalances.vaultingWallet.totalMicrogons).toBe(0n);
    await result.waitForFinalizedBlock;
    await new Promise(setImmediate);
    expect(walletBalances.miningWallet.finalizedBalance?.availableMicrogons ?? 0n).toBe(5_000_000n);
    // send a bunch of transfers
    let nextNonce = (await client.rpc.system.accountNextIndex(alice.address)).toNumber();
    let finalizedTxs = 0;
    const waitForTxs = createDeferred();
    const txResults: TxResult[] = [];
    let txSubmissions = 0;
    let lastBlockNumber = 0;
    const unsubscribe = await client.rpc.chain.subscribeNewHeads(async h => {
      const blockNumber = h.number.toNumber();
      if (blockNumber <= lastBlockNumber) return;
      lastBlockNumber = blockNumber;

      if (waitForTxs.isSettled) {
        return;
      }
      await Promise.all(txResults.map(txResult => txResult.waitForInFirstBlock));
      if (txSubmissions >= 10) {
        return;
      }
      txSubmissions++;
      const txResult = await new TxSubmitter(
        client,
        client.tx.balances.transferKeepAlive(miningAccount.address, 1_000_000n),
        alice,
      ).submit({ nonce: nextNonce++ });
      txResults.push(txResult);
      await txResult.waitForFinalizedBlock;
      finalizedTxs++;

      if (finalizedTxs >= 10) {
        unsubscribe();
        waitForTxs.resolve();
      }
    });

    await waitForTxs.promise;

    const deletedBlockHash = await didBlockGetDeleted.promise;
    await new Promise(setImmediate);
    expect(walletBalances.miningWallet.balanceHistory.map(x => x.block.blockHash)).not.toContain(deletedBlockHash);

    const table = new WalletTransfersTable(db);
    const entries = await table.fetchAll();
    const inboundTransfers = entries.length;
    console.log(`Total TransfersIn - ${inboundTransfers}`, {
      entries,
      callbacks: { balanceChanges, blocksDeleted },
    });
    // should have cleaned up duplicate entries from reorgs

    transferBlocks = Array.from(new Set(entries.map(x => x.blockNumber)));
    transferCount = entries.length;
    const walletLedger = new WalletLedgerTable(db);
    const ledgerEntries = await walletLedger.fetchAll();
    console.log('Total Ledger Entries - ', ledgerEntries.length, ledgerEntries);
    expect(ledgerEntries.length).toBe(transferBlocks.length);
    expect(ledgerEntries.every(x => x.isFinalized)).toBe(true);
  });

  it.sequential('should recover wallet balances on restart', async () => {
    // 1. Test that it will fill gap from last synced to latest block
    const db = await createTestDb();
    const blockWatch = new BlockWatch(clients);
    const walletBalances = new WalletBalances(walletKeys, Promise.resolve(db), blockWatch, undefined);
    const spy = vi.spyOn(walletBalances, 'lookupTransferOrClaimBlocks').mockImplementation(async (address, blocks) => {
      const mostRecentBlock = Math.max(...transferBlocks);
      for (const block of transferBlocks) {
        if (address === walletKeys.miningAddress) {
          blocks.add(block);
        }
      }
      return { asOfBlock: mostRecentBlock };
    });
    // @ts-expect-error set a small backlog to force using indexer
    walletBalances.blockBacklogBeforeUsingIndexer = 10;
    await blockWatch.start();
    await walletBalances.resumeWalletSync();
    // @ts-expect-error - private
    expect(walletBalances.blockHistory).toHaveLength(1);
    // @ts-expect-error - private
    expect(walletBalances.blockHistory[0].blockNumber).toBe(Math.max(...transferBlocks));
    expect(walletBalances.miningWallet.balanceHistory).toHaveLength(1);
    expect(walletBalances.miningWallet.balanceHistory[0].block.blockNumber).toBe(Math.max(...transferBlocks));
    expect(walletBalances.miningWallet.balanceHistory[0].availableMicrogons).toBe(5_000_000n + 10n * 1_000_000n);
    expect(walletBalances.vaultingWallet.balanceHistory[0].block.blockNumber).toBe(Math.max(...transferBlocks));
    expect(walletBalances.vaultingWallet.balanceHistory[0].availableMicrogons).toBe(0n);
    expect(walletBalances.holdingWallet.balanceHistory[0].block.blockNumber).toBe(Math.max(...transferBlocks));
    expect(walletBalances.holdingWallet.balanceHistory[0].availableMicrogons).toBe(0n);

    expect(spy).toHaveBeenCalledTimes(1);
    closeOnTeardown(walletBalances);
    expect(walletBalances.miningWallet.totalMicrogons).toBeGreaterThan(0n);
    expect(walletBalances.miningWallet.balanceHistory.length).toBeGreaterThan(0);
    const walletLedger = new WalletLedgerTable(db);
    const ledgerEntries = await walletLedger.fetchAll();
    console.log('Total Ledger Entries - ', ledgerEntries.length, ledgerEntries);
    expect(ledgerEntries.length).toBeLessThanOrEqual(transferBlocks.length); // some transfers may be in same block
    expect(ledgerEntries.every(x => x.isFinalized)).toBe(true);

    const transfers = await new WalletTransfersTable(db).fetchAll();
    console.log('Total Transfer Entries - ', transfers.length, transfers);
    expect(transfers).toHaveLength(transferCount);
  });

  it.sequential('should recover wallet balances on restart without indexer', async () => {
    // 1. Test that it will fill gap from last synced to latest block
    const db = await createTestDb();
    const blockWatch = new BlockWatch(clients);
    const walletBalances = new WalletBalances(walletKeys, Promise.resolve(db), blockWatch, undefined);
    closeOnTeardown(walletBalances);
    // @ts-expect-error set a small backlog to force using indexer
    walletBalances.blockBacklogBeforeUsingIndexer = 1000;
    await blockWatch.start();
    await walletBalances.resumeWalletSync();
    // @ts-expect-error - private
    expect(walletBalances.blockHistory).toHaveLength(1);
    // @ts-expect-error - private
    expect(walletBalances.blockHistory[0].blockNumber).toBe(0);
    expect(walletBalances.miningWallet.balanceHistory).toHaveLength(1);
    // nothing will load during resume sync, but it will start at 0 and sync back up after
    expect(walletBalances.miningWallet.balanceHistory[0].block.blockNumber).toBe(0);
    expect(walletBalances.miningWallet.balanceHistory[0].availableMicrogons).toBe(0n);
    expect(walletBalances.vaultingWallet.balanceHistory[0].block.blockNumber).toBe(0);
    expect(walletBalances.vaultingWallet.balanceHistory[0].availableMicrogons).toBe(0n);
    expect(walletBalances.holdingWallet.balanceHistory[0].block.blockNumber).toBe(0);
    expect(walletBalances.holdingWallet.balanceHistory[0].availableMicrogons).toBe(0n);

    await walletBalances.loadBalancesAt(blockWatch.bestBlockHeader);

    expect(walletBalances.miningWallet.totalMicrogons).toBe(15_000_000n);
    const walletLedger = new WalletLedgerTable(db);
    const ledgerEntries = await walletLedger.fetchAll();
    console.log('Total Ledger Entries - ', ledgerEntries.length, ledgerEntries);
    expect(ledgerEntries.length).toBeLessThanOrEqual(transferBlocks.length); // some transfers may be in same block
    expect(ledgerEntries.every(x => x.isFinalized)).toBe(true);

    const transfers = await new WalletTransfersTable(db).fetchAll();
    console.log('Total Transfer Entries - ', transfers.length, transfers);
    expect(transfers).toHaveLength(transferCount);
  });
});
