import { teardown } from '@argonprotocol/testing';
import { MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startArgonTestNetwork } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { createTestDb } from './helpers/db.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import Path from 'path';
import { WalletBalances } from '../lib/WalletBalances.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { Keyring, TxSubmitter } from '@argonprotocol/mainchain';
import { createDeferred } from '../lib/Utils.ts';
import { WalletLedgerTable } from '../lib/db/WalletLedgerTable.ts';

afterAll(teardown);

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

describe.skipIf(skipE2E).sequential('Wallet balances monitoring tests', { timeout: 60e3 }, () => {
  let clients: MainchainClients;
  let mainchainUrl: string;
  const { walletKeys, miningAccount, vaultingAccount } = createTestWallet('//Alice');

  beforeAll(async () => {
    const network = await startArgonTestNetwork(Path.basename(import.meta.filename), { profiles: ['miners'] });

    mainchainUrl = network.archiveUrl;
    clients = new MainchainClients(mainchainUrl);
    setMainchainClients(clients);
    MiningFrames.setNetwork('dev-docker');
  }, 60e3);

  it('should track balances', async () => {
    const client = await clients.get(false);
    const db = await createTestDb();
    const walletBalances = new WalletBalances(clients, walletKeys, Promise.resolve(db));
    await walletBalances.load();
    const onBalanceChange = vi.fn();
    const onTransferIn = vi.fn();
    const onBlockDeleted = vi.fn();
    const didBlockGetDeleted = createDeferred<string>();
    walletBalances.onBlockDeleted = block => {
      console.log('Block deleted:', block);
      didBlockGetDeleted.resolve(block.blockHash);
      onBlockDeleted(block);
    };
    const didGetBalanceChange = createDeferred();
    walletBalances.onBalanceChange = (balanceChange, type) => {
      console.log('Balance changed:', type, balanceChange.microgonsAdded, balanceChange.block.blockHash);
      onBalanceChange(type);
      didGetBalanceChange.resolve();
    };
    walletBalances.onTransferIn = onTransferIn;
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
    expect(walletBalances.miningWallet.finalizedBalance.availableMicrogons).toBe(0n);
    expect(onBalanceChange).toHaveBeenCalledTimes(1 + onBlockDeleted.mock.calls.length);
    expect(onBalanceChange).toHaveBeenCalledWith('mining');
    expect(onTransferIn).toHaveBeenCalledTimes(1);
    expect(onTransferIn.mock.calls[0][1].microgonsAdded).toBe(5_000_000n);
    expect(onTransferIn.mock.calls[0][1].inboundTransfers).toHaveLength(1);
    expect(onTransferIn.mock.calls[0][1].inboundTransfers[0]).toMatchObject(
      expect.objectContaining({
        to: miningAccount.address,
        from: alice.address,
        amount: 5_000_000n,
        isOwnership: false,
        events: expect.arrayContaining([
          expect.objectContaining({
            method: 'Transfer',
            pallet: 'balances',
            data: expect.objectContaining({
              to: miningAccount.address,
              from: alice.address,
            }),
          }),
        ]),
      }),
    );
    expect(walletBalances.vaultingWallet.totalMicrogons).toBe(0n);
    // send a bunch of transfers
    let nextNonce = (await client.rpc.system.accountNextIndex(alice.address)).toNumber();
    let txs = 0;
    const waitForTxs = createDeferred();
    const unsubscribe = await client.rpc.chain.subscribeNewHeads(async () => {
      if (waitForTxs.isSettled) {
        return;
      }
      const txResult = await new TxSubmitter(
        client,
        client.tx.balances.transferKeepAlive(miningAccount.address, 1_000_000n),
        alice,
      ).submit({ nonce: nextNonce++ });
      await txResult.waitForFinalizedBlock;
      txs += 1;
      if (txs >= 10) {
        console.log('Unsubscribing from new heads');
        unsubscribe();
        waitForTxs.resolve();
      }
    });

    await waitForTxs.promise;

    const deletedBlockHash = await didBlockGetDeleted.promise;
    await new Promise(setImmediate);
    expect(walletBalances.miningWallet.balanceHistory.map(x => x.block.blockHash)).not.toContain(deletedBlockHash);

    const table = new WalletLedgerTable(db);
    const entries = await table.fetchAll();
    expect(entries).toHaveLength(11);
  });
});
